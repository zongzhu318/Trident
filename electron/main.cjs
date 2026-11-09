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
    // 断线视为失败：唤醒暂停等待器并中止全部在途文件与传输任务
    for (const controller of session.transfers.values()) {
      controller.disconnected = true;
      controller.paused = false;
      controller.state = "error";
      controller.error ??= new Error("连接已断开");
      abortAll(controller);
      wakeAll(controller);
      emitTransfer(controller, true);
    }
    session.transfers.clear();
    session.output?.dispose();
    session.ready = false;
    sessions.delete(id);
    updater?.refreshBusy();
    if (session.ftp) {
      closeFTPPool(session);
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
    transfers: new Map(),
    files: null,
    controlFiles: null,
    limiter: null,
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
      // 非预期断线也走统一清理：标记全部任务失败并唤醒暂停/等待中的文件操作
      disconnect(id);
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
            session.controlFiles = session.files;
            // 多任务共享同一条 SFTP 通道，用会话级槽位限制总并发句柄数
            session.limiter = createLimiter(SFTP_SMALL_CONCURRENCY);
            sftp.on("error", (error) => {
              session.files = null;
              session.controlFiles = null;
              emit(id, "notice", `SFTP 错误：${error.message}`);
            });
            sftp.on("close", () => {
              session.files = null;
              session.controlFiles = null;
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
  const session = {
    id,
    client,
    ftp: true,
    ready: false,
    transfers: new Map(),
    // 仅驻留内存：连接池重连需要凭据；会话删除即释放，不落盘
    ftpAccess: null,
    ftpPool: createFTPPool(),
    // basic-ftp 单连接不支持并发命令；主连接的操作统一走这把锁
    controlLock: createMutex(),
  };
  sessions.set(id, session);
  updater?.refreshBusy();
  try {
    const access = {
      host: profile.host,
      port: profile.port,
      user: profile.username,
      password: credentials.password,
      secure: profile.protocol === "ftps",
      secureOptions: { rejectUnauthorized: true },
    };
    await client.access(access);
    if (sessions.get(id) !== session) {
      client.close();
      throw new Error("连接已取消");
    }
    session.ftpAccess = access;
    session.files = ftpFiles(client);
    session.controlFiles = serializedFiles(session.files, session.controlLock);
    session.ready = true;
    client.ftp.socket.on("close", () => {
      if (sessions.get(id) === session) disconnect(id);
    });
    emit(id, "ready", { sftp: true });
    return { sftp: true };
  } catch (error) {
    disconnect(id);
    throw error;
  }
}
function createMutex() {
  let tail = Promise.resolve();
  return (operation) => {
    const task = tail.catch(() => {}).then(operation);
    tail = task.catch(() => {});
    return task;
  };
}
// 多任务可同时请求文件对话框，逐个弹出避免平台限制
const withDialog = createMutex();
// basic-ftp 单条控制连接不支持并发命令，逐方法串行化主连接上的操作
function serializedFiles(files, lock) {
  return new Proxy(
    {},
    {
      get(_target, method) {
        const value = files[method];
        if (typeof value !== "function") return value;
        return (...args) => lock(() => value.apply(files, args));
      },
    },
  );
}
function createLimiter(max) {
  return { max, active: 0, waiters: new Set() };
}
function createFTPPool() {
  return {
    clients: new Set(),
    idle: [],
    waiters: new Set(),
    building: 0,
    failed: false,
  };
}
function wakeFTPPool(pool) {
  const waiters = [...pool.waiters];
  pool.waiters.clear();
  for (const wake of waiters) wake();
}
function closeFTPPool(session) {
  const pool = session.ftpPool;
  if (!pool) return;
  for (const client of pool.clients) client.close();
  pool.clients.clear();
  pool.idle.length = 0;
  wakeFTPPool(pool);
}
function closeFTPPoolIfIdle(session) {
  if (!session?.ftpPool || session.transfers.size) return;
  closeFTPPool(session);
}
async function acquireFTPClient(session, c) {
  for (;;) {
    checkCancelled(c);
    if (c.paused) {
      await waitForResume(c);
      continue;
    }
    const pool = session.ftpPool;
    for (;;) {
      const client = pool.idle.pop();
      if (!client) break;
      if (client.closed) pool.clients.delete(client);
      else return client;
    }
    if (!pool.failed && pool.clients.size + pool.building < FTP_CONCURRENCY) {
      pool.building += 1;
      const client = new FTPClient(30000);
      try {
        await client.access(session.ftpAccess);
        if (sessions.get(session.id) !== session || !session.ready)
          throw new Error("连接已关闭");
        pool.clients.add(client);
        return client;
      } catch {
        // 服务器限制连接数时停止扩容，使用已建立的连接或回退主连接
        pool.failed = true;
        client.close();
      } finally {
        pool.building -= 1;
        wakeFTPPool(pool);
      }
      continue;
    }
    // 零连接且无法再扩容：回退主连接串行；否则等待已有连接归还
    if (!pool.clients.size && !pool.building) return null;
    await waitOnTransfer(c, pool.waiters);
  }
}
function releaseFTPClient(session, client) {
  const pool = session.ftpPool;
  if (!pool || sessions.get(session.id) !== session || client.closed) {
    pool?.clients.delete(client);
    client.close();
    wakeFTPPool(pool);
    return;
  }
  if (!pool.idle.includes(client)) pool.idle.push(client);
  wakeFTPPool(pool);
}
async function withFTPLane(session, c, operation) {
  const client = await acquireFTPClient(session, c);
  if (!client) return operation(session.controlFiles);
  try {
    return await operation(ftpFiles(client));
  } finally {
    releaseFTPClient(session, client);
  }
}
async function withSFTPFiles(session, c, operation) {
  const limiter = session.limiter;
  if (!limiter) return operation(session.controlFiles);
  const release = await acquireSlot(limiter, c);
  try {
    return await operation(session.files);
  } finally {
    release();
  }
}
// 所有文件操作不再互斥：传输任务共享连接资源，浏览与改名/删除走主连接
async function withFiles(id, operation) {
  const session = getSession(id);
  if (!session.files) throw new Error("此连接的文件服务不可用");
  return operation(session.controlFiles, session);
}

const MAX_TRANSFER_ENTRIES = 20000;
const TRANSFER_INTERVAL = 100;
const SFTP_CONCURRENCY = 4;
// 小文件主要受往返延迟限制，可安全提高并发；大文件仍用较低并发避免争抢带宽
const SFTP_SMALL_CONCURRENCY = 16;
const SFTP_SMALL_FILE_LIMIT = 1024 * 1024;
const FTP_CONCURRENCY = 3;
// 部分 SFTP 服务器在并发句柄过多或瞬时繁忙时返回 SSH_FX_FAILURE；短暂退避后按已写入偏移重试
const SFTP_RETRY_LIMIT = 2;
const SFTP_RETRY_DELAY = 150;
const TERMINAL_STATES = new Set(["done", "error", "cancelled"]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function shouldRetrySftp(c, error, attempts) {
  return !c.session?.ftp && error?.code === 4 && attempts < SFTP_RETRY_LIMIT;
}
// 目录扫描与文件读写同样可能遇到瞬时 SSH_FX_FAILURE，按相同策略退避重试
async function retrySftp(c, operation) {
  let attempts = 0;
  for (;;) {
    checkCancelled(c);
    try {
      return await operation();
    } catch (error) {
      if (!shouldRetrySftp(c, error, attempts)) throw error;
      attempts += 1;
      await delay(SFTP_RETRY_DELAY * attempts);
    }
  }
}

class TransferCancelled extends Error {
  constructor() {
    super("传输已停止");
    this.name = "TransferCancelled";
  }
}

// 文件因同名冲突被跳过：不计入完成、失败或部分上传结果
class TransferSkipped extends Error {
  constructor() {
    super("文件已跳过");
    this.name = "TransferSkipped";
  }
}

function abortAll(c) {
  for (const abort of c.aborts) abort.abort();
}
function wakeAll(c) {
  const wakes = [...c.wakes];
  c.wakes.clear();
  for (const wake of wakes) wake();
}
// 等待资源期间也要响应暂停 / 继续 / 停止：停止时唤醒并抛 TransferCancelled
function waitOnTransfer(c, ...sets) {
  return new Promise((resolve) => {
    const done = () => {
      c.wakes.delete(done);
      for (const set of sets) set.delete(done);
      resolve();
    };
    for (const set of sets) set.add(done);
    c.wakes.add(done);
  });
}
async function acquireSlot(limiter, c) {
  for (;;) {
    checkCancelled(c);
    if (c.paused) {
      await waitForResume(c);
      continue;
    }
    if (limiter.active < limiter.max) {
      limiter.active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        limiter.active -= 1;
        const waiters = [...limiter.waiters];
        limiter.waiters.clear();
        for (const wake of waiters) wake();
      };
    }
    await waitOnTransfer(c, limiter.waiters);
  }
}
function syncBytes(c) {
  let transferred = c.completedBytes;
  for (const item of c.active.values()) transferred += item.transferred;
  c.bytes.transferred = transferred;
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
  const speed = terminal || c.state === "paused" ? 0 : sampleSpeed(c);
  const remainingBytes = Math.max(0, c.bytes.total - c.bytes.transferred);
  return {
    taskId: c.taskId,
    // 任务标题保持稳定的顶层名称，不随当前处理的文件变化
    name: c.name,
    file: c.current.name,
    direction: c.direction,
    state: c.state,
    transferred: c.current.transferred,
    total: c.current.total,
    active: c.active.size,
    files: { ...c.files },
    dirs: { ...c.dirs },
    bytes: { ...c.bytes },
    speed,
    // 剩余时间按最近数秒速率估算；速率未知、暂停或已结束时不给估计值
    eta:
      !terminal && c.state !== "paused" && speed > 0 && remainingBytes > 0
        ? Math.ceil(remainingBytes / speed)
        : null,
    discovered: c.discovered,
    elapsed: terminal ? Math.round((Date.now() - c.startedAt) / 1000) : 0,
    error: c.state === "error" ? (c.error?.message ?? "传输失败") : null,
  };
}
function emitTransfer(c, force = false) {
  const now = Date.now();
  if (!force && now - c.lastEmit < TRANSFER_INTERVAL) return;
  c.lastEmit = now;
  emit(c.id, "transfer", transferPayload(c));
}
// 多选时用首项加数量代表整批上传，避免任务标题随当前文件变化
function transferTitle(sources) {
  if (!sources.length) return "上传";
  const first = path.basename(sources[0]);
  return sources.length > 1 ? `${first} 等 ${sources.length} 项` : first;
}
function createTransfer(id, session, direction, name) {
  const c = {
    id,
    taskId: randomUUID(),
    session,
    direction,
    name,
    state: "preparing",
    paused: false,
    cancelled: false,
    disconnected: false,
    stopping: false,
    error: null,
    // 每个 worker 与每个文件尝试各自持有 AbortController
    aborts: new Set(),
    wakes: new Set(),
    plan: [],
    partial: [],
    conflict: null,
    conflictAsk: null,
    discovered: 0,
    startedAt: Date.now(),
    samples: [{ time: Date.now(), bytes: 0 }],
    lastEmit: 0,
    current: { name: "", transferred: 0, total: 0 },
    // 在途文件：整体字节 = completedBytes + 全部 active 的 transferred
    active: new Map(),
    completedBytes: 0,
    files: { completed: 0, total: 0, skipped: 0, failed: 0 },
    dirs: { completed: 0, total: 0 },
    bytes: { transferred: 0, total: 0 },
  };
  // 每个文件尝试都从会话共享资源中取一条流：FTP 复用连接池，SFTP 用槽位限流
  c.runFiles = (operation) =>
    session.ftp
      ? withFTPLane(session, c, operation)
      : withSFTPFiles(session, c, operation);
  session.transfers.set(c.taskId, c);
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
  if (c.cancelled || c.disconnected) throw new TransferCancelled();
}
async function waitForResume(c) {
  while (c.paused && !c.cancelled) {
    if (c.state !== "paused") {
      c.state = "paused";
      emitTransfer(c, true);
    }
    await new Promise((resolve) => {
      c.wakes.add(resolve);
    });
  }
  checkCancelled(c);
  if (c.state === "paused") {
    c.state = "running";
    resetSpeed(c);
    emitTransfer(c, true);
  }
}
async function skipConflict(c, entry, detail) {
  checkCancelled(c);
  if (!c.conflict) {
    // 并发 worker 共享同一次询问：只有第一个冲突创建弹窗，其余等待同一结果
    if (!c.conflictAsk) {
      c.conflictAsk = (async () => {
        try {
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
            abortAll(c);
            wakeAll(c);
            throw new TransferCancelled();
          }
          c.conflict = "skip";
        } finally {
          c.conflictAsk = null;
        }
      })();
    }
    await c.conflictAsk;
  }
  c.files.skipped += 1;
  c.completedBytes += entry.size;
  c.current = { name: entry.name, transferred: entry.size, total: entry.size };
  syncBytes(c);
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
    const failure =
      error instanceof Error ? error : new Error(String(error));
    if (c.disconnected) {
      c.paused = false;
      c.error ??= new Error("连接已断开");
      c.state = "error";
      emitTransfer(c, true);
      throw error instanceof TransferCancelled ? c.error : error;
    }
    if (error instanceof TransferCancelled || c.cancelled) {
      c.paused = false;
      c.state = "cancelled";
      emitTransfer(c, true);
      return c.direction === "upload" ? c.partial : false;
    }
    c.paused = false;
    c.error ??= failure;
    c.state = "error";
    emitTransfer(c, true);
    throw error;
  } finally {
    session.transfers.delete(c.taskId);
    closeFTPPoolIfIdle(session);
    c.aborts.clear();
    wakeAll(c);
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

function setActive(c, entry, transferred) {
  c.active.set(entry, {
    name: entry.name,
    transferred,
    total: entry.size,
  });
  c.current = {
    name: entry.name,
    transferred,
    total: entry.size,
  };
  syncBytes(c);
}
function reportActive(c, entry, transferred, total) {
  const item = c.active.get(entry);
  if (!item) return;
  item.transferred = transferred;
  item.total = total || entry.size;
  c.current = {
    name: item.name,
    transferred,
    total: item.total,
  };
  syncBytes(c);
  emitTransfer(c);
}
async function cleanupPartial(session, c, entry) {
  if (c.direction === "upload") {
    // 只有本次真正打开/创建过远程文件时才清理，避免误删已存在的同名文件
    if (entry.remote && entry.remoteTouched && session?.controlFiles)
      await session.controlFiles.remove(entry.remote).catch(() => {});
  } else if (entry.temp) {
    await fs.unlink(entry.temp).catch(() => {});
  }
}

async function runUploadFile(c, entry) {
  let resumed = false;
  let attempts = 0;
  for (;;) {
    checkCancelled(c);
    await waitForResume(c);
    let start = 0;
    if (resumed) {
      const remoteSize = await c.runFiles((files) => files.size(entry.remote));
      if (remoteSize != null && remoteSize >= entry.size) return;
      if (remoteSize === 0) {
        // 暂停时尚未写入任何字节，远端留下了空文件，重新独占创建
        await c.runFiles((files) => files.remove(entry.remote).catch(() => {}));
      } else if (remoteSize != null) start = remoteSize;
      setActive(c, entry, start);
      emitTransfer(c, true);
    } else {
      setActive(c, entry, 0);
      emitTransfer(c, true);
    }
    const abort = new AbortController();
    c.aborts.add(abort);
    const report = (transferred, total) =>
      reportActive(c, entry, transferred, total);
    try {
      await c.runFiles((files) =>
        files.upload(entry.local, entry.remote, report, {
          signal: abort.signal,
          start,
          onOpen: () => {
            entry.remoteTouched = true;
          },
        }),
      );
      return;
    } catch (error) {
      if (c.cancelled || c.stopping) {
        // 停止或同批其它文件失败：仅尽力删除本次真正创建的不完整内容
        const files = c.session.controlFiles;
        if (entry.remoteTouched && files)
          await files.remove(entry.remote).catch(() => {});
        throw new TransferCancelled();
      }
      if (c.disconnected) throw error;
      // 暂停的 abort 可能到 resume 之后才抛错，以本次尝试的 signal 为准
      if (abort.signal.aborted || c.paused) {
        resumed = true;
        continue;
      }
      // 已开始写入后服务端瞬时失败：退避后从远端已写入偏移续传
      if (
        entry.remoteTouched &&
        !error.sftpOpenFailed &&
        shouldRetrySftp(c, error, attempts)
      ) {
        attempts += 1;
        await delay(SFTP_RETRY_DELAY * attempts);
        resumed = true;
        continue;
      }
      throw error;
    } finally {
      c.aborts.delete(abort);
    }
  }
}

// 小文件批次按 1 MiB 平均大小判断，避免为混合批次过度并发
function sftpConcurrency(entries) {
  if (entries.length <= SFTP_CONCURRENCY) return SFTP_CONCURRENCY;
  const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  return bytes <= entries.length * SFTP_SMALL_FILE_LIMIT
    ? SFTP_SMALL_CONCURRENCY
    : SFTP_CONCURRENCY;
}

async function runFileWorkers(c, entries, limit, task) {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, entries.length) },
    async () => {
      for (;;) {
        if (c.error || c.cancelled || c.stopping) return;
        await waitForResume(c);
        if (c.error || c.cancelled || c.stopping) return;
        const index = next;
        next += 1;
        if (index >= entries.length) return;
        // 实际连接/句柄由 c.runFiles 从会话共享资源中租借，多个任务公平分享
        await task(entries[index]);
      }
    },
  );
  await Promise.allSettled(workers);
  if (c.error) throw c.error;
  checkCancelled(c);
}

