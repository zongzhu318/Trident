# Design

## Context

现状与本设计相关的既有约束：

- 渲染进程启用 `contextIsolation`、`sandbox`，不能直接访问文件系统；Electron 32+ 已移除 `File.path`，拖入项的本地路径只能由 preload 的 `webUtils.getPathForFile` 提供。
- 文件操作统一经 `withFiles` 串行执行（`session.transferring` 互斥），上传、下载、重命名、删除共享同一把锁。
- 上传目标目录来自 `sftp:list` 的 `realpath` 结果；远程路径必须经 `validate.remotePath` 规范化，远程文件名必须经 `validate.fileName` 校验。
- 上传现状：SFTP 使用 `flags:"wx"` 独占创建；FTP 上传前用目录列表检查同名文件（检查与写入非原子）。文件夹递归与拖拽上传已实现，但只上报当前文件进度。
- 下载现状：仅支持单个文件；`sftp:download` 通过保存对话框选择目标，写入同目录 `.part` 临时文件，完成后重命名；SFTP 用 `fastGet`，FTP 用 `downloadTo`。界面对目录禁用下载。
- Node 内置 `AbortController` 与 `stream/promises.pipeline(..., { signal })` 可用；basic-ftp 的 `downloadTo(destination, remote, startAt)` 支持 `REST` 续传，SFTP 读写流均支持 `start` 偏移。

## Goals / Non-Goals

**Goals:**

- 上传与下载共用一套计划、扫描、统计、速率、冲突、暂停/继续、停止与失败处理模型。
- 上传支持文件多选、文件夹递归与拖拽；下载支持单文件与目录递归。
- 传输前完成扫描并确定文件总数与总字节；扫描可停止且不产生副作用。
- 暂停与停止在当前文件内部生效；续传不重传已完成字节、不产生重复或空洞。
- 递归下载的远程条目名与本地落点经过严格校验，杜绝路径穿越。
- 传输面板标明方向，展示整体统计、速率、控制按钮与结束汇总。

**Non-Goals:**

- 不做并发/队列化传输、失败回滚或应用重启后的断点续传。
- 不做目录递归删除。
- 不引入多任务传输队列 UI，同一会话仍只展示一个活动传输。
- 不保留远程文件的 mtime、权限或所有者（沿用现有上传/下载语义）。

## Decisions

### D1：拖拽路径解析放在 preload，使用 `webUtils.getPathForFile`

渲染进程在 `drop` 时同时收集 `dataTransfer.files` 与 `dataTransfer.items[*].getAsFile()`（去重），逐个交给 preload 暴露的 `getPathForFile`。原因：`File.path` 已移除，这是 Electron 官方路径；双来源可覆盖不同平台/拖拽源只填充其中一个列表的情况。`webkitGetAsEntry()` 只提供虚拟相对路径，无法还原本地绝对路径，故不采用。

### D2：目录遍历与路径安全放在主进程

渲染进程不枚举目录内容：上传只传本地绝对路径，下载只传远程路径。主进程负责：

- 上传：`fs.lstat` / `fs.readdir` 递归展开本地来源；
- 下载：通过 `files.list` 递归列出远程目录。

原因：渲染进程保持 sandbox 最小权限面；目录遍历、远程建目录/建本地目录、逐文件传输与进度事件在同一处编排，错误信息统一；本地来源经 `validate.localPaths` 校验，远程条目名经 `validate.fileName` 校验，边界清晰。

### D3：先构建完整计划，再执行

两个方向都先产出有序计划（目录在前、文件在后，名称使用相对路径），再开始任何写入：

- 上传：递归本地来源，记录每个普通文件的 `lstat.size`，目录条目保留以创建空目录；顶层来源用 `lstat` 拒绝符号链接，目录内符号链接跳过；总量上限 20000 条，跨全部来源累计。
- 下载：递归列出远程目录，记录文件大小与目录条目；跳过符号链接；每个名称逐段经 `fileName` 校验；总量上限 20000 条。

原因：文件总数与总字节必须在传输前确定；空目录也能创建；非法名称、路径过长、超出上限等问题在写入任何内容前暴露。下载计划阶段不创建本地目录，扫描被取消或失败时不会留下空目录。

### D4：目录可合并，文件不覆盖

新增并复用 `files.exists` 与 `files.ensureDirectory`：

