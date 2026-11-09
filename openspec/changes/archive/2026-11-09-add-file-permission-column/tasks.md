# Tasks

## 1. 后端权限规范化

- [x] 1.1 在 `electron/files.cjs` 增加 `modeToSymbolic` 与 `symbolicOrEmpty`：SFTP 取 `mode & 0o777`、八进制补足三位后映射为 9 位 `rwx`，FTP 仅接受 `/^[rwx-]{9}$/`，无法获取或格式异常返回空串；两条 `list` 路径改为返回规范化后的 `permissions`，运行 `npm test` 确认现有列表与传输用例不回退
- [x] 1.2 在 `tests/ssh.integration.test.cjs` 增加权限断言：SFTP 对 `chmod 600/644/755` 的文件与目录断言 `rw-------`、`rw-r--r--`、`rwxr-xr-x` 的 9 位结果，FTP 断言返回 9 位符号串或空串且不再出现 `—`，运行 `npm test` 通过

## 2. 文件面板权限列

- [x] 2.1 在 `src/FileBrowser.tsx` 增加 `permissionText(file)`：空权限返回 `—`，否则按 `symlink → l`、`directory → d`、普通文件 `-` 拼接 9 位权限；`title` 复用同一文本，运行 `npx tsc --noEmit` 确认类型通过
- [x] 2.2 表头增加「权限」列，行内在名称与大小之间增加 `.file-permissions` 单元格；为名称与大小单元格补充 `.file-name`、`.file-size` 语义类名，运行 `npm run build` 确认构建通过
- [x] 2.3 在 `src/styles.css` 将 `.file-table-heading` 与 `.file-row` 改为共享网格 `minmax(0, 1fr) 72px 56px`（列间距 10px），权限列等宽右对齐、大小列右对齐、名称列省略；保持选中态、hover、40px 行高与虚拟定位不变，运行 `npm run build` 确认样式构建通过
- [x] 2.4 在 `scripts/smoke.cjs` 断言表头包含「权限」、目录行权限单元格以 `d` 开头、文件行以 `-` 开头，并保持现有选择与下载流程通过，运行 `npm run test:ui` 通过
- [x] 2.5 更新 `README.md` 与 `src/App.tsx` 帮助文本，说明文件面板展示 rwx 权限且不可修改；人工核对文档描述与界面一致

## 3. 集成验证

- [x] 3.1 运行 `npx tsc --noEmit`、`npm test`、`npm run test:ui`，确认全部通过且选择、双击、刷新、隐藏文件、虚拟列表与传输面板无回归
- [x] 3.2 在真实桌面分别连接 SFTP 与 FTP 手动验证：普通文件、目录、符号链接的权限前缀与 9 位内容正确，未知权限显示 `—`，面板缩到最小宽度时权限列不被截断、名称列省略

## Workflow follow-up

- 评审通过后归档本变更，并确认 `remote-file-browser` 主 spec 正确包含权限列相关需求。
- 若 `add-batch-download` 先合并，归档本变更前确认多选行结构保留了 `.file-permissions` 单元格与同一网格模板。
