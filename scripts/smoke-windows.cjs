// Run on Windows against the installed application, not the development Electron.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
if (process.platform !== "win32") throw new Error("Windows runner required");
const executable = path.resolve(process.argv[2]);
const expectedVersion = process.argv[3];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "trident-installed-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  executable,
  ["--inspect=127.0.0.1:0", `--user-data-dir=${temp}`],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "",
  socket,
  started = false,
  passed = false;
const timer = setTimeout(() => {
  console.error("Installed application timed out", output);
  process.exitCode = 1;
  socket?.close();
  child.kill();
}, 45000);
child.on("error", (error) => {
  clearTimeout(timer);
  console.error(error);
  process.exitCode = 1;
});
child.stdout.on("data", (data) => {
  output += data;
});
child.stderr.on("data", async (data) => {
  output += data;
  const match = output.match(/Debugger listening on (ws:\/\/[^\s]+)/);
  if (!match || started) return;
  started = true;
  try {
    socket = new WebSocket(match[1]);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    const pending = new Map();
    let sequence = 0;
    socket.onmessage = (event) => {
      const response = JSON.parse(event.data);
      if (response.id) {
        const request = pending.get(response.id);
        pending.delete(response.id);
        if (response.error) request.reject(response.error);
        else request.resolve(response.result);
      }
    };
    const evaluate = (expression) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      });
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      ready = (await evaluate("!!process.mainModule"))?.result?.value === true;
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, "Main module must load");
    const response = await evaluate(`(async () => {
      const {app, BrowserWindow, Menu, safeStorage} = process.mainModule.require('electron');
      await app.whenReady();
      let window;
      for (let i = 0; i < 200; i++) {
        window = BrowserWindow.getAllWindows()[0];
        if (window && !window.webContents.isLoading() && await window.webContents.executeJavaScript('!!document.querySelector(".home")')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const view = await window.webContents.executeJavaScript('(async () => ({ home: !!document.querySelector(".home"), profiles: await window.trident.profiles(), platform: document.documentElement.dataset.platform, logo: document.querySelector(".brand-mark")?.naturalWidth, node: typeof window.require }))()');
      const encrypted = safeStorage.encryptString('installer-test');
      return { packaged: app.isPackaged, version: app.getVersion(), view, vault: safeStorage.decryptString(encrypted) === 'installer-test', menus: Menu.getApplicationMenu().items[0].submenu.items.map(item => item.label) };
    })()`);
    if (response.exceptionDetails)
      throw new Error(JSON.stringify(response.exceptionDetails));
    const result = response.result.value;
    assert.equal(result.packaged, true);
    assert.equal(result.version, expectedVersion);
    assert.equal(result.view.home, true);
    assert.equal(result.view.platform, "other");
    assert.ok(result.view.logo > 0);
    assert.equal(result.view.node, "undefined");
    assert.deepEqual(result.view.profiles, []);
    assert.equal(result.vault, true);
    assert.ok(result.menus.includes("下载新版本…"));
    assert.ok(!result.menus.includes("自动检查更新"));
    passed = true;
    await evaluate(
      "setTimeout(() => process.mainModule.require('electron').app.quit(), 100); 'quit'",
    );
    socket.close();
  } catch (error) {
    console.error(error, output);
    process.exitCode = 1;
    socket?.close();
    child.kill();
  }
});
child.on("exit", (code) => {
  clearTimeout(timer);
  socket?.close();
  if (!passed || code !== 0) {
    console.error("Installed application failed", code, output);
    process.exitCode = 1;
  } else
    console.log(
      "Installed Windows application passed: startup, version, UI, isolated IPC, DPAPI and quit",
    );
});
