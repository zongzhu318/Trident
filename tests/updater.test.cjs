const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createQuitCoordinator } = require("../electron/quit-coordinator.cjs");
const { createUpdater } = require("../electron/updater.cjs");

test("preparation flushes state, disconnects once and is not repeated", async () => {
  let prompts = 0,
    closed = 0,
    finish;
  const flushed = new Promise((resolve) => {
    finish = resolve;
  });
  const q = createQuitCoordinator({
    confirm: () => {
      prompts++;
      return true;
    },
    flush: () => flushed,
    disconnect: () => closed++,
    showError: assert.fail,
  });
  const first = q.prepare();
  const second = q.prepare();
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => q.assertOpen(), /正在保存/);
  assert.equal(closed, 0);
  finish();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(prompts, 1);
  assert.equal(closed, 1);
  assert.equal(await q.prepare(), true);
  assert.equal(prompts, 1);
  assert.equal(closed, 1);
});

test("the renderer stays usable while the quit confirmation is pending", async () => {
  let resolveConfirm;
  const q = createQuitCoordinator({
    confirm: () =>
      new Promise((resolve) => {
        resolveConfirm = resolve;
      }),
    flush: async () => {},
    disconnect: () => {},
    showError: assert.fail,
  });
  const pending = q.prepare();
  await new Promise((resolve) => setImmediate(resolve));
  q.assertOpen();
  resolveConfirm(true);
  assert.equal(await pending, true);
  assert.throws(() => q.assertOpen(), /正在保存/);
});

