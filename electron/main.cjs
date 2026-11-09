const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  nativeTheme,
  shell,
} = require("electron");
// 开发模式直接运行 Electron.app，app.name 默认取 package.json 的 name，统一为产品名以对齐打包版
app.setName("Trident");
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
const vault = makeVault();
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
let quitting = false;
// Cmd+Q / 菜单退出是强制退出：不拦截 before-quit，只记录状态，避免窗口 close
// 处理器在退出过程中再弹一次「断开所有连接？」确认框。落盘由 IPC 处理器自行 await。
app.on("before-quit", () => {
  quitting = true;
});
const quitter = createQuitCoordinator({
  confirm: async () => {
    if (!sessions.size) return true;
    // 异步弹窗：等待用户选择期间主进程保持响应，界面不会被冻结或拒绝请求
    const { response } = await dialog.showMessageBox(window, {
      type: "warning",
      message: "断开所有连接并安装更新？",
      detail:
        "安装更新会中断远程终端和正在传输的文件。可取消，待操作完成后再试。",
      buttons: ["取消", "断开并安装"],
      defaultId: 0,
      cancelId: 0,
    });
    return response === 1;
  },
  flush: async () => {
    await configurationQueue;
    await persistQueue;
  },
  disconnect: () => {
    for (const id of sessions.keys()) disconnect(id);
  },
  showError: (error) =>
    dialog.showErrorBox("无法完成更新", `配置尚未保存：${error.message}`),
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
    const controller = session.transfer;
    if (controller) {
      // 断线视为失败：唤醒暂停等待器并中止当前文件，让 withFiles 释放锁
      controller.disconnected = true;
      controller.paused = false;
      controller.state = "error";
      controller.abort?.abort();
      const wake = controller.wake;
      controller.wake = null;
      wake?.();
      emitTransfer(controller, true);
      session.transfer = null;
    }
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
    return await operation(session.files, session);
  } finally {
    session.transferring = false;
  }
}

const MAX_TRANSFER_ENTRIES = 20000;
const TRANSFER_INTERVAL = 100;
const TERMINAL_STATES = new Set(["done", "error", "cancelled"]);

class TransferCancelled extends Error {
  constructor() {
    super("传输已停止");
    this.name = "TransferCancelled";
  }
}

