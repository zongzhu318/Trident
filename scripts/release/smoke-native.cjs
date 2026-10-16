// Launch a real packaged binary with a loopback-only Node inspector.
// Uses temporary user data; never edits the tested application bundle.
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const appPath = path.resolve(process.argv[2]);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "trident-sparkle-"));
const fixture = path.join(temp, "cocoa-terminate.node");
const marker = path.join(temp, "before-quit");
execFileSync("xcrun", [
  "clang++",
  "-fobjc-arc",
  "-fblocks",
  "-DNAPI_VERSION=8",
  "-DNODE_GYP_MODULE_NAME=cocoa_terminate",
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-I",
  process.env.NODE_API_HEADERS ||
    path.resolve(`vendor/node-v${process.versions.node}/include/node`),
  "-framework",
  "Cocoa",
  "tests/helpers/cocoa-terminate.mm",
  "-o",
  fixture,
]);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  path.join(appPath, "Contents/MacOS/Trident"),
  ["--inspect=127.0.0.1:0", `--user-data-dir=${temp}`],
  { env: environment, stdio: ["ignore", "pipe", "pipe"] },
);
let socket;
const timer = setTimeout(() => {
  console.error("Native updater smoke timed out");
  child.kill();
  process.exitCode = 1;
}, 30000);
let started = false;
let stderr = "";
child.stdout.on("data", (chunk) => {
  stderr += chunk;
});
child.on("error", (error) => {
  console.error(error);
  clearTimeout(timer);
  process.exitCode = 1;
});
child.stderr.on("data", async (chunk) => {
  stderr += chunk;
  const match = stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/);
  if (!match || started) return;
  started = true;
  try {
    socket = new WebSocket(match[1]);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    let sequence = 0;
    const pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const p = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) p.reject(message.error);
        else p.resolve(message.result);
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
    const result = await evaluate(`(async () => {
      for (let i = 0; i < 100 && !process.mainModule; i++) await new Promise(r => setTimeout(r, 50));
      const { app, Menu } = process.mainModule.require('electron');
      await app.whenReady();
      for (let i = 0; i < 100 && !Menu.getApplicationMenu()?.items[0]?.submenu?.items.some(item => item.label === '自动检查更新'); i++) await new Promise(r => setTimeout(r, 50));
      const menu = Menu.getApplicationMenu().items[0].submenu.items;
      const automatic = menu.find(item => item.label === '自动检查更新');
      if (!automatic?.enabled) throw new Error('Native updater not enabled');
      const bridge = process.mainModule.require(process.resourcesPath + '/sparkle/sparkle-bridge.node');
      bridge.setBusy(true);
      let blocked = false;
      try { bridge.check(); } catch { blocked = true; }
      bridge.setBusy(false);
      const original = bridge.state().automatic;
      bridge.setAutomatic(!original);
      const toggled = bridge.state().automatic === !original;
      bridge.setAutomatic(original);
      return { packaged: app.isPackaged, version: app.getVersion(), blocked, toggled, original, state: bridge.state(), checkMenu: !!menu.find(item => item.label === '检查更新…') };
    })()`);
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    const state = result.result.value;
    assert.equal(state.packaged, true);
    assert.equal(state.blocked, true);
    assert.equal(state.toggled, true);
    assert.equal(state.checkMenu, true);
    assert.equal(state.state.canCheck, true);
    assert.equal(state.state.automatic, state.original);
    console.log("Native Sparkle smoke passed:", JSON.stringify(state));
    // Sparkle uses Cocoa termination. Verify it reaches Electron before-quit.
    await evaluate(
      `process.mainModule.require('electron').app.on('before-quit', () => process.mainModule.require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'before-quit\\n')); setTimeout(() => process.mainModule.require(${JSON.stringify(fixture)}).terminate(), 100); 'quitting'`,
    );
    socket.close();
  } catch (error) {
    console.error(error, stderr);
    process.exitCode = 1;
    socket?.close();
    child.kill();
  }
});
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  socket?.close();
  if (code !== 0 || signal || !started || !fs.existsSync(marker)) {
    console.error(
      "Application exited unexpectedly or bypassed before-quit",
      code,
      signal,
      stderr,
    );
    process.exitCode = 1;
  } else console.log("Cocoa termination passed through Electron before-quit");
});
