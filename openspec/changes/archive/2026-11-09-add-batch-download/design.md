# Design

## Context

动机见 `proposal.md`，行为契约见 `specs/remote-file-transfer/spec.md`。现状约束：

- [FileBrowser.tsx:268](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/FileBrowser.tsx#L268) 只维护单个 `selected` 名称，[FileBrowser.tsx:341](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/FileBrowser.tsx#L341) 由它派生 `item`，工具栏下载、重命名、删除都依赖 `item`。
- 文件行是单个 `<button>`（[FileBrowser.tsx:651-680](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/src/FileBrowser.tsx#L651-L680)）；列表超过 100 项时只渲染可视窗口（`renderedFiles`），选中与全选必须基于 `visibleFiles` 而不是已渲染行。
- 后端下载入口 `sftp:download`（[main.cjs:1708](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L1708)）只接受一个远程路径：文件走保存对话框，目录走父目录选择并在其下创建同名目录。
- 下载计划构建 `collectDownloadEntries`（[main.cjs:1250](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L1250)）以单一来源为根目录，生成相对路径并校验本地路径不越界。
- 传输控制器已支持多文件并发、扫描计数、冲突策略、暂停/继续/停止与聚合统计，批量下载可直接复用，无需改动传输执行模型。
- `transferTitle`（[main.cjs:671](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs#L671)）已支持「首项名称 等 N 项」的批量标题格式，上传多选已在用。

## Goals / Non-Goals

**Goals:**

- 以最小改动为文件面板补齐多选交互，并让下载入口按选择数量分流。
- 多选下载只确认一次本地目标文件夹，整批作为一个传输任务运行。
- 复用现有扫描、并发、冲突、暂停/停止与统计能力，保持单选下载和双击行为不变。
- 选中、全选、区间选择在虚拟列表与隐藏文件过滤下语义正确。

**Non-Goals:**

- 不做框选、右键菜单、跨目录批量选择或多窗口拖拽。
- 不新增批量重命名 / 批量删除 / 批量移动。
- 不改变单文件保存对话框、目录结构保留、20000 条目上限等既有下载语义。
- 不新增下载队列、并发度设置或本地文件浏览器。

## Decisions

### D1：选择状态改为名称集合 + 锚点

`FileBrowser` 用 `selected: Set<string>` 保存当前目录内的选中名称，另用 `anchor` 记录 `Shift` 区间选择的起点：

- 普通单击：只选中该行，并把锚点设为该行。
- `Cmd/Ctrl + 单击` 或点击复选框：切换该行，并把锚点设为该行。
- `Shift + 单击`：在 `visibleFiles` 的索引上，从锚点到当前行选择区间；锚点为空时退化为普通单击。
- 全选按钮：所有可下载的可见条目都已选中时清空选择，否则选中它们。
- 切换目录、刷新列表时清空选择；切换「隐藏文件」时从集合中移除已不可见的名称。

选择集合以名称为键，目录内名称唯一；虚拟列表只影响渲染，不影响选择范围。选择逻辑统一在 `visibleFiles` 上计算，避免全选/区间选择漏掉未渲染条目。

### D2：行结构改为可聚焦容器 + 真实复选框，避免交互控件嵌套

当前行是 `<button>`，直接内嵌 `<input type="checkbox">` 会产生非法的交互元素嵌套。把行改为 `<div role="option" tabIndex={0} aria-selected>`：

- 行内渲染真实复选框；复选框点击 `stopPropagation` 后只切换本行。
- 行点击按 D1 的修饰键规则处理；双击仍执行原有行为（目录进入、文件下载）。
- 键盘 `Space` 切换选择，`Enter` 执行双击行为，保留现有键盘可访问性；不可用状态用 `aria-disabled` 与样式表达。

样式沿用 `.file-row` / `.selected` 类，不新增独立复选框列：复选框绝对定位到文件类型图标的槽位（`left: 17px`），默认 `opacity: 0` 且不占布局空间；行悬浮、键盘聚焦（`focus-within`）或已选中时显示，同时图标淡出，文件名称与大小列不发生位移；`@media (hover: none)` 下复选框常显。复选框必须显式提升层叠层级（`z-index`）：淡出中的图标 `opacity < 1` 会创建层叠上下文并绘制在复选框之上，若不提升层级，真实鼠标点击会被透明图标拦截并冒泡为普通行点击，导致每次勾选都覆盖之前的选择（合成 `.click()` 无法暴露该问题）。`scripts/smoke.cjs` 用 `elementFromPoint` 断言复选框位于图标之上，并将基于 `.file-row` 与 `aria-pressed` 的断言改为 `aria-selected`。

### D3：下载入口按选择数量分流，单选行为完全不变

工具栏下载按钮：

- 选中 0 个可下载条目（或被阻塞）：禁用。
- 恰好 1 个：调用现有 `api.download(id, path)`，保留单文件保存对话框与单目录父目录选择。
- 2 个及以上：调用新增 `api.downloadPaths(id, paths)`，由后端弹出一次目标文件夹选择对话框并创建单个批量任务。

重命名与删除只在恰好 1 个选中项时可用；多选时禁用并保留原有单选交互。双击下载不受影响。

### D4：新增批量下载 IPC，复用下载计划与传输控制器

新增 `sftp:download-paths`：

1. 校验入参为非空远程路径数组，去重且不超过 20000；要求所有来源位于同一远程父目录，且每个 `basename` 通过 `validate.fileName`。根目录、符号链接、不存在的条目在打开对话框前拒绝。
2. 顺序读取各来源 `details`（FTP 主连接同一时刻只能执行一个控制操作），确定文件/目录与大小。
3. 通过一次 `showOpenDialog` 选择目标文件夹，作为本地目标根目录；取消则返回 `false`。
4. 用 `transferTitle(names)` 创建单个下载任务，构建计划后调用现有 `downloadPlan`。

把 `collectDownloadEntries` 泛化为接受多个来源：每个顶层条目以 `basename` 作为相对路径起点，目录继续递归遍历；目标根目录为所选文件夹，单目录下载可等价传入「父目录 + 目录名」的单一来源。所有条目仍逐个通过 `validate.fileName` 与 `resolveLocalPath` 校验，超出 20000 合计上限时在扫描阶段中止，不创建任何目录或临时文件。

批量下载不覆盖本地同名文件：顶层文件冲突与递归文件冲突都进入现有「跳过所有同名文件并继续 / 停止传输」策略；已存在目录继续按合并处理。

### D5：保留旧 IPC，批量入口只处理多选

不改动 `sftp:download` 的语义，避免单文件保存对话框、单目录父目录选择与既有测试回归；新增入口与旧入口共享 `collectDownloadEntries`、`downloadPlan`、冲突与统计代码。批量任务与单任务一样注册到会话的传输表，因此暂停/继续/停止按 `taskId` 隔离，断线时与其他任务一起转为失败。

## Risks / Trade-offs

- [行容器由 `<button>` 改为 `<div role="option">` 影响样式与现有冒烟测试] → 沿用 `.file-row` 类名，补充 `tabIndex`、键盘处理与复选框列，并在 `scripts/smoke.cjs` 校验行与下载按钮状态。
- [超长目录 + 20k 条目的全选/区间选择成本] → 选择集合只做名称级增删，区间选择按索引批量构造；全选为一次 O(n) 生成，不逐项触发 IPC。
- [批量下载顶层同名冲突] → 顶层来源来自同一父目录，名称天然唯一；目标端同名文件统一走冲突策略，目录走合并。
- [FTP 单控制连接下逐个读取 details 较慢] → 仅在打开对话框前读取顶层条目元数据，递归扫描仍在后台任务中执行并展示扫描进度；不会阻塞其他传输。
- [大选择导致任务标题过长] → 标题沿用「首项名称 等 N 项」，不拼接全部名称。

## Migration Plan

无数据模型或配置迁移。新增 IPC 与界面入口为增量能力；旧 IPC、既有下载行为与测试保持兼容，可随时回滚到仅单选下载。

## Open Questions

无。
