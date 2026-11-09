# Tasks

## 1. 传输控制器聚合状态

- [x] 1.1 在 `createTransfer` 中新增 `active`、`aborts`、`completedBytes`、`error`、`stopping`、`conflictAsk` 字段，实现 `syncBytes(c)` 计算 `completedBytes + Σactive`，并用它替换所有 `baseBytes + current.transferred` 赋值；运行 `npm test` 确认既有单文件进度用例仍通过
- [x] 1.2 将 `runUploadFile` / `runDownloadFile` 中的单个 `c.abort` 改为向 `c.aborts` 注册并在 `finally` 移除；文件开始/完成/跳过时同步更新 `active` 与 `completedBytes`；运行暂停、继续、停止的既有集成用例确认行为不回退
- [x] 1.3 让 `pauseTransfer`、`resumeTransfer`、`cancelTransfer` 与 `disconnect` 遍历中止全部 `c.aborts`，并保证重复调用幂等；运行 FTP 与 SFTP 的暂停/停止集成用例验证控制通道仍可用

## 2. 两阶段执行与 SFTP 并发

- [x] 2.1 把 `uploadSources` 与 `downloadPlan` 拆成目录阶段和文件阶段：目录阶段按父目录先于子目录的层级并发创建并沿用 `checkCancelled` / `waitForResume`，文件阶段只收集非目录条目；运行现有文件夹上传、目录下载与空目录用例确认统计不变
- [x] 2.1.1 上传目录创建改为先 `mkdir`、失败后再 `stat` 确认可合并，新建目录只产生一次协议往返；界面在建目录阶段展示目录进度，避免进度条长时间停在 0%
- [x] 2.2 实现内部工作池（按 lane 并发消费文件队列，`SFTP_CONCURRENCY = 4`，实际并发取 `min(4, 文件数)`），并让单文件路径不创建额外并发；运行单文件上传/下载用例确认行为与改造前一致
- [x] 2.2.1 小文件（平均不超过 1 MiB）批次把 SFTP 并发提高到 16，大文件保持 4；更新并发用例断言并确认上传下载内容一致
- [x] 2.3 让工作池捕获首个文件错误：记录 `c.error`、置 `c.stopping`、中止其余在途文件；`Promise.allSettled` 后优先抛出首个错误，其余在途文件按停止路径清理；新增一个批量中途失败的集成用例验证后续文件不再开始且错误文案保持一致
- [x] 2.4 在 SSH/SFTP 测试服务器上统计同时打开的文件句柄数并暴露最大值；新增 SFTP 多文件上传与下载用例（带 io 延迟），断言最大并发大于 1 且不超过 4，目录结构与文件内容正确
- [x] 2.5 新增 SFTP 并行暂停/继续与停止用例：暂停后所有在途文件各自保留偏移，继续后字节精确一致；停止后所有 `.part` 与远程不完整文件被清理，已完成文件保留
- [x] 2.6 去掉 SFTP 上传的逐文件 `exists` 预检：独占创建在打开阶段失败且未写入时再确认同名冲突，跳过与停止语义不变；FTP 保留上传前检查
- [x] 2.7 SSH/SFTP 会话把整棵目录树合并为一次（超长时分块）`mkdir -p` 远程命令，失败或校验不通过时回退逐目录创建；测试服务器支持 exec 并断言目录树由一次命令创建

## 3. FTP 连接池与降级

- [x] 3.1 在 `connectFTP` 中把 `access` 参数保存到 `session.ftpAccess`（仅内存），新增 `session.ftpPool`；在 `disconnect` 中关闭池内全部连接；运行连接关闭与断线用例确认无泄漏与回归
- [x] 3.2 实现 FTP 文件阶段的连接池：按需建立最多 `FTP_CONCURRENCY = 3` 条额外连接并包装为 `ftpFiles`，每条连接一个 lane；传输结束（完成、失败、停止）在 `finally` 中全部关闭；运行现有 FTP 传输用例确认主连接仍可用
- [x] 3.3 实现建池失败降级：任一条额外连接失败即停止扩容，使用已建立的连接数；一条都没建成时回退主连接串行；新增用例模拟服务器拒绝额外连接，断言传输全部成功且不报错
- [x] 3.4 在 `tests/helpers/ftp-server.cjs` 中统计当前/最大控制连接数与在途 STOR/APPE/RETR 数；新增 FTP 多文件上传与下载用例，断言最大并发不超过 3、连接数在传输结束后归零
- [x] 3.5 新增 FTP 并行暂停/继续与停止用例，验证各连接独立续传（APPE/REST）、暂停期间连接保持、停止后清理所有未完成内容

## 4. 冲突弹窗、界面与文档

- [x] 4.1 将冲突询问改为共享 `c.conflictAsk` Promise：只弹一次、所有等待者复用结果，选择停止时置 `c.cancelled`；新增两个文件并发冲突的用例，断言 `hostPrompts` 只增加 1 且跳过数正确
- [x] 4.2 在 `transferPayload` 增加 `active`，同步 `src/types.ts` 的 `Transfer` 类型，并在 `src/FileBrowser.tsx` 与 `src/styles.css` 中显示「并行 N 个文件」；运行 `npx tsc --noEmit` 与 `npm run test:ui` 确认类型与界面正常
- [x] 4.3 更新 `README.md` 与 `src/App.tsx` 帮助文本，说明批量文件并发、FTP 额外连接与连接数受限时的自动降级；人工核对文档描述与实现一致
- [x] 4.4 在 `transferPayload` 基于剩余字节与 3 秒滑动窗口速率新增 `eta`，暂停/结束/速率未知时为 `null`；`src/types.ts` 同步类型，`src/FileBrowser.tsx` 显示「剩余约 x」，集成用例断言运行中 `eta` 符合公式且暂停后为 `null`

## 5. 集成验证

- [x] 5.1 运行 `npx tsc --noEmit`、`npm test`、`npm run test:ui`，确认全部通过且无并发相关回归
- [x] 5.2 在真实桌面手动验证：多文件批量上传/下载、并行中暂停/继续/停止、FTP 服务器限制连接数时的降级，以及单文件传输与冲突弹窗行为

## Workflow follow-up

- 评审通过后归档本变更，并确认 `remote-file-transfer` 主 spec 正确合并并发相关需求。
