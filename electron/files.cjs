const fs = require("node:fs/promises");
const { createReadStream, createWriteStream } = require("node:fs");
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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 中止后等待服务端关闭数据连接的控制响应，避免污染后续命令的应答队列
const FTP_CONTROL_TIMEOUT = 1000;

function modeToSymbolic(mode) {
  if (!Number.isInteger(mode)) return "";
  const digits = (mode & 0o777).toString(8).padStart(3, "0");
  let result = "";
  for (const char of digits) {
    const bits = Number.parseInt(char, 8);
    result += bits & 4 ? "r" : "-";
    result += bits & 2 ? "w" : "-";
    result += bits & 1 ? "x" : "-";
  }
  return result;
}

function symbolicOrEmpty(value) {
  return typeof value === "string" && /^[rwx-]{9}$/.test(value) ? value : "";
}

function ftpPermissions(permissions) {
  if (!permissions) return "";
  const parts = [permissions.user, permissions.group, permissions.world];
  if (parts.every((part) => Number.isInteger(part))) {
    const digits = parts.map((part) => (part & 7).toString(8)).join("");
    return modeToSymbolic(Number.parseInt(digits, 8));
  }
  return symbolicOrEmpty(parts.join(""));
}

function meter(report, start, total) {
  let transferred = start;
  return new Transform({
    transform(chunk, _encoding, callback) {
      transferred += chunk.length;
      report(transferred, total);
      callback(null, chunk);
    },
  });
}

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
            permissions: modeToSymbolic(f.attrs.mode),
          })),
      };
    },
    mkdir: (target) => call(sftp, "mkdir", target),
    async details(target) {
      try {
        const attrs = await call(sftp, "lstat", target);
        return {
          directory: attrs.isDirectory(),
          symlink: attrs.isSymbolicLink(),
          size: attrs.size,
        };
      } catch (error) {
        if (error.code === 2) return null;
        throw error;
      }
    },
    async exists(target) {
      try {
        await call(sftp, "lstat", target);
        return true;
      } catch (error) {
        if (error.code === 2) return false;
        throw error;
      }
    },
    async size(target) {
      try {
        return (await call(sftp, "lstat", target)).size;
      } catch (error) {
        if (error.code === 2) return null;
        throw error;
      }
    },
    async ensureDirectory(target) {
      // 先 mkdir：新建目录只需一次往返，已存在时再 stat 确认可合并
      try {
        await call(sftp, "mkdir", target);
        return;
      } catch (error) {
        let attrs;
        try {
          attrs = await call(sftp, "stat", target);
        } catch {
          // 目录不存在或无法读取时保留 mkdir 的原始错误
          throw error;
        }
        if (!attrs.isDirectory())
          throw new Error("远程已存在同名文件，无法创建目录");
      }
    },
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
    async upload(local, remote, report, { signal, start = 0, onOpen } = {}) {
      const { size } = await fs.stat(local);
      report(start, size);
      const destination =
        start > 0
          ? sftp.createWriteStream(remote, {
              flags: "r+",
              start,
              mode: 0o600,
            })
          : sftp.createWriteStream(remote, { flags: "wx", mode: 0o600 });
      // 先等 OPEN 结果再开始传输：若在 OPEN 往返中因停止销毁流，服务端可能已创建
      // 远程文件，但客户端收不到 open 回调，清理阶段就无法删除残留空文件
      let openError = null;
      await new Promise((resolve) => {
        destination.once("open", () => {
          onOpen?.();
          resolve();
        });
        destination.once("error", (error) => {
          openError = error;
          resolve();
        });
      });
      if (openError) {
        // 独占创建在打开阶段失败且尚未写入：可能只是同名冲突，交给上层确认
        if (start === 0 && !signal?.aborted) openError.sftpOpenFailed = true;
        throw openError;
      }
      await pipeline(
        createReadStream(local, start > 0 ? { start } : undefined),
        meter(report, start, size),
        destination,
        { signal },
      );
    },
    async download(remote, local, report, { signal, start = 0 } = {}) {
      const { size } = await call(sftp, "lstat", remote);
      report(start, size);
      await pipeline(
        sftp.createReadStream(remote, start > 0 ? { start } : undefined),
        meter(report, start, size),
        // 临时文件名由本次任务随机生成，追加写入即可从偏移续传
        createWriteStream(local, { flags: "a", mode: 0o600 }),
        { signal },
      );
    },
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
          permissions: ftpPermissions(f.permissions),
        })),
    };
  }
  async function find(target) {
    return (await list(path.posix.dirname(target))).files.find(
      (f) => f.name === path.posix.basename(target),
    );
  }
  async function exists(target) {
    return Boolean(await find(target));
  }
  return {
    list,
    exists,
    async details(target) {
      const item = await find(target);
      if (!item) return null;
      return {
        directory: item.directory && !item.symlink,
        symlink: item.symlink,
        size: item.size,
      };
    },
    async size(target) {
      try {
        return await client.size(target);
      } catch {
        return null;
      }
    },
    mkdir: (target) => client.send(`MKD ${target}`),
    async ensureDirectory(target) {
      const item = await find(target);
      if (item) {
        if (!item.directory)
          throw new Error("远程已存在同名文件，无法创建目录");
        return;
      }
      await client.send(`MKD ${target}`);
    },
    async rename(source, target) {
      if (await exists(target))
        throw new Error("目标名称已存在，请使用其他名称");
      return client.rename(source, target);
    },
    async remove(target) {
      const item = await find(target);
      if (!item) throw new Error("文件已不存在");
      // RMD only removes empty directories; never recursively deletes contents.
      return item.directory && !item.symlink
        ? client.send(`RMD ${target}`)
        : client.remove(target);
    },
    async upload(local, remote, report, { signal, start = 0, onOpen } = {}) {
      if (signal?.aborted) throw new Error("传输已中止");
      const { size } = await fs.stat(local);
      report(start, size);
      onOpen?.();
      const source = createReadStream(local, start > 0 ? { start } : undefined);
      let aborted = false;
      // 主动销毁源流会让 basic-ftp 关闭整条控制连接；改为正常结束数据流
      const onAbort = () => {
        aborted = true;
        source.push(null);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      client.trackProgress((info) => report(start + info.bytes, size));
      try {
        // APPE 续写已存在的部分文件；首次上传仍由控制器先做同名检查
        if (start > 0) await client.appendFrom(source, remote);
        else await client.uploadFrom(source, remote);
        if (aborted) throw new Error("传输已中止");
      } finally {
        signal?.removeEventListener("abort", onAbort);
        client.trackProgress();
        source.destroy();
      }
    },
    async download(remote, local, report, { signal, start = 0 } = {}) {
      if (signal?.aborted) throw new Error("传输已中止");
      const size = await client.size(remote).catch(() => 0);
      report(start, size);
      const ftp = client.ftp;
      await client.prepareTransfer(ftp);
      const socket = ftp.dataSocket;
      if (!socket) throw new Error("无法建立 FTP 数据连接");
      const destination = createWriteStream(local, {
        flags: "a",
        mode: 0o600,
      });
      // 本地写入失败（目录被删除、磁盘已满）时先无错关闭数据连接：
      // 否则 pipeline 会把本地错误传播到数据 socket，basic-ftp 会因此关闭整条控制连接
      destination.once("error", () => {
        if (ftp.dataSocket === socket) ftp.dataSocket = undefined;
      });
      let received = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          report(start + received, size);
          callback(null, chunk);
        },
      });
      let abortError = null;
      let rejectAbort;
      const aborted = new Promise((_resolve, reject) => {
        rejectAbort = reject;
      });
      aborted.catch(() => {});
      const onAbort = () => {
        abortError = new Error("传输已中止");
        // 先销毁本端已停止的数据连接和写入流，避免基础库把中止升级为连接错误
        socket.destroy();
        destination.destroy();
        rejectAbort(abortError);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      let control;
      try {
        if (start > 0) await ftp.request(`REST ${start}`);
        if (abortError) throw abortError;
        control = new Promise((resolve, reject) => {
          // handle 返回的 Promise 在拒绝时要单独捕获：它只由回调中的 task 结算，
          // 我们不使用其返回值，但它与 control 同时拒绝
          ftp
            .handle(`RETR ${remote}`, (res, task) => {
              if (res instanceof Error) {
                task.reject(res);
                reject(res);
              } else if (res.code >= 200 && res.code < 300) {
                task.resolve(res);
                resolve();
              }
            })
            .catch(() => {});
        });
        const data = pipeline(socket, meter, destination);
        control.catch(() => {});
        data.catch(() => {});
        await Promise.race([Promise.all([control, data]), aborted]);
      } catch (error) {
        if (abortError) {
          // 等控制连接收下中止后的响应再交还会话，续传时才能安全发送下一条命令
          if (control)
            await Promise.race([
              control.catch(() => {}),
              delay(FTP_CONTROL_TIMEOUT),
            ]);
          throw abortError;
        }
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        destination.destroy();
        socket.destroy();
      }
    },
  };
}
module.exports = {
  sftpFiles,
  ftpFiles,
  modeToSymbolic,
  symbolicOrEmpty,
  ftpPermissions,
};
