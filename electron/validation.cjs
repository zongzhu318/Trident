const path = require("node:path");

function requiredString(value, label, max = 1024) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error(`${label}无效`);
  }
  return value.trim();
}

function profile(input) {
  if (!input || typeof input !== "object") throw new Error("连接配置无效");
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("端口必须为 1–65535");
  const protocol = input.protocol ?? "ssh";
  if (!["ssh", "sftp", "ftp", "ftps"].includes(protocol))
    throw new Error("连接协议无效");
  if (
    !["password", "key", "agent"].includes(input.auth) ||
    (["ftp", "ftps"].includes(protocol) && input.auth !== "password")
  )
    throw new Error("认证方式无效");
  const host = requiredString(input.host, "主机", 253);
  if (/[\s/]/.test(host))
    throw new Error("请输入主机名或 IP 地址，不要包含协议或路径");
  return {
    id: requiredString(input.id, "连接 ID", 128),
    name: requiredString(input.name, "名称", 100),
    protocol,
    host,
    port,
    username: requiredString(input.username, "用户名", 128),
    auth: input.auth,
    keyPath:
      input.auth === "key"
        ? requiredString(input.keyPath, "私钥路径", 4096)
        : "",
    group: typeof input.group === "string" ? input.group.slice(0, 60) : "",
  };
}

function remotePath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    /[\0\r\n]/.test(value) ||
    value.length > 8192
  ) {
    throw new Error("远程路径必须是绝对路径");
  }
  return path.posix.normalize(value);
}

function fileName(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    value === ".." ||
    /[/\\\0\r\n]/.test(value)
  ) {
    throw new Error("文件名无效");
  }
  return value;
}

module.exports = { profile, remotePath, fileName };