// 同层目录互不依赖，按层并发创建，父目录必然先于子目录完成
async function createDirectories(c, directories, limit, create) {
  const levels = new Map();
  for (const entry of directories) {
    const depth = entry.name.split("/").length;
    const level = levels.get(depth);
    if (level) level.push(entry);
    else levels.set(depth, [entry]);
  }
  for (const depth of [...levels.keys()].sort((a, b) => a - b)) {
    const level = levels.get(depth);
    let next = 0;
    let failure = null;
    const workers = Array.from(
      { length: Math.min(limit, level.length) },
      async () => {
        for (;;) {
          if (failure || c.cancelled) return;
          await waitForResume(c);
          if (failure || c.cancelled) return;
          const index = next;
          next += 1;
          if (index >= level.length) return;
          const entry = level[index];
          try {
            await create(entry);
          } catch (error) {
            if (!failure)
              failure = new Error(
                `${entry.name} 目录创建失败：${error.message}`,
              );
            return;
          }
          c.dirs.completed += 1;
          emitTransfer(c);
        }
      },
    );
    const results = await Promise.allSettled(workers);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
    if (failure) throw failure;
    checkCancelled(c);
  }
}

// POSIX 单引号转义：路径可包含空格、引号与 shell 元字符
function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function runRemoteCommand(client, command, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let channel = null;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => {
      channel?.destroy();
      settle(new Error("远程命令超时"));
    }, timeout);
    client.exec(command, (error, stream) => {
      channel = stream;
      if (error) return settle(error);
      let stderr = "";
      let code = null;
      stream.on("data", () => {});
      stream.stderr.on("data", (chunk) => {
        if (stderr.length < 4096) stderr += chunk;
      });
      stream.on("exit", (exitCode) => {
        code = exitCode;
      });
      stream.on("error", (streamError) => settle(streamError));
      stream.on("close", () => {
        if (code === 0) settle();
        else
          settle(
            new Error(stderr.trim() || `远程命令退出码 ${code ?? "未知"}`),
          );
      });
    });
  });
}

