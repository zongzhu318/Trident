const {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scrypt,
} = require("node:crypto");
const { promisify } = require("node:util");
const validate = require("./validation.cjs");
const derive = promisify(scrypt);
const MAX_BACKUP = 8 * 1024 * 1024;
const AAD = Buffer.from("trident-backup:v1:scrypt-v1");
const LOCAL_FORMAT = "trident-local:v1";

function credentials(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("凭据格式无效");
  const result = {};
  for (const name of ["password", "passphrase"]) {
    if (value[name] !== undefined) {
      if (
        typeof value[name] !== "string" ||
        value[name].length > 16384 ||
        value[name].includes("\0")
      )
        throw new Error("密码或口令格式无效");
      result[name] = value[name];
    }
  }
  return result;
}
function binding(profile) {
  return JSON.stringify([
    profile.protocol ?? "ssh",
    profile.host,
    profile.port,
    profile.username,
    profile.auth,
    profile.keyPath,
  ]);
}
function relevant(profile, input) {
  const value = credentials(input);
  return profile.auth === "password"
    ? value.password === undefined
      ? {}
      : { password: value.password }
    : profile.auth === "key"
      ? value.passphrase === undefined
        ? {}
        : { passphrase: value.passphrase }
      : {};
}
function parseLocalSecret(record, requested) {
  if (!record?.secret || binding(record) !== binding(requested)) return {};
  try {
    const value = JSON.parse(record.secret);
    if (value?.format !== LOCAL_FORMAT || value.binding !== binding(requested))
      return {};
    return relevant(requested, value.credentials);
  } catch {
    return {};
  }
}
function makeVault() {
  return {
    seal(profile, input) {
      const value = relevant(profile, input);
      if (!Object.keys(value).length) return undefined;
      return JSON.stringify({
        format: LOCAL_FORMAT,
        binding: binding(profile),
        credentials: value,
      });
    },
    open(record, requested = record) {
      return parseLocalSecret(record, requested);
    },
  };
}
function publicProfile(record) {
  return {
    ...validate.profile(record),
    hasSavedCredentials:
      Object.keys(parseLocalSecret(record, record)).length > 0,
  };
}
function validateEntries(entries, allowCredentials) {
  if (!Array.isArray(entries) || entries.length > 1000)
    throw new Error("最多支持导入 1000 个连接");
  return entries.map((entry) => {
    const profile = validate.profile(entry.profile);
    if (!allowCredentials && entry.credentials !== undefined)
      throw new Error("包含凭据的备份必须加密");
    return {
      profile,
      credentials: allowCredentials ? relevant(profile, entry.credentials) : {},
    };
  });
}
function passwordValid(password) {
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 1024
  )
    throw new Error("备份密码需要 8–1024 个字符");
}
async function keyFor(password, salt) {
  return derive(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}
async function encodeBackup(entries, includeCredentials, password) {
  const normalized = validateEntries(
    entries.map((e) => (includeCredentials ? e : { profile: e.profile })),
    includeCredentials,
  );
  const payload = {
    entries: normalized.map((e) =>
      includeCredentials ? e : { profile: e.profile },
    ),
  };
  const header = {
    format: "trident-backup",
    version: 1,
    encrypted: Boolean(includeCredentials),
  };
  if (!includeCredentials)
    return JSON.stringify({ ...header, ...payload }, null, 2);
  passwordValid(password);
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const key = await keyFor(password, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return JSON.stringify(
      {
        ...header,
        kdf: "scrypt-v1",
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      },
      null,
      2,
    );
  } finally {
    key.fill(0);
  }
}
async function decodeBackup(text, password) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BACKUP)
    throw new Error("备份文件过大（最多 8 MB）");
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("备份文件不是有效 JSON");
  }
  if (
    !envelope ||
    envelope.format !== "trident-backup" ||
    envelope.version !== 1 ||
    typeof envelope.encrypted !== "boolean"
  )
    throw new Error("不支持的 Trident 备份格式或版本");
  if (!envelope.encrypted) return validateEntries(envelope.entries, false);
  passwordValid(password);
  if (envelope.kdf !== "scrypt-v1") throw new Error("不支持的备份加密方式");
  function bytes(name, length) {
    if (
      typeof envelope[name] !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(envelope[name])
    )
      throw new Error("备份加密数据无效");
    const buffer = Buffer.from(envelope[name], "base64");
    if (length && buffer.length !== length) throw new Error("备份加密数据无效");
    return buffer;
  }
  const salt = bytes("salt", 16),
    iv = bytes("iv", 12),
    tag = bytes("tag", 16),
    data = bytes("data");
  const key = await keyFor(password, salt);
  let decoded;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    decoded = JSON.parse(
      Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"),
    );
  } catch {
    throw new Error("备份密码错误或文件已损坏");
  } finally {
    key.fill(0);
  }
  return validateEntries(decoded.entries, true);
}
module.exports = {
  makeVault,
  relevant,
  publicProfile,
  encodeBackup,
  decodeBackup,
  MAX_BACKUP,
};