function resetSpeed(c) {
  c.samples = [{ time: Date.now(), bytes: c.bytes.transferred }];
}
function sampleSpeed(c) {
  const now = Date.now();
  const last = c.samples.at(-1);
  if (!last || last.time !== now)
    c.samples.push({ time: now, bytes: c.bytes.transferred });
  while (c.samples.length > 2 && now - c.samples[0].time > 3000)
    c.samples.shift();
  const first = c.samples[0];
  const span = (now - first.time) / 1000;
  if (span <= 0) return 0;
  return Math.max(0, Math.round((c.bytes.transferred - first.bytes) / span));
}
function transferPayload(c) {
  const terminal = TERMINAL_STATES.has(c.state);
  return {
    name: c.current.name,
    direction: c.direction,
    state: c.state,
    transferred: c.current.transferred,
    total: c.current.total,
    files: { ...c.files },
    dirs: { ...c.dirs },
    bytes: { ...c.bytes },
    speed: terminal || c.state === "paused" ? 0 : sampleSpeed(c),
    discovered: c.discovered,
    elapsed: terminal ? Math.round((Date.now() - c.startedAt) / 1000) : 0,
  };
}
function emitTransfer(c, force = false) {
  const now = Date.now();
  if (!force && now - c.lastEmit < TRANSFER_INTERVAL) return;
  c.lastEmit = now;
  emit(c.id, "transfer", transferPayload(c));
}
function createTransfer(id, session, direction) {
  const c = {
    id,
    direction,
    state: "preparing",
    paused: false,
    cancelled: false,
    disconnected: false,
    abort: null,
    wake: null,
    plan: [],
    partial: [],
    conflict: null,
    discovered: 0,
    startedAt: Date.now(),
    samples: [{ time: Date.now(), bytes: 0 }],
    lastEmit: 0,
    current: { name: "", transferred: 0, total: 0 },
    files: { completed: 0, total: 0, skipped: 0, failed: 0 },
    dirs: { completed: 0, total: 0 },
    bytes: { transferred: 0, total: 0 },
    // 已完成与跳过条目的源字节累计，当前文件进度在此基础上叠加
    baseBytes: 0,
  };
  session.transfer = c;
  emitTransfer(c, true);
  return c;
}
function initializeStats(c) {
  const files = c.plan.filter((entry) => !entry.directory);
  c.files.total = files.length;
  c.bytes.total = files.reduce((sum, entry) => sum + entry.size, 0);
  c.dirs.total = c.plan.length - files.length;
}
function checkCancelled(c) {
  if (c.cancelled) throw new TransferCancelled();
}
async function waitForResume(c) {
  while (c.paused && !c.cancelled) {
    c.state = "paused";
    emitTransfer(c, true);
    await new Promise((resolve) => {
      c.wake = resolve;
    });
    c.wake = null;
  }
  checkCancelled(c);
  if (c.state === "paused") {
    c.state = "running";
    resetSpeed(c);
    emitTransfer(c, true);
  }
}
async function skipConflict(c, entry, detail) {
  if (!c.conflict) {
    // 批量传输逐文件询问不可用：首次冲突时询问一次并作用于整批
    const { response } = await dialog.showMessageBox(window, {
      type: "warning",
      title: "同名文件",
      message: `${entry.name} 已存在`,
      detail: `${detail}「跳过所有同名文件并继续」将跳过本次传输中所有已存在的文件，不再逐个询问。`,
      buttons: ["跳过所有同名文件并继续", "停止传输"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) {
      c.cancelled = true;
      throw new TransferCancelled();
    }
    c.conflict = "skip";
  }
  c.files.skipped += 1;
  c.baseBytes += entry.size;
  c.bytes.transferred = c.baseBytes;
  c.current = { name: entry.name, transferred: entry.size, total: entry.size };
  emitTransfer(c, true);
}
async function runTransfer(session, c, execute) {
  try {
    const result = await execute();
    if (c.state !== "cancelled") {
      c.paused = false;
      c.state = "done";
      emitTransfer(c, true);
    }
    return result;
  } catch (error) {
    if (error instanceof TransferCancelled || c.cancelled) {
      c.paused = false;
      c.state = "cancelled";
      emitTransfer(c, true);
      return c.direction === "upload" ? c.partial : false;
    }
    c.paused = false;
    c.state = "error";
    emitTransfer(c, true);
    throw error;
  } finally {
    if (session.transfer === c) session.transfer = null;
    c.abort = null;
    if (c.wake) {
      const wake = c.wake;
      c.wake = null;
      wake();
    }
  }
}

async function collectUploadEntries(source, c) {
  let stat;
  try {
    stat = await fs.lstat(source);
  } catch {
    throw new Error(`无法读取本地文件：${source}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`不支持上传符号链接：${source}`);
  const add = (entry) => {
    checkCancelled(c);
    c.plan.push(entry);
    c.discovered = c.plan.length;
    if (c.plan.length > MAX_TRANSFER_ENTRIES)
      throw new Error(`单次上传不能超过 ${MAX_TRANSFER_ENTRIES} 个文件和目录`);
    emitTransfer(c);
  };
  const name = validate.fileName(path.basename(source));
  if (stat.isFile()) {
    add({ local: source, name, size: stat.size });
    return;
  }
  if (!stat.isDirectory())
    throw new Error(`仅支持上传普通文件或文件夹：${source}`);
  add({ local: source, name, directory: true });
  async function walk(directory, relative) {
    let items;
    try {
      items = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      throw new Error(`无法读取本地目录：${directory}`);
    }
    for (const item of items) {
      checkCancelled(c);
      // 不跟随符号链接，避免目录环和超出用户可见范围
      if (item.isSymbolicLink()) continue;
      const local = path.join(directory, item.name);
      const entry = `${relative}/${validate.fileName(item.name)}`;
      if (item.isDirectory()) {
        add({ local, name: entry, directory: true });
        await walk(local, entry);
      } else if (item.isFile()) {
        add({ local, name: entry, size: (await fs.lstat(local)).size });
      }
    }
  }
  await walk(source, name);
}

async function runUploadFile(files, c, entry) {
  let resumed = false;
  for (;;) {
    checkCancelled(c);
    let start = 0;
    if (resumed) {
      const remoteSize = await files.size(entry.remote);
      if (remoteSize != null && remoteSize >= entry.size) return;
      if (remoteSize === 0) {
        // 暂停时尚未写入任何字节，远端留下了空文件，重新独占创建
        await files.remove(entry.remote).catch(() => {});
      } else if (remoteSize != null) start = remoteSize;
      c.current = { name: entry.name, transferred: start, total: entry.size };
      c.bytes.transferred = c.baseBytes + start;
      emitTransfer(c, true);
      await waitForResume(c);
    } else {
      c.current = { name: entry.name, transferred: 0, total: entry.size };
      c.bytes.transferred = c.baseBytes;
      emitTransfer(c, true);
    }
    const abort = new AbortController();
    c.abort = abort;
    const report = (transferred, total) => {
      c.current = {
        name: entry.name,
        transferred,
        total: total || entry.size,
      };
      c.bytes.transferred = c.baseBytes + transferred;
      emitTransfer(c);
    };
    try {
      await files.upload(entry.local, entry.remote, report, {
        signal: abort.signal,
        start,
      });
      return;
    } catch (error) {
      if (c.cancelled) {
        // 当前远程文件由本次任务独占创建，尽力删除不完整内容
        await files.remove(entry.remote).catch(() => {});
        throw new TransferCancelled();
      }
      if (c.paused) {
        resumed = true;
        continue;
      }
      throw error;
    } finally {
      if (c.abort === abort) c.abort = null;
    }
  }
}

async function uploadSources(files, target, sources, c) {
  for (const source of sources) await collectUploadEntries(source, c);
  for (const entry of c.plan)
    entry.remote = validate.remotePath(path.posix.join(target, entry.name));
  initializeStats(c);
  await waitForResume(c);
  c.state = "running";
  resetSpeed(c);
  emitTransfer(c, true);
  for (const entry of c.plan) {
    checkCancelled(c);
    await waitForResume(c);
    if (entry.directory) {
      try {
        await files.ensureDirectory(entry.remote);
      } catch (error) {
        throw new Error(`${entry.name} 目录创建失败：${error.message}`);
      }
      c.dirs.completed += 1;
      emitTransfer(c);
      continue;
    }
    if (await files.exists(entry.remote)) {
      await skipConflict(c, entry, "远程目录中已存在同名文件。");
      continue;
    }
    try {
      await runUploadFile(files, c, entry);
    } catch (error) {
      if (error instanceof TransferCancelled) throw error;
      c.files.failed += 1;
      throw new Error(
        `${entry.name} 上传失败：${error.message}；如传输已开始，远程可能保留不完整文件`,
      );
    }
    c.files.completed += 1;
    c.baseBytes += entry.size;
    c.bytes.transferred = c.baseBytes;
    c.current = {
      name: entry.name,
      transferred: entry.size,
      total: entry.size,
    };
    emitTransfer(c, true);
    c.partial.push(entry.name);
  }
  return c.partial;
}

function resolveLocalPath(root, relative) {
  const base = path.resolve(root);
  if (!relative) return base;
  const local = path.resolve(base, ...relative.split("/"));
  if (local !== base && !local.startsWith(base + path.sep))
    throw new Error(`远程文件名不安全：${relative}`);
  return local;
}

async function collectDownloadEntries(files, source, c, root) {
  const add = (entry) => {
    checkCancelled(c);
    entry.local = resolveLocalPath(root, entry.relative);
    c.plan.push(entry);
    c.discovered = c.plan.length;
    if (c.plan.length > MAX_TRANSFER_ENTRIES)
      throw new Error(`单次下载不能超过 ${MAX_TRANSFER_ENTRIES} 个文件和目录`);
    emitTransfer(c);
  };
  add({
    relative: "",
    name: validate.fileName(path.posix.basename(source)),
    directory: true,
    remote: source,
  });
  async function walk(remoteDir, relative) {
    checkCancelled(c);
    const listing = await files.list(remoteDir);
    for (const item of listing.files) {
      checkCancelled(c);
      // 每个远程条目名必须是单一文件名，路径拼接后再校验仍在目标根目录内
      const name = validate.fileName(item.name);
      const child = relative ? `${relative}/${name}` : name;
      const remote = path.posix.join(listing.path, name);
      if (item.symlink) continue;
      if (item.directory) {
        add({ relative: child, name: child, directory: true, remote });
        await walk(remote, child);
      } else {
        add({
          relative: child,
          name: child,
          size: item.size,
          remote,
        });
      }
    }
  }
  await walk(source, "");
}

async function ensureLocalDirectory(local) {
  try {
    await fs.mkdir(local, { mode: 0o700 });
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = await fs.lstat(local);
  if (!info.isDirectory())
    throw new Error(`本地已存在同名文件，无法创建目录：${local}`);
}

async function runDownloadFile(files, c, entry) {
  let resumed = false;
  for (;;) {
    checkCancelled(c);
    let start = 0;
    if (resumed) {
      const size = await fs
        .stat(entry.temp)
        .then((info) => info.size)
        .catch(() => 0);
      if (size >= entry.size) {
        await fs.rename(entry.temp, entry.local);
        return;
      }
      start = size;
      c.current = { name: entry.name, transferred: start, total: entry.size };
      c.bytes.transferred = c.baseBytes + start;
      emitTransfer(c, true);
      await waitForResume(c);
    } else {
      c.current = { name: entry.name, transferred: 0, total: entry.size };
      c.bytes.transferred = c.baseBytes;
      emitTransfer(c, true);
    }
    const abort = new AbortController();
    c.abort = abort;
    const report = (transferred, total) => {
      c.current = {
        name: entry.name,
        transferred,
        total: total || entry.size,
      };
      c.bytes.transferred = c.baseBytes + transferred;
      emitTransfer(c);
    };
    try {
      await files.download(entry.remote, entry.temp, report, {
        signal: abort.signal,
        start,
      });
      await fs.rename(entry.temp, entry.local);
      return;
    } catch (error) {
      if (c.cancelled) {
        await fs.unlink(entry.temp).catch(() => {});
        throw new TransferCancelled();
      }
      if (c.paused) {
        // 暂停保留 .part 临时文件，继续时以实际大小作为偏移
        resumed = true;
        continue;
      }
      await fs.unlink(entry.temp).catch(() => {});
      throw error;
    } finally {
      if (c.abort === abort) c.abort = null;
    }
  }
}

async function downloadPlan(files, c) {
  initializeStats(c);
  await waitForResume(c);
  c.state = "running";
  resetSpeed(c);
  emitTransfer(c, true);
  for (const entry of c.plan) {
    checkCancelled(c);
    await waitForResume(c);
    if (entry.directory) {
      await ensureLocalDirectory(entry.local);
      c.dirs.completed += 1;
      emitTransfer(c);
      continue;
    }
    if (!entry.overwrite) {
      const exists = await fs.lstat(entry.local).then(
        () => true,
        (error) => (error.code === "ENOENT" ? false : Promise.reject(error)),
      );
      if (exists) {
        await skipConflict(c, entry, "本地目标中已存在同名文件。");
        continue;
      }
    }
    entry.temp = `${entry.local}.${randomUUID()}.part`;
    try {
      await runDownloadFile(files, c, entry);
    } catch (error) {
      if (error instanceof TransferCancelled) throw error;
      c.files.failed += 1;
      throw new Error(`${entry.name} 下载失败：${error.message}`);
    }
    c.files.completed += 1;
    c.baseBytes += entry.size;
    c.bytes.transferred = c.baseBytes;
    c.current = {
      name: entry.name,
      transferred: entry.size,
      total: entry.size,
    };
    emitTransfer(c, true);
  }
}

function activeTransfer(id) {
  const c = sessions.get(id)?.transfer;
  if (!c || TERMINAL_STATES.has(c.state)) return null;
  return c;
}
function pauseTransfer(id) {
  const c = activeTransfer(id);
  if (!c) return false;
  if (c.paused) return true;
  c.paused = true;
  if (c.state === "running") c.state = "paused";
  c.abort?.abort();
  const wake = c.wake;
  c.wake = null;
  wake?.();
  emitTransfer(c, true);
  return true;
}
function resumeTransfer(id) {
  const c = activeTransfer(id);
  if (!c) return false;
  if (!c.paused) return true;
  c.paused = false;
  if (c.state === "paused") {
    c.state = "running";
    resetSpeed(c);
  }
  const wake = c.wake;
  c.wake = null;
  wake?.();
  emitTransfer(c, true);
  return true;
}
function cancelTransfer(id) {
  const c = activeTransfer(id);
  if (!c) return false;
  if (c.cancelled) return true;
  c.cancelled = true;
  c.state = "cancelled";
  c.abort?.abort();
  const wake = c.wake;
  c.wake = null;
  wake?.();
  emitTransfer(c, true);
  return true;
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
  handle("sftp:upload", (id, directory, mode = "files") =>
    withFiles(id, async (files, session) => {
      if (mode !== "files" && mode !== "folder")
        throw new Error("上传方式无效");
      const target = validate.remotePath(directory);
      const choice = await dialog.showOpenDialog(window, {
        title: mode === "folder" ? "选择要上传的文件夹" : "选择要上传的文件",
        properties:
          mode === "folder"
            ? ["openDirectory", "multiSelections"]
            : ["openFile", "multiSelections"],
      });
      if (choice.canceled || !choice.filePaths?.length) return [];
      const controller = createTransfer(id, session, "upload");
      return runTransfer(session, controller, () =>
        uploadSources(files, target, choice.filePaths, controller),
      );
    }),
  );
  handle("sftp:upload-paths", (id, directory, sources) =>
    withFiles(id, (files, session) => {
      const target = validate.remotePath(directory);
      const paths = validate.localPaths(sources);
      const controller = createTransfer(id, session, "upload");
      return runTransfer(session, controller, () =>
        uploadSources(files, target, paths, controller),
      );
    }),
  );
  handle("sftp:download", (id, remote) =>
    withFiles(id, async (files, session) => {
      const source = validate.remotePath(remote);
      if (source === "/") throw new Error("不能下载根目录");
      const details = await files.details(source);
      if (!details) throw new Error("远程文件不存在");
      if (details.symlink) throw new Error("符号链接不支持下载");
      const name = validate.fileName(path.posix.basename(source));
      if (details.directory) {
        const choice = await dialog.showOpenDialog(window, {
          title: "选择下载到的文件夹",
          properties: ["openDirectory", "createDirectory"],
        });
        if (choice.canceled || !choice.filePaths?.length) return false;
        const root = path.join(choice.filePaths[0], name);
        const existing = await fs.lstat(root).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (existing && !existing.isDirectory())
          throw new Error("本地已存在同名文件，无法下载目录");
        const controller = createTransfer(id, session, "download");
        return runTransfer(session, controller, async () => {
          // 扫描完成前不创建任何本地目录，失败或停止时不留空目录
          await collectDownloadEntries(files, source, controller, root);
          await downloadPlan(files, controller);
          return true;
        });
      }
      const choice = await dialog.showSaveDialog(window, {
        title: "下载文件",
        defaultPath: path.join(app.getPath("downloads"), name),
      });
      if (choice.canceled || !choice.filePath) return false;
      const controller = createTransfer(id, session, "download");
      return runTransfer(session, controller, async () => {
        controller.plan = [
          {
            relative: path.basename(choice.filePath),
            // 面板显示远程文件名，本地保存名只决定写入位置
            name,
            local: choice.filePath,
            remote: source,
            size: details.size,
            // 保存对话框已显式确认覆盖，不再走批量冲突策略
            overwrite: true,
          },
        ];
        await downloadPlan(files, controller);
        return true;
      });
    }),
  );
  handle("transfer:pause", pauseTransfer);
  handle("transfer:resume", resumeTransfer);
  handle("transfer:cancel", cancelTransfer);
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
    if (quitting || quitter.prepared) return;
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
    await fs.mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
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
      prepareQuit: quitter.prepare,
      cancelQuit: quitter.cancelPreparation,
      isBusy: () => sessions.size > 0,
    });
    app.setAboutPanelOptions({
      applicationName: "Trident",
      applicationVersion: app.getVersion(),
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Trident",
          submenu: [
            process.platform === "darwin"
              ? { role: "about", label: "关于 Trident" }
              : {
                  label: "关于 Trident",
                  click: () => {
                    dialog.showMessageBox(window, {
                      type: "info",
                      title: "Trident",
                      message: "Trident",
                      // Windows 打包版 app.getVersion() 返回 exe 的 4 段 FileVersion（如 0.0.10.0），去掉补位的 .0
                      detail: app.getVersion().replace(/\.0$/, ""),
                    });
                  },
                },
            ...updater.menu(),
            { type: "separator" },
            ...(process.platform === "darwin"
              ? [
                  { role: "services", label: "服务" },
                  { type: "separator" },
                  { role: "hide", label: "隐藏 Trident" },
                  { role: "hideOthers", label: "隐藏其他" },
                  { type: "separator" },
                ]
              : []),
            { role: "quit", label: "退出 Trident" },
          ],
        },
        {
          label: "编辑",
          submenu: [
            { role: "undo", label: "撤销" },
            { role: "redo", label: "重做" },
            { type: "separator" },
            { role: "cut", label: "剪切" },
            {
              role: "copy",
              label: "复制",
              ...(process.platform === "win32"
                ? { accelerator: "Ctrl+Shift+C" }
                : {}),
            },
            {
              role: "paste",
              label: "粘贴",
              ...(process.platform === "win32"
                ? { accelerator: "Ctrl+Shift+V" }
                : {}),
            },
            {
              role: "selectAll",
              label: "全选",
              ...(process.platform === "win32"
                ? { accelerator: "Ctrl+Shift+A" }
                : {}),
            },
          ],
        },
        {
          label: "显示",
          submenu: [
            {
              label: "专注模式",
              accelerator:
                process.platform === "darwin" ? "Command+M" : "Control+Shift+M",
              click: (_item, target) => {
                const win = target ?? BrowserWindow.getFocusedWindow();
                win?.webContents.send("ui:toggle-focus");
              },
            },
            { type: "separator" },
            { role: "resetZoom", label: "实际大小" },
            { role: "zoomIn", label: "放大" },
            { role: "zoomOut", label: "缩小" },
            { role: "togglefullscreen", label: "切换全屏" },
            ...(dev
              ? [{ role: "toggleDevTools", label: "切换开发者工具" }]
              : []),
          ],
        },
        {
          label: "窗口",
          submenu: [
            // minimize role 会强制保留 macOS 的 Cmd+M，改用普通菜单项让位给专注模式
            process.platform === "darwin"
              ? {
                  label: "最小化",
                  accelerator: "Command+Alt+M",
                  click: (_item, target) => {
                    const win = target ?? BrowserWindow.getFocusedWindow();
                    win?.minimize();
                  },
                }
              : { role: "minimize", label: "最小化" },
            { role: "zoom", label: "缩放" },
            { role: "front", label: "前置全部窗口" },
          ],
        },
      ]),
    );
    createWindow();
    app.on("activate", () => {
      // 退出准备完成后不再复活窗口：重新打开只会撞上被拒绝的 IPC 并显示误导性横幅
      if (quitter.prepared) return;
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
