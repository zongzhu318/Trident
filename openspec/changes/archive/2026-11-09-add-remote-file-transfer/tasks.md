# Tasks

## 1. 校验与文件适配器

- [x] 1.1 在 `electron/validation.cjs` 新增 `localPaths`：校验非空数组、最多 256 项、每项为绝对路径且长度 ≤ 4096、不含 NUL；在 `tests/validation.test.cjs` 覆盖合法与非法输入。验证：`npm test` 中校验用例通过
- [x] 1.2 在 `electron/files.cjs` 为 SFTP 与 FTP 适配器新增 `exists` 与 `ensureDirectory`（目录可复用、同名文件报错）；在 `tests/ssh.integration.test.cjs` 的 SFTP / FTP 用例中覆盖目录合并与同名冲突。验证：集成测试通过

## 2. 主进程上传编排

- [x] 2.1 在 `electron/main.cjs` 实现 `collectUploadEntries`：递归遍历本地目录、跳过目录内符号链接并拒绝顶层符号链接、保留空目录、单次上传跨全部来源合计上限 20000 条，并把相对路径逐段经 `fileName` 校验。验证：集成测试上传含嵌套目录、空目录与符号链接的文件夹后结构一致且链接未被上传
- [x] 2.2 实现 `uploadSources`：预先构建上传计划并校验全部远程路径，逐层确保远程目录、逐文件检查同名冲突后上传并上报进度，失败中止并提示不完整文件风险。验证：SFTP / FTP 集成用例覆盖递归上传、同名文件拒绝、同名目录合并、失败提示
- [x] 2.3 扩展 IPC：`sftp:upload` 增加可选 `mode`（`files` / `folder`），新增 `sftp:upload-paths` 接收拖拽路径；均经 `withFiles` 互斥并保持两参数旧调用的文件对话框行为。验证：既有集成测试与 `scripts/smoke.cjs` 的按钮上传路径通过

## 3. 界面与交互

- [x] 3.1 在 `electron/preload.cjs` 暴露 `uploadPaths` 与 `getPathForFile`（`webUtils`），并在 `src/types.ts` 同步类型。验证：`npx tsc --noEmit` 通过
- [x] 3.2 在 `src/FileBrowser.tsx` 增加「上传文件夹」按钮；在文件面板实现拖放事件（事件深度计数、`Files` 类型过滤、`files` 与 `items` 双来源去重、阻止默认导航）与落点遮罩；在 `src/styles.css` 增加遮罩样式。验证：`scripts/smoke.cjs` 点击「上传文件夹（含子目录）」后远程出现 `ui-folder/nested/n.txt`
- [x] 3.3 更新 `README.md` 与 `src/App.tsx` 帮助文案：说明文件/文件夹上传、拖拽上传，并把「目录递归传输」限制收窄为「目录递归下载/删除」。验证：文案与实际行为一致，`npm run build` 通过

## 4. 集成验证

- [x] 4.1 运行 `npm test` 与 `npm run test:ui`，确认单元、SFTP/FTP 集成与 Electron UI 冒烟全部通过。验证：命令退出码为 0
- [x] 4.2 在真实桌面环境中拖入一个含子目录、空目录和同名文件的本地文件夹，确认遮罩、递归结构、空目录、同名拒绝与进度显示符合预期。验证：远程目录结构与本地一致，冲突文件内容未被覆盖

## 5. 统一传输计划、扫描与冲突策略

- [x] 5.1 在 `electron/main.cjs` 为上传与下载注册每会话传输控制器（方向、状态、暂停/取消标志、当前文件 `AbortController`、暂停等待器、计划与统计），状态按 `preparing → running → paused/done/error/cancelled` 流转，结束或失败时在 `finally` 清除。验证：集成测试断言状态序列且会话不残留控制器
- [x] 5.2 实现下载计划与本地路径安全：主进程 `lstat` 判断远程类型；目录通过父目录选择确定目标根目录；递归 `files.list` 构建计划，跳过符号链接，每个名称经 `fileName` 校验并用 `path.resolve` 校验位于目标根目录内，条目上限 20000；扫描完成前不创建任何本地目录。验证：路径穿越用例被拒绝且目标目录外无文件
- [x] 5.3 实现批量冲突策略：上传用 `files.exists`、下载用本地 `lstat` 检测同名文件；首次冲突弹一次「跳过所有同名文件并继续 / 停止传输」，策略作用于整批；跳过条目计入 `skipped` 并按源大小计入已处理字节；目录冲突始终合并；单文件下载由保存对话框确认覆盖。验证：集成测试覆盖跳过继续、停止与目录合并

## 6. 扫描与统计事件

