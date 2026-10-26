const { test } = require("node:test");
const assert = require("node:assert/strict");
const { uniqueName, uniqueNames, NAME_MAX } = require("../electron/naming.cjs");

test("keeps an unused name unchanged", () => {
  assert.equal(uniqueName("开发服务器", ["测试服务器"]), "开发服务器");
  assert.equal(uniqueName("开发服务器", []), "开发服务器");
});
test("appends the next available sequence number", () => {
  assert.equal(uniqueName("开发服务器", ["开发服务器"]), "开发服务器 (2)");
  assert.equal(
    uniqueName("开发服务器", ["开发服务器", "开发服务器 (2)"]),
    "开发服务器 (3)",
  );
  assert.equal(
    uniqueName("开发服务器 (2)", ["开发服务器 (2)"]),
    "开发服务器 (3)",
  );
});
test("matches existing names case-insensitively", () => {
  assert.equal(uniqueName("Production", ["production"]), "Production (2)");
  assert.equal(uniqueName("PROD", ["prod", "Prod (2)"]), "PROD (3)");
});
test("keeps generated names within the profile name limit", () => {
  const name = "服".repeat(NAME_MAX);
  const result = uniqueName(name, [name]);
  assert.equal(result.length, NAME_MAX);
  assert.ok(result.endsWith(" (2)"));
  assert.equal(
    uniqueName(name, [name, result]),
    `${"服".repeat(NAME_MAX - 4)} (3)`,
  );
});
test("renames a batch in order without mutating input", () => {
  const profiles = [{ name: "开发" }, { name: "开发" }, { name: "测试" }];
  const result = uniqueNames(profiles, ["开发"]);
  assert.deepEqual(
    result.map((p) => p.name),
    ["开发 (2)", "开发 (3)", "测试"],
  );
  assert.deepEqual(
    profiles.map((p) => p.name),
    ["开发", "开发", "测试"],
  );
  assert.equal(result[2], profiles[2]);
});
