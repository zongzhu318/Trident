const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { Server, utils } = require("ssh2");
const startFTP = require("./helpers/ftp-server.cjs");
test(
  "real SSH and SFTP through the application IPC handlers",
  { timeout: 120000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trident-test-"));
    const remote = path.join(root, "remote");
    fs.mkdirSync(remote);
    const hostKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({ type: "pkcs1", format: "pem" });
    const clients = new Set();
    let shellRequests = 0;
    // 测试用节流与恶意目录项注入
    let ioDelay = 0;
    let malicious = null;
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      clients.add(client);
      client.on("close", () => clients.delete(client));
      client.on("error", () => {});
      client.on("authentication", (ctx) =>
        ctx.method === "password" &&
        ctx.username === "tester" &&
        ctx.password === "test-password"
          ? ctx.accept()
          : ctx.reject(),
      );
      client.on("ready", () =>
        client.on("session", (accept) => {
          const session = accept();
          session.on("pty", (accept) => accept());
          session.on("window-change", (accept) => accept?.());
          session.on("shell", (accept) => {
            shellRequests++;
            const stream = accept();
            stream.write("Welcome to local integration server\r\n");
            stream.on("data", (data) => stream.write(`echo:${data}`));
          });
          session.on("sftp", (accept) => {
            const sftp = accept();
            const handles = new Map();
            let nextHandle = 0;
            const localPath = (p) => {
              const normalized = path.posix.normalize("/" + p);
              return path.join(remote, normalized);
            };
            const attrs = (stat) => ({
              mode: stat.mode,
              uid: stat.uid,
              gid: stat.gid,
              size: stat.size,
              atime: Math.floor(stat.atimeMs / 1000),
              mtime: Math.floor(stat.mtimeMs / 1000),
            });
            const safe = (id, fn) => {
              try {
                fn();
              } catch (e) {
                sftp.status(id, e.code === "ENOENT" ? 2 : 4, e.message);
              }
            };
            const addHandle = (id, value) => {
              const h = Buffer.alloc(4);
              h.writeUInt32BE(++nextHandle);
              handles.set(nextHandle, value);
              sftp.handle(id, h);
            };
            sftp.on("REALPATH", (id, p) =>
              sftp.name(id, [
                {
                  filename: p === "." ? "/" : path.posix.normalize(p),
                  longname: "",
                  attrs: {},
                },
              ]),
            );
            sftp.on("OPENDIR", (id, p) =>
              safe(id, () => {
                const dir = fs.readdirSync(localPath(p)).map((name) => ({
                  filename: name,
                  longname: name,
                  attrs: attrs(fs.statSync(path.join(localPath(p), name))),
                }));
                if (malicious && p === malicious.dir)
                  dir.push({
                    filename: malicious.name,
                    longname: malicious.name,
                    attrs: { size: 4, mode: 0o100644 },
                  });
                addHandle(id, { dir, sent: false });
              }),
            );
            sftp.on("READDIR", (id, h) =>
              safe(id, () => {
                const value = handles.get(h.readUInt32BE());
                if (value.sent || !value.dir.length) return sftp.status(id, 1);
                value.sent = true;
                sftp.name(id, value.dir);
              }),
            );
            sftp.on("OPEN", (id, p, flags, attributes) =>
              safe(id, () =>
                addHandle(id, {
                  fd: fs.openSync(
                    localPath(p),
                    utils.sftp.flagsToString(flags),
                    attributes.mode ?? 0o600,
                  ),
                }),
              ),
            );
            sftp.on("READ", (id, h, offset, length) => {
              const respond = () => {
                try {
                  const buffer = Buffer.alloc(length);
                  const read = fs.readSync(
                    handles.get(h.readUInt32BE()).fd,
                    buffer,
                    0,
                    length,
                    offset,
                  );
                  if (read) sftp.data(id, buffer.subarray(0, read));
                  else sftp.status(id, 1);
                } catch {
                  sftp.status(id, 4);
                }
              };
              if (ioDelay) setTimeout(respond, ioDelay);
              else respond();
            });
            sftp.on("WRITE", (id, h, offset, data) => {
              const respond = () => {
                try {
                  const value = handles.get(h.readUInt32BE());
                  fs.writeSync(value.fd, data, 0, data.length, offset);
                  sftp.status(id, 0);
                } catch {
                  sftp.status(id, 4);
                }
              };
              if (ioDelay) setTimeout(respond, ioDelay);
              else respond();
            });
            sftp.on("FSTAT", (id, h) =>
              safe(id, () =>
                sftp.attrs(
                  id,
                  attrs(fs.fstatSync(handles.get(h.readUInt32BE()).fd)),
                ),
              ),
            );
            sftp.on("STAT", (id, p) =>
              safe(id, () => sftp.attrs(id, attrs(fs.statSync(localPath(p))))),
            );
            sftp.on("LSTAT", (id, p) =>
              safe(id, () => sftp.attrs(id, attrs(fs.lstatSync(localPath(p))))),
            );
            sftp.on("RENAME", (id, from, to) =>
              safe(id, () => {
                fs.renameSync(localPath(from), localPath(to));
                sftp.status(id, 0);
              }),
            );
            sftp.on("REMOVE", (id, p) =>
              safe(id, () => {
                fs.unlinkSync(localPath(p));
                sftp.status(id, 0);
              }),
            );
            sftp.on("RMDIR", (id, p) =>
              safe(id, () => {
                fs.rmdirSync(localPath(p));
                sftp.status(id, 0);
              }),
            );
            sftp.on("MKDIR", (id, p) =>
              safe(id, () => {
                fs.mkdirSync(localPath(p));
                sftp.status(id, 0);
              }),
            );
            sftp.on("CLOSE", (id, h) =>
              safe(id, () => {
                const value = handles.get(h.readUInt32BE());
                if (value.fd !== undefined) fs.closeSync(value.fd);
                handles.delete(h.readUInt32BE());
                sftp.status(id, 0);
              }),
            );
            sftp.on("close", () => {
              for (const value of handles.values())
                if (value.fd !== undefined) {
                  try {
                    fs.closeSync(value.fd);
                  } catch {}
                }
            });
          });
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    t.after(() => {
      for (const client of clients) client.end();
      server.close();
      fs.rmSync(root, { recursive: true, force: true });
    });

    const handlers = new Map();
    const events = [];
    let hostResponse = 1;
    let hostPrompts = 0;
    let chooseFiles = [];
    let destination;
    let instance;
    let startup;
    let quitRequests = 0;
    class FakeWindow extends EventEmitter {
      constructor() {
        super();
        instance = this;
        this.webContents = new EventEmitter();
        Object.assign(this.webContents, {
          mainFrame: {},
          send: (_channel, payload) => events.push(payload),
          setWindowOpenHandler() {},
          session: {
            setPermissionRequestHandler() {},
            setPermissionCheckHandler() {},
          },
        });
      }
      isDestroyed() {
        return false;
      }
      setBackgroundColor() {}
      loadFile() {}
      static getAllWindows() {
        return [instance];
      }
    }
    const electron = {
      nativeTheme: Object.assign(new EventEmitter(), {
        themeSource: "system",
        shouldUseDarkColors: true,
      }),
      app: Object.assign(new EventEmitter(), {
        getPath: () => root,
        getVersion: () => "0.0.1",
        setName() {},
        setAboutPanelOptions() {},
        whenReady: () => ({
          then: (fn) => {
            startup = Promise.resolve().then(fn);
            return startup;
          },
        }),
        quit() {
          quitRequests++;
        },
      }),
      BrowserWindow: FakeWindow,
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on() {} },
      dialog: {
        showMessageBox: async () => {
          hostPrompts++;
          return { response: hostResponse };
        },
        showOpenDialog: async () => ({
          canceled: false,
          filePaths: chooseFiles,
        }),
        showSaveDialog: async () => ({
          canceled: false,
          filePath: destination,
        }),
        showErrorBox: (_title, message) => {
          throw new Error(message);
        },
      },
      Menu: { buildFromTemplate: (items) => items, setApplicationMenu() {} },
    };
    const originalLoad = Module._load;
    fs.writeFileSync(
      path.join(root, "preferences.json"),
      JSON.stringify({ theme: "dark", terminalTheme: "nord" }),
    );
    Module._load = function (name, ...args) {
      return name === "electron"
        ? electron
        : originalLoad.call(this, name, ...args);
    };
    try {
      require("../electron/main.cjs");
    } finally {
      Module._load = originalLoad;
    }
    await startup;
    const invoke = (channel, ...args) =>
      handlers.get(channel)(
        {
          sender: instance.webContents,
          senderFrame: instance.webContents.mainFrame,
        },
        ...args,
      );
    const waitFor = async (predicate, timeout = 10000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("等待传输事件超时");
    };
    const transferEvents = () =>
      events.filter((event) => event.type === "transfer").map((e) => e.data);
    const lastTransfer = () => transferEvents().at(-1);
    // 暂停后已发出的分片仍可能在途落盘，等待大小稳定再断言
    const stableSize = async (file, timeout = 5000) => {
      let size = fs.statSync(file).size;
      let changedAt = Date.now();
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const next = fs.statSync(file).size;
        if (next !== size) {
          size = next;
          changedAt = Date.now();
        } else if (Date.now() - changedAt >= 200) return size;
      }
      throw new Error("暂停后文件大小未稳定");
    };
    const profile = {
      id: "profile",
      name: "Local test",
      host: "127.0.0.1",
      port,
      username: "tester",
      auth: "password",
      keyPath: "",
      group: "Test",
    };

    await t.test(
      "appearance preferences validate, persist and notify the renderer",
      async () => {
        assert.equal((await invoke("theme:get")).mode, "dark");
        assert.equal((await invoke("theme:get")).terminalTheme, "nord");
        assert.equal((await invoke("theme:set", "light")).mode, "light");
        assert.equal(
          JSON.parse(
            fs.readFileSync(path.join(root, "preferences.json"), "utf8"),
          ).theme,
          "light",
        );
        await assert.rejects(invoke("theme:set", "invalid"), /主题/);
        assert.equal((await invoke("theme:get")).mode, "light");
        await invoke("theme:set", "system");
        electron.nativeTheme.shouldUseDarkColors = false;
        electron.nativeTheme.emit("updated");
        assert.equal(events.at(-1).effective, "light");
      },
    );

    await t.test(
      "terminal colors persist independently and concurrent appearance changes preserve both preferences",
      async () => {
        assert.equal((await invoke("theme:get")).terminalTheme, "nord");
        await Promise.all([
          invoke("theme:set", "dark"),
          invoke("theme:terminal-set", "tokyo-night"),
        ]);
        const saved = JSON.parse(
          fs.readFileSync(path.join(root, "preferences.json"), "utf8"),
        );
        assert.equal(saved.theme, "dark");
        assert.equal(saved.terminalTheme, "tokyo-night");
        assert.equal(events.at(-1).terminalTheme, "tokyo-night");
        for (const invalid of ["invalid", "__proto__", null, {}, 1]) {
          await assert.rejects(invoke("theme:terminal-set", invalid), /配色/);
        }
        assert.equal((await invoke("theme:get")).terminalTheme, "tokyo-night");
        assert.deepEqual(
          JSON.parse(
            fs.readFileSync(path.join(root, "preferences.json"), "utf8"),
          ),
          saved,
        );
        await invoke("theme:terminal-set", "auto");
        await invoke("theme:set", "system");
      },
    );

    await t.test("saved profiles never include credentials", async () => {
      await invoke("profiles:save", { ...profile, password: "do-not-save" });
      assert.equal(
        fs
          .readFileSync(path.join(root, "connections.json"), "utf8")
          .includes("do-not-save"),
        false,
      );
      assert.throws(
        () => handlers.get("profiles:list")({ sender: {}, senderFrame: {} }),
        /非法请求/,
      );
    });
    await t.test("host trust rejection prevents a session", async () => {
      hostResponse = 0;
      await assert.rejects(
        invoke("ssh:connect", "rejected", profile, {
          password: "test-password",
        }),
      );
      assert.equal(fs.existsSync(path.join(root, "known-hosts.json")), false);
    });
    await t.test(
      "trusted SSH provides a shell and SFTP on the same connection",
      async () => {
        hostResponse = 1;
        assert.deepEqual(
          await invoke("ssh:connect", "session", profile, {
            password: "test-password",
          }),
          { sftp: true },
        );
        await invoke("ssh:write", "session", "hello\n");
        await invoke("ssh:resize", "session", 120, 40);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.ok(
          events.some(
            (e) =>
              e.type === "data" &&
              Buffer.from(e.data).toString().includes("echo:hello"),
          ),
        );
        assert.equal(
          Object.keys(
            JSON.parse(
              fs.readFileSync(path.join(root, "known-hosts.json"), "utf8"),
            ),
          ).length,
          1,
        );
        assert.deepEqual(await invoke("sftp:list", "session", null), {
          path: "/",
          files: [],
        });
      },
    );
    await t.test(
      "SFTP creates directories, uploads and downloads exact bytes, and refuses overwrite",
      async () => {
        await invoke("sftp:mkdir", "session", "/", "项目");
        const data = Buffer.from("Unicode 文件内容\n".repeat(10000));
        const source = path.join(root, "payload.txt");
        fs.writeFileSync(source, data);
        chooseFiles = [source];
        assert.deepEqual(await invoke("sftp:upload", "session", "/项目"), [
          "payload.txt",
        ]);
        assert.deepEqual(
          fs.readFileSync(path.join(remote, "项目/payload.txt")),
          data,
        );
        hostResponse = 0;
        assert.deepEqual(
          await invoke("sftp:upload", "session", "/项目"),
          [],
          "同名文件按跳过策略处理",
        );
        assert.deepEqual(
          fs.readFileSync(path.join(remote, "项目/payload.txt")),
          data,
        );
        const listing = await invoke("sftp:list", "session", "/项目");
        assert.equal(listing.files[0].name, "payload.txt");
        destination = path.join(root, "download.txt");
        await invoke("sftp:download", "session", "/项目/payload.txt");
        assert.deepEqual(fs.readFileSync(destination), data);
        assert.equal(
          fs.readdirSync(root).some((name) => name.endsWith(".part")),
          false,
        );
        assert.ok(
          events.some(
            (e) =>
              e.type === "transfer" &&
              e.data.direction === "download" &&
              e.data.state === "done",
          ),
        );
        await assert.rejects(
          invoke("sftp:download", "session", "/missing-file.txt"),
        );
        assert.deepEqual(
          fs.readFileSync(destination),
          data,
          "a failed download must preserve an existing destination",
        );
        assert.equal(
          fs.readdirSync(root).some((name) => name.endsWith(".part")),
          false,
        );
      },
    );
    await t.test(
      "folder upload recursively creates directories and refuses existing files",
      async () => {
        const folder = path.join(root, "bundle");
        fs.mkdirSync(path.join(folder, "nested"), { recursive: true });
        fs.mkdirSync(path.join(folder, "empty"));
        fs.writeFileSync(path.join(folder, "top.txt"), "top");
        fs.writeFileSync(path.join(folder, "nested", "deep.txt"), "deep");
        const symlinks = process.platform !== "win32";
        if (symlinks) {
          fs.symlinkSync(
            path.join(folder, "top.txt"),
            path.join(folder, "link.txt"),
          );
          fs.symlinkSync(folder, path.join(root, "bundle-link"));
        }
        await invoke("sftp:mkdir", "session", "/", "上传目录");
        chooseFiles = [folder];
        const completed = await invoke(
          "sftp:upload",
          "session",
          "/上传目录",
          "folder",
        );
        assert.deepEqual(completed.sort(), [
          "bundle/nested/deep.txt",
          "bundle/top.txt",
        ]);
        assert.equal(completed.includes("bundle/link.txt"), false);
        assert.equal(
          fs.readFileSync(path.join(remote, "上传目录/bundle/top.txt"), "utf8"),
          "top",
        );
        assert.equal(
          fs.readFileSync(
            path.join(remote, "上传目录/bundle/nested/deep.txt"),
            "utf8",
          ),
          "deep",
        );
        assert.ok(
          fs.statSync(path.join(remote, "上传目录/bundle/empty")).isDirectory(),
        );
        assert.deepEqual(
          await invoke("sftp:upload-paths", "session", "/上传目录", [folder]),
          [],
          "同名文件全部跳过且不覆盖",
        );
        assert.equal(
          fs.readFileSync(path.join(remote, "上传目录/bundle/top.txt"), "utf8"),
          "top",
        );
        if (symlinks)
          await assert.rejects(
            invoke("sftp:upload-paths", "session", "/上传目录", [
              path.join(root, "bundle-link"),
            ]),
            /符号链接/,
          );
      },
    );
    await t.test(
      "recursive directory download preserves structure, merges, stops and rejects traversal",
      async () => {
        const tree = path.join(remote, "下载树");
        fs.mkdirSync(path.join(tree, "nested"), { recursive: true });
        fs.mkdirSync(path.join(tree, "empty"));
        fs.writeFileSync(path.join(tree, "a.txt"), "aaa");
        fs.writeFileSync(path.join(tree, "nested", "b.txt"), "bbb");
        const parent = fs.mkdtempSync(path.join(root, "local-"));
        events.length = 0;
        chooseFiles = [parent];
        assert.equal(await invoke("sftp:download", "session", "/下载树"), true);
        assert.equal(
          fs.readFileSync(path.join(parent, "下载树/nested/b.txt"), "utf8"),
          "bbb",
        );
        assert.ok(
          fs.statSync(path.join(parent, "下载树/empty")).isDirectory(),
          "空目录也必须保留",
        );
        assert.equal(
          fs.readdirSync(parent).some((name) => name.endsWith(".part")),
          false,
        );
        const done = transferEvents().find((event) => event.state === "done");
        assert.deepEqual(done.files, {
          completed: 2,
          total: 2,
          skipped: 0,
          failed: 0,
        });
        assert.deepEqual(done.dirs, { completed: 3, total: 3 });
        assert.equal(done.bytes.total, 6);
        assert.equal(done.bytes.transferred, 6);
        assert.ok(
          transferEvents().some((event) => event.state === "preparing"),
          "扫描阶段需要上报 preparing 事件",
        );

        // 已存在目录合并，同名文件首次询问后整批跳过
        hostResponse = 0;
        events.length = 0;
        assert.equal(await invoke("sftp:download", "session", "/下载树"), true);
        const skipped = transferEvents().find(
          (event) => event.state === "done",
        );
        assert.equal(skipped.files.skipped, 2);
        assert.equal(skipped.files.completed, 0);
        assert.equal(
          fs.readFileSync(path.join(parent, "下载树/a.txt"), "utf8"),
          "aaa",
        );

        // 选择停止时保持已存在文件不变
        hostResponse = 1;
        events.length = 0;
        assert.equal(
          await invoke("sftp:download", "session", "/下载树"),
          false,
        );
        const stopped = transferEvents().find(
          (event) => event.state === "cancelled",
        );
        assert.ok(stopped);
        assert.equal(
          fs.readFileSync(path.join(parent, "下载树/a.txt"), "utf8"),
          "aaa",
        );

        // 远程返回路径穿越名称时在扫描阶段中止，目标目录外不写入
        fs.mkdirSync(path.join(remote, "恶意"));
        fs.writeFileSync(path.join(remote, "恶意/ok.txt"), "ok");
        malicious = { dir: "/恶意", name: "../escape.txt" };
        const escaped = fs.mkdtempSync(path.join(root, "escape-"));
        chooseFiles = [escaped];
        events.length = 0;
        await assert.rejects(
          invoke("sftp:download", "session", "/恶意"),
          /文件名/,
        );
        malicious = null;
        assert.equal(fs.existsSync(path.join(escaped, "escape.txt")), false);
        assert.equal(
          fs.existsSync(path.join(escaped, "恶意")),
          false,
          "扫描失败时不得留下空目录",
        );
        assert.equal(transferEvents().at(-1).state, "error");
      },
    );
    await t.test(
      "upload pause resumes from the remote offset and cancel removes the partial file",
      async () => {
        await invoke("sftp:mkdir", "session", "/", "暂停");
        const big = path.join(root, "big.bin");
        const data = Buffer.alloc(3 * 1024 * 1024, 0x5a);
        fs.writeFileSync(big, data);
        const target = path.join(remote, "暂停/big.bin");
        ioDelay = 3;
        events.length = 0;
        const pending = invoke("sftp:upload-paths", "session", "/暂停", [big]);
        await waitFor(() =>
          transferEvents().some(
            (event) =>
              event.state === "running" &&
              event.name === "big.bin" &&
              event.transferred > 0,
          ),
        );
        assert.equal(await invoke("transfer:pause", "session"), true);
        await waitFor(() =>
          transferEvents().some((event) => event.state === "paused"),
        );
        const paused = transferEvents()
          .filter((event) => event.state === "paused")
          .at(-1);
        assert.equal(paused.speed, 0);
        const partial = await stableSize(target);
        assert.ok(partial > 0 && partial < data.length);
        assert.equal(fs.statSync(target).size, partial, "暂停期间不得继续写入");
        assert.equal(await invoke("transfer:resume", "session"), true);
        assert.deepEqual(await pending, ["big.bin"]);
        assert.deepEqual(fs.readFileSync(target), data);
        const done = transferEvents().find((event) => event.state === "done");
        assert.equal(done.files.completed, 1);
        assert.equal(done.bytes.transferred, data.length);
        ioDelay = 0;

        // 停止：保留已完成文件，清理当前未完成的远程文件并释放锁
        const folder = path.join(root, "cancel-source");
        fs.mkdirSync(folder);
        fs.writeFileSync(path.join(folder, "a-small.txt"), "small");
        fs.writeFileSync(path.join(folder, "z-big.bin"), data);
        await invoke("sftp:mkdir", "session", "/", "取消");
        ioDelay = 3;
        events.length = 0;
        const cancelledRun = invoke("sftp:upload-paths", "session", "/取消", [
          folder,
        ]);
        await waitFor(() =>
          transferEvents().some(
            (event) =>
              event.state === "running" &&
              event.name === "cancel-source/z-big.bin" &&
              event.transferred > 0,
          ),
        );
        assert.equal(await invoke("transfer:cancel", "session"), true);
        assert.deepEqual(await cancelledRun, ["cancel-source/a-small.txt"]);
        assert.equal(
          fs.existsSync(path.join(remote, "取消/cancel-source/z-big.bin")),
          false,
          "当前未完成的远程文件应被尽力删除",
        );
        assert.equal(
          fs.readFileSync(
            path.join(remote, "取消/cancel-source/a-small.txt"),
            "utf8",
          ),
          "small",
        );
        assert.ok(
          transferEvents().some((event) => event.state === "cancelled"),
        );
        ioDelay = 0;
        // 无活动传输时控制幂等；文件锁已释放，可继续操作
        assert.equal(await invoke("transfer:pause", "session"), false);
        await invoke("sftp:mkdir", "session", "/", "取消后");
        assert.ok(fs.existsSync(path.join(remote, "取消后")));
      },
    );
    await t.test(
      "trusted host reconnects without a prompt and bad passwords fail",
      async () => {
        await invoke("ssh:disconnect", "session");
        const promptsBefore = hostPrompts;
        await assert.rejects(
          invoke("ssh:connect", "bad-password", profile, {
            password: "incorrect",
          }),
        );
        assert.deepEqual(
          await invoke("ssh:connect", "second", profile, {
            password: "test-password",
          }),
          { sftp: true },
        );
        assert.equal(hostPrompts, promptsBefore);
        await invoke("ssh:disconnect", "second");
        await assert.rejects(invoke("sftp:list", "second", "/"), /连接已断开/);
      },
    );

    await t.test(
      "standalone SFTP opens no shell and supports rename/delete with cancellation",
      async () => {
        const before = shellRequests;
        const filesProfile = { ...profile, protocol: "sftp", id: "files-only" };
        await invoke("ssh:connect", "files-only", filesProfile, {
          password: "test-password",
        });
        assert.equal(shellRequests, before);
        assert.throws(
          () => invoke("ssh:write", "files-only", "hello"),
          /没有 SSH 终端/,
        );
        await invoke(
          "files:rename",
          "files-only",
          "/项目/payload.txt",
          "renamed.txt",
        );
        assert.equal(
          fs.existsSync(path.join(remote, "项目/renamed.txt")),
          true,
        );
        fs.writeFileSync(path.join(remote, "项目/existing.txt"), "keep");
        await assert.rejects(
          invoke(
            "files:rename",
            "files-only",
            "/项目/renamed.txt",
            "existing.txt",
          ),
          /已存在/,
        );
        await assert.rejects(invoke("files:remove", "files-only", "/项目"));
        hostResponse = 0;
        assert.equal(
          await invoke("files:remove", "files-only", "/项目/renamed.txt"),
          false,
        );
        assert.equal(
          fs.existsSync(path.join(remote, "项目/renamed.txt")),
          true,
        );
        hostResponse = 1;
        assert.equal(
          await invoke("files:remove", "files-only", "/项目/renamed.txt"),
          true,
        );
        await invoke("files:remove", "files-only", "/项目/existing.txt");
        await invoke("files:remove", "files-only", "/项目");
        assert.equal(fs.existsSync(path.join(remote, "项目")), false);
        await assert.rejects(
          invoke("files:remove", "files-only", "/"),
          /根目录/,
        );
        await invoke("ssh:disconnect", "files-only");
      },
    );
    await t.test(
      "saved passwords connect without being exposed to the renderer, and encrypted backup import adds independent records",
      async () => {
        let profiles = await invoke(
          "profiles:save",
          profile,
          { password: "test-password" },
          true,
        );
        assert.equal(profiles[0].hasSavedCredentials, true);
        assert.equal(profiles[0].secret, undefined);
        const stored = JSON.parse(
          fs.readFileSync(path.join(root, "connections.json"), "utf8"),
        );
        assert.equal(
          JSON.parse(stored[0].secret).credentials.password,
          "test-password",
        );
        await invoke("ssh:connect", "saved", profile, {});
        await invoke("ssh:disconnect", "saved");
        await assert.rejects(
          invoke(
            "ssh:connect",
            "changed",
            { ...profile, host: "localhost" },
            {},
          ),
          /请输入密码/,
        );
        destination = path.join(root, "backup.json");
        await invoke("profiles:export", true, "portable-password");
        assert.equal(
          fs.readFileSync(destination, "utf8").includes("test-password"),
          false,
        );
        chooseFiles = [destination];
        const preview = await invoke(
          "profiles:prepare-import",
          "portable-password",
        );
        assert.equal(preview.profiles.length, 1);
        assert.equal(preview.profiles[0].hasSavedCredentials, true);
        profiles = await invoke("profiles:commit-import", preview.token);
        assert.equal(profiles.length, 2);
        assert.notEqual(profiles[0].id, profiles[1].id);
        await invoke("ssh:connect", "imported", profiles[1], {});
        await invoke("ssh:disconnect", "imported");
        await assert.rejects(
          invoke("profiles:commit-import", preview.token),
          /过期/,
        );
        const before = JSON.stringify(await invoke("profiles:list"));
        await assert.rejects(
          invoke("profiles:prepare-import", "wrong-password"),
          /密码错误/,
        );
        assert.equal(JSON.stringify(await invoke("profiles:list")), before);
        profiles = await invoke("profiles:save", profile, {}, false);
        assert.equal(
          profiles.find((p) => p.id === profile.id).hasSavedCredentials,
          false,
        );
        await assert.rejects(
          invoke("ssh:connect", "forgotten", profile, {}),
          /请输入密码/,
        );
      },
    );
    await t.test(
      "FTP password login, passive transfers, Unicode paths, rename and empty-directory deletion",
      async () => {
        const ftpRoot = path.join(root, "ftp");
        fs.mkdirSync(ftpRoot);
        const ftpServer = await startFTP(ftpRoot);
        t.after(() => ftpServer.close());
        const ftpProfile = {
          ...profile,
          id: "ftp",
          protocol: "ftp",
          port: ftpServer.port,
        };
        await assert.rejects(
          invoke("ssh:connect", "ftp-bad", ftpProfile, { password: "wrong" }),
        );
        await invoke(
          "profiles:save",
          ftpProfile,
          { password: "ftp-password" },
          true,
        );
        await invoke("ssh:connect", "ftp", ftpProfile, {});
        assert.deepEqual(await invoke("sftp:list", "ftp", null), {
          path: "/",
          files: [],
        });
        await invoke("sftp:mkdir", "ftp", "/", "资料");
        const source = path.join(root, "ftp-upload.txt");
        const data = Buffer.from("FTP 二进制内容\0\n".repeat(500));
        fs.writeFileSync(source, data);
        chooseFiles = [source];
        await invoke("sftp:upload", "ftp", "/资料");
        assert.deepEqual(
          fs.readFileSync(path.join(ftpRoot, "资料/ftp-upload.txt")),
          data,
        );
        hostResponse = 0;
        assert.deepEqual(
          await invoke("sftp:upload", "ftp", "/资料"),
          [],
          "FTP 同名文件按跳过策略处理",
        );
        const list = await invoke("sftp:list", "ftp", "/资料");
        assert.equal(list.files[0].name, "ftp-upload.txt");
        const tree = path.join(root, "ftp-tree");
        fs.mkdirSync(path.join(tree, "sub"), { recursive: true });
        fs.writeFileSync(path.join(tree, "a.txt"), "a");
        fs.writeFileSync(path.join(tree, "sub", "b.txt"), "b");
        await invoke("sftp:mkdir", "ftp", "/", "树");
        assert.deepEqual(
          (await invoke("sftp:upload-paths", "ftp", "/树", [tree])).sort(),
          ["ftp-tree/a.txt", "ftp-tree/sub/b.txt"],
        );
        assert.equal(
          fs.readFileSync(path.join(ftpRoot, "树/ftp-tree/sub/b.txt"), "utf8"),
          "b",
        );
        assert.deepEqual(
          await invoke("sftp:upload-paths", "ftp", "/树", [tree]),
          [],
          "FTP 目录内同名文件全部跳过",
        );

        // FTP 目录下载：保留空目录与结构，已存在文件走批量跳过
        const downloadTree = path.join(ftpRoot, "下载树");
        fs.mkdirSync(path.join(downloadTree, "nested"), { recursive: true });
        fs.mkdirSync(path.join(downloadTree, "empty"));
        fs.writeFileSync(path.join(downloadTree, "n.txt"), "nn");
        fs.writeFileSync(path.join(downloadTree, "nested", "m.txt"), "m");
        const ftpParent = fs.mkdtempSync(path.join(root, "ftp-local-"));
        hostResponse = 1;
        events.length = 0;
        chooseFiles = [ftpParent];
        assert.equal(await invoke("sftp:download", "ftp", "/下载树"), true);
        assert.equal(
          fs.readFileSync(path.join(ftpParent, "下载树/nested/m.txt"), "utf8"),
          "m",
        );
        assert.ok(
          fs.statSync(path.join(ftpParent, "下载树/empty")).isDirectory(),
          "FTP 下载也必须保留空目录",
        );
        const ftpDone = transferEvents().find(
          (event) => event.state === "done",
        );
        assert.deepEqual(ftpDone.files, {
          completed: 2,
          total: 2,
          skipped: 0,
          failed: 0,
        });
        assert.deepEqual(ftpDone.dirs, { completed: 3, total: 3 });
        assert.equal(ftpDone.bytes.total, 3);
        assert.equal(ftpDone.bytes.transferred, 3);
        assert.ok(
          transferEvents().some((event) => event.state === "preparing"),
          "FTP 扫描阶段需要上报 preparing 事件",
        );
        hostResponse = 0;
        events.length = 0;
        assert.equal(await invoke("sftp:download", "ftp", "/下载树"), true);
        const ftpSkipped = transferEvents().find(
          (event) => event.state === "done",
        );
        assert.equal(ftpSkipped.files.skipped, 2);
        assert.equal(ftpSkipped.files.completed, 0);
        hostResponse = 1;

        // FTP 上传暂停后按 APPE 从远程偏移续传
        await invoke("sftp:mkdir", "ftp", "/", "暂停");
        const ftpBig = path.join(root, "ftp-big.bin");
        const ftpData = Buffer.alloc(6 * 1024 * 1024, 0x6b);
        fs.writeFileSync(ftpBig, ftpData);
        const ftpTarget = path.join(ftpRoot, "暂停/ftp-big.bin");
        ftpServer.setIoDelay(8);
        chooseFiles = [ftpBig];
        events.length = 0;
        const ftpPending = invoke("sftp:upload", "ftp", "/暂停");
        await waitFor(
          () => fs.existsSync(ftpTarget) && fs.statSync(ftpTarget).size > 0,
        );
        assert.equal(await invoke("transfer:pause", "ftp"), true);
        await waitFor(() =>
          transferEvents().some((event) => event.state === "paused"),
        );
        const ftpPaused = transferEvents()
          .filter((event) => event.state === "paused")
          .at(-1);
        assert.equal(ftpPaused.speed, 0);
        const ftpPartial = await stableSize(ftpTarget);
        assert.ok(ftpPartial > 0 && ftpPartial < ftpData.length);
        assert.equal(
          fs.statSync(ftpTarget).size,
          ftpPartial,
          "FTP 暂停期间不得继续写入",
        );
        assert.equal(await invoke("transfer:resume", "ftp"), true);
        assert.deepEqual(await ftpPending, ["ftp-big.bin"]);
        assert.deepEqual(fs.readFileSync(ftpTarget), ftpData);
        const ftpUploadDone = transferEvents().find(
          (event) => event.state === "done",
        );
        assert.equal(ftpUploadDone.files.completed, 1);
        assert.equal(ftpUploadDone.bytes.transferred, ftpData.length);

        // FTP 下载暂停后从 .part 大小续传，完成后临时文件消失
        const bigDownload = Buffer.alloc(4 * 1024 * 1024, 0x7c);
        fs.writeFileSync(path.join(ftpRoot, "大文件.bin"), bigDownload);
        destination = path.join(root, "ftp-big-download.bin");
        events.length = 0;
        const ftpDownload = invoke("sftp:download", "ftp", "/大文件.bin");
        const partPath = () => {
          const name = fs.readdirSync(root).find((n) => n.endsWith(".part"));
          return name ? path.join(root, name) : null;
        };
        await waitFor(() => partPath() && fs.statSync(partPath()).size > 0);
        assert.equal(await invoke("transfer:pause", "ftp"), true);
        await waitFor(() =>
          transferEvents().some((event) => event.state === "paused"),
        );
        const ftpPartSize = await stableSize(partPath());
        assert.ok(ftpPartSize > 0 && ftpPartSize < bigDownload.length);
        assert.equal(
          fs.statSync(partPath()).size,
          ftpPartSize,
          "FTP 下载暂停期间不得继续写入",
        );
        assert.equal(await invoke("transfer:resume", "ftp"), true);
        assert.equal(await ftpDownload, true);
        assert.deepEqual(fs.readFileSync(destination), bigDownload);
        assert.equal(partPath(), null, "完成后不得留下临时文件");

        // FTP 停止上传：保留已完成文件，删除进行中的远程文件并释放锁
        const cancelFolder = path.join(root, "ftp-cancel");
        fs.mkdirSync(cancelFolder);
        fs.writeFileSync(path.join(cancelFolder, "a-small.txt"), "small");
        fs.writeFileSync(path.join(cancelFolder, "z-big.bin"), bigDownload);
        await invoke("sftp:mkdir", "ftp", "/", "取消");
        events.length = 0;
        const ftpCancelled = invoke("sftp:upload-paths", "ftp", "/取消", [
          cancelFolder,
        ]);
        const cancelTarget = path.join(ftpRoot, "取消/ftp-cancel/z-big.bin");
        await waitFor(
          () =>
            fs.existsSync(cancelTarget) && fs.statSync(cancelTarget).size > 0,
        );
        assert.equal(await invoke("transfer:cancel", "ftp"), true);
        assert.deepEqual(await ftpCancelled, ["ftp-cancel/a-small.txt"]);
        assert.equal(
          fs.existsSync(cancelTarget),
          false,
          "FTP 停止时应尽力删除未完成的远程文件",
        );
        assert.equal(
          fs.readFileSync(
            path.join(ftpRoot, "取消/ftp-cancel/a-small.txt"),
            "utf8",
          ),
          "small",
        );
        assert.ok(
          transferEvents().some((event) => event.state === "cancelled"),
        );
        ftpServer.setIoDelay(0);
        assert.equal(await invoke("transfer:pause", "ftp"), false);

        destination = path.join(root, "ftp-download.txt");
        await invoke("sftp:download", "ftp", "/资料/ftp-upload.txt");
        assert.deepEqual(fs.readFileSync(destination), data);
        await invoke(
          "files:rename",
          "ftp",
          "/资料/ftp-upload.txt",
          "renamed.txt",
        );
        fs.writeFileSync(path.join(ftpRoot, "资料/existing.txt"), "keep");
        await assert.rejects(
          invoke("files:rename", "ftp", "/资料/renamed.txt", "existing.txt"),
          /已存在/,
        );
        await assert.rejects(invoke("files:remove", "ftp", "/资料"));
        hostResponse = 0;
        assert.equal(
          await invoke("files:remove", "ftp", "/资料/renamed.txt"),
          false,
        );
        hostResponse = 1;
        await invoke("files:remove", "ftp", "/资料/renamed.txt");
        await invoke("files:remove", "ftp", "/资料/existing.txt");
        await invoke("files:remove", "ftp", "/资料");
        assert.equal(fs.existsSync(path.join(ftpRoot, "资料")), false);
        await assert.rejects(
          invoke("sftp:mkdir", "ftp", "/", "bad\r\nDELE file"),
          /文件名/,
        );
        await invoke("ssh:disconnect", "ftp");
        await assert.rejects(invoke("sftp:list", "ftp", "/"), /连接已断开/);
        await assert.rejects(
          invoke(
            "ssh:connect",
            "no-tls",
            { ...ftpProfile, protocol: "ftps" },
            { password: "ftp-password" },
          ),
          "FTPS must not fall back to plain FTP",
        );
      },
    );
    await t.test(
      "menu quit is not intercepted and leaves IPC usable",
      async () => {
        // Cmd+Q 是强制退出：不得阻断默认终止，也不额外发起一次 quit
        electron.app.emit("before-quit", { preventDefault: assert.fail });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(quitRequests, 0);
        assert.equal((await invoke("theme:get")).mode, "system");
        assert.ok(Array.isArray(await invoke("profiles:list")));
        assert.equal((await invoke("theme:set", "dark")).mode, "dark");
        await invoke("theme:set", "system");
      },
    );
  },
);