- SFTP：`exists` 用 `lstat` 区分「不存在」；`ensureDirectory` 用 `stat` 判断已存在目录（含指向目录的符号链接）则复用，同名文件则报错，不存在才 `mkdir`。
- FTP：用目录列表实现同样的判定，不存在才发送 `MKD`。
- 下载：本地目录用 `fs.lstat` 判断；已存在目录复用，同名文件冲突；本地文件写入前检查是否已存在。

文件冲突不由系统静默覆盖，统一走 D13 的批量冲突策略。这样冲突不会产生半截文件，同时已存在目录可继续合并。

### D5：IPC 与 API 形态

- `sftp:upload(id, directory, mode)`：`mode` 为 `"files"`（默认）或 `"folder"`；旧的两参数调用行为不变。
- `sftp:upload-paths(id, directory, sources)`：供拖拽使用，`sources` 经 `validate.localPaths` 校验。
- `sftp:download(id, remote)`：主进程 `lstat` 判断类型；文件走保存对话框，目录走父目录选择并递归下载。渲染进程不再需要区分类型。
- `transfer:pause` / `transfer:resume` / `transfer:cancel(id)`：按会话控制当前传输，绕过 `withFiles`。
- 上述传输通道仍由 `withFiles` 串行化；控制通道只读取会话上的控制器，不获取文件锁。
- preload 暴露 `uploadPaths`、`getPathForFile`、`pauseTransfer`、`resumeTransfer`、`cancelTransfer`；`types.ts` 同步。

### D6：拖拽交互用事件深度计数控制遮罩

在文件面板 `<aside>` 上监听 `dragenter` / `dragover` / `dragleave` / `drop`，仅处理 `dataTransfer.types` 含 `"Files"` 的拖拽；用 ref 计数配平子元素进出，避免遮罩闪烁。`drop` 与 `dragover` 一律 `preventDefault` 以阻止窗口导航；`canDrop = enabled && !busy && directory` 决定 `dropEffect` 与是否真正上传，未就绪或忙碌时显示 `none` 并忽略落点。

### D7：每会话统一传输控制器

每次上传或下载在 `withFiles` 内注册一个传输控制器（结束时清除），同一会话由文件锁保证最多一个：

```text
{
  direction: "upload" | "download",
  state: "preparing" | "running" | "paused" | "done" | "error" | "cancelled",
  paused, cancelled,
  abort,                      // 当前文件的 AbortController
  wake,                       // 暂停等待器
  plan,                       // 已扫描的条目
  stats                       // 见 D9
}
```

`transfer` 事件沿用现有 100 ms 节流（≤10 Hz），payload 扩展为：

```text
{ name, direction, state,
  transferred, total,                    // 当前文件
  files: { completed, total, skipped },
  dirs: { completed, total },
  bytes: { transferred, total },
  speed,                                 // B/s
  discovered,                            // 扫描阶段已发现条目数
  elapsed }                              // 结束状态的耗时（秒）
```

`preparing` 阶段 `files.total` 与 `bytes.total` 尚未确定，渲染进程以 `discovered` 展示「正在扫描」；扫描完成后总数固定。

### D8：扫描阶段可停止且不产生副作用

- 上传在本地遍历期间每处理一批条目发送一次 `preparing`（含 `discovered`），并在条目之间检查 `cancelled`。
- 下载逐目录调用 `files.list`，每个目录返回后检查 `cancelled`；远程目录遍历可能较慢，但受 20000 条上限约束。
- 扫描被停止或失败时：不创建远程目录、不创建本地目录、不创建临时文件，直接以 `cancelled` / `error` 结束。
- 扫描期间点击暂停时，`paused` 标志保留，扫描完成后在开始第一个文件前进入暂停；扫描本身是本地/远程枚举，不产生数据传输。
- 扫描完成后才进入 `running`，此时计划与统计固定。

### D9：整体统计、速率与结束汇总

统计字段在扫描完成后初始化：

