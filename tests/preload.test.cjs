const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const vm = require("node:vm");

test("session events use one IPC listener and cross the bridge only for the target session", () => {
  let api;
  const ipcRenderer = new EventEmitter();
  vm.runInNewContext(
    fs.readFileSync(require.resolve("../electron/preload.cjs"), "utf8"),
    {
      require: () => ({
        ipcRenderer,
        contextBridge: {
          exposeInMainWorld(_name, value) {
            api = value;
          },
        },
      }),
    },
  );
  const hits = new Array(100).fill(0),
    cleanup = [];
  for (let i = 0; i < 100; i++)
    cleanup.push(api.onSessionEvent(String(i), () => hits[i]++, true));
  let controlHits = 0;
  cleanup.push(api.onSessionEvent("7", () => controlHits++));
  assert.equal(ipcRenderer.listenerCount("session:event"), 1);
  ipcRenderer.emit(
    "session:event",
    {},
    { id: "7", type: "data", data: Buffer.from("hello") },
  );
  assert.equal(hits[7], 1);
  assert.equal(controlHits, 0);
  assert.equal(
    hits.reduce((a, b) => a + b, 0),
    1,
  );
  cleanup.forEach((fn) => fn());
  ipcRenderer.emit("session:event", {}, { id: "7", type: "close" });
  assert.equal(hits[7], 1);
});
