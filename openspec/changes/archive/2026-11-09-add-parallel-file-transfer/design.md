# Design

## Context

动机见 `proposal.md`，行为契约见 `specs/remote-file-transfer/spec.md`。现状约束：

- 批量传输由 [main.cjs:666](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L666) 与 [main.cjs:835](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L835) 的 `for (const entry of c.plan)` 串行执行，目录创建、冲突检查与文件传输混在同一循环。
- 控制器只持有单个 `c.current`、`c.baseBytes`、`c.abort`（[main.cjs:445-468](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L445-L468)），进度与暂停/停止都按单文件设计。
- SFTP 适配器基于一条 `ssh2` SFTP 通道，可同时承载多个读写流；FTP 适配器基于单条 basic-ftp 控制连接，同一时刻只能执行一个任务。
- FTP 会话当前只保存 `client` 与 `files`，`access` 参数没有留在内存中（[main.cjs:347-383](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L347-L383)）。
- 同名冲突首次询问一次并作用于整批（[main.cjs:498-522](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L498-L522)）；并发后需要保证只弹一次。
- 既有暂停/继续/停止、续传偏移、`.part` 临时文件与 FTP 数据连接自管理逻辑保持不变，本设计只把作用对象从单文件扩展为多文件。

## Goals / Non-Goals

**Goals:**

- 目录先建、文件后传；文件阶段用固定大小工作池并发执行，单文件行为不变。
- SFTP 与 FTP 各有明确的并发上限；FTP 通过额外控制连接池实现，主连接保留。
- 聚合进度、暂停/继续、停止、失败传播与冲突弹窗在多在途文件下保持正确。
- FTP 连接池可降级：服务器限制连接数时自动减少并发或回退串行。
- 测试能观测协议层的并发度与连接数，覆盖并行下的暂停、停止、冲突与降级。

**Non-Goals:**

- 不提供并发度设置界面，不引入传输队列或多任务面板。
- 不做跨会话断点续传、带宽限速或动态调整并发。
- 不改变单文件、目录结构、路径校验、20000 条目上限等既有语义。
- 不引入第三方并发库，工作池为小型内部实现。

## Decisions

### D1：两阶段执行，目录按层并发、文件并发

`uploadSources` 与 `downloadPlan` 在 `running` 状态开始后：

1. 目录阶段：按层级遍历 `entry.directory`，同层目录互不依赖，使用与文件阶段相同的并发上限并发创建，父目录必然先于子目录完成。SSH/SFTP 会话优先把全部目录路径拼成一次（超长时分块）`mkdir -p` 远程命令，用一个往返创建整棵树；命令被拒绝、未生效或校验最深目录不存在时，回退到逐目录创建。上传逐目录创建会先 `mkdir`、失败后再 `stat` 确认是否可合并，新建目录只产生一次协议往返。下载调用 `ensureLocalDirectory`。
2. 文件阶段：仅收集非目录条目，交给工作池。

目录阶段沿用 `checkCancelled` / `waitForResume` 检查点；目录统计与非目录统计沿用现有字段。若目录阶段失败，其余同层目录不再开始，整个传输以失败结束，不进入文件阶段。与"边建目录边传文件"相比，两阶段多一次遍历但实现和错误语义更简单，空目录也仍会创建。

### D2：并发度使用内部常量，实际并发取文件数与上限的较小值

- `SFTP_CONCURRENCY = 4`、`FTP_CONCURRENCY = 3`（不含主连接）。
- 平均文件大小不超过 1 MiB 且文件数超过 4 的 SFTP 批次使用 `SFTP_SMALL_CONCURRENCY = 16`：小文件的耗时由往返延迟主导，提高并发收益明显；大文件仍保持 4，避免争抢带宽。
- 上传的冲突检测不再为每个 SFTP 文件预先 `lstat`：独占创建（`wx`）在打开阶段失败且尚未写入时，再确认远程是否已存在；FTP 的 `STOR` 会覆盖，仍保留上传前检查。
- `lanes = min(并发上限, 文件条目数)`；只有一个文件时不创建任何额外连接，行为与现状一致。
- 不暴露设置：不同服务器的连接限制差异很大，自动降级比让用户配置更可靠；后续需要时可在 `preferences` 上独立演进。

