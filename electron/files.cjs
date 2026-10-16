const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const path = require("node:path");
const validate = require("./validation.cjs");
const call = (sftp, method, ...args) =>
  new Promise((resolve, reject) =>
    sftp[method](...args, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );

function sftpFiles(sftp) {
  return {
    async list(directory) {
      const resolved = await call(
        sftp,
        "realpath",
        directory === null ? "." : validate.remotePath(directory),
      );
      const files = await call(sftp, "readdir", resolved);
      return {
        path: resolved,
        files: files
          .filter((f) => f.filename !== "." && f.filename !== "..")
          .map((f) => ({
            name: f.filename,
            size: f.attrs.size,
            modified: f.attrs.mtime,
            directory: f.attrs.isDirectory(),
            symlink: f.attrs.isSymbolicLink(),
            permissions: (f.attrs.mode & 0o777).toString(8),
          })),
      };
    },
    mkdir: (target) => call(sftp, "mkdir", target),
    async rename(source, target) {
      try {
        await call(sftp, "lstat", target);
      } catch (error) {
        if (error.code === 2) return call(sftp, "rename", source, target);
        throw error;
      }
      throw new Error("目标名称已存在，请使用其他名称");
    },
    async remove(target) {
      const attrs = await call(sftp, "lstat", target);
      return call(
        sftp,
        attrs.isDirectory() && !attrs.isSymbolicLink() ? "rmdir" : "unlink",
        target,
      );
    },
    async upload(local, remote, report) {
      const { size } = await fs.stat(local);
      let transferred = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          transferred += chunk.length;
          report(transferred, chunk.length, size);
          callback(null, chunk);
        },
      });
      await pipeline(
        createReadStream(local),
        meter,
        sftp.createWriteStream(remote, { flags: "wx", mode: 0o600 }),
      );
    },
    download: (remote, local, report) =>
      call(sftp, "fastGet", remote, local, { step: report }),
  };
}

function ftpFiles(client) {
  async function list(directory) {
    const resolved =
      directory === null
        ? validate.remotePath(await client.pwd())
        : validate.remotePath(directory);
    const files = await client.list(resolved);
    return {
      path: resolved,
      files: files
        .filter((f) => f.name !== "." && f.name !== "..")
        .map((f) => ({
          name: f.name,
          size: f.size,
          modified: f.modifiedAt
            ? Math.floor(f.modifiedAt.getTime() / 1000)
            : 0,
          directory: f.isDirectory,
          symlink: f.isSymbolicLink,
          permissions: f.permissions
            ? `${f.permissions.user}${f.permissions.group}${f.permissions.world}`
            : "—",
        })),
    };
  }
  async function exists(target) {
    return (await list(path.posix.dirname(target))).files.some(
      (f) => f.name === path.posix.basename(target),
    );
  }
  return {
    list,
    mkdir: (target) => client.send(`MKD ${target}`),
    async rename(source, target) {
      if (await exists(target))
        throw new Error("目标名称已存在，请使用其他名称");
      return client.rename(source, target);
    },
    async remove(target) {
      const item = (await list(path.posix.dirname(target))).files.find(
        (f) => f.name === path.posix.basename(target),
      );
      if (!item) throw new Error("文件已不存在");
      // RMD only removes empty directories; never recursively deletes contents.
      return item.directory && !item.symlink
        ? client.send(`RMD ${target}`)
        : client.remove(target);
    },
    async upload(local, remote, report) {
      if (await exists(remote)) throw new Error("目标文件已存在，未上传");
      const { size } = await fs.stat(local);
      client.trackProgress((info) => report(info.bytes, 0, size));
      try {
        await client.uploadFrom(local, remote);
      } finally {
        client.trackProgress();
      }
    },
    async download(remote, local, report) {
      const size = await client.size(remote).catch(() => 0);
      client.trackProgress((info) => report(info.bytes, 0, size));
      try {
        await client.downloadTo(local, remote);
      } finally {
        client.trackProgress();
      }
    },
  };
}
module.exports = { sftpFiles, ftpFiles };