- [x] 6.1 扫描阶段发送 `preparing` 事件（含 `discovered`，≤10 Hz），并在条目/目录之间检查取消标志；扫描被停止或失败时不创建远程目录、本地目录或临时文件。验证：扫描中停止后远程与本地均无新增
- [x] 6.2 扫描完成后初始化统计并扩展 `transfer` 事件 payload：方向、当前文件进度、`files {completed,total,skipped}`、`dirs {completed,total}`、`bytes {transferred,total}`、`speed`、`discovered`、`elapsed`；实现约 3 秒滑动窗口速率、暂停/继续重置、0 字节退化与 100% 钳制。验证：集成测试断言统计字段、跳过计数与暂停/继续后的连续累计
- [x] 6.3 扩展 `src/types.ts` 的 `Transfer`（新增字段与 `preparing` / `paused` / `cancelled` 状态），并把 `src/SessionView.tsx` 的断线收敛从 `running` 扩展到 `preparing` / `running` / `paused`。验证：`npx tsc --noEmit` 通过

## 7. 暂停 / 继续 / 停止

- [x] 7.1 改造 SFTP 上传与下载支持 `signal` 与偏移：上传续传用 `createWriteStream(remote, { flags:"r+", start })`，下载续传用 `createReadStream(remote, { start })` 追加到 `.part`；远端/本地已写入大小达到目标时直接完成。验证：暂停后保留部分内容，继续后最终内容一致
- [x] 7.2 改造 FTP 上传与下载支持暂停/续传：上传在暂停时正常结束受控读流并在继续时用 `appendFrom`（`APPE`），下载自行管理数据连接并在继续时先发 `REST` 再 `RETR`；暂停时先销毁本端数据连接与写入流再等待控制响应，避免 basic-ftp 把中止升级为关闭整条控制连接。验证：FTP 双方向暂停→继续后内容一致
- [x] 7.3 在统一编排中实现暂停/继续/停止：暂停在当前文件内部生效并等待唤醒，继续后从远端/本地偏移重试同一文件，文件间暂停在下一个条目前停住；停止中止当前条目、尽力删除上传未完成的远程文件或下载 `.part` 临时文件、保留已完成项与目录、唤醒挂起的等待器并正常结束。暂停期间保持文件锁，停止后由 `withFiles` 释放。验证：集成测试覆盖双方向暂停继续、文件间暂停、暂停后停止、停止清理与停止后再次传输
- [x] 7.4 新增 IPC `transfer:pause` / `transfer:resume` / `transfer:cancel` 与 preload `pauseTransfer` / `resumeTransfer` / `cancelTransfer`：按会话查找控制器、绕过 `withFiles`、幂等且无活动传输时无副作用。验证：类型检查与集成测试通过

## 8. 目录递归下载

- [x] 8.1 在 `electron/main.cjs` 实现目录下载：父目录选择、目标根目录、按计划先创建本地目录（含空目录）再逐文件下载；每个文件写入同目录 `.part` 临时文件，成功后重命名；遵守递归上限并跳过符号链接。验证：SFTP 与 FTP 集成测试断言目录结构与文件内容一致
- [x] 8.2 渲染进程下载按钮对目录启用（符号链接除外），主进程自动判断文件/目录；单文件保持保存对话框语义。验证：`scripts/smoke.cjs` 或手动冒烟完成一次目录下载

## 9. 传输面板界面

- [x] 9.1 在 `src/FileBrowser.tsx` 传输面板展示：扫描态（已发现 N 项）、方向、当前文件名与进度、`已完成 x/y（跳过 s）`、整体百分比与字节、实时速率、结束汇总；运行中显示「暂停」「停止」，暂停中显示「继续」「停止」，结束状态隐藏控制；按钮状态完全由 `transfer` 事件驱动。验证：手动冒烟与 `npm run test:ui` 通过
- [x] 9.2 在 `src/styles.css` 增加扫描不确定进度、暂停 accent、停止/失败 danger 与汇总布局样式，确保明暗主题可读且按钮不挤压文件名。验证：两种主题下目视检查
- [x] 9.3 更新 `README.md` 与 `src/App.tsx` 帮助文案：说明文件夹/拖拽上传、目录递归下载、整体进度、速率、暂停/继续/停止与冲突策略；移除「暂不支持目录递归下载」限制，保留目录递归删除限制。验证：文案与实际一致，`npm run build` 通过

## 10. 集成验证

- [x] 10.1 在 `tests/ssh.integration.test.cjs` 为 SFTP 与 FTP 增加双方向用例：目录递归上传/下载、冲突跳过与停止、暂停/继续（用大文件或受控延迟保证可稳定中途暂停）、停止清理、路径穿越拒绝、统计字段与结束状态。验证：`npm test` 通过
- [x] 10.2 运行 `npx tsc --noEmit`、`npm test`、`npm run test:ui`，并在本地用大文件与含空目录的文件夹验证上传/下载的扫描、整体进度、速率、暂停/继续、停止与会话恢复。验证：命令全部通过，交互符合预期

## Workflow follow-up

- 评审通过后归档本变更，把 `remote-file-transfer` 规格同步到主 specs。