// 一次 mkdir -p 创建整棵目录树；命令被拒绝或未生效时回退逐目录创建
async function execDirectories(session, c, directories) {
  const chunks = [];
  let chunk = [];
  let length = 0;
  for (const entry of directories) {
    const arg = shellQuote(entry.remote);
    if (chunk.length && length + arg.length > 16384) {
      chunks.push(chunk);
      chunk = [];
      length = 0;
    }
    chunk.push(arg);
    length += arg.length + 1;
  }
  if (chunk.length) chunks.push(chunk);
  try {
    let completed = 0;
    for (const args of chunks) {
      checkCancelled(c);
      await waitForResume(c);
      await runRemoteCommand(session.client, `mkdir -p ${args.join(" ")}`);
      completed += args.length;
      c.dirs.completed = completed;
      emitTransfer(c);
    }
    // 某些服务器会以 0 退出但实际未执行命令（如 ForceCommand），抽查最深目录兜底
    const deepest = directories.at(-1);
    const verified = await session.files.details(deepest.remote).then(
      (item) => Boolean(item?.directory),
      () => false,
    );
    if (verified) {
      c.dirs.completed = directories.length;
      emitTransfer(c, true);
      return;
    }
  } catch (error) {
    if (c.cancelled || c.error) throw error;
  }
  // 回退路径会重新确保全部目录，已存在的目录按合并处理
  c.dirs.completed = 0;
  await createDirectories(c, directories, SFTP_CONCURRENCY, (entry) =>
    c.runFiles((files) => files.ensureDirectory(entry.remote)),
  );
}