### D3：SFTP 在单条连接上多流并发

SFTP 的 `files` 适配器可被多个 worker 同时调用：每个 worker 独占一个文件，`createReadStream` / `createWriteStream` 各自独立。并发数固定为 4，避免在单连接上打开过多句柄导致服务器端 `SSH_FX_FAILURE` 或性能下降。

### D4：FTP 使用额外控制连接池，主连接不参与传输

- `connectFTP` 把 `access` 参数（host、port、user、password、secure、secureOptions）保存在 `session.ftpAccess`，仅驻留内存，会话删除即释放，不落盘。
- 文件阶段开始时惰性建立最多 `FTP_CONCURRENCY` 条 `new FTPClient(30000)` 连接，逐条 `access` 并包装为 `ftpFiles(client)`；每条连接同一时刻只跑一个文件，因此并发度等于成功建立连接数。
- 主连接继续承担浏览、重命名、删除等控制操作，不进入工作池；某个传输连接故障只终结本次传输，不会直接打死会话主连接。
- 建立某条连接失败时关闭该连接并停止继续扩容，使用已建立的连接数；一条都没建成时回退为主连接串行（即现状）。
- 池在 `uploadSources` / `downloadPlan` 的 `finally` 中全部 `close()`；`disconnect` 也兜底关闭 `session.ftpPool`，防止断线时泄漏连接。
- 选择额外连接而不是"主连接排队执行多任务"，是因为 basic-ftp 单连接天然串行，排队无法提升小文件吞吐；选择不把主连接纳入池，是为了隔离传输错误对会话的影响。

### D5：控制器改为聚合状态

控制器新增/调整字段：

```text
active: Map<entryKey, { name, transferred, total }>   // 在途文件
aborts: Set<AbortController>                          // 替代单 abort
completedBytes: number                                // 已完成/跳过条目的源字节
current: { name, transferred, total }                 // 最近上报的文件，供面板展示
error: Error | null                                   // 首个失败
stopping: boolean                                     // 因失败或停止而中止其余 worker
conflictAsk: Promise<boolean> | null                  // 共享冲突弹窗
```

- 整体字节统一为 `bytes.transferred = completedBytes + Σactive[*].transferred`，由 `syncBytes(c)` 计算；不再使用 `baseBytes + current.transferred`。完成、跳过、失败都只在一个同步代码块中更新计数，不存在竞态。
- `c.current` 保持"最近一次上报文件"的语义，`transferPayload` 兼容现有字段，并新增 `active: c.active.size`。面板在 `active > 1` 时显示「并行 N 个文件」。
- 速率仍基于聚合 `bytes.transferred` 的 3 秒滑动窗口，暂停/继续时重置。

### D6：工作池与暂停/继续、停止

文件阶段使用简单工作池：

```text
next = 0
worker(lane):
  while next < files.length && !c.error && !c.cancelled:
    await waitForResume(c)
    entry = files[next++]
    await transferEntry(lane, entry)
await Promise.allSettled(lanes.map(worker))
```

- 每个 lane 对应一个可用的 FTP 连接；SFTP 的多个 lane 共享同一个适配器。
- `runUploadFile` / `runDownloadFile` 的每个文件循环保留现有 `paused → 等待唤醒` 与续传偏移逻辑，只把 `c.abort` 换成向 `c.aborts` 添加/删除自己的 `AbortController`。
- `pauseTransfer` 遍历 `c.aborts` 全部 abort；所有在途文件各自进入暂停等待，保留各自偏移。`resumeTransfer` 唤醒 worker 与文件循环，全部从各自偏移继续。
- `cancelTransfer` 置 `c.cancelled`、abort 全部；每个文件按现有停止清理逻辑删除远程不完整内容或 `.part` 文件，未开始的文件不再启动。`disconnect` 同样 abort 全部。
- 文件完成/跳过时从 `active` 删除并把源大小累加到 `completedBytes`；暂停期间这些值保持不变。

### D7：失败只记录首个错误，随后中止其余在途文件

