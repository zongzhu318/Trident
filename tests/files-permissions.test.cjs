const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  modeToSymbolic,
  symbolicOrEmpty,
  ftpPermissions,
} = require("../electron/files.cjs");

test("modeToSymbolic masks type bits and pads octal digits", () => {
  assert.equal(modeToSymbolic(0o644), "rw-r--r--");
  assert.equal(modeToSymbolic(0o600), "rw-------");
  assert.equal(modeToSymbolic(0o755), "rwxr-xr-x");
  assert.equal(modeToSymbolic(0o075), "---rwxr-x");
  assert.equal(modeToSymbolic(0o100644), "rw-r--r--");
  assert.equal(modeToSymbolic(undefined), "");
});

test("symbolicOrEmpty accepts only 9-digit symbolic permissions", () => {
  assert.equal(symbolicOrEmpty("rwxr-xr-x"), "rwxr-xr-x");
  assert.equal(symbolicOrEmpty("drwxr-xr-x"), "");
  assert.equal(symbolicOrEmpty("644"), "");
  assert.equal(symbolicOrEmpty(undefined), "");
});

test("ftpPermissions normalizes basic-ftp mode digits", () => {
  assert.equal(ftpPermissions({ user: 6, group: 4, world: 4 }), "rw-r--r--");
  assert.equal(ftpPermissions({ user: 7, group: 5, world: 5 }), "rwxr-xr-x");
  assert.equal(ftpPermissions({ user: 0, group: 7, world: 5 }), "---rwxr-x");
  assert.equal(ftpPermissions({ user: 0, group: 0, world: 0 }), "---------");
  assert.equal(
    ftpPermissions({ user: "rw-", group: "r--", world: "r--" }),
    "rw-r--r--",
  );
  assert.equal(ftpPermissions(undefined), "");
});
