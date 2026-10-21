const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  makeVault,
  publicProfile,
  encodeBackup,
  decodeBackup,
} = require("../electron/credentials.cjs");
const profile = {
  id: "one",
  name: "测试",
  protocol: "sftp",
  host: "example.com",
  port: 22,
  username: "root",
  auth: "password",
  keyPath: "",
  group: "",
};
test("local credential vault stores plaintext bound to the endpoint and hides it from profile views", () => {
  const vault = makeVault();
  const record = {
    ...profile,
    secret: vault.seal(profile, { password: "very secret 密码" }),
  };
  assert.equal(
    JSON.parse(record.secret).credentials.password,
    "very secret 密码",
  );
  assert.deepEqual(vault.open(record), { password: "very secret 密码" });
  assert.deepEqual(
    vault.open(record, { ...profile, host: "other.example.com" }),
    {},
  );
  assert.deepEqual(vault.open(record, { ...profile, username: "other" }), {});
  assert.deepEqual(vault.open(record, { ...profile, protocol: "ftp" }), {});
  assert.equal(publicProfile(record).secret, undefined);
  assert.equal(publicProfile(record).hasSavedCredentials, true);
  assert.deepEqual(makeVault().open(record), { password: "very secret 密码" });
  const legacy = {
    ...profile,
    secret: Buffer.from("legacy-ciphertext").toString("base64"),
  };
  assert.deepEqual(vault.open(legacy), {});
  assert.equal(publicProfile(legacy).hasSavedCredentials, false);
});
test("private key passphrases persist locally and are only returned for key auth", () => {
  const keyProfile = { ...profile, auth: "key", keyPath: "/tmp/id_ed25519" };
  const vault = makeVault();
  const record = {
    ...keyProfile,
    secret: vault.seal(keyProfile, {
      password: "ignored",
      passphrase: "私钥口令",
    }),
  };
  assert.deepEqual(vault.open(record), { passphrase: "私钥口令" });
  assert.deepEqual(vault.open(record, { ...keyProfile, auth: "password" }), {});
  assert.deepEqual(
    vault.open(record, { ...keyProfile, keyPath: "/tmp/other" }),
    {},
  );
  assert.equal(publicProfile(record).hasSavedCredentials, true);
  assert.equal(vault.seal(profile, {}), undefined);
});
test("encrypted portable backups round trip passwords and passphrases, and reject tampering", async () => {
  const entries = [
    { profile, credentials: { password: "备份中的密码" } },
    {
      profile: {
        ...profile,
        id: "two",
        auth: "key",
        keyPath: "/tmp/id_ed25519",
      },
      credentials: { passphrase: "备份中的口令" },
    },
  ];
  const text = await encodeBackup(entries, true, "backup-password");
  assert.equal(text.includes("备份中的"), false);
  assert.equal(text.includes("example.com"), false);
  assert.deepEqual(await decodeBackup(text, "backup-password"), entries);
  await assert.rejects(decodeBackup(text, "wrong-password"), /密码错误/);
  const tampered = JSON.parse(text);
  const bytes = Buffer.from(tampered.data, "base64");
  bytes[0] ^= 1;
  tampered.data = bytes.toString("base64");
  await assert.rejects(
    decodeBackup(JSON.stringify(tampered), "backup-password"),
    /损坏/,
  );
});
test("plain exports contain only profiles and imports validate every entry before use", async () => {
  const text = await encodeBackup(
    [{ profile, credentials: { password: "must-not-export" } }],
    false,
  );
  assert.equal(text.includes("must-not-export"), false);
  assert.deepEqual(await decodeBackup(text), [{ profile, credentials: {} }]);
  const modified = JSON.parse(text);
  modified.entries[0].credentials = { password: "plaintext" };
  await assert.rejects(decodeBackup(JSON.stringify(modified)), /必须加密/);
  const invalid = JSON.parse(text);
  invalid.entries.push({ profile: { ...profile, port: 70000 } });
  await assert.rejects(decodeBackup(JSON.stringify(invalid)), /端口/);
  await assert.rejects(
    decodeBackup(JSON.stringify({ ...JSON.parse(text), version: 99 })),
    /版本/,
  );
  await assert.rejects(encodeBackup([{ profile }], true, "short"), /8–1024/);
});
