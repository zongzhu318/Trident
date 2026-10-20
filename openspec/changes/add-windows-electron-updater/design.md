# Design

## Context

现状：macOS 走 Sparkle 原生桥（`native/sparkle-bridge/` + `electron/updater.cjs` 的 darwin 分支），Windows 仅在 `createUpdater` 的 win32 分支返回「下载新版本…」菜单项跳转浏览器。发布流水线 `release.yml`：prepare → build（mac）∥ build-windows（NSIS，`--publish never`）→ publish（macOS runner 上生成 appcast、建草稿 Release、传产物、转正）→ pages。发布说明由「汇总版本更新说明」步骤从提交历史生成单一文件，已同时喂给 appcast 与 Release 正文。

关键约束：

- 现有 NSIS 是辅助安装器（`oneClick: false`、`perMachine: false`、`allowElevation: false`、`allowToChangeInstallationDirectory: true`），按用户安装、无提权；改变安装形态会影响所有现有 Windows 用户的升级路径，必须保持。
- publish 任务的「草稿 → 转正」纪律是发布安全的核心，且 electron-updater 的 GitHub provider 匿名请求只读已发布 Release，两者天然兼容。
- `createUpdater` 已有依赖注入结构（`load = require`、`prepareQuit`、`isBusy` 等），测试注入沿用此模式。

## Goals / Non-Goals

**Goals:**

- Windows 打包版获得与 macOS 对等的应用内更新体验（检查、下载、空闲后静默安装、重启）。
- 更新元数据（latest.yml/blockmap）进入流水线产物链并受严格校验保护。
- macOS 链路零改动；发布说明继续单一来源。

**Non-Goals:**

- 不引入代码签名/EdDSA 等额外签名机制（latest.yml 的 sha512 + HTTPS 已满足完整性需求）。
- 不改 NSIS 安装器形态、不做按机器安装、不引入安装向导文案变化。
- 不给 Windows 部署 Pages 侧更新源（feed 即 GitHub Release）。
- 不做更新频道（stable/beta）划分。

## Decisions

### D1：选型 electron-updater（GitHub provider），而非 Squirrel 或自建

- Squirrel.Windows 要求换掉整套 NSIS 打包，且与 `oneClick: false` 辅助安装器不兼容，迁移成本最高。
- 自建更新器需自行实现下载、校验、提权、回滚，工作量远超收益。
- electron-updater 与现有 electron-builder NSIS + GitHub Releases 发布形态零摩擦；事件模型可映射进现有 `createUpdater` 架构。

### D2：保持辅助安装器形态，静默更新用 `/S`

electron-updater 对辅助 NSIS 安装器执行 `quitAndInstall(true, true)` 时以 `/S` 静默运行安装包，并沿用注册表中记录的原安装目录；`perMachine: false` 保证不弹 UAC。**不改** `oneClick: false`/`allowToChangeInstallationDirectory`。若未来改 oneClick 反而会改变用户安装交互，且对静默更新无额外收益。

### D3：win32 分支的接线方式——沿用 `load = require` 惰性注入

`electron/updater.cjs` 中 win32 打包分支通过注入的 `load` 惰性 `require("electron-updater")`：

- 仅 `process.platform === "win32" && app.isPackaged` 时加载，开发版与 macOS 完全不受影响，也不增加它们的启动开销；
- 测试通过注入假模块驱动 win32 路径用例，与现有 `tests/updater.test.cjs` 的注入结构一致；
- 事件映射：`update-downloaded` → 记录待安装状态并用对话框呈现 `releaseNotes` + 版本号（对应 spec 的「更新说明展示」）；`error` → 对话框呈现（对应「更新失败呈现」）。

### D4：忙碌协调——「检查时拒绝 + 退出时安装」双保险

- 检查入口：`isBusy()` 为真时点击「检查更新…」直接提示断开连接（复用 darwin 分支 `assertCanConnect` 的既有语义，main.cjs 的 `assertCanConnect` 调用点也自动覆盖 win32）。
- 安装时机：`autoInstallOnAppQuit` 保持默认 true——下载完成后即使不点「立即安装」，用户正常退出（此时会话必然已断开、文件操作必然已结束）后自动静默安装。这天然满足「安装不在忙碌时发生」：只有用户主动退出才会触发。对话框中的「立即重启安装」按钮在确认时再次检查 `isBusy()`。

### D5：流水线只加「收集 + 校验 + 上传」，不动拓扑

- build-windows：`--publish never` 下 electron-builder 仍会在 `release/` 生成 `latest.yml` 与 `.exe.blockmap`（`build.publish` 配置存在后）；artifact 上传从单文件改为列表（exe + latest.yml + blockmap）。
- publish（macOS runner）：
  1. 校验 latest.yml：`jq` 验证 `version == $RELEASE_VERSION`、`path == $EXE_NAME`；`shasum -a 512` 计算 exe 摘要，hex 经 `xxd -r -p | base64` 转换后与 latest.yml 的 sha512（base64 格式）比对；
  2. `gh release upload` 追加 latest.yml 与 blockmap；
  3. latest.yml 哈希并入 SHA256SUMS；
  4. 转正后 `curl --head` 可达性检查清单加入 latest.yml 与 blockmap 地址。
- 草稿转正机制、appcast 生成、Pages 部署全部不动。

### D6：差量更新的现实预期

blockmap 差量依赖本地缓存的旧安装包（`%LOCALAPPDATA%\<app>-updater\pending`）。首次自动更新（旧版客户端从未缓存过安装包）必为全量下载，之后各版本间走差量。这是电子上游的固有行为，spec 已按「全量回退」建模，不做额外处理。

## Risks / Trade-offs

- [GitHub API 匿名限流（60 次/小时/IP）] → electron-updater 内置响应缓存；应用内检查由用户手动触发（无定时轮询），单用户触发频率远低于限流阈值。
- [用户手动编辑 Release 正文后与 appcast 说明不同步] → 保持「发布产物不可变、绝不覆盖」的现有纪律即可；流水线生成的两处消费同源于一份文件，人工编辑属流程外行为，不在机制层防护。
- [辅助安装器静默更新的上游兼容性回归] → electron-updater 对 `oneClick: false` 的支持是其官方路径；在 CI 的 `test-windows-installer.ps1` 中补充静默安装验证，让该组合每次发布都被真实执行过。
- [latest.yml 与实际附件不一致（部分上传失败等）] → publish 任务的 sha512 严格比对 + 转正后可达性检查双道防线，任一失败即发布失败。
- [electron-updater 运行时依赖增加打包体积] → 仅 win32 打包分支惰性加载；macOS 包不受影响。

## Migration Plan

1. 应用侧改动（依赖、updater.cjs、package.json、测试）先行合入，不影响现有发布（旧流水线不会上传 latest.yml，新客户端在首个携带元数据的 Release 之前检查会得到「无更新」）。
2. 流水线改动合入后，下一次「发布 macOS / Windows 版本」即产出首个双端更新源齐全的 Release。
3. 回滚：回退流水线改动即可——已发布的 Release 附件不可变；删除 latest.yml 附件会让新客户端检查失败（对话框提示），旧客户端无感知。

## Open Questions

（无——选型、安装形态、接线方式均已在设计内定论。）
