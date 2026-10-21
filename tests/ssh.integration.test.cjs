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
  { timeout: 30000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trident-test-"));
    const remote = path.join(root, "remote");
    fs.mkdirSync(remote);
    const hostKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({ type: "pkcs1", format: "pem" });
    const clients = new Set();
    let shellRequests = 0;
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
              safe(id, () =>
                addHandle(id, {
                  dir: fs.readdirSync(localPath(p)).map((name) => ({
                    filename: name,
                    longname: name,
                    attrs: attrs(fs.statSync(path.join(localPath(p), name))),
                  })),
                  sent: false,
                }),
              ),
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
            sftp.on("READ", (id, h, offset, length) =>
              safe(id, () => {
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
              }),
            );
            sftp.on("WRITE", (id, h, offset, data) =>
              safe(id, () => {
                fs.writeSync(
                  handles.get(h.readUInt32BE()).fd,
                  data,
                  0,
                  data.length,
                  offset,
                );
                sftp.status(id, 0);
              }),
            );
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
        await assert.rejects(invoke("sftp:upload", "session", "/项目"));
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
        await assert.rejects(invoke("sftp:upload", "ftp", "/资料"), /已存在/);
        const list = await invoke("sftp:list", "ftp", "/资料");
        assert.equal(list.files[0].name, "ftp-upload.txt");
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
      "quit preparation keeps the theme readable but rejects stateful IPC, and cannot be re-entered",
      async () => {
        electron.app.emit("before-quit", { preventDefault() {} });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(quitRequests, 1);
        assert.equal((await invoke("theme:get")).mode, "system");
        await assert.rejects(async () => invoke("profiles:list"), /请稍候/);
        await assert.rejects(async () => invoke("theme:set", "dark"), /请稍候/);
        await assert.rejects(
          async () => invoke("theme:terminal-set", "nord"),
          /请稍候/,
        );
      },
    );
  },
);
