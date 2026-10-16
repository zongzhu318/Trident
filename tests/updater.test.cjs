const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createQuitCoordinator } = require("../electron/quit-coordinator.cjs");
const { createUpdater } = require("../electron/updater.cjs");
const {
  compare,
  validVersion,
  checkKey,
} = require("../scripts/release/publish.cjs");
const { generateKeyPairSync } = require("node:crypto");

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

test("stable ordering rejects prereleases and compares numeric versions", () => {
  assert.equal(compare("0.10.0", "0.9.9"), 1);
  assert.equal(compare("0.4.0", "0.4.0"), 0);
  assert.equal(compare("0.4.0", "1.0.0"), -1);
  assert.equal(validVersion("0.4.0-beta.1"), false);
  assert.equal(validVersion("00.4.0"), false);
});

test("release requires matching Sparkle public/private keys", () => {
  const previous = { ...process.env };
  try {
    const pair = generateKeyPairSync("ed25519");
    process.env.SPARKLE_PRIVATE_KEY = pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .subarray(-32)
      .toString("base64");
    process.env.SPARKLE_PUBLIC_KEY = pair.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64");
    checkKey();
    process.env.SPARKLE_PUBLIC_KEY = Buffer.alloc(32).toString("base64");
    assert.throws(checkKey, /do not match/);
  } finally {
    for (const key of ["SPARKLE_PRIVATE_KEY", "SPARKLE_PUBLIC_KEY"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