- `files.total`：普通文件数（目录不计）；`dirs.total`：目录条目数；`bytes.total`：全部普通文件字节数；
- `files.completed`：已完成文件数；`files.skipped`：冲突跳过的文件数；`bytes.transferred`：已完成字节 + 跳过条目的源大小 + 当前文件已传输字节；
- 跳过条目按「已处理」计入整体进度，保证最终达到 100%，同时在面板单独显示跳过数；
- `speed` 用最近约 3 秒的 `(时间, bytes.transferred)` 采样滑动窗口计算，暂停/继续时重置窗口；百分比钳制在 100%；
- `bytes.total === 0` 时百分比退化为 `files.completed / files.total`（文件也为 0 时显示条目创建进度或直接完成），不出现 NaN；
- `elapsed` 为传输开始到结束的墙钟时间，包含暂停时间；结束状态的汇总由渲染进程用这些字段拼装，不新增单独通道。

### D10：上传暂停/继续按远端实际大小续写

`files.upload(local, remote, report, { signal, start })`：

- `start === 0`：沿用 `flags:"wx"` 独占创建；
- `start > 0`：`createReadStream(local, { start })` + `createWriteStream(remote, { flags:"r+", start })`；
- 暂停时通过 `pipeline(..., { signal })` 中止，写流关闭后远端保留已落盘部分；
- FTP：`start === 0` 用 `uploadFrom`（`STOR`），`start > 0` 用 `appendFrom`（`APPE`）；暂停时正常结束受控读流而不是销毁，让当前 `STOR`/`APPE` 以完整收尾结束，控制连接保持可用，随后按远端大小重试；
- 继续时先 `lstat`/`SIZE` 远端大小作为偏移（不使用最后一次进度值，避免空洞或重复），若已达到本地大小则视为完成；
- 上传循环捕获中止错误后区分 `paused` 与 `cancelled`，暂停则等待继续/停止唤醒，继续后从远端大小重试同一文件。

### D11：下载暂停/继续基于临时文件与远端偏移

每个下载文件写入同目录的 `<目标名>.<uuid>.part`，完成后再重命名为目标名，避免半截文件伪装成完整文件。

`files.download(remote, temp, report, { signal, start })`：

- SFTP：`sftp.createReadStream(remote, { start })` → 计量 `Transform` → `createWriteStream(temp, { flags:"a" })`，`pipeline` 传入 `signal`；暂停后临时文件保留，继续时以临时文件大小作为 `start`。
- FTP：自行管理数据连接（`prepareTransfer` + `ftp.handle("RETR …")`），`start > 0` 时先 `REST start` 再读取；暂停时先无错误地销毁本端数据连接与写入流，再等待服务端关闭连接的响应，避免 basic-ftp 把数据流错误升级为关闭整条控制连接；继续时以临时文件大小作为 `start`，控制连接仍可复用。
- 完成：`fs.rename(temp, target)`；失败/停止：尽力 `fs.unlink(temp)`。
- 若续传起点已达到远端大小，直接视为完成；若 `REST` 或远端读取偏移不被服务器接受，报错终止，不静默从头重写。

### D12：停止清理只针对本次任务未完成的条目

- 上传：中止当前文件后尽力删除当前远程文件（SFTP `unlink` / FTP `remove`）；该文件由本次任务独占创建，不会误删既有文件。
- 下载：中止当前文件后尽力删除当前 `.part` 临时文件；不会留下看似完整的半截目标文件。
- 已完成文件、已创建目录保留；停止不执行递归删除。
- 无论完成、失败还是停止，`withFiles` 的 `finally` 都释放 `transferring` 锁；控制器的 `finally` 清除会话引用。
- 停止时若有暂停等待器，先唤醒再结束，避免悬挂 Promise。

### D13：批量冲突首次询问，策略作用于整批

- 上传每个文件前用 `files.exists` 检查远程同名；下载每个文件前用 `fs.lstat` 检查本地同名。
- 首次冲突时通过 `dialog.showMessageBox(window, ...)` 询问一次：
  - 「跳过所有同名文件并继续」：本次传输后续冲突全部跳过，计入 `files.skipped`，并按源大小计入已处理字节；
  - 「停止传输」：按停止流程结束。
- 选择结果保存在控制器内，后续不再询问。原因：逐文件询问在大量文件时不可用；上传前对全部条目做远程预检需要 N 次往返，代价过高。
- 目录冲突始终按合并处理；目录与文件类型不一致时按冲突策略处理。
- 单文件下载沿用保存对话框，用户在系统对话框中确认替换即视为显式覆盖，不再弹二次询问。

### D14：下载计划与本地路径安全

