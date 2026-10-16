const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TerminalOutput } = require("../electron/terminal-output.cjs");

test("small terminal chunks are coalesced without changing bytes or UTF-8 boundaries", () => {
  const sent = [];
  const output = new TerminalOutput({
    send: (data) => sent.push(data),
    pause() {},
    resume() {},
  });
  const input = Buffer.from("中文终端\x1b[32m绿色\x1b[0m\r\n".repeat(100));
  for (const byte of input) output.push(Buffer.from([byte]));
  output.dispose();
  assert.equal(sent.length, 1);
  assert.deepEqual(Buffer.concat(sent), input);
});
test("backpressure pauses the source until parsed bytes are acknowledged", () => {
  let paused = 0,
    resumed = 0;
  const sent = [];
  const output = new TerminalOutput({
    send: (data) => sent.push(data),
    pause() {
      paused++;
    },
    resume() {
      resumed++;
    },
  });
  for (let i = 0; i < 16; i++) output.push(Buffer.alloc(16 * 1024, i));
  assert.equal(paused, 1);
  assert.equal(sent.length, 4);
  assert.equal(output.inFlight, 256 * 1024);
  for (const invalid of [-1, 0, 0.5, NaN, Infinity, 257 * 1024])
    output.acknowledge(invalid);
  assert.equal(output.inFlight, 256 * 1024);
  assert.equal(resumed, 0);
  output.acknowledge(192 * 1024);
  assert.equal(resumed, 1);
  assert.equal(output.inFlight, 64 * 1024);
  output.dispose();
});
test("interactive output flushes on its timer and disposal cancels subsequent work", async () => {
  const sent = [];
  const output = new TerminalOutput({
    send: (data) => sent.push(data),
    pause() {},
    resume() {},
    delay: 5,
  });
  output.push(Buffer.from("prompt> "));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sent[0].toString(), "prompt> ");
  output.push(Buffer.from("final output"));
  output.dispose();
  output.dispose();
  output.push(Buffer.from("ignored"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sent.length, 2);
  assert.equal(output.timer, null);
});
