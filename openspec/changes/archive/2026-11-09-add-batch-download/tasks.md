# Tasks

## 1. 后端批量下载入口

- [x] 1.1 泛化 `collectDownloadEntries` 为接受多个顶层来源：每个来源以 `basename` 作为相对路径起点，目录继续递归；目标根目录使用所选文件夹，所有条目继续通过 `validate.fileName` 与 `resolveLocalPath` 校验，合计条目数超过 20000 时在扫描阶段中止；运行既有单目录下载、空目录、合并目录与路径穿越用例，确认行为不回退
- [x] 1.2 新增 `sftp:download-paths` IPC（`electron/main.cjs`、`electron/preload.cjs`、`src/types.ts`）：校验非空数组、去重、同一远程父目录、非根目录、非符号链接、条目存在且不超过 20000；顺序读取顶层 `details`，弹出一次目标文件夹对话框，使用 `transferTitle(names)` 创建单个下载任务并复用 `downloadPlan`；运行 `npx tsc --noEmit` 确认类型通过
- [x] 1.3 在 `tests/ssh.integration.test.cjs` 增加批量下载用例：多个文件、文件与目录混合、空目录、目标文件夹已存在的合并；断言只弹出一次目录对话框、任务标题为「首项名称 等 N 项」、本地结构与内容正确，运行 `npm test` 通过
- [x] 1.4 增加批量下载的同名冲突与安全用例：本地已存在同名文件时选择跳过或停止、顶层名称路径穿越或超过 20000 条时在写入前中止；断言跳过数、失败提示与目标目录之外无文件，运行 `npm test` 通过
- [x] 1.5 增加批量下载任务控制用例：暂停后继续、停止后清理未完成临时文件，且不影响同会话其他传输任务；断言按 `taskId` 作用的控制结果与最终文件状态，运行 `npm test` 通过

## 2. 文件面板多选交互

- [x] 2.1 将 `FileBrowser` 的单选 `selected` 改为 `selected: Set<string>` 与区间锚点：切换目录或刷新时清空，切换「隐藏文件」时移除不可见名称；运行 `npx tsc --noEmit` 确认选择状态相关类型通过
- [x] 2.2 把文件行由 `<button>` 改为可聚焦的 `role="option"` 容器并加入真实复选框：行点击、复选框点击、`Space` 与 `Enter` 键盘行为符合设计，不可用状态使用 `aria-disabled`；补充 `.file-row` 选中与复选框样式，运行 `npm run build` 确认构建通过
- [x] 2.3 实现修饰键与全选语义：普通单击单选、`Cmd/Ctrl + 单击` 或复选框切换、`Shift + 单击` 按 `visibleFiles` 选择区间、全选/取消全选作用于全部可见可下载条目，符号链接不可选；在 `scripts/smoke.cjs` 中断言这些选择结果
- [x] 2.4 下载入口按选择数量分流：0 个禁用、1 个调用既有 `api.download`、2 个及以上调用 `api.downloadPaths`；重命名与删除仅在恰好 1 个选中项时可用；在 `scripts/smoke.cjs` 中断言单选、多选与禁用状态，运行 `npm run test:ui` 通过
- [x] 2.5 更新 `scripts/smoke.cjs` 中既有 `.file-row` 断言从 `aria-pressed` 改为 `aria-selected`，新增多选后一次选择目标文件夹并完成批量下载的界面用例；断言任务只创建一个、目标文件夹中文件齐全，运行 `npm run test:ui` 通过
- [x] 2.6 更新 `README.md` 与 `src/App.tsx` 帮助文本，说明复选框、`Cmd/Ctrl`、`Shift`、全选、单条目重命名/删除限制与批量下载目标文件夹规则；人工核对文档描述与界面行为一致
- [x] 2.7 复选框改为悬浮、键盘聚焦或已选中时显示并替代文件类型图标，不占用行内空间；为复选框提升层叠层级，避免淡出图标拦截真实鼠标点击导致多选被覆盖；在 `scripts/smoke.cjs` 中用 `elementFromPoint` 增加命中测试，运行 `npm run test:ui` 通过

## 3. 集成验证

- [x] 3.1 运行 `npx tsc --noEmit`、`npm test`、`npm run test:ui`，确认全部通过且单选下载、双击下载、上传与传输控制无回归
- [x] 3.2 在真实桌面手动验证：多选文件/目录混合下载、一次目标文件夹选择、同名冲突跳过与停止、批量任务暂停/继续/停止、单选保存对话框与目录选择行为保持不变

## Workflow follow-up

- 评审通过后归档本变更，并确认 `remote-file-transfer` 主 spec 正确合并多选与批量下载相关需求。
