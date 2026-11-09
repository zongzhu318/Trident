# Design

## Context

动机见 `proposal.md`，行为契约见 `specs/remote-file-transfer/spec.md`。当前实现的约束：

- 文件操作入口 `withFiles` 以会话级串行锁串行化所有文件操作（[main.cjs:525](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L525)），传输期间浏览、重命名、删除与新建目录都被排队。
- 传输控制器以「一个会话一个控制器」建模，进度、暂停与停止都按单任务设计；`createTransfer` 与 `runTransfer` 见 [main.cjs:648](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L648) 与 [main.cjs:751](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L751)。
- 界面在传输期间置忙碌状态，工具栏禁用；传输面板只展示一条进度（[FileBrowser.tsx](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/FileBrowser.tsx)）。
- SFTP 适配器基于一条 `ssh2` 通道，可同时承载多个读写流；FTP 适配器基于单条 basic-ftp 控制连接，同一时刻只能执行一个命令。
- 任务内的多文件并发（SFTP 16/4、FTP 3）与暂停续传、`.part` 清理、冲突策略已经存在，本次不改变这些单任务语义。

## Goals / Non-Goals

**Goals:**

- 把并发边界从「单任务内多文件」提升到「会话内多任务」，任务之间互不阻塞。
- 传输控制按任务隔离且幂等；断线时统一终止并清理。
- 传输期间文件浏览与整理操作保持可用。
- SFTP/FTP 传输资源在任务间共享，总并发受协议上限约束，任务全部结束后释放。

**Non-Goals:**

- 不引入任务队列、排队上限或用户可配置的并发度。
- 不做跨会话断点续传、带宽限速或传输优先级。
- 不改变目录结构、路径校验、20000 条目上限、冲突策略与单文件进度语义。
- 不改动传输对话框的交互（保存/选择目录仍逐个弹出）。

## Decisions

### D1：以 `taskId` 作为任务标识，控制与事件按任务路由

`createTransfer` 为每个任务生成 `randomUUID()` 作为 `taskId`，会话以 `transfers: Map<taskId, controller>` 持有全部任务。传输事件负载新增 `taskId`；`transfer:pause`、`transfer:resume`、`transfer:cancel` 增加 `taskId` 参数，只作用于对应任务并保持幂等。

`activeTransfer(id, taskId)` 在未传 `taskId` 时，仅当会话中恰好有一个非终态任务时返回它，兼容既有单任务调用方；否则返回 `null`，控制操作不产生副作用。断线时 `disconnect` 遍历全部控制器，置 `disconnected` 与失败状态、中止在途文件并唤醒所有等待器（[main.cjs:131](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L131)）。

选择 `taskId` 参数而不是新增 IPC 通道，是因为 preload 的 `invoke` 透传任意参数，渲染层只需同步签名，通道集合与权限校验保持不变。

### D2：渲染层按任务合并状态，传输面板改为任务列表

