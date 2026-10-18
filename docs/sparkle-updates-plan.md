# Trident：Sparkle + GitHub Actions 更新

仓库：[zongzhu318/Trident](https://github.com/zongzhu318/Trident)。从 **0.0.1** 开始接入 Sparkle 2.10.0，首版支持 macOS 12+ / Apple Silicon（arm64）。

当前实现采用 **无 Apple Developer ID 证书** 的发布方式：应用做 ad-hoc 签名，DMG 和 appcast 用 Sparkle Ed25519 密钥校验；不进行 Apple 公证。Sparkle 签名不能代替 Apple 身份认证。首次安装可能被 Gatekeeper 拦截，需用户确认来源后在「系统设置 → 隐私与安全性」中允许打开。不要关闭全局 Gatekeeper。

代码和流水线可在配置下列项目后发布。自动化测试不能代替两份实际发行包之间的安装、重启及 Gatekeeper 验收。未推送代码、配置密钥和运行流水线前，不代表线上更新服务已开通。

## 一次性配置

### 1. 生成 Sparkle 密钥

在 macOS 项目目录执行：

```bash
npm run sparkle:sdk
vendor/sparkle/bin/generate_keys --account trident
```

它会在你的 macOS 登录钥匙串中创建密钥，并显示公钥。使用独立的 `trident` account，避免混用其他应用的密钥。SDK 固定版本及 SHA-256，生成工具来自 Sparkle 官方。

复制公钥：

```bash
vendor/sparkle/bin/generate_keys --account trident -p | pbcopy
```

在 GitHub 仓库的 **Settings → Secrets and variables → Actions → Variables** 新增：

| 名称                 | 内容                      |
| -------------------- | ------------------------- |
| `SPARKLE_PUBLIC_KEY` | 上一步的公钥，一行 base64 |

私钥不能放入仓库、聊天或应用包。将它暂时导出到项目目录之外，再复制到 Secrets；下面命令不会把私钥打印到终端：

```bash
umask 077
vendor/sparkle/bin/generate_keys --account trident -x "$TMPDIR/trident-sparkle-private.key"
pbcopy < "$TMPDIR/trident-sparkle-private.key"
```

在 **Settings → Secrets and variables → Actions → Secrets** 新增：

| 名称                  | 内容                                             |
| --------------------- | ------------------------------------------------ |
| `SPARKLE_PRIVATE_KEY` | 导出文件内容，一行 base64；新格式为 32 字节 seed |

保存后清空剪贴板并删除临时导出文件；将私钥另外保存到可靠的离线备份。登录钥匙串中的原密钥继续保留。不要每次发布重新生成密钥，也不要随意更换客户端公钥；旧客户端依赖原密钥验证后续升级。

不需要 `CSC_LINK`、Apple ID、Team ID 或 notarization Secrets。未来接入 Developer ID 时，再单独调整签名、公证与换钥策略。

### 2. 开启 GitHub Pages / Actions

1. **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
2. 在 **Settings → Environments** 创建 `release`；仓库级 Secrets/Variables 可直接继承，也可放入此环境。
3. Pages 自动使用 `github-pages` 环境。如果该环境限制分支或 Tag，允许 `v*` 发布 Tag；否则部署会被拒绝。可以按自己的策略添加审批。
4. 保持仓库和 Releases 公共可下载；当前客户端不携带 GitHub token。

更新清单固定为：

```text
https://zongzhu318.github.io/Trident/stable/appcast-arm64.xml
```

完整更新包示例：

```text
https://github.com/zongzhu318/Trident/releases/download/v0.0.1/Trident-0.0.1-arm64.dmg
```

Pages 专门用于这个应用的更新源；当前只发布一个 stable/arm64 清单和下载首页，不承诺保留其他网站内容或其他架构 feed。

## 发布版本

首次发布使用 `0.0.1`。确认上述配置完成、代码已提交推送后，在 **Actions → Release macOS (Sparkle) → Run workflow** 直接运行；Tag 留空时自动取上一个稳定版 +1，没有历史发布时使用 `package.json` 中的版本。

后续例如 `0.0.2`：更新 `package.json` 和 lockfile 的版本、界面版本及 `docs/release-notes.md`，提交推送后运行 workflow，或留空 Tag 让流水线自动递增。只接受稳定版 `x.y.z`；Tag 必须与源码版本一致，`CFBundleVersion` 使用同一递增语义版本，不采用 workflow run number。

流水线会：

1. 校验版本、仓库、密钥是否匹配；拒绝用旧版本覆盖新 Release / appcast。
2. 执行测试和 UI 回归，校验 Sparkle SDK 的固定 SHA-256，编译 Node-API / Objective-C++ 桥。
3. 构建 arm64 应用、嵌入 Sparkle.framework 和公钥、完成 ad-hoc 签名并生成 DMG。
4. 用 Sparkle 官方 `generate_appcast` 签名最终 DMG 和 XML 清单；解压前验证开启，签名清单验证开启，不生成 delta。
5. 上传 DMG、appcast 和 SHA256SUMS 到 draft Release，全部完成后发布 Release。
6. 确认公开下载可用，再部署 Pages，并检查线上清单与 Release 中的文件逐字节一致。

PR / main / master 的 CI 不读取发布私钥。发布 workflow 串行执行，第三方 Actions 固定 commit SHA。`GITHUB_TOKEN` 由 Actions 自动提供，无需个人 PAT。

### 失败重试

- **Release 已公开，Pages 部署失败**：发布流水线不重试同名标签。修复 Pages 部署问题后，递增版本号发布一个全新版本；每次触发发布都必须是未发布的全新 Tag。
- **存在未完成的 draft Release**：先人工检查该 draft，确认没有对外发布后删除 draft，再重试。流水线不会自动覆盖已有资产。
- **已发布包本身有问题**：修复并递增版本发布；不要重写旧 Tag、替换同名 DMG 或降级 feed。
- **Pages 首次返回 404**：首发允许没有历史清单；其他网络错误会停止发布，避免丢失历史 feed。历史清单必须通过原密钥验证。

## 客户端行为

- macOS 顶部 **Trident → 检查更新…** 使用 Sparkle 标准原生窗口。
- **Trident → 自动检查更新** 默认关闭，由用户开启；Sparkle 持久化该设置，自动检查默认约一天一次。不启用无人确认的自动下载/安装。
- 有活动/正在连接的会话时，不开始检查更新。请先完成传输并断开会话。
- 更新周期进行中暂不接受新连接，完成或关闭更新窗口后恢复；安装前等待配置写入。
- 普通退出和更新退出共用 `before-quit` 保护，取消或保存失败时不退出；Sparkle 的延后重启代理额外协调配置保存。
- 更新仅替换 `.app`，保持 Bundle ID `com.trident.desktop` 与原有用户数据位置。
- 开发模式及普通 `npm run package:mac` 构建不加载正式更新器，检查入口会说明未配置；生产包需通过 `npm run package:release` 构建。

**0.0.1 之前没有已发布版本**，本版即首个可自动更新的版本，首次需手动安装。把应用拖入「应用程序」，退出旧实例后启动新版本。不要长期从只读 DMG 内运行应用。

## 本地构建与验证

```bash
npm ci
npm test
npm run test:ui
npm run sparkle:bridge
```

发布构建需要公钥环境变量（公钥不是秘密）：

```bash
export SPARKLE_PUBLIC_KEY="你的 Sparkle 公钥"
npm run package:release
```

产物：`release/mac-arm64/Trident.app` 和 `release/Trident-0.0.1-arm64.dmg`。客户端包只含公钥，`SPARKLE_PRIVATE_KEY` 只用于发布阶段。使用 Node-API 稳定 C ABI，不依赖 V8 私有接口；SDK/头文件缓存和编译产物不提交 Git。客户端包只含公钥，`SPARKLE_PRIVATE_KEY` 只用于发布阶段。使用 Node-API 稳定 C ABI，不依赖 V8 私有接口；SDK/头文件缓存和编译产物不提交 Git。

正式验收至少需要两个递增版本，用实际发行包验证：旧版本到新版本的替换与重启；连接、密码和主机指纹保留；错误签名与断网不替换应用；用户取消退出；活动连接及文件操作不会无提示中断；首次下载的 Gatekeeper 行为。没有完成这些真实升级检查前，不应宣称端到端升级已验证。

## 相关文件与官方文档

本次本机验证（2026-10-16）：29 项自动化测试通过；既有 SSH / FTP / 凭据 / 主题 UI 回归通过；独立测试应用和 DMG 构建成功；实际打包应用中的原生 Sparkle 加载、会话检查拦截和开关通过；Cocoa 终止请求进入 Electron `before-quit`；最终 DMG、含更新说明的签名清单及包长度校验通过，篡改清单被拒绝。测试密钥和测试产物仅位于被 Git 忽略的 `.release-work/`，不得用作生产发布密钥。GitHub 线上流水线及实际跨版本替换/重启尚未验收。

- `native/sparkle-bridge/bridge.mm`：原生 Sparkle / Node-API 桥。
- `electron/updater.cjs`、`electron/quit-coordinator.cjs`：菜单、会话和退出协调。
- `scripts/release/`：固定 SDK、原生构建、发布和清单验证。
- `.github/workflows/ci.yml`、`.github/workflows/release-macos.yml`：CI 与发布。
- [Sparkle 官方文档](https://sparkle-project.org/documentation/)
- [发布更新与 EdDSA 签名](https://sparkle-project.org/documentation/publishing/)
- [程序化接入](https://sparkle-project.org/documentation/programmatic-setup/)
