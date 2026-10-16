# Trident

面向 macOS 的 SSH 终端与 SFTP / FTP / FTPS 文件管理桌面应用，参考 Xshell / Xftp 的连接管理、多会话和文件传输工作方式。

## 启动

需要 Node.js 22+ 和 npm。

```bash
npm install
npm run dev
```

生产模式启动：

```bash
npm run build
npm start
```

打包当前 Mac 架构的应用：

```bash
npm run package:mac
```

生成的 `Trident.app` 位于 `release/mac-arm64/`（Apple Silicon）或 `release/mac/`（Intel）。当前构建未签名、未公证，适用于本机开发体验；正式分发需配置 Apple Developer 签名和公证。

## 功能

- 浅色、深色与跟随系统三种主题，侧栏底部「外观」切换；终端和系统对话框同步，选择会保存并在下次启动恢复。
- 保存、编辑、删除与搜索连接配置，支持分组标签。
- 多标签 SSH 终端，支持 UTF-8、ANSI、交互式 shell 和终端尺寸同步。
- 密码、私钥（包括带口令的私钥）和 SSH Agent 认证。
- 独立 SFTP 连接，无需服务器允许交互式 shell；FTP / 显式 FTPS 连接使用被动传输模式。
- 首次连接确认 SHA256 主机指纹，指纹变化再次警告确认。
- 同一 SSH 连接内打开 SFTP，或使用独立文件连接；支持浏览目录、输入绝对路径、切换隐藏文件、新建目录、重命名、删除文件和空目录。
- 通过 macOS 文件对话框选择多个本地文件上传、选择本地保存位置下载，显示当前文件进度。
- SFTP 上传使用独占创建拒绝覆盖；FTP / FTPS 上传前检查同名文件（FTP 协议下检查与写入不是原子操作，不能防止其他客户端同时写入）。下载成功后从临时文件移动到目标，失败清理临时文件。
- 密码和私钥口令可选择加密保存在本机，后续连接无需重复输入；取消保存后清除已有凭据。
- 连接配置导入导出；包含凭据时使用独立备份密码加密，支持迁移到其他 Mac。

打开应用，点击「新建连接」选择 SSH / SFTP / FTP / FTPS、填写服务器和认证信息。勾选「在本机保存密码 / 私钥口令」即可记住凭据。SSH / SFTP 首次连接前请向服务器管理员核对指纹。终端支持 ⌘C / ⌘V；Ctrl+C 中断远程命令。文件列表单击选中后可通过工具栏下载、重命名或删除，双击目录打开、双击普通文件下载。删除前需确认，非空目录不会递归删除。

FTP 是明文协议；需要加密传输请选择 SFTP 或 FTPS。FTPS 使用显式 TLS，默认端口 21，严格验证服务器证书，不会自动降级为明文 FTP。

## 本地凭据与备份

本地密码及私钥口令使用 Electron `safeStorage` 加密后写入 `connections.json` 的 `secret` 字段；macOS 的加密密钥由系统钥匙串保护。加密不可用时明确报错，不会改为明文保存。界面只获取「是否已保存」标记，不读取已存密码明文；连接时在主进程解密。修改主机、端口、协议、用户名、认证方式或私钥路径后，不会沿用旧目标的凭据。

在连接管理页面点击「导出连接」：

- 不勾选凭据：导出普通 JSON，仅含连接信息，不含密码或口令。
- 勾选凭据：必须设置至少 8 个字符的备份密码，整个备份使用 scrypt 派生密钥和 AES-256-GCM 加密。请单独保管备份密码，应用不保存该密码，也无法找回。

点击「导入连接」，为加密备份输入备份密码后选择文件。预览连接列表及凭据数量，确认后以新的 ID 添加，不覆盖已有连接。所有条目通过校验后才写入；错误密码或损坏文件不会导入部分内容。支持本应用导出的 v1 JSON 备份，单次文件最大 8 MB、连接总数最多 1000。

备份不包含私钥文件内容或服务器信任记录。换电脑后请重新选择私钥文件，并重新核验 SSH 主机指纹。本机 `secret` 密文不能作为跨电脑备份直接复制，应使用带备份密码的导入导出。

