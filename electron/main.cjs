const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  safeStorage,
  nativeTheme,
  shell,
} = require("electron");
const { Client } = require("ssh2");
const { Client: FTPClient } = require("basic-ftp");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const validate = require("./validation.cjs");
const { TerminalOutput } = require("./terminal-output.cjs");
const { createUpdater } = require("./updater.cjs");
const { createQuitCoordinator } = require("./quit-coordinator.cjs");
const { sftpFiles, ftpFiles } = require("./files.cjs");
const {
  makeVault,
  relevant,
  publicProfile,
  encodeBackup,
  decodeBackup,
  MAX_BACKUP,
} = require("./credentials.cjs");
const vault = makeVault(safeStorage);
const pendingImports = new Map();
const profileViews = () => savedProfiles.map(publicProfile);

let window;
const sessions = new Map();
let savedProfiles = [];
let knownHosts = {};
const terminalThemeIds = [
  "auto",
  "dark",
  "light",
  "dracula",
  "nord",
  "tokyo-night",
  "monokai",
  "solarized-light",
];
let preferences = { theme: "system", terminalTheme: "auto" };
const themeState = () => ({
  mode: nativeTheme.themeSource,
  effective: nativeTheme.shouldUseDarkColors ? "dark" : "light",
  terminalTheme: preferences.terminalTheme,
});
function publishTheme() {
  if (!window || window.isDestroyed()) return;
  const state = themeState();
  window.setBackgroundColor(state.effective === "dark" ? "#111b28" : "#f8f9fc");
  window.webContents.send("theme:changed", state);
}
let persistQueue = Promise.resolve();
let configurationQueue = Promise.resolve();
let updater;
const quitter = createQuitCoordinator({
  app,
  confirm: () => {
    if (!sessions.size) return true;
    return (
      dialog.showMessageBoxSync(window, {
        type: "warning",
        message: "断开所有连接并退出？",
        detail:
          "退出或安装更新会中断远程终端和正在传输的文件。可取消并在操作完成后重试。",
        buttons: ["取消", "断开并退出"],
        defaultId: 0,
        cancelId: 0,
      }) === 1
    );
  },
  flush: async () => {
    await configurationQueue;
    await persistQueue;
  },
  disconnect: () => {
    for (const id of sessions.keys()) disconnect(id);
  },
  showError: (error) =>
    dialog.showErrorBox("无法安全退出", `配置尚未保存：${error.message}`),
});
const dev = process.argv.includes("--dev");
const emit = (id, type, data) => {
  if (window && !window.isDestroyed())
    window.webContents.send("session:event", { id, type, data });
};
const storagePath = (name) => path.join(app.getPath("userData"), name);
async function readJSON(name, fallback) {
  try {
    return JSON.parse(await fs.readFile(storagePath(name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
function persist(name, data) {
  const content = JSON.stringify(data, null, 2);
  const task = persistQueue
    .catch(() => {})
    .then(async () => {
      const dest = storagePath(name);
      const temp = `${dest}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, content, { mode: 0o600 });
      await fs.rename(temp, dest);
    });
  persistQueue = task;
  return task;
}
function updateConfiguration(operation) {
  const task = configurationQueue.catch(() => {}).then(operation);
  configurationQueue = task;
  return task;
}
function getSession(id) {
  const session = sessions.get(id);
  if (!session || !session.ready) throw new Error("连接已断开，请重新连接");
  return session;
}
function disconnect(id) {
  const session = sessions.get(id);
  if (session) {
    session.output?.dispose();
    session.ready = false;
    sessions.delete(id);
    updater?.refreshBusy();
    if (session.ftp) {
      session.client.close();
      emit(id, "close", null);
    } else session.client.destroy();
  }
}
function handle(channel, fn, { allowWhileClosing = false } = {}) {
  ipcMain.handle(channel, (event, ...args) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error("非法请求来源");
    }
    if (!allowWhileClosing) quitter.assertOpen();
    return fn(...args);
  });
}

async function connect(id, raw, credentials = {}) {
  updater?.assertCanConnect();
  if (typeof id !== "string" || id.length > 128 || sessions.has(id))
    throw new Error("会话 ID 无效或重复");
  const profile = validate.profile(raw);
  const supplied = relevant(profile, credentials);
  credentials = Object.keys(supplied).length
    ? supplied
    : vault.open(
        savedProfiles.find((p) => p.id === profile.id),
        profile,
      );
  if (["ftp", "ftps"].includes(profile.protocol))
    return connectFTP(id, profile, credentials);
  const client = new Client();
  const session = {
    client,
    ready: false,
    shell: null,
    sftp: null,
    transferring: false,
  };
  sessions.set(id, session);
  updater?.refreshBusy();
  const options = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    readyTimeout: 120000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
    hostHash: "sha256",
    hostVerifier: (hash, callback) => {
      const host = `[${profile.host}]:${profile.port}`;
      const fingerprint = `SHA256:${Buffer.from(hash, "hex").toString("base64").replace(/=+$/, "")}`;
      if (knownHosts[host] === fingerprint) return callback(true);
      const changed = Boolean(knownHosts[host]);
      dialog
        .showMessageBox(window, {
          type: changed ? "warning" : "question",
          title: changed ? "服务器身份发生变化" : "确认服务器身份",
          message: changed
            ? `${host} 的主机密钥与已保存的记录不同`
            : `首次连接到 ${host}`,
          detail: `${changed ? `之前的指纹：${knownHosts[host]}\n\n` : ""}当前指纹：${fingerprint}\n\n请通过可信渠道向服务器管理员核对指纹。${changed ? "这可能是服务器重装，也可能意味着连接被拦截。" : ""}`,
          buttons: ["取消连接", changed ? "确认更换并连接" : "信任并连接"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        .then(async ({ response }) => {
          if (response !== 1 || sessions.get(id) !== session)
            return callback(false);
          await updateConfiguration(async () => {
            await persist("known-hosts.json", {
              ...knownHosts,
              [host]: fingerprint,
            });
            knownHosts[host] = fingerprint;
          });
          callback(true);
        })
        .catch(() => callback(false));
    },
  };
  if (profile.auth === "password") {
    if (typeof credentials.password !== "string" || !credentials.password) {
      disconnect(id);
      throw new Error("请输入密码");
    }
    options.password = credentials.password;
  } else if (profile.auth === "key") {
    try {
      options.privateKey = await fs.readFile(profile.keyPath);
    } catch (error) {
      disconnect(id);
      throw error;
    }
    if (credentials.passphrase) options.passphrase = credentials.passphrase;
  } else {
    if (!process.env.SSH_AUTH_SOCK) {
      disconnect(id);
      throw new Error("未找到 SSH Agent，请先运行 ssh-add 或改用私钥认证");
    }
    options.agent = process.env.SSH_AUTH_SOCK;
  }
  if (sessions.get(id) !== session) throw new Error("连接已取消");
  return new Promise((resolve, reject) => {
    let connected = false;
    client.on("error", (error) => {
      emit(id, "error", error.message);
      if (!connected) reject(error);
      disconnect(id);
    });
    client.on("close", () => {
      session.output?.dispose();
      session.ready = false;
      if (sessions.get(id) === session) sessions.delete(id);
      emit(id, "close", null);
      if (!connected) reject(new Error("连接已关闭"));
    });
    client.on("ready", () => {
      const openFiles = () =>
        client.sftp((sftpError, sftp) => {
          if (sessions.get(id) !== session) return;
          if (sftpError && profile.protocol === "sftp") {
            reject(sftpError);
            disconnect(id);
            return;
          }
          session.ready = true;
          connected = true;
          if (sftpError)
            emit(id, "notice", `SFTP 不可用：${sftpError.message}`);
          else {
            session.sftp = sftp;
            session.files = sftpFiles(sftp);
            sftp.on("error", (error) => {
              session.files = null;
              emit(id, "notice", `SFTP 错误：${error.message}`);
            });
            sftp.on("close", () => {
              session.files = null;
            });
          }
          emit(id, "ready", { sftp: Boolean(sftp) });
          resolve({ sftp: Boolean(sftp) });
        });
      if (profile.protocol === "sftp") {
        openFiles();
        return;
      }
      client.shell(
        { term: "xterm-256color", cols: 100, rows: 30 },
        (error, shell) => {
          if (error) {
            reject(error);
            disconnect(id);
            return;
          }
          if (sessions.get(id) !== session) {
            shell.close();
            return;
          }
          session.shell = shell;
          session.output = new TerminalOutput({
            send: (data) => emit(id, "data", data),
            pause: () => {
              shell.pause();
              shell.stderr.pause();
            },
            resume: () => {
              shell.resume();
              shell.stderr.resume();
            },
          });
          shell.on("data", (data) => session.output.push(data));
          shell.stderr.on("data", (data) => session.output.push(data));
          shell.on("error", (error) => {
            emit(id, "error", error.message);
            disconnect(id);
          });
          shell.on("close", () => disconnect(id));
          openFiles();
        },
      );
    });
    try {
      client.connect(options);
    } catch (error) {
      disconnect(id);
      reject(error);
    }
  });
}

async function connectFTP(id, profile, credentials) {
  if (typeof credentials.password !== "string") throw new Error("请输入密码");
  if (/[\r\n]/.test(profile.username + credentials.password))
    throw new Error("FTP 用户名和密码不能包含换行符");
  const client = new FTPClient(30000);
  const session = { client, ftp: true, ready: false, transferring: false };
  sessions.set(id, session);
  updater?.refreshBusy();
  try {
    await client.access({
      host: profile.host,
      port: profile.port,
      user: profile.username,
      password: credentials.password,
      secure: profile.protocol === "ftps",
      secureOptions: { rejectUnauthorized: true },
    });
    if (sessions.get(id) !== session) {
      client.close();
      throw new Error("连接已取消");
    }
    session.files = ftpFiles(client);
    session.ready = true;
    client.ftp.socket.on("close", () => {
      if (sessions.get(id) === session) {
        sessions.delete(id);
        session.ready = false;
        emit(id, "close", null);
      }
    });
    emit(id, "ready", { sftp: true });
    return { sftp: true };
  } catch (error) {
    disconnect(id);
    throw error;
  }
}
async function withFiles(id, operation) {
  const session = getSession(id);
  if (!session.files) throw new Error("此连接的文件服务不可用");
  if (session.transferring)
    throw new Error("此连接正在进行文件操作，请等待完成");
  session.transferring = true;
  try {
    return await operation(session.files);
  } finally {
    session.transferring = false;
  }
}
function progress(id, name, direction) {
  let last = 0;
  return (transferred, _chunk, total) => {
    const now = Date.now();
    if (now - last > 100 || transferred === total) {
      emit(id, "transfer", {
        name,
        direction,
        transferred,
        total,
        state: "running",
      });
      last = now;
    }
  };
}

function registerIPC() {
  // 纯读取，退出准备期间渲染进程仍需它完成首屏渲染
  handle("theme:get", themeState, { allowWhileClosing: true });
  handle("theme:set", (mode) =>
    updateConfiguration(async () => {
      if (!["system", "light", "dark"].includes(mode))
        throw new Error("主题设置无效");
      const next = { ...preferences, theme: mode };
      await persist("preferences.json", next);
      preferences = next;
      nativeTheme.themeSource = mode;
      publishTheme();
      return themeState();
    }),
  );
  handle("theme:terminal-set", (id) =>
    updateConfiguration(async () => {
      if (!terminalThemeIds.includes(id)) throw new Error("终端配色设置无效");
      const next = { ...preferences, terminalTheme: id };
      await persist("preferences.json", next);
      preferences = next;
      publishTheme();
      return themeState();
    }),
  );
  ipcMain.on("ssh:ack", (event, id, bytes) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      return;
    sessions.get(id)?.output?.acknowledge(bytes);
  });
  handle("profiles:list", profileViews);
  handle("profiles:save", (raw, supplied = {}, remember = false) =>
    updateConfiguration(async () => {
      if (typeof remember !== "boolean") throw new Error("保存凭据选项无效");
      const item = validate.profile(raw);
      const old = savedProfiles.find((p) => p.id === item.id);
      if (remember) {
        const value = relevant(item, supplied);
        const merged = Object.keys(value).length
          ? value
          : vault.open(old, item);
        item.secret = vault.seal(item, merged);
      }
      const next = [...savedProfiles.filter((p) => p.id !== item.id), item];
      if (next.length > 1000) throw new Error("连接总数不能超过 1000");
      await persist("connections.json", next);
      savedProfiles = next;
      return profileViews();
    }),
  );
  handle("profiles:delete", (id) =>
    updateConfiguration(async () => {
      const next = savedProfiles.filter((p) => p.id !== id);
      await persist("connections.json", next);
      savedProfiles = next;
      return profileViews();
    }),
  );
  handle("profiles:export", async (includeCredentials, password) => {
    if (typeof includeCredentials !== "boolean")
      throw new Error("导出选项无效");
    const entries = savedProfiles.map((p) => ({
      profile: validate.profile(p),
      ...(includeCredentials ? { credentials: vault.open(p) } : {}),
    }));
    const text = await encodeBackup(entries, includeCredentials, password);
    if (Buffer.byteLength(text) > MAX_BACKUP)
      throw new Error("备份超过 8 MB，无法导出");
    const choice = await dialog.showSaveDialog(window, {
      title: "导出连接备份",
      defaultPath: `Trident-${new Date().toISOString().slice(0, 10)}${includeCredentials ? "-encrypted" : ""}.json`,
      filters: [{ name: "Trident 备份", extensions: ["json"] }],
    });
    if (choice.canceled || !choice.filePath) return false;
    const temp = `${choice.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, text, { flag: "wx", mode: 0o600 });
      await fs.rename(temp, choice.filePath);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
    return true;
  });
  handle("profiles:prepare-import", async (password) => {
    const choice = await dialog.showOpenDialog(window, {
      title: "选择 Trident 连接备份",
      properties: ["openFile"],
      filters: [{ name: "Trident 备份", extensions: ["json"] }],
    });
    if (choice.canceled) return null;
    const file = await fs.open(choice.filePaths[0], "r");
    let text;
    try {
      if ((await file.stat()).size > MAX_BACKUP)
        throw new Error("备份文件过大（最多 8 MB）");
      const buffer = Buffer.alloc(MAX_BACKUP + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          offset,
          buffer.length - offset,
          null,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > MAX_BACKUP) throw new Error("备份文件过大（最多 8 MB）");
      text = buffer.subarray(0, offset).toString("utf8");
    } finally {
      await file.close();
    }
    const entries = await decodeBackup(text, password);
    pendingImports.clear();
    const token = randomUUID();
    // Re-encrypt immediately: pending confirmations do not retain plaintext credentials.
    const records = entries.map(({ profile, credentials }) => {
      const item = { ...profile, id: randomUUID() };
      return { ...item, secret: vault.seal(item, credentials) };
    });
    pendingImports.set(token, records);
    setTimeout(() => pendingImports.delete(token), 5 * 60 * 1000).unref();
    return { token, profiles: records.map(publicProfile) };
  });
  handle("profiles:commit-import", (token) =>
    updateConfiguration(async () => {
      const records = pendingImports.get(token);
      if (!records) throw new Error("导入预览已过期，请重新选择备份");
      const next = [...savedProfiles, ...records];
      if (next.length > 1000) throw new Error("连接总数不能超过 1000");
      await persist("connections.json", next);
      savedProfiles = next;
      pendingImports.delete(token);
      return profileViews();
    }),
  );
  handle("key:choose", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "选择 SSH 私钥",
      defaultPath: path.join(app.getPath("home"), ".ssh"),
      properties: ["openFile", "showHiddenFiles"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle("ssh:connect", connect);
  handle("ssh:disconnect", disconnect);
  handle("ssh:write", (id, data) => {
    if (typeof data !== "string" || data.length > 1048576)
      throw new Error("终端输入无效或过长");
    const shell = getSession(id).shell;
    if (!shell) throw new Error("此连接没有 SSH 终端");
    shell.write(data);
  });
  handle("ssh:resize", (id, cols, rows) => {
    if (![cols, rows].every((v) => Number.isInteger(v) && v > 0 && v <= 1000))
      return;
    const session = sessions.get(id);
    const size = `${cols}:${rows}`;
    if (session?.ready && session.shell && session.size !== size) {
      session.size = size;
      session.shell.setWindow(rows, cols, 0, 0);
    }
  });
  handle("sftp:list", (id, directory) =>
    withFiles(id, (files) =>
      files.list(directory === null ? null : validate.remotePath(directory)),
    ),
  );
  handle("sftp:mkdir", (id, parent, name) =>
    withFiles(id, (files) =>
      files.mkdir(
        path.posix.join(validate.remotePath(parent), validate.fileName(name)),
      ),
    ),
  );
  handle("files:rename", (id, source, name) =>
    withFiles(id, (files) => {
      const from = validate.remotePath(source);
      if (from === "/") throw new Error("不能重命名根目录");
      const to = path.posix.join(
        path.posix.dirname(from),
        validate.fileName(name),
      );
      if (from === to) return;
      return files.rename(from, to);
    }),
  );
  handle("files:remove", (id, source) =>
    withFiles(id, async (files) => {
      const target = validate.remotePath(source);
      if (target === "/") throw new Error("不能删除根目录");
      const { response } = await dialog.showMessageBox(window, {
        type: "warning",
        message: `永久删除 ${path.posix.basename(target)}？`,
        detail: `${target}\n\n删除后无法从回收站恢复。目录只有在为空时才能删除。`,
        buttons: ["取消", "删除"],
        defaultId: 0,
        cancelId: 0,
      });
      if (response !== 1) return false;
      getSession(id);
      await files.remove(target);
      return true;
    }),
  );
  handle("sftp:upload", (id, directory) =>
    withFiles(id, async (files) => {
      const target = validate.remotePath(directory);
      const choice = await dialog.showOpenDialog(window, {
        title: "选择要上传的文件",
        properties: ["openFile", "multiSelections"],
      });
      if (choice.canceled) return [];
      const completed = [];
      for (const local of choice.filePaths) {
        const name = validate.fileName(path.basename(local));
        const remote = path.posix.join(target, name);
        emit(id, "transfer", {
          name,
          direction: "upload",
          transferred: 0,
          total: 0,
          state: "running",
        });
        try {
          getSession(id);
          await files.upload(local, remote, progress(id, name, "upload"));
          completed.push(name);
          emit(id, "transfer", { name, direction: "upload", state: "done" });
        } catch (error) {
          emit(id, "transfer", { name, direction: "upload", state: "error" });
          throw new Error(
            `${name} 上传失败：${error.message}；如传输已开始，远程可能保留不完整文件`,
          );
        }
      }
      return completed;
    }),
  );
  handle("sftp:download", (id, remote) =>
    withFiles(id, async (files) => {
      const source = validate.remotePath(remote);
      const name = validate.fileName(path.posix.basename(source));
      const choice = await dialog.showSaveDialog(window, {
        title: "下载文件",
        defaultPath: path.join(app.getPath("downloads"), name),
      });
      if (choice.canceled || !choice.filePath) return false;
      const temp = `${choice.filePath}.${randomUUID()}.part`;
      emit(id, "transfer", {
        name,
        direction: "download",
        transferred: 0,
        total: 0,
        state: "running",
      });
      try {
        getSession(id);
        await fs.writeFile(temp, "", { flag: "wx", mode: 0o600 });
        await files.download(source, temp, progress(id, name, "download"));
        await fs.rename(temp, choice.filePath);
        emit(id, "transfer", { name, direction: "download", state: "done" });
        return true;
      } catch (error) {
        await fs.unlink(temp).catch(() => {});
        emit(id, "transfer", { name, direction: "download", state: "error" });
        throw error;
      }
    }),
  );
}

function createWindow() {
  window = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1020,
    minHeight: 680,
    title: "Trident",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111b28" : "#f8f9fc",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 20, y: 10 } }
      : {
          titleBarStyle: "default",
          icon: path.join(__dirname, "../dist/logo.png"),
        }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on("render-process-gone", () => {
    for (const id of sessions.keys()) disconnect(id);
  });
  window.on("close", (event) => {
    if (quitter.prepared) return;
    if (!sessions.size) return;
    const response = dialog.showMessageBoxSync(window, {
      type: "question",
      message: "关闭窗口并断开所有连接？",
      detail: "运行中的远程终端和文件传输会被中断。",
      buttons: ["取消", "断开并关闭"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 0) event.preventDefault();
    else for (const id of sessions.keys()) disconnect(id);
  });
  if (dev) window.loadURL("http://127.0.0.1:5173");
  else window.loadFile(path.join(__dirname, "../dist/index.html"));
}

app
  .whenReady()
  .then(async () => {
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    const savedPreferences = (await readJSON("preferences.json", {})) || {};
    preferences = {
      ...savedPreferences,
      theme: ["system", "light", "dark"].includes(savedPreferences.theme)
        ? savedPreferences.theme
        : "system",
      terminalTheme: terminalThemeIds.includes(savedPreferences.terminalTheme)
        ? savedPreferences.terminalTheme
        : "auto",
    };
    nativeTheme.themeSource = preferences.theme;
    nativeTheme.on("updated", publishTheme);
    savedProfiles = (await readJSON("connections.json", [])).map((record) => ({
      ...validate.profile(record),
      ...(typeof record.secret === "string" ? { secret: record.secret } : {}),
    }));
    knownHosts = await readJSON("known-hosts.json", {});
    registerIPC();
    updater = createUpdater({
      app,
      dialog,
      openExternal: (url) => shell.openExternal(url),
      prepareQuit: quitter.prepare,
      cancelQuit: quitter.cancelPreparation,
      isBusy: () => sessions.size > 0,
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Trident",
          submenu: [
            { role: "about" },
            ...updater.menu(),
            { type: "separator" },
            ...(process.platform === "darwin"
              ? [
                  { role: "services" },
                  { type: "separator" },
                  { role: "hide" },
                  { role: "hideOthers" },
                  { type: "separator" },
                ]
              : []),
            { role: "quit" },
          ],
        },
        {
          label: "编辑",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            {
              role: "copy",
              ...(process.platform === "win32"
                ? { accelerator: "Ctrl+Shift+C" }
                : {}),
            },
            {
              role: "paste",
              ...(process.platform === "win32"
                ? { accelerator: "Ctrl+Shift+V" }
                : {}),
            },
            {
              role: "selectAll",
              ...(process.platform === "win32"
                ? { accelerator: "Ctrl+Shift+A" }
                : {}),
            },
          ],
        },
        {
          label: "显示",
          submenu: [
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { role: "togglefullscreen" },
            ...(dev ? [{ role: "toggleDevTools" }] : []),
          ],
        },
        {
          label: "窗口",
          submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
        },
      ]),
    );
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error) => {
    dialog.showErrorBox("Trident 启动失败", error.message);
    app.quit();
  });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