- worker 捕获文件错误后：若属于停止/连带中止路径，清理当前文件并退出；否则包装为现有文案（`${entry.name} 上传失败：…`），在 `c.error` 为空时记录，置 `c.stopping = true`、`abortAll(c)`，失败计数只加一次。
- 其余在途文件的 catch 看到 `c.stopping` 时执行与停止一致的尽力清理，然后退出，不覆盖首个错误。
- `Promise.allSettled` 后：有 `c.error` 则抛出它（`runTransfer` 进入 `error` 状态）；否则有 `c.cancelled` 则抛 `TransferCancelled`；否则正常完成。
- 保持现有语义：失败即终止整批，不继续传输剩余文件。

### D8：冲突弹窗共享同一个 Promise

`skipConflict` 改为：

- 若 `c.conflict === "skip"`，直接计跳过。
- 否则若 `c.conflictAsk` 为空，创建弹窗 Promise 并保存；所有并发冲突都 `await c.conflictAsk`。
- 用户选择停止时置 `c.cancelled` 并抛 `TransferCancelled`；选择跳过则置 `c.conflict = "skip"`，所有等待者按跳过处理。
- 弹窗只创建一次，解决并发 worker 同时进入导致的重复弹窗；选择结果与现有"作用于整批"语义一致。

### D9：进度事件与渲染层增量

`transferPayload` 保持现有字段，新增 `active` 与 `eta`。`src/types.ts` 的 `Transfer` 增加 `active: number` 与 `eta?: number | null`；`src/FileBrowser.tsx` 在运行/暂停状态显示活动文件数，运行时按剩余字节除以最近 3 秒聚合速率估算剩余时间（向上取整秒），速率未知、暂停或已结束时为 `null`，面板不展示。`src/App.tsx` 帮助文本与 `README.md` 补充批量并发、FTP 连接数限制与预计剩余时间说明。结束汇总、按钮状态与 `done/error/cancelled` 逻辑不变。

### D10：测试可观测性

- `tests/helpers/ftp-server.cjs`：统计当前控制连接数、最大连接数、当前在途 STOR/APPE/RETR 数与最大并发数；提供重置与读取接口，并支持模拟拒绝额外连接（如对第 2 条起的连接返回 `421`）。
- SSH/SFTP 测试服务器：统计同时打开的读写句柄数（作为 SFTP 并发度代理），提供最大值读取。
- 集成测试新增：
  1. SFTP 多文件上传/下载在 io 延迟下最大并发 > 1 且 ≤ 4；
  2. FTP 多文件上传/下载最大并发 ≤ 3，连接数随传输开始增加、结束后归零；
  3. 并行下暂停/继续，所有文件字节精确、续传无重复或空洞；
  4. 并行下停止，所有 `.part` 与远程不完整文件被清理，已完成文件保留；
  5. 多个文件并发冲突时 `hostPrompts` 只增加 1；
  6. FTP 拒绝额外连接时降级为串行且传输成功。
- 现有串行用例保留，验证单文件路径未回归；`npm test`、`npm run test:ui`、`npx tsc --noEmit` 必须全绿。

## Risks / Trade-offs

- [FTP 服务器限制连接数或单 IP 并发] → 建池失败即降级，最少回退串行；降级过程不改变本次传输的完成性。
- [SFTP 单连接并发过高触发服务端句柄限制] → 固定为 4，必要时可再下调；失败按首个错误终止整批并提示。
- [并发下"当前文件"不再唯一] → 面板以最近活动文件为主、附加并行文件数；整体统计与文件计数保持准确，避免误导为单文件进度。
- [某在途文件失败会中止其它已开始的传输] → 与既有"失败即终止"语义一致；被中止文件按停止路径清理，已完成文件保留。
- [FTP 连接池增加服务器端会话数] → 最多 3 条额外连接、传输结束立即关闭；凭据只在会话内存中短暂保留。
- [并发完成顺序与计划顺序不同] → 文件计数、字节与冲突策略不依赖顺序；冲突弹窗共享结果，跳过与停止仍作用于整批。
- [小文件收益明显、大文件收益有限] → 并发目标是降低往返延迟，不承诺提升单连接带宽。

## Migration Plan

无数据迁移。单文件上传/下载、保存对话框、目录递归与路径校验保持不变；新增并发与连接池为内部执行模型调整。回退时删除连接池与工作池，恢复串行循环即可，控制器新增字段不会影响既有 IPC 使用方。

## Open Questions

（无。）
