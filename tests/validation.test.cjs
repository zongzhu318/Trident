const { test } = require("node:test");
const assert = require("node:assert/strict");
const { profile, remotePath, fileName } = require("../electron/validation.cjs");
const valid = {
  id: "one",
  name: "Server",
  protocol: "ssh",
  host: "example.com",
  port: 22,
  username: "root",
  auth: "password",
  keyPath: "",
  group: "",
};

test("persisted connection configuration excludes passwords and unknown fields", () => {
  const result = profile({
    ...valid,
    password: "secret",
    passphrase: "secret",
    privateKey: "secret",
    arbitrary: true,
  });
  assert.deepEqual(result, valid);
});
test("hostnames and IPv6 accepted, protocol URLs and whitespace rejected", () => {
  assert.equal(profile({ ...valid, host: "2001:db8::1" }).host, "2001:db8::1");
  for (const host of [
    "ssh://example.com",
    "example.com/path",
    "bad host",
    "host\0name",
  ]) {
    assert.throws(() => profile({ ...valid, host }));
  }
});
test("port and authentication validated before connecting", () => {
  for (const port of [0, -1, 65536, 22.5, "not-a-port"])
    assert.throws(() => profile({ ...valid, port }));
  assert.throws(() => profile({ ...valid, auth: "none" }));
  assert.throws(() => profile({ ...valid, auth: "key" }));
  assert.equal(
    profile({ ...valid, auth: "key", keyPath: "/Users/test/.ssh/id_ed25519" })
      .auth,
    "key",
  );
});
test("remote paths normalized using POSIX rules and must be absolute", () => {
  assert.equal(remotePath("/home/test/../other"), "/home/other");
  assert.equal(remotePath("/"), "/");
  for (const value of ["../etc", "relative", "/bad\0path", null])
    assert.throws(() => remotePath(value));
});
test("folder names cannot escape the selected remote directory", () => {
  for (const value of ["..", ".", "../escape", "a/b", "a\\b", "bad\0name", ""])
    assert.throws(() => fileName(value));
  assert.equal(fileName("项目 files"), "项目 files");
});