test("cancel or failed save prevents exit and permits further use", async () => {
  for (const failure of [false, true]) {
    const errors = [];
    const q = createQuitCoordinator({
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
  let finish;
  const flushed = new Promise((resolve) => {
    finish = resolve;
  });
  let disconnected = 0;
  const q = createQuitCoordinator({
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

function fakeUpdaterModule() {
  const listeners = new Map();
  const calls = { checks: 0, installs: [] };
  const autoUpdater = {
    autoDownload: undefined,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    async checkForUpdates() {
      calls.checks++;
    },
    quitAndInstall(silent, force) {
      calls.installs.push([silent, force]);
    },
  };
  return {
    module: { autoUpdater },
    autoUpdater,
    calls,
    emit(event, payload) {
      for (const handler of listeners.get(event) || []) handler(payload);
    },
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("development builds expose an explanation without loading native updates", () => {
  const errors = [];
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const updater = createUpdater({
      app: { isPackaged: false },
      dialog: { showErrorBox: (_, e) => errors.push(e) },
      prepareQuit: assert.fail,
      isBusy: () => false,
      load: assert.fail,
    });
    updater.assertCanConnect();
    updater.menu()[0].click();
    assert.match(errors[0], /未配置/);
    assert.equal(updater.menu()[1].enabled, false);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("Windows development builds explain packaging requirement without network access", () => {
  const errors = [];
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const updater = createUpdater({
      app: { isPackaged: false },
      dialog: { showErrorBox: (_, e) => errors.push(e) },
      prepareQuit: assert.fail,
      isBusy: () => false,
      load: assert.fail,
    });
    updater.assertCanConnect();
    assert.equal(updater.menu()[0].label, "检查更新…");
    updater.menu()[0].click();
    assert.match(errors[0], /打包版/);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("Windows packaged builds reject the update check while busy", () => {
  const errors = [];
  const fake = fakeUpdaterModule();
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const updater = createUpdater({
      app: { isPackaged: true },
      dialog: { showErrorBox: (_, e) => errors.push(e) },
      prepareQuit: assert.fail,
      isBusy: () => true,
      load: () => fake.module,
    });
    assert.equal(fake.autoUpdater.autoDownload, true);
    updater.menu()[0].click();
    assert.match(errors[0], /断开/);
    assert.equal(fake.calls.checks, 0);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("Windows packaged builds check updates when idle", async () => {
  const fake = fakeUpdaterModule();
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const updater = createUpdater({
      app: { isPackaged: true },
      dialog: { showErrorBox: assert.fail },
      prepareQuit: assert.fail,
      isBusy: () => false,
      load: () => fake.module,
    });
    updater.menu()[0].click();
    await flush();
    assert.equal(fake.calls.checks, 1);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("Windows download completion (full or differential fallback) prompts with release notes and installs on confirm", async () => {
  const fake = fakeUpdaterModule();
  const dialogs = [];
  let resolveBox;
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const updater = createUpdater({
      app: { isPackaged: true },
      dialog: {
        showErrorBox: assert.fail,
        showMessageBox: (options) => {
          dialogs.push(options);
          return new Promise((resolve) => {
            resolveBox = resolve;
          });
        },
      },
      prepareQuit: async () => true,
      isBusy: () => false,
      load: () => fake.module,
    });
    fake.emit("update-downloaded", {
      version: "1.2.4",
      releaseNotes: "修复了若干问题。",
    });
    await flush();
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0].message, /1\.2\.4/);
    assert.match(dialogs[0].detail, /修复了若干问题/);
    resolveBox({ response: 0 });
    await flush();
    assert.deepEqual(fake.calls.installs, [[true, true]]);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("Windows release notes in HTML are converted to plain text for the prompt", async () => {
  const fake = fakeUpdaterModule();
  const dialogs = [];
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const updater = createUpdater({
      app: { isPackaged: true },
      dialog: {
        showErrorBox: assert.fail,
        showMessageBox: async (options) => {
          dialogs.push(options);
          return { response: 1 };
        },
      },
      prepareQuit: assert.fail,
      isBusy: () => false,
      load: () => fake.module,
    });
    fake.emit("update-downloaded", {
      version: "0.0.11",
      releaseNotes:
        "<h3>优化</h3>\n<ul>\n<li>例行发布，无用户可感知的变更。</li>\n</ul>",
    });
    await flush();
    assert.equal(dialogs.length, 1);
    assert.equal(
      dialogs[0].detail,
      "优化\n\n• 例行发布，无用户可感知的变更。",
    );
    assert.equal(fake.calls.installs.length, 0);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("Windows install prompt waits for idle sessions before showing", async () => {
  const fake = fakeUpdaterModule();
  const dialogs = [];
  let busy = true;
  let response = 0;
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const updater = createUpdater({
      app: { isPackaged: true },
      dialog: {
        showErrorBox: assert.fail,
        showMessageBox: async (options) => {
          dialogs.push(options);
          return { response };
        },
      },
      prepareQuit: async () => true,
      isBusy: () => busy,
      load: () => fake.module,
    });
    fake.emit("update-downloaded", { version: "1.2.4", releaseNotes: "" });
    await flush();
    assert.equal(dialogs.length, 0);
    assert.equal(fake.calls.installs.length, 0);
    busy = false;
    updater.refreshBusy();
    await flush();
    assert.equal(dialogs.length, 1);
    assert.equal(fake.calls.installs.length, 1);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("Windows install confirmation saves state via prepareQuit before quitting", async () => {
  const fake = fakeUpdaterModule();
  const order = [];
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const updater = createUpdater({
      app: { isPackaged: true },
      dialog: {
        showErrorBox: assert.fail,
        showMessageBox: async () => ({ response: 0 }),
      },
      prepareQuit: async () => {
        order.push("prepare");
        return true;
      },
      isBusy: () => false,
      load: () => fake.module,
    });
    fake.autoUpdater.quitAndInstall = (silent, force) => {
      order.push(["install", silent, force]);
    };
    fake.emit("update-downloaded", { version: "1.2.4", releaseNotes: "" });
    await flush();
    assert.deepEqual(order, [
      "prepare",
      ["install", true, true],
    ]);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("Windows install confirmation aborts without quitting when saving is cancelled", async () => {
  const fake = fakeUpdaterModule();
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const updater = createUpdater({
      app: { isPackaged: true },
      dialog: {
        showErrorBox: assert.fail,
        showMessageBox: async () => ({ response: 0 }),
      },
      prepareQuit: async () => false,
      isBusy: () => false,
      load: () => fake.module,
    });
    fake.emit("update-downloaded", { version: "1.2.4", releaseNotes: "" });
    await flush();
    assert.equal(fake.calls.installs.length, 0);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("Windows install confirmation re-checks busy state before quitting", async () => {
  const fake = fakeUpdaterModule();
  const errors = [];
  const dialogs = [];
  let busy = false;
  let resolveBox;
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const updater = createUpdater({
      app: { isPackaged: true },
      dialog: {
        showErrorBox: (_, e) => errors.push(e),
        showMessageBox: (options) => {
          dialogs.push(options);
          return new Promise((resolve) => {
            resolveBox = resolve;
          });
        },
      },
      prepareQuit: async () => true,
      isBusy: () => busy,
      load: () => fake.module,
    });
    fake.emit("update-downloaded", { version: "1.2.4", releaseNotes: "" });
    await flush();
    busy = true;
    resolveBox({ response: 0 });
    await flush();
    assert.match(errors[0], /断开/);
    assert.equal(fake.calls.installs.length, 0);
    busy = false;
    updater.menu()[0].click();
    await flush();
    assert.equal(dialogs.length, 2);
    resolveBox({ response: 0 });
    await flush();
    assert.deepEqual(fake.calls.installs, [[true, true]]);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("Windows updater errors are presented and a later check restarts cleanly", async () => {
  const errors = [];
  const fake = fakeUpdaterModule();
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const updater = createUpdater({
      app: { isPackaged: true },
      dialog: { showErrorBox: (_, e) => errors.push(e) },
      prepareQuit: assert.fail,
      isBusy: () => false,
      load: () => fake.module,
    });
    updater.menu()[0].click();
    await flush();
    fake.emit("error", new Error("网络中断"));
    assert.match(errors[0], /网络中断/);
    updater.menu()[0].click();
    await flush();
    assert.equal(fake.calls.checks, 2);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("Windows updater reports when already on the latest version", async () => {
  const fake = fakeUpdaterModule();
  const dialogs = [];
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const updater = createUpdater({
      app: { isPackaged: true },
      dialog: {
        showErrorBox: assert.fail,
        showMessageBox: async (options) => {
          dialogs.push(options);
          return { response: 0 };
        },
      },
      prepareQuit: assert.fail,
      isBusy: () => false,
      load: () => fake.module,
    });
    fake.emit("update-not-available");
    await flush();
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0].message, /已是最新版本/);
    assert.equal(fake.calls.installs.length, 0);
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