`SessionView` 用 `Map<taskId, Transfer>` 合并事件：按 `taskId` 覆盖同一条任务，结束任务超过 30 条时裁剪最旧记录；会话关闭时把仍在运行的任务标记为失败（[SessionView.tsx:330](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/SessionView.tsx#L330)）。`FileBrowser` 的 `TransferItem` 为每条任务独立渲染方向、名称、聚合进度、并行文件数、速率/剩余时间、暂停/继续/停止与结束汇总，并支持清除记录。

`startTransfer` 只发起任务，不设置面板的 `busy`；`busy` 仅用于目录读取、重命名、删除等一次性文件操作（[FileBrowser.tsx:304](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/FileBrowser.tsx#L304)）。因此传输期间工具栏保持可用，用户可以连续发起多个下载或上传。任务列表限制了高度并可滚动，避免多条任务挤压文件列表。

### D3：SFTP 使用会话级信号量限制总流数

每条 SSH 会话在 SFTP 打开后创建 `limiter = createLimiter(16)`，并在关闭/失败时置空。每个文件尝试通过 `withSFTPFiles` 获取一个槽位后再调用适配器（[main.cjs:514](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L514)），保证多个任务共享同一条通道时总并发不超过 16。任务内部的 4/16 并发仍由工作池决定，实际流数为两者与文件数的较小值。

选择会话级共享信号量而不是每任务独立限流，是因为服务器侧限制的是单连接句柄与流数；按任务限流会在多任务时成倍放大占用。

### D4：FTP 使用会话级连接租约池，主连接保留给控制操作

会话维护 `ftpPool`（最多 `FTP_CONCURRENCY = 3` 条任务连接）：

- 每个文件尝试通过 `withFTPLane` 租用一条连接，执行完立即归还；空闲连接复用，不按任务固定分配（[main.cjs:505](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L505)）。
- 连接按需建立；任一额外连接建立失败即置 `pool.failed`，停止扩容并只使用已建立的连接；一条都没建成时回退到 `session.controlFiles`（主连接串行），不中止传输。
- 租约等待挂在任务的唤醒集合上，暂停、停止、断线都能打断等待并抛出取消信号，避免任务卡在资源获取阶段。
- 所有任务结束、失败或停止后，`runTransfer` 的 `finally` 调用 `closeFTPPoolIfIdle`，仅在 `session.transfers` 为空时关闭全部额外连接；断线时直接关闭池（[main.cjs:452](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L452)）。

选择租约池而不是「按任务各建连接」，是为了让多任务共享总量上限并复用连接，避免任务数增加时连接数线性增长；选择保留主连接，是为了让浏览与控制不被大文件传输阻塞。

### D5：浏览与控制走主连接，并以互斥锁串行化单条 FTP 控制连接

`withFiles` 不再加会话级锁，直接把 `session.controlFiles` 交给操作。FTP 的 `controlFiles` 是用 `serializedFiles` 包装的适配器：每个方法调用经互斥队列串行（[main.cjs:415](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L415)）。这样浏览、重命名、删除、新建目录可以与其他任务并发发起，但不会在同一控制连接上并发下发命令。FTP 主连接同时用于传输降级路径，因此降级时控制操作可能等待当前文件传输片段完成，与 spec 中的 MAY 一致。

文件对话框通过独立的 `withDialog` 互斥串行弹出，避免多任务同时请求系统对话框导致平台限制或焦点抢占。

### D6：并发等待器统一响应暂停、继续、停止与断线

控制器维护 `wakes: Set<wake>`。`waitOnTransfer` 把唤醒函数同时注册到任务唤醒集合与资源等待集合，资源可用、暂停恢复、停止与断线都会唤醒等待者（[main.cjs:564](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L564)）。`acquireSlot` 与 `acquireFTPClient` 在循环中先检查取消与暂停，再尝试获取资源，确保：

- 暂停期间不占用也不新申请槽位/连接；
- 停止或断线时立即退出等待并走既有清理路径；
- 资源释放时唤醒所有等待者，由它们重新竞争。

选择「唤醒后重新循环竞争」而不是严格的 FIFO 队列，是因为等待者数量等于任务内工作池大小（最多 16），规模小且实现简单；公平性差异不影响完成性。

### D7：断线、失败与停止保持任务级隔离

- 单个任务失败或停止只影响自身：`runTransfer` 在 `finally` 中删除该 `taskId`、清理任务的中止控制器与唤醒器，并按需关闭空闲连接池。
- 断线时所有任务统一转为失败，等待器被唤醒，未完成内容按既有停止路径清理（上传删除远程不完整内容、下载删除 `.part` 临时文件）。
- 其他任务不因某个任务失败而终止；文件面板的操作也不受影响。

### D8：任务失败原因随事件上报

控制器新增 `error` 字段，`runTransfer` 的每个错误出口（扫描失败、文件失败、断线、未预期异常）都会在转为 `error` 状态前写入该字段；断线时 `disconnect` 与渲染层的 `close` 处理分别兜底为“连接已断开”。`transferPayload` 仅在 `state === "error"` 时输出 `error`，任务项以危险色展示原因（[main.cjs:661](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L661)、[FileBrowser.tsx:171](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/FileBrowser.tsx#L171)）。

选择随任务事件上报而不是只依赖全局错误横幅，是因为横幅会被下一次发起传输清空，多任务并发时也无法判断是哪一个任务失败；任务项内的原因可以随任务记录保留到用户清除。

### D9：SFTP 瞬时失败的有界重试

部分 SFTP 服务器在并发句柄过多或瞬时繁忙时返回通用失败 `SSH_FX_FAILURE`（错误码 4）。`shouldRetrySftp` 统一判定：仅 SFTP（FTP 已有连接池降级且续传语义不同）、错误码为 4、且尝试次数小于 2；退避 150ms、300ms，重试前检查暂停、停止与断线。

- 文件传输：上传与下载在捕获失败后按已写入偏移续传（下载取 `.part` 实际大小，上传取远程已有大小），失败信息仍保留在任务 `error` 中。
- 目录扫描：新增 `retrySftp` 包装 `files.list`（[main.cjs:545](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L545)），扫描阶段的瞬时失败不会再让任务以 0/0 直接失败。

重试次数有界并带退避，避免在服务器持续异常时放大压力；超过上限仍失败，由 D8 上报原因。

### D10：任务标题与当前文件分离

`createTransfer` 增加稳定的 `name`：下载取远程条目名，上传取所选顶层名称，多选时使用“首项 等 N 项”（`transferTitle`）。传输事件同时输出 `file`（当前处理的文件），任务标题只使用 `name`（[main.cjs:643](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L643)）。扫描阶段标题显示“名称 · 正在扫描…”，运行阶段在“当前文件”行单独展示 `file`（[FileBrowser.tsx:102](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/FileBrowser.tsx#L102)）。

原实现把 `name` 取自 `current.name`，会随当前文件不断覆盖；文件夹任务在多任务并发时标题会变成最后处理的文件名，扫描失败时甚至没有名称。拆分后标题在一生中保持稳定。

### D11：FTP 本地写入失败隔离

FTP 数据 socket 上的错误会被 basic-ftp 的默认处理器升级为 `closeWithError`，关闭整条控制连接。本地目标写入失败（目录被删除、磁盘已满）时，目标流先触发 `error`，`pipeline` 会把该错误传播到共享数据 socket，导致会话内其他任务与文件操作一起失败。

处理方式：在创建目标流后立即监听其 `error`，若当前数据 socket 仍是本次传输的 socket，则执行 `ftp.dataSocket = undefined`，由 basic-ftp 无错关闭数据连接并移除其监听；随后由 `pipeline` 的拒绝按普通任务失败上报（[files.cjs:278](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/files.cjs#L278)）。同时捕获 `ftp.handle` 返回的 Promise（[files.cjs:311](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/files.cjs#L311)），避免任务被拒绝时产生未处理拒绝。验证方式：FTP 本地写入失败后，同一会话仍能继续 rename/list。

### D12：测试可观测性

- 集成测试通过 FTP 测试服务器的控制连接数与在途传输数、SFTP 测试服务器的并发句柄数，断言多任务确实并发且总量不超上限。
- 新增用例覆盖：SFTP 两个并发下载期间执行 list/mkdir/rename；FTP 两个并发下载产生至少两条连接、任务结束后连接数回落；断线终止全部任务并带“连接已断开”原因；SFTP 与 FTP 本地写入失败时任务项带原因且不残留临时文件；注入一次 `READ` 失败验证按偏移续传；注入一次 `OPENDIR` 失败验证目录扫描重试；文件夹上传/下载的事件标题保持顶层名称、当前文件单独上报。
- UI smoke 启动两个慢速下载，断言两条任务同时运行、文件操作按钮保持可用、两个目标文件内容一致；触发一次本地写入失败，断言任务项展示失败原因；断言文件夹任务标题为文件夹名而不是其内部文件。

## Risks / Trade-offs

- [FTP 服务器限制并发连接数] → 建池失败即停止扩容并回退主连接串行，传输仍可完成，只是并发降低。
- [SFTP 多任务叠加导致流数过高] → 会话级信号量统一限流，总流数不超过 16。
- [降级时控制操作被单个传输命令短暂阻塞] → 单条 FTP 控制连接无法并发命令；降级只发生在连接不足时，且 spec 允许控制操作等待当前片段完成。
- [任务列表无限增长] → 只保留最近 30 条已结束记录，运行中的任务不裁剪。
- [断线与资源等待竞态] → `disconnected` 标记 + 唤醒集合，确保等待中的任务退出而不悬挂。
- [多个文件对话框同时请求] → `withDialog` 串行弹出，避免平台限制与焦点错乱。
- [并发同一会话时服务器端会话数增加] → 总额外连接最多 3 条，任务全部结束后立即关闭，凭据仅驻留内存。
- [瞬时失败重试放大服务器压力] → 仅针对 `SSH_FX_FAILURE`，最多 2 次并带 150ms/300ms 退避，重试前检查取消、暂停与断线，仍失败则正常上报。

## Migration Plan

无数据迁移。IPC 事件新增 `taskId`、控制接口新增参数，由渲染层与 preload 同步更新；主进程保留单活动任务时省略 `taskId` 的兼容路径。回退时可恢复会话级串行锁与单任务控制器，已写入的本地/远程文件不受影响。

## Open Questions

（无。）
