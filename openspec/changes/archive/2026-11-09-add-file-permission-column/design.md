# Design

## Context

动机见 `proposal.md`，行为契约见 `specs/remote-file-browser/spec.md`。现状约束：

- 后端目录列表已经返回权限：SFTP 在 [files.cjs:47](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/files.cjs#L47) 返回 `(mode & 0o777).toString(8)`，FTP 在 [files.cjs:183-185](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/files.cjs#L183-L185) 返回 `user + group + world` 拼接串或 `—`。两种协议格式不同，且 SFTP 结果可能不足三位（如 `0o075` → `75`）。
- 前端只在行 `title` 中显示权限（[FileBrowser.tsx:658](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/FileBrowser.tsx#L658)），列表表头只有名称与大小（[FileBrowser.tsx:632-635](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/FileBrowser.tsx#L632-L635)），行内只有名称与大小两个单元格（[FileBrowser.tsx:659-679](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/FileBrowser.tsx#L659-L679)）。
- 表头与行目前用 `display: flex; justify-content: space-between`（[styles.css:1374-1413](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/styles.css#L1374-L1413)），尺寸样式通过 `:nth-child(2)` 命中大小列；文件面板宽度可在 260–560px 之间调整（[FileBrowser.tsx:406-435](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/FileBrowser.tsx#L406-L435)）。
- 列表超过阈值时只渲染可视窗口，行高固定 40px（[styles.css:1733-1745](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/styles.css#L1733-L1745)）。
- 未提交的 `add-batch-download` 变更会把这行改成多选 `role="option"` 结构并加入复选框列，本设计需与其保持单元格级兼容。

## Goals / Non-Goals

**Goals:**

- 以一次目录列表请求的数据补齐权限列，不产生逐条目远程往返。
- 让 `RemoteFile.permissions` 对两种协议具有统一、可测试的语义。
- 在 260px 最小面板宽度下权限列完整可读，名称列省略。
- 保持现有选择、双击、刷新、虚拟列表与传输面板行为不变。

**Non-Goals:**

- 不做权限编辑、`chmod`、权限筛选或权限排序。
- 不展示特殊位（setuid / setgid / sticky）的 `s`/`t` 标记，也不展示 ACL。
- 不改列表请求协议、不新增 IPC 字段、不引入本地文件浏览器。
- 不重做文件面板视觉风格。

## Decisions

### D1：在后端把权限规范化为 9 位符号串

在 `electron/files.cjs` 增加两个小工具：

- `modeToSymbolic(mode)`：取 `mode & 0o777`，转成八进制并 `padStart(3, "0")`，再逐位映射为 `rwx`。例如 `0o644` → `rw-r--r--`、`0o75` → `---rwxr-x`、`0o755` → `rwxr-xr-x`。
- `symbolicOrEmpty(value)`：FTP 权限串必须匹配 `/^[rwx-]{9}$/`，否则返回空串。

SFTP 与 FTP 的 `list` 都返回该 9 位串；无法获取时返回空串（不再返回 `—`）。选择后端而非前端转换的原因：

- 统一 `RemoteFile.permissions` 的契约，前端、`title` 与未来消费方不需要各自判断八进制还是符号串。
- 转换逻辑可在 `tests/ssh.integration.test.cjs` 中直接对 `sftp:list` 结果断言，覆盖两种协议。
- 避免前端为每个条目解析协议相关格式，也避免 `—` 与类型前缀组合出 `d—`。

备选方案「前端 helper 按协议转换」需要把协议传入行组件或保留双格式判断，重复逻辑且易漏掉 FTP 缺失场景，因此不采用。

### D2：类型前缀由条目类型决定，未知权限显示 `—`

渲染函数 `permissionText(file)`：

- `file.permissions` 为空 → 返回 `—`，不带任何前缀。
- 否则前缀按 `symlink ? "l" : directory ? "d" : "-"` 取一个字符，拼接 9 位权限。

符号链接优先于目录：`readdir` 返回的是链接自身的 lstat 属性，符号链接不应被当作可进入目录。`title` 中的权限文本复用同一函数，保证列与提示一致。

### D3：表头与行改为同一套三列网格

把 `.file-table-heading` 与 `.file-row` 从 flex 改为共享网格：

```css
grid-template-columns: minmax(0, 1fr) 72px 56px;
column-gap: 10px;
```

- 名称列弹性收缩，保留图标 + 省略文本；权限列固定 72px、等宽字体、右对齐；大小列固定 56px、右对齐。
- 260px 面板减去左右内边距与列间距后，名称列仍有约 80px，足以显示图标与部分文件名并省略。
- 表头标题顺序改为「名称 / 权限 / 大小」，与行单元格一一对应。
- 用语义类名 `.file-name`、`.file-permissions`、`.file-size` 取代 `:nth-child` 定位，避免新增单元格后大小列样式错位；`.file-row` 的选中态、hover、虚拟定位与固定行高保持不变。

备选方案「保持 flex 并用 `margin-left:auto` 挤到右侧」在名称很长或面板极窄时无法保证权限列固定宽度，故不采用。

### D4：只在现有行内增加一个纯展示单元格

在名称与大小之间插入 `<span className="file-permissions">{permissionText(file)}</span>`。该单元格无点击处理，点击落到行本身，因此选中与双击行为与行内其他区域一致；不需要 `stopPropagation`。固定 40px 行高与虚拟滚动偏移无需调整。

若 `add-batch-download` 先落地，其行结构为复选框 + 名称 + 大小；本变更在该网格中插入权限列即可，两处都使用同一网格模板与语义类名。若本变更先落地，后续多选改造应保留 `.file-permissions` 单元格。两者不改变数据层契约，合并成本局限于行 JSX 与网格列定义。

### D5：测试与断言同步更新

- `tests/ssh.integration.test.cjs`：现有空的 `sftp:list` 断言不受影响；新增 SFTP 文件/目录 `chmod` 后的符号权限断言，以及 FTP 列表权限为 9 位符号串或空串的断言。若测试夹具中存在对 `permissions` 值的假设，需同步为新格式。
- `scripts/smoke.cjs`：断言表头包含「权限」，目录行权限单元格以 `d` 开头，文件行以 `-` 开头；现有基于 `.file-row` innerText / `aria-pressed` 的流程不变。
- 文档：README 与 `src/App.tsx` 帮助文本补充「权限列展示 rwx，不可修改」。

## Risks / Trade-offs

- [SFTP 服务器返回的 mode 可能包含特殊位或被裁剪] → 只取低 9 位并按八进制补零，特殊位明确不展示；格式异常时回退 `—`，不显示错位字符。
- [最小宽度 260px 下三列拥挤] → 名称列弹性省略，权限与大小列固定宽度；行高保持 40px，不换行。
- [FTP 服务器权限字段缺失或非标准] → 仅接受 9 位 `rwx-` 串，其他值显示 `—`，不影响列表其余字段与操作。
- [与 `add-batch-download` 的行结构改造冲突] → 统一网格模板与语义类名，按合并顺序保留权限单元格；数据契约不变，冲突仅限 JSX 与 CSS。
- [逐条目 `stat` 会拖慢大目录] → 不新增任何远程请求，权限完全复用列表结果；刷新时随列表一次性更新。

## Migration Plan

无数据模型或配置迁移。`RemoteFile.permissions` 的取值从「协议相关字符串」收紧为「9 位符号串或空串」，仅影响内部类型与展示；发布后无需用户操作。回滚只需还原后端 `list` 映射与行/表头渲染，列表请求协议保持不变。

## Open Questions

无。
