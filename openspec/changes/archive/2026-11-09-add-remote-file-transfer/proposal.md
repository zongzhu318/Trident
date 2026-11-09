# Proposal

## Why

文件面板目前的上传与下载都没有形成闭环：

- **上传**：只能通过系统文件对话框多选文件（[electron/main.cjs:705-720](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs)），无法上传文件夹，也不支持拖入窗口；带目录结构的项目需要先在远程逐层建目录再逐个上传。
- **下载**：只支持单个文件（[electron/main.cjs:731-761](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs)），目录在界面上不可下载；下载一个目录需要手动逐层创建本地目录再逐个下载。
- **传输面板**：只显示当前文件的百分比，没有整体文件数、已完成数、整体字节与速率，也没有暂停或停止入口。用户无法判断整体进度，也无法中止，只能等待完成或断开连接。

文件夹与拖拽上传、目录递归下载会进一步放大传输规模，因此需要同时把两个方向的扫描、统计、冲突、暂停/继续、停止与结束汇总补齐。

## What Changes

- **上传入口**：新增「上传文件夹」按钮与文件面板拖放区；文件夹递归上传保留目录结构与空目录，跳过目录内符号链接、拒绝顶层符号链接，远程目录可合并、同名文件不覆盖，单次上限 20000 条。
- **下载入口**：普通文件与目录都可下载；单文件沿用保存对话框并写入临时文件后原子重命名；目录通过父目录选择对话框递归下载，保留结构、空目录，跳过符号链接，远程目录可合并、本地同名文件不覆盖，单次上限 20000 条。
- **传输前扫描**：上传遍历本地来源、下载递归列出远程目录，先构建完整计划并确定文件总数与总字节；扫描期间显示已发现条目数，可停止，停止后不产生任何传输或目录/临时文件。
- **统一统计与速率**：两个方向共用传输面板，展示文件总数/已完成数/跳过数、整体字节与百分比、当前文件进度、实时速率（滑动窗口）与耗时；结束后展示完成/跳过/失败数量与总字节，停止时显示剩余数量；处理 0 字节、纯目录与进度钳制。
- **冲突策略**：批量传输首次遇到同名文件时询问一次「跳过所有同名文件并继续」或「停止传输」，跳过数进入统计；目录可合并；单文件下载的覆盖由保存对话框显式确认。
- **暂停/继续（双方向）**：暂停在当前文件内部生效；上传从远程已写入偏移续写（SFTP `r+` / FTP `APPE`），下载从本地临时文件偏移续读（SFTP 读流 `start` / FTP `REST`），不重传已完成字节、不产生重复或空洞；暂停期间保持连接与进度。
- **停止（双方向）**：中止当前文件与后续计划；上传尽力删除当前未完成的远程文件，下载尽力删除当前临时文件；保留已完成文件与已创建目录，释放文件操作锁，会话保持可用。
- **控制通道**：新增 `transfer:pause` / `transfer:resume` / `transfer:cancel`（按会话幂等，绕过文件操作锁但只作用于当前传输）；`session:event` 的 `transfer` 载荷扩展方向、状态、`files`、`bytes`、`dirs`、`speed`、`discovered`、`elapsed`，状态新增 `preparing` / `paused` / `cancelled`。
- **本地路径安全**：递归下载时每个远程条目名按单一文件名校验，解析后的本地路径必须位于目标根目录内，拒绝路径穿越，避免恶意服务器在目标目录之外写文件。
- **界面**：下载按钮对目录可用；传输面板标明上传/下载方向，展示扫描状态、整体统计、速率、暂停/继续/停止按钮与结束汇总；按钮状态完全由主进程事件驱动。
- **文档与测试**：同步 README、应用内帮助；补充 SFTP / FTP 的递归下载、冲突策略、暂停续传、停止清理、路径穿越与统计字段测试，以及 UI 冒烟。

## Capabilities

### New Capabilities

- `remote-file-transfer`: 远程文件面板的上传与下载行为——文件多选、文件夹递归、拖拽上传、单文件与目录递归下载、传输前扫描、目录结构与空目录保留、同名冲突策略、批量整体统计与速率、暂停/继续/停止、结束汇总、路径安全与失败呈现。

### Modified Capabilities

（无——项目尚无既有 spec。）

## Impact

- **应用代码**：[electron/main.cjs](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs)（上传/下载计划与扫描、统一传输控制器、统计与速率、冲突策略、暂停/继续/停止编排、控制 IPC）、[electron/files.cjs](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/files.cjs)（`exists` / `ensureDirectory`、带 `signal` 与偏移的上传/下载、递归列出）、[electron/preload.cjs](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/preload.cjs)（`uploadPaths` / `getPathForFile` / 传输控制）、[electron/validation.cjs](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/validation.cjs)（本地路径校验）。
- **界面**：[src/FileBrowser.tsx](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/FileBrowser.tsx)（上传文件夹按钮、拖放事件与遮罩、目录下载入口、传输面板统计与控制）、[src/styles.css](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/styles.css)、[src/types.ts](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/types.ts)、[src/SessionView.tsx](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/SessionView.tsx)（断线状态收敛）、[src/App.tsx](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/App.tsx)（帮助文案）。
- **测试**：[tests/ssh.integration.test.cjs](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/tests/ssh.integration.test.cjs)（SFTP/FTP 递归上传与下载、统计字段、冲突策略、暂停续传、停止清理、路径穿越）、[tests/validation.test.cjs](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/tests/validation.test.cjs)（本地路径校验）、[scripts/smoke.cjs](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/scripts/smoke.cjs)（GUI 文件夹上传与目录下载）。
- **兼容性**：无新增依赖（使用 Node 内置 `AbortController`）；`sftp:upload` 第三个参数可选，旧调用方式行为不变；单文件下载沿用保存对话框与临时文件语义；FTP / SFTP / 独立 SFTP 连接均适用。暂停/续传仅在当前应用进程内有效，不支持应用重启后的断点续传；目录递归删除仍不在本次范围。
