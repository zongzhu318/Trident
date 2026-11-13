# Design

## Context

- 见 proposal.md。当前 `connect()` 在入口调用 `updater.assertCanConnect()`（electron/main.cjs:171），其判定完全依赖原生桥接的 `inProgress`（native/sparkle-bridge/bridge.mm:91），而 `inProgress = preparing || sessionInProgress`，把后台自动检查、手动检查、下载与「等待重启安装」混为一谈。
- Sparkle 文档明确：`sessionInProgress` 覆盖整个更新会话（检查、下载、安装准备）；`canCheckForUpdates` 才是菜单可用性判据。
- 退出协调已具备：`handle()` 在进入每个 IPC 处理前调用 `quitter.assertOpen()`（electron/main.cjs:165），`prepare()` 在用户确认后才把 `closing` 置真（electron/quit-coordinator.cjs:16-20），确认框展示期间 `assertOpen()` 仍然放行。`connect` 注册为 `handle("ssh:connect", connect)`，未使用 `allowWhileClosing`。
- Sparkle 的 `showReadyToInstallAndRelaunch:` reply 是一次性的：一旦回复 INSTALL，`SPUInstallerDriver` 会等待 `shouldPostponeRelaunchForUpdate` 保存的 handler，中途没有中止接口；`dismissUpdateInstallation` 只拆除界面，会话会永久停留在 `sessionInProgress`，后续检查更新失效。实际验收已验证该行为。

## Goals / Non-Goals

**Goals:**

- 检查与下载阶段完全不影响新建连接与已有会话。
- 只有在用户确认安装、应用开始保存数据并退出后才拒绝新连接，且提示准确。
- 用户取消安装确认后，立即恢复连接与再次检查更新的能力，无需重启。

**Non-Goals:**

- 不改变 Windows 的更新流程与忙碌协调语义（`bridge` 为空时行为不变）。
- 不引入「延后到空闲时自动安装」的新交互；取消即放弃本次待安装（下次检查可重新发现）。
- 不调整更新检查的调度时机（仍在自动检查开启时启动后立即后台检查一次）。

## Decisions

### D1：连接闸门收敛到退出协调器

移除 `connect()` 中的 `updater.assertCanConnect()` 调用及 updater 的同名方法，连接可用性只由既有的 `quitter.assertOpen()` 决定。

- 理由：唯一需要保护的是「保存数据 → 断开 → 进程替换」窗口，退出协调器已精确覆盖；`closing` 在用户确认后才置真，天然满足「确认框展示期间仍可连接」。
- 备选（放弃）：保留 `assertCanConnect()` 并改为只读 `installing` 标志。但 Sparkle 在 `shouldPostponeRelaunchForUpdate` 时、即确认框弹出*之前*就进入安装准备态，按该标志拒绝会违反「确认框期间可连接」；若再引入「已确认」标志，则与 `closing` 重复。
- 备选（放弃）：后台检查沿用 `sessionInProgress` 但加宽限时间。仍然是隐式竞态，不能表达「什么阶段允许连接」的语义。

### D2：原生状态拆分为 checking / installing

`bridge.state()` 返回 `canCheck`、`checking`、`installing`、`automatic`、`pendingInstall`，移除 `inProgress`：

- `checking = !preparing && updater.sessionInProgress`
- `installing = preparing`（`preparing` 覆盖「等待用户答复」到「进程被替换」的整个准备阶段）

`checking`/`installing` 只用于可观测性与菜单/检查入口判断，不再参与连接判定；菜单「检查更新…」仍以 `canCheckForUpdates` 与 JS 侧 `isBusy()` 为判据。

### D3：安装选择先确认，取消时回复 SKIP

Sparkle 只提供一条可行的取消路径：在回复 INSTALL 之前改回 SKIP。因此原生桥接不再实现 `shouldPostponeRelaunchForUpdate`，改用 `SPUStandardUserDriver` 子类直接构造 `SPUUpdater`，拦截两处安装选择：

- `showReadyToInstallAndRelaunch:`（已下载更新询问「安装并重启」）；
- `showUpdateFoundWithAppcastItem:state:reply:` 中 stage 为 `Installing` 的分支。

拦截到 INSTALL 时暂存 reply、置 `preparing` 并通知 JS `prepare-install`：

1. `prepareQuit()` 返回 `true`：`resume()` 回复 INSTALL，Sparkle 继续安装并退出；
2. 返回 `false`（用户取消）或抛错：`cancelInstall()` 回复 SKIP（取消本次安装，但不跳过该版本），Sparkle 自行结束会话并拆除界面。

`didAbortWithError` 与 `standardUserDriverWillFinishUpdateSession` 都会清除暂存 reply，避免回复已经结束的会话。SKIP 后再次检查更新会重新呈现这个已下载的版本。

备选（放弃）：回复 INSTALL 后调用 `dismissUpdateInstallation`。只拆界面不结束会话，Sparkle 与 installer 进程残留，菜单「检查更新…」静默失效（验收实测）。

### D4：文档与规格同步

`docs/sparkle-updates-plan.md` 中「更新周期进行中暂不接受新连接」改为「仅安装并重启阶段拒绝新连接；用户取消后立即恢复」。

## Risks / Trade-offs

- [确认框到 `closing` 之间极短的微任务间隙内仍可能接受一次连接] → 该连接会被随后的 `disconnect()` 一并断开，与「断开所有连接并安装」的语义一致；不需要额外机制。
- [Sparkle 的 reply 被暂存期间会话仍处于 `sessionInProgress`] → 该状态只影响菜单可用性，不影响连接；确认框期间 `preparing` 已使 `checking` 为假、`installing` 为真，语义与界面一致。
- [SKIP 后 Sparkle 可能回调 `didAbortWithError` 或 `standardUserDriverWillFinishUpdateSession`，重复触发 `cancel-install`] → `cancelInstall` 先清状态，回调判定不再命中；JS 侧 `cancelQuit()` 幂等。
- [SKIP 后已下载的更新仍会保留，再次检查会重新提示安装] → 符合「取消本次安装但不跳过版本」的预期。
- [原生模块需重新编译才能验证新导出] → 通过 release 工作流的原生编译步骤与冒烟脚本验证；本机单元测试覆盖 JS 分支。

## Migration Plan

- 无数据迁移。发布后随下一个 macOS 版本生效；旧版本客户端不受影响。
- 回滚：还原 `bridge.mm` 的状态字段与 `updater.cjs` 的取消分支即可，无持久化状态变化。

## Open Questions

（无）
