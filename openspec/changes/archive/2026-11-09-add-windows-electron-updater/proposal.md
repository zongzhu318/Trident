# Proposal

## Why

Windows 端目前没有应用内自动更新：菜单「下载新版本…」只是跳转 GitHub Releases 让用户手动下载安装包覆盖安装（[electron/updater.cjs:63-77](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/updater.cjs)）。用户感知不到新版本、升级摩擦大，与 macOS 端 Sparkle 提供的自动更新体验严重不对称。项目发布形态（electron-builder NSIS + GitHub Releases）与 electron-updater 的 feed 模型天然契合，接入成本低。

## What Changes

- 引入 `electron-updater` 依赖，Windows 端新增应用内更新能力：检查更新 → 后台下载（支持差量）→ 等待空闲 → 退出并静默安装（NSIS `/S`，保留原安装目录，无 UAC）→ 自动重启。
- 重写 `electron/updater.cjs` 的 win32 分支：菜单从「下载新版本…」改为「检查更新…」，复用现有忙碌保护机制（`isBusy`/`assertCanConnect`）——有活跃 SSH 会话或文件操作时禁止检查/安装，与 macOS 行为对齐。
- `package.json` 的 electron-builder 配置新增 `publish`（GitHub provider：zongzhu318/Trident）；NSIS 保持现有辅助安装器形态（`oneClick: false`、`perMachine: false`），不改变安装交互。
- 发布流水线 [release.yml](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/.github/workflows/release.yml)：
  - build-windows 任务收集 `latest.yml` 与 `.exe.blockmap` 产物；
  - publish 任务对 `latest.yml` 做严格校验（版本、文件名、SHA512 与实际 exe 一致），连同 blockmap 上传到 Release，并纳入发布后可达性检查；
  - 草稿转正机制保持不变，macOS Sparkle 链路（appcast、Pages、签名）零改动。
- 更新说明维持单一来源：Windows 客户端从 GitHub Release 正文读取（electron-updater 内置行为），与 macOS appcast 嵌入的说明同源同文。
- 旧版 Windows 客户端（无内嵌更新器）不受影响，继续手动下载；无迁移问题。

## Capabilities

### New Capabilities

- `windows-auto-update`: Windows 客户端的应用内更新行为——更新检查、后台下载、忙碌状态协调、静默安装、菜单入口与错误呈现。
- `release-update-metadata`: 发布流水线产出的 Windows 更新元数据契约——`latest.yml`/blockmap 的生成、校验、上传与发布后可达性要求。

### Modified Capabilities

（无——项目尚无既有 spec。）

## Impact

- **应用代码**：[electron/updater.cjs](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/updater.cjs)（win32 分支重写）、[electron/main.cjs:712-719](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/electron/main.cjs)（createUpdater 接线可能需传入新依赖）、[package.json](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/package.json)（依赖 + build.publish）。
- **测试**：[tests/updater.test.cjs](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/tests/updater.test.cjs) 新增 win32 路径用例（沿用现有依赖注入结构）。
- **发布流水线**：[.github/workflows/release.yml](file:///Users/littlefisher/Documents/LittleFisher/Workspaces/jyn/Trident/.github/workflows/release.yml) 的 build-windows 与 publish 任务。
- **依赖**：新增运行时依赖 `electron-updater`（应用打包体积小幅增加，仅 Windows 生效的代码路径）。
- **兼容性**：安装器形态不变；现有 Windows 用户无破坏性变化；macOS 端无任何行为变化。
