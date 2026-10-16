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
  updater.menu()[0].click();
  assert.match(errors[0], /未配置/);
  assert.equal(updater.menu()[1].enabled, false);
});