- 主进程 `lstat` 判断远程类型：符号链接直接拒绝；文件走现有保存对话框；目录走 `openDirectory` 父目录选择。
- 目录下载的目标根目录为 `path.join(父目录, validate.fileName(远程目录名))`；根目录位置若已存在同名文件（而非目录），直接报错，不做覆盖或跳过。
- 递归列出的每个名称经 `validate.fileName` 校验（拒绝 `/`、`\`、`.`、`..`、NUL、换行）；拼接后用 `path.resolve` 计算本地路径，并校验 `local === root || local.startsWith(root + path.sep)`，否则中止。
- 计划中目录条目在前；扫描完成后按计划依次创建本地目录（已存在目录复用）、下载文件（临时文件 + 重命名）。
- 符号链接跳过；单次条目总数上限 20000；本地写入错误（磁盘满、权限不足、Windows 非法文件名）按失败处理并清理当前临时文件。

### D15：控制通道与传输面板状态

- `transfer:pause` / `transfer:resume` / `transfer:cancel` 直接查找会话上的控制器，绕过 `withFiles`；无控制器或状态不匹配时无副作用；重复调用幂等。
- 控制对上传和下载同样生效，方向由 `transfer` 事件携带。
- 渲染进程的 `Transfer` 类型扩展 `files`、`dirs`、`bytes`、`speed`、`discovered`、`elapsed`，状态新增 `preparing`、`paused`、`cancelled`。
- 传输面板：
  - `preparing`：显示「正在扫描… 已发现 N 项」与不确定进度条；
  - `running` / `paused`：显示方向、当前文件名、当前文件进度、`已完成 x/y（跳过 s）`、整体百分比、字节、速率；运行中显示「暂停」「停止」，暂停中显示「继续」「停止」；
  - `done` / `error` / `cancelled`：显示汇总（完成/跳过/失败数量、总字节、耗时；停止时附剩余数量），隐藏控制按钮。
- 按钮状态完全由事件驱动；控制请求失败不改变界面状态，由下一条事件或错误提示校正。
- 下载按钮对文件和目录都启用（符号链接除外）；面板仍只展示一个活动传输。

## Risks / Trade-offs

- [大量小文件时逐文件串行 + 冲突检查/建目录往返，速度偏慢] → 单次上限 20000 条，并用整体统计与实时速率让等待可预期；并发/队列化列为非目标。
- [FTP 中止传输若直接销毁源/目标流，basic-ftp 会把数据流错误升级为关闭整条控制连接] → 上传在暂停时正常结束数据流，下载自行管理数据连接并在中止后等待控制响应；控制连接保持可复用，集成测试覆盖暂停/继续与停止。该路径依赖真实 FTP 服务器行为，仍需人工验证。
- [SFTP `r+` 随机写与 `start` 读取依赖服务器实现] → 主流服务器支持；不支持时向用户报错并保持已完成文件不变。
- [FTP `REST` 续传并非所有服务器都支持] → 失败时报错终止，保留临时文件供用户重试；不静默从头下载覆盖已完成部分。
- [冲突跳过只按文件名判断，可能跳过内容不同的同名文件] → 由用户在首次冲突时显式选择，跳过数在汇总中可见；后续可独立演进为按大小/哈希比较。
- [暂停期间保持文件操作锁，用户无法改名/删除] → 避免批量计划失效；面板明确显示暂停状态并提供停止入口，停止即释放锁。
- [下载时 Windows 保留名/非法字符可能导致单文件失败] → 按失败中止并清理临时文件；名称净化不在本次范围。
- [扫描阶段对超大目录较慢] → 20000 条上限、扫描状态可见且可停止。
- [进度 100 ms 节流与 3 秒窗口导致速率起停瞬间不精确] → 速率用于直观判断，不作为计量依据；暂停/继续重置采样窗口。
- [停止清理失败（权限、网络中断）] → 尽力删除并提示残留风险；已完成文件与目录始终保留，锁始终释放。

## Migration Plan

无数据迁移。单文件上传/下载的既有调用与保存对话框语义保持不变；`sftp:download` 由主进程判断远程类型，旧渲染进程调用仍然可用；新增的文件夹下载与传输控制为增量能力。回退即移除新增入口、控制通道与控制器逻辑。

## Open Questions

（无。）
