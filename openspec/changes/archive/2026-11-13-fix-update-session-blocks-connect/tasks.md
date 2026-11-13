# Tasks

## 1. 原生桥接（macOS）

- [x] 1.1 将 `bridge.state()` 拆为 `checking`（`!preparing && sessionInProgress`）与 `installing`（`preparing`），移除 `inProgress`；保留 `canCheck`、`automatic`、`pendingInstall`。验证：按 `.github/workflows/release.yml` 的原生编译命令本地编译 `native/sparkle-bridge/bridge.mm` 通过，并用冒烟脚本打印 `state()` 确认字段齐全。
- [x] 1.2 用 `SPUStandardUserDriver` 子类拦截安装选择（`showReadyToInstallAndRelaunch:` 与 Installing 阶段的更新说明），暂存 reply 并置 `preparing`；`resume()` 回复 INSTALL，新增导出的 `cancelInstall()` 回复 SKIP 结束会话。验证：原生编译通过；打包版验收确认取消后会话结束、可再次检查更新。

## 2. 主进程协调与单元测试

- [x] 2.1 移除 `electron/main.cjs` 中 `connect()` 的 `updater.assertCanConnect()` 调用与 `electron/updater.cjs` 的同名方法，连接关闭期保护由既有 `quitter.assertOpen()` 承担；同步删除 `tests/updater.test.cjs` 中对 `assertCanConnect` 的调用。验证：`npm test` 全部通过。
- [x] 2.2 在 `updater.resume()` 中，`prepareQuit()` 返回 `false` 或抛错时调用 `bridge.cancelInstall()`（不改动成功路径）。验证：`tests/updater.test.cjs` 新增用例断言取消时不调用 `resume()`、`cancelInstall` 恰好一次且不弹错误框，`npm test` 通过。
- [x] 2.3 补充「检查/下载不阻塞连接」的回归用例：以假 bridge 返回 `checking: true, installing: false` 驱动 updater，验证不存在任何连接拒绝路径（连接闸门仅由退出协调器测试覆盖）。验证：新增用例随 `npm test` 通过。

## 3. 文档同步

- [x] 3.1 更新 `docs/sparkle-updates-plan.md`：将「更新周期进行中暂不接受新连接」改为「仅安装并重启阶段拒绝新连接，用户取消后立即恢复」，并说明取消安装确认会放弃本次待安装。验证：通读该段与新的 `macos-auto-update` 规格一致。

## 4. 集成验证

- [x] 4.1 macOS 打包版手动验证：启动后后台自动检查期间新建连接成功；手动检查与下载期间连接不受影响；用户取消「断开所有连接并安装更新？」后现有会话保留、可再次连接、菜单「检查更新…」可再次发起。验证：三项可观察行为均符合 `macos-auto-update` 规格。
- [x] 4.2 全量校验：`npm run build` 与 `npm test` 通过，确认渲染进程与主进程无回归。

## Workflow follow-up

- 实施完成后按项目流程归档本次变更。