async function runFileTask(c, entry, failure, transfer) {
  try {
    await transfer();
  } catch (error) {
    if (error instanceof TransferCancelled) throw error;
    if (error instanceof TransferSkipped) {
      c.active.delete(entry);
      syncBytes(c);
      return false;
    }
    // 另一个 worker 已经记录了首个错误：按停止路径清理后退出，不覆盖错误
    if (c.error) {
      await cleanupPartial(c.session, c, entry);
      throw new TransferCancelled();
    }
    c.files.failed += 1;
    c.error = new Error(failure(error));
    c.stopping = true;
    abortAll(c);
    throw c.error;
  }
  c.files.completed += 1;
  c.completedBytes += entry.size;
  c.active.delete(entry);
  c.current = {
    name: entry.name,
    transferred: entry.size,
    total: entry.size,
  };
  syncBytes(c);
  emitTransfer(c, true);
  return true;
}

async function uploadSources(files, target, sources, c, session) {
  for (const source of sources) await collectUploadEntries(source, c);
  for (const entry of c.plan)
    entry.remote = validate.remotePath(path.posix.join(target, entry.name));
  initializeStats(c);
  await waitForResume(c);
  c.state = "running";
  resetSpeed(c);
  emitTransfer(c, true);
  const directories = c.plan.filter((entry) => entry.directory);
  const pending = c.plan.filter((entry) => !entry.directory);
  if (directories.length) {
    if (!session?.ftp && session?.client && session?.sftp)
      await execDirectories(session, c, directories);
    else
      // FTP 主连接同一时刻只能执行一条命令，并发不会更快
      await createDirectories(
        c,
        directories,
        session?.ftp ? 1 : SFTP_CONCURRENCY,
        (entry) =>
          session?.ftp
            ? files.ensureDirectory(entry.remote)
            : c.runFiles((target) => target.ensureDirectory(entry.remote)),
      );
  }
  if (pending.length) {
    const limit = session?.ftp ? FTP_CONCURRENCY : sftpConcurrency(pending);
    await runFileWorkers(c, pending, limit, async (entry) => {
      // FTP 的 STOR 会直接覆盖，必须先确认同名冲突
      if (
        session?.ftp &&
        (await c.runFiles((target) => target.exists(entry.remote)))
      ) {
        await skipConflict(c, entry, "远程目录中已存在同名文件。");
        return;
      }
      const completed = await runFileTask(
        c,
        entry,
        (error) =>
          `${entry.name} 上传失败：${error.message}；如传输已开始，远程可能保留不完整文件`,
        async () => {
          try {
            await runUploadFile(c, entry);
          } catch (error) {
            if (error instanceof TransferCancelled) throw error;
            // 独占创建在写入前失败时再确认同名冲突，正常文件省去一次 lstat 往返
            if (
              error.sftpOpenFailed &&
              (await c
                .runFiles((target) => target.exists(entry.remote))
                .catch(() => false))
            ) {
              c.active.delete(entry);
              syncBytes(c);
              await skipConflict(c, entry, "远程目录中已存在同名文件。");
              throw new TransferSkipped();
            }
            throw error;
          }
        },
      );
      if (completed) c.partial.push(entry.name);
    });
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
    const listing = await retrySftp(c, () => files.list(remoteDir));
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

async function runDownloadFile(c, entry) {
  let resumed = false;
  let attempts = 0;
  for (;;) {
    checkCancelled(c);
    await waitForResume(c);
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
      setActive(c, entry, start);
      emitTransfer(c, true);
    } else {
      setActive(c, entry, 0);
      emitTransfer(c, true);
    }
    const abort = new AbortController();
    c.aborts.add(abort);
    const report = (transferred, total) =>
      reportActive(c, entry, transferred, total);
    try {
      await c.runFiles((files) =>
        files.download(entry.remote, entry.temp, report, {
          signal: abort.signal,
          start,
        }),
      );
      await fs.rename(entry.temp, entry.local);
      return;
    } catch (error) {
      if (c.cancelled || c.stopping) {
        await fs.unlink(entry.temp).catch(() => {});
        throw new TransferCancelled();
      }
      if (c.disconnected) {
        await fs.unlink(entry.temp).catch(() => {});
        throw error;
      }
      // 暂停的 abort 可能到 resume 之后才抛错，以本次尝试的 signal 为准
      if (abort.signal.aborted || c.paused) {
        // 暂停保留 .part 临时文件，继续时以实际大小作为偏移
        resumed = true;
        continue;
      }
      // 服务端瞬时失败：退避后从本地临时文件已写入偏移续传
      if (shouldRetrySftp(c, error, attempts)) {
        attempts += 1;
        await delay(SFTP_RETRY_DELAY * attempts);
        resumed = true;
        continue;
      }
      await fs.unlink(entry.temp).catch(() => {});
      throw error;
    } finally {
      c.aborts.delete(abort);
    }
  }
}

async function downloadPlan(files, c, session) {
  initializeStats(c);
  await waitForResume(c);
  c.state = "running";
  resetSpeed(c);
  emitTransfer(c, true);
  const directories = c.plan.filter((entry) => entry.directory);
  const pending = c.plan.filter((entry) => !entry.directory);
  for (const entry of directories) {
    checkCancelled(c);
    await waitForResume(c);
    await ensureLocalDirectory(entry.local);
    c.dirs.completed += 1;
    emitTransfer(c);
  }
  if (pending.length) {
    const limit = session?.ftp ? FTP_CONCURRENCY : sftpConcurrency(pending);
    await runFileWorkers(c, pending, limit, async (entry) => {
      if (!entry.overwrite) {
        const exists = await fs.lstat(entry.local).then(
          () => true,
          (error) => (error.code === "ENOENT" ? false : Promise.reject(error)),
        );
        if (exists) {
          await skipConflict(c, entry, "本地目标中已存在同名文件。");
          return;
        }
      }
      entry.temp = `${entry.local}.${randomUUID()}.part`;
      await runFileTask(
        c,
        entry,
        (error) => `${entry.name} 下载失败：${error.message}`,
        () => runDownloadFile(c, entry),
      );
    });
  }
}

// taskId 可省略：兼容只有单个活动任务的旧调用方
function activeTransfer(id, taskId) {
  const session = sessions.get(id);
  if (!session) return null;
  if (taskId) {
    const c = session.transfers.get(taskId);
    return c && !TERMINAL_STATES.has(c.state) ? c : null;
  }
  const active = [...session.transfers.values()].filter(
    (c) => !TERMINAL_STATES.has(c.state),
  );
  return active.length === 1 ? active[0] : null;
}
function pauseTransfer(id, taskId) {
  const c = activeTransfer(id, taskId);
  if (!c) return false;
  if (c.paused) return true;
  c.paused = true;
  if (c.state === "running") c.state = "paused";
  abortAll(c);
  wakeAll(c);
  emitTransfer(c, true);
  return true;
}
function resumeTransfer(id, taskId) {
  const c = activeTransfer(id, taskId);
  if (!c) return false;
  if (!c.paused) return true;
  c.paused = false;
  if (c.state === "paused") {
    c.state = "running";
    resetSpeed(c);
  }
  wakeAll(c);
  emitTransfer(c, true);
  return true;
}
function cancelTransfer(id, taskId) {
  const c = activeTransfer(id, taskId);
  if (!c) return false;
  if (c.cancelled) return true;
  c.cancelled = true;
  c.state = "cancelled";
  abortAll(c);
  wakeAll(c);
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
      const choice = await withDialog(() =>
        dialog.showOpenDialog(window, {
          title: mode === "folder" ? "选择要上传的文件夹" : "选择要上传的文件",
          properties:
            mode === "folder"
              ? ["openDirectory", "multiSelections"]
              : ["openFile", "multiSelections"],
        }),
      );
      if (choice.canceled || !choice.filePaths?.length) return [];
      const controller = createTransfer(
        id,
        session,
        "upload",
        transferTitle(choice.filePaths),
      );
      return runTransfer(session, controller, () =>
        uploadSources(files, target, choice.filePaths, controller, session),
      );
    }),
  );
  handle("sftp:upload-paths", (id, directory, sources) =>
    withFiles(id, (files, session) => {
      const target = validate.remotePath(directory);
      const paths = validate.localPaths(sources);
      const controller = createTransfer(
        id,
        session,
        "upload",
        transferTitle(paths),
      );
      return runTransfer(session, controller, () =>
        uploadSources(files, target, paths, controller, session),
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
        const choice = await withDialog(() =>
          dialog.showOpenDialog(window, {
            title: "选择下载到的文件夹",
            properties: ["openDirectory", "createDirectory"],
          }),
        );
        if (choice.canceled || !choice.filePaths?.length) return false;
        const root = path.join(choice.filePaths[0], name);
        const existing = await fs.lstat(root).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (existing && !existing.isDirectory())
          throw new Error("本地已存在同名文件，无法下载目录");
        const controller = createTransfer(id, session, "download", name);
        return runTransfer(session, controller, async () => {
          // 扫描完成前不创建任何本地目录，失败或停止时不留空目录
          await collectDownloadEntries(files, source, controller, root);
          await downloadPlan(files, controller, session);
          return true;
        });
      }
      const choice = await withDialog(() =>
        dialog.showSaveDialog(window, {
          title: "下载文件",
          defaultPath: path.join(app.getPath("downloads"), name),
        }),
      );
      if (choice.canceled || !choice.filePath) return false;
      const controller = createTransfer(id, session, "download", name);
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
        await downloadPlan(files, controller, session);
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
