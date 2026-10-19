const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createQuitCoordinator } = require("../electron/quit-coordinator.cjs");
const { createUpdater } = require("../electron/updater.cjs");

test("quit waits for persistence, blocks new work and does not duplicate prompts", async () => {
  const app = new EventEmitter();
  let quit = 0,
    prompts = 0,
    closed = 0,
    finish;
  app.quit = () => quit++;
  const flushed = new Promise((resolve) => {
    finish = resolve;
  });
  const q = createQuitCoordinator({
    app,
    confirm: () => {
      prompts++;
      return true;
    },
    flush: () => flushed,
    disconnect: () => closed++,
    showError: assert.fail,
  });
  let prevented = 0;
  app.emit("before-quit", {
    preventDefault() {
      prevented++;
    },
  });
  app.emit("before-quit", {
    preventDefault() {
      prevented++;
    },
  });
  assert.throws(() => q.assertOpen(), /正在保存/);
  assert.equal(closed, 0);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts, 1);
  assert.equal(prevented, 2);
  assert.equal(closed, 1);
  assert.equal(quit, 1);
  app.emit("before-quit", { preventDefault: assert.fail });
});

test("cancel or failed save prevents exit and permits further use", async () => {
  for (const failure of [false, true]) {
    const app = new EventEmitter();
    const errors = [];
    const q = createQuitCoordinator({
      app,
      confirm: () => failure,
      flush: async () => {
        throw new Error("disk full");
      },
      disconnect: assert.fail,
      showError: (e) => errors.push(e),
    });
    assert.equal(await q.prepare(), false);
    q.assertOpen();
    assert.equal(errors.length, failure ? 1 : 0);
  }
});

test("aborted installation unlocks the application and invalidates pending preparation", async () => {
  const app = new EventEmitter();
  let finish;
  const flushed = new Promise((resolve) => {
    finish = resolve;
  });
  let disconnected = 0;
  const q = createQuitCoordinator({
    app,
    confirm: () => true,
    flush: () => flushed,
    disconnect: () => disconnected++,
    showError: assert.fail,
  });
  const pending = q.prepare();
  q.cancelPreparation();
  q.assertOpen();
  finish();
  assert.equal(await pending, false);
  assert.equal(disconnected, 0);
  assert.equal(await q.prepare(), true);
  q.cancelPreparation();
  assert.equal(q.prepared, false);
  q.assertOpen();
});

test("development builds expose an explanation without loading native updates", () => {
  const errors = [];
  const updater = createUpdater({
    app: { isPackaged: false },
    dialog: { showErrorBox: (_, e) => errors.push(e) },
    prepareQuit: assert.fail,
    isBusy: () => false,
    load: assert.fail,
  });
  updater.assertCanConnect();
  if (process.platform === "win32") {
    assert.equal(updater.menu()[0].label, "下载新版本…");
    return;
  }
  updater.menu()[0].click();
  assert.match(errors[0], /未配置/);
  assert.equal(updater.menu()[1].enabled, false);
});

test("Windows opens the fixed release page and never loads Sparkle", async () => {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const opened = [];
    const updater = createUpdater({
      app: { isPackaged: true },
      dialog: { showErrorBox: assert.fail },
      prepareQuit: assert.fail,
      isBusy: () => false,
      load: assert.fail,
      openExternal: async (url) => opened.push(url),
    });
    updater.assertCanConnect();
    assert.equal(updater.menu().length, 1);
    updater.menu()[0].click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, [
      "https://github.com/zongzhu318/Trident/releases/latest",
    ]);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("resume that fails to terminate the app restores availability", async () => {
  const errors = [];
  let cancelled = 0;
  const bridge = {
    start() {},
    state: () => ({ pendingInstall: true }),
    setBusy() {},
    resume() {},
  };
  const originalPlatform = process.platform;
  const originalResourcesPath = process.resourcesPath;
  Object.defineProperty(process, "platform", { value: "darwin" });
  process.resourcesPath = "/tmp/trident-test-resources";
  try {
    const updater = createUpdater({
      app: { isPackaged: true },
      dialog: { showErrorBox: (_, e) => errors.push(e) },
      prepareQuit: async () => true,
      cancelQuit: () => cancelled++,
      isBusy: () => false,
      load: (p) => (p.endsWith("config.json") ? { enabled: true } : bridge),
      resumeGraceMs: 20,
    });
    updater.menu()[0].click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cancelled, 1);
    assert.match(errors[0], /未能完成/);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.resourcesPath = originalResourcesPath;
  }
});