连接配置存放于 Electron 的 `app.getPath('userData')` 目录，macOS 通常为 `~/Library/Application Support/Trident/` 或开发模式下的 `trident/`：

- `connections.json`：协议、主机、用户名、端口、私钥路径，以及可选的加密凭据。
- `known-hosts.json`：本应用信任的服务器指纹，与 OpenSSH 的 `known_hosts` 独立。
- `preferences.json`：外观偏好，默认跟随 macOS 系统主题。

SSH Agent 需要启动应用的环境中存在 `SSH_AUTH_SOCK`，并已执行 `ssh-add`。

## 技术结构

- Electron 主进程：SSH / SFTP / FTP / FTPS、原生文件对话框、主机核验、本地持久化。
- React + TypeScript + Vite：连接管理与文件界面。
- xterm.js：VT 终端模拟，适用于 Vim / htop 等交互式工具。
- ssh2：SSH 协议客户端，终端与 SFTP 共用连接。
- basic-ftp：FTP / 显式 FTPS 文件连接与被动传输。
- 打包禁用可选本机模块重编译；ssh2 在模块不可用时使用 Node.js 内置密码学实现。
- 隔离的 preload 桥：只开放明确的 IPC 方法，渲染器启用 sandbox 和 contextIsolation，不开放 Node.js。

```text
electron/main.cjs        主进程、会话生命周期与导入导出
electron/preload.cjs     IPC 桥
electron/validation.cjs  配置与路径校验
electron/credentials.cjs 本机加密、备份加密与格式校验
electron/files.cjs       SFTP / FTP 文件操作适配
src/App.tsx             工作空间、连接管理
src/ConnectionModal.tsx 协议、认证、保存凭据
src/BackupModal.tsx     连接导入导出与预览
src/SessionView.tsx     终端与文件会话
src/FileBrowser.tsx     远程文件管理
src/styles.css          macOS 深色桌面布局
tests/                  校验、IPC 与本机协议集成测试
```

## 验证

```bash
npm test
npm run build
npm run test:ui
```

协议测试在本机临时端口启动 SSH / FTP 服务器，验证真实上传下载、重命名、删除、凭据复用和备份导入。UI 测试使用临时应用配置、macOS `safeStorage` 和本机 FTP 服务器，通过界面验证文件操作、加密保存及加密备份往返；原生文件对话框在测试中使用临时路径替代。测试不会连接用户的服务器或修改已有连接配置。

## 当前边界

本版是可运行的开发 MVP，支持 **SSH / SFTP / FTP / 显式 FTPS**。暂不支持目录递归传输/删除、断点续传、任务队列、跳板机、端口转发、键盘交互式 MFA、自动重连、隐式 FTPS 和自定义证书信任。符号链接不打开，可重命名或删除链接本身。一个连接同一时间执行一个文件操作；关闭连接会中断传输。上传失败可能留下远程不完整文件，需要自行检查处理。

旧版未包含协议字段的连接配置会按 SSH 读取，无需手动迁移。应用仍为未签名公证的本机开发版本。

## 性能与资源占用

- 超过 100 项的文件目录按可见区域渲染，保留完整目录数据；滚动时复用有限的页面节点。过滤/排序只在目录数据或隐藏文件设置变化时重新计算。
- SSH 输出以二进制数据批量发送，最多等待约 16 ms 合并小块；终端解析滞后时通过确认机制暂停/恢复 SSH 输出流，避免输出在跨进程队列中无限堆积。传输会适当等待终端处理，不丢弃输出。
- 会话事件在 preload 内按连接分发，终端数据仅传给对应终端；后台标签不反复更新传输进度界面，并暂停光标闪烁。
- 终端回滚历史上限调整为 5,000 行，减少长期运行的内存占用；尺寸变化按动画帧合并，并跳过重复的远程 resize。
- 弹窗移除实时背景模糊，降低合成开销。

可运行 `node scripts/launch.cjs scripts/performance.cjs` 重现包含 5,000 个文件的本机目录测试。优化前后的实测记录与限制见 [性能记录](docs/performance.md)。
