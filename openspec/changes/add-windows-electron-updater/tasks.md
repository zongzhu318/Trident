# Tasks

## 1. 依赖与构建配置

- [x] 1.1 在 `package.json` 中新增运行时依赖 `electron-updater` 并执行 `npm install`，确认安装成功且 `package-lock.json` 更新
- [x] 1.2 在 `package.json` 的 `build` 中新增 `publish` 配置（`{"provider": "github", "owner": "zongzhu318", "repo": "Trident"}`），确认 `npm run package:win:built` 后 `release/` 下生成 `latest.yml` 与 `Trident-*.exe.blockmap`（版本来自 `--config.extraMetadata.version` 传入值）

## 2. updater.cjs win32 分支重写

- [x] 2.1 重写 `electron/updater.cjs` 的 win32 分支：打包环境下通过注入的 `load` 惰性加载 electron-updater，设置 `autoDownload`，注册 `update-downloaded`/`error` 事件；开发版保留「更新仅对打包版生效」提示。验证：`node --test tests/updater.test.cjs` 中新增用例通过
- [x] 2.2 实现 win32 菜单「检查更新…」：`isBusy()` 时提示需断开连接，空闲时触发检查；`update-downloaded` 时弹出含 `releaseNotes` 与版本号的确认对话框，「立即重启安装」确认时再次校验 `isBusy()` 后调 `quitAndInstall(true, true)`，`autoInstallOnAppQuit` 保持默认 true 兜底。验证：单测覆盖忙碌拒绝、确认安装、说明展示三条路径
- [x] 2.3 在 `electron/main.cjs` 的 `createUpdater` 接线处传入 win32 分支所需参数（沿用现有 `load`/`prepareQuit`/`isBusy` 注入结构，必要时补充新参数），确认 macOS darwin 分支行为零变化。验证：现有全部测试通过 + macOS 菜单用例无回归

## 3. 测试补全

- [x] 3.1 在 `tests/updater.test.cjs` 新增 win32 用例（注入假 electron-updater 模块）：开发版不发起网络请求、忙碌时拒绝检查、差量不可用时全量回退路径的提示、错误对话框呈现、下载中断后可重新检查。验证：`npm test` 全绿

## 4. 发布流水线

- [x] 4.1 修改 `release.yml` build-windows 任务的 artifact 上传为列表（exe + `latest.yml` + `*.exe.blockmap`），并确认 `scripts/test-windows-installer.ps1` 补充静默安装（`/S`）验证。验证：本地或 CI 干跑确认三个文件均进入 artifact
- [x] 4.2 在 publish 任务「生成并校验更新源」步骤追加 latest.yml 校验：`jq` 验证 `version == $RELEASE_VERSION`、`path == $EXE_NAME`，`shasum -a 512`（hex → base64）与 latest.yml 的 sha512 比对，失败即终止；latest.yml 哈希并入 SHA256SUMS。验证：构造不匹配的 latest.yml 时步骤失败，正常产物时通过
- [x] 4.3 修改 `gh release upload` 追加 latest.yml 与 blockmap 两个附件；转正后的 `curl --head` 可达性检查清单加入两者的下载地址。验证：干跑 release.yml（workflow_dispatch 或 lint）确认步骤顺序与命令正确

## 5. 集成验证

- [x] 5.1 本地完整验证 Windows 打包链路：`npm run package:win` 后检查 `release/` 产物齐全（exe、blockmap、latest.yml 三者版本一致、sha512 一致）。验证：命令产物清单与校验脚本输出
- [ ] 5.2 端到端冒烟：在一台 Windows 测试机上用旧版本安装包安装，指向测试 Release 验证「检查更新 → 下载 → 退出静默安装 → 重启为新版本」全流程及自定义安装目录保留。验证：机器上版本号变化且安装目录未变
