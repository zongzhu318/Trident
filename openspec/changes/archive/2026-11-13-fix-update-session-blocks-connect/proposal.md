# Proposal

## Why

macOS 端当前把 Sparkle 的整个 update session（含无界面的后台自动检查与下载）都当作「安装中」，`assertCanConnect()` 因此拒绝一切新建连接。用户在启动后连接时会被一条「正在检查或安装更新」的错误挡住，而界面上根本没有任何更新窗口；此外，用户取消安装确认后 `preparing`/`pendingInstall` 不会复位，应用会一直停留在不可连接的忙碌状态，直到重启。实际需要保护窗口只有「安装并重启」这一瞬，检查与下载不应影响连接。

## What Changes

- 删除 `updater.assertCanConnect()` 及其在 `connect()` 中的调用：连接闸门统一收敛到既有的退出协调器 `quitter.assertOpen()`。后台自动检查、手动检查、下载以及「安装确认框展示期间」均不影响新建连接；只在用户确认安装、应用开始保存数据并退出后拒绝，并提示「应用正在保存数据并退出」。
- 原生桥接层把更新状态拆分为 `checking`（检查/下载）与 `installing`（等待重启安装），移除混用的 `inProgress`；这两个状态仅用于可观测性与菜单/检查入口判断，不参与连接判定。
- 用户取消「断开所有连接并安装更新」确认后，复位 `preparing`/`pendingReply` 并以 Sparkle 的 `SPUUserUpdateChoiceSkip` 结束当前安装（取消本次安装但不跳过该版本），使应用立即恢复正常连接与再次检查更新的能力，无需重启。
- 更新 `docs/sparkle-updates-plan.md` 中「更新周期中暂不接受新连接」的描述，使其与新的协调语义一致。

## Capabilities

### New Capabilities

- `macos-auto-update`: 定义 macOS 打包版通过 Sparkle 更新的行为，重点是更新活动（检查、下载、安装）与连接可用性、更新状态复位之间的协调。

### Modified Capabilities

（无）

## Impact

- 原生桥接：`native/sparkle-bridge/bridge.mm`（状态拆分、安装取消复位、新增导出能力）。
- 主进程：`electron/updater.cjs`（连接判定、取消确认后的复位）、必要时 `electron/main.cjs` 的调用点。
- 文档：`docs/sparkle-updates-plan.md`。
- 测试：`tests/updater.test.cjs` 增补状态判定与取消复位用例。
- Windows 分支行为不变（`bridge` 为 `undefined` 时 `assertCanConnect()` 本就放行）；无新增依赖，无数据迁移。
