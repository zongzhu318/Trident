const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
module.exports = async function ftpServer(root) {
  const connections = new Set(),
    dataServers = new Set();
  // 测试用节流：让大文件传输可持续足够久以便中途暂停
  let ioDelay = 0;
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    const send = (text) => socket.write(text + "\r\n");
    let buffer = "",
      cwd = "/",
      renameFrom,
      dataReady,
      restart = 0,
      authenticated = false;
    const local = (name) => path.join(root, path.posix.resolve(cwd, name));
    async function command(line) {
      const space = line.indexOf(" "),
        cmd = (space < 0 ? line : line.slice(0, space)).toUpperCase(),
        arg = space < 0 ? "" : line.slice(space + 1);
      try {
        if (cmd === "USER") return send("331 Password required");
        if (cmd === "PASS") {
          authenticated = arg === "ftp-password";
          return send(authenticated ? "230 Logged in" : "530 Login incorrect");
        }
        if (cmd === "QUIT") {
          socket.end("221 Bye\r\n");
          return;
        }
        if (!authenticated) return send("530 Not logged in");
        if (cmd === "FEAT")
          return send(
            "211-Features\r\n MLST type*;size*;modify*;\r\n UTF8\r\n211 End",
          );
        if (["TYPE", "OPTS", "STRU", "NOOP"].includes(cmd))
          return send("200 OK");
        if (cmd === "PWD") return send(`257 "${cwd}"`);
        if (cmd === "CWD") {
          if (!fs.statSync(local(arg)).isDirectory())
            throw new Error("Not directory");
          cwd = path.posix.resolve(cwd, arg);
          return send("250 Directory changed");
        }
        if (cmd === "EPSV") {
          const dataServer = net.createServer();
          dataServers.add(dataServer);
          dataReady = new Promise((resolve) =>
            dataServer.once("connection", (stream) => {
              connections.add(stream);
              stream.on("error", () => {});
              stream.on("close", () => connections.delete(stream));
              resolve(stream);
              dataServer.close();
              dataServers.delete(dataServer);
            }),
          );
          dataServer.listen(0, "127.0.0.1");
          await once(dataServer, "listening");
          return send(
            `229 Entering Extended Passive Mode (|||${dataServer.address().port}|)`,
          );
        }
        if (cmd === "REST") {
          restart = Number.parseInt(arg, 10) || 0;
          return send(`350 Restarting at ${restart}`);
        }
        if (["MLSD", "LIST", "RETR", "STOR", "APPE"].includes(cmd)) {
          send("150 Opening data connection");
          const stream = await dataReady;
          if (cmd === "STOR" || cmd === "APPE") {
            // 边收边写，暂停中止时保留已写入部分，便于 APPE 续传
            const fd = fs.openSync(local(arg), cmd === "APPE" ? "a" : "w");
            try {
              if (ioDelay > 0)
                stream.on("data", (chunk) => {
                  fs.writeSync(fd, chunk);
                  stream.pause();
                  setTimeout(() => stream.resume(), ioDelay);
                });
              else stream.on("data", (chunk) => fs.writeSync(fd, chunk));
              // 正常结束或被客户端中止时都会触发 close
              await once(stream, "close");
            } finally {
              fs.closeSync(fd);
            }
            stream.end();
          } else {
            let data;
            if (cmd === "RETR") {
              data = fs.readFileSync(local(arg));
              if (restart > 0) {
                data = data.subarray(restart);
                restart = 0;
              }
            } else
              data = fs
                .readdirSync(local(arg || cwd))
                .map((name) => {
                  const stat = fs.statSync(path.join(local(arg || cwd), name));
                  return `type=${stat.isDirectory() ? "dir" : "file"};size=${stat.size};modify=20261015090000; ${name}\r\n`;
                })
                .join("");
            if (ioDelay > 0 && Buffer.isBuffer(data) && data.length) {
              let offset = 0;
              const push = () => {
                if (stream.destroyed) return;
                if (offset >= data.length) {
                  stream.end();
                  return;
                }
                stream.write(data.subarray(offset, offset + 32768));
                offset += 32768;
                setTimeout(push, ioDelay);
              };
              push();
            } else stream.end(data);
            await once(stream, "close");
          }
          return send("226 Transfer complete");
        }
        if (cmd === "SIZE") return send(`213 ${fs.statSync(local(arg)).size}`);
        if (cmd === "MKD") {
          fs.mkdirSync(local(arg));
          return send(`257 "${arg}"`);
        }
        if (cmd === "RMD") {
          fs.rmdirSync(local(arg));
          return send("250 Removed directory");
        }
        if (cmd === "DELE") {
          fs.unlinkSync(local(arg));
          return send("250 Removed file");
        }
        if (cmd === "RNFR") {
          renameFrom = local(arg);
          fs.statSync(renameFrom);
          return send("350 Ready for target");
        }
        if (cmd === "RNTO") {
          fs.renameSync(renameFrom, local(arg));
          return send("250 Renamed");
        }
        send("502 Unsupported command");
      } catch (error) {
        send(`550 ${error.code || "Operation failed"}`);
      }
    }
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        void command(line);
      }
    });
    send("220 Trident test FTP server");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    setIoDelay(ms) {
      ioDelay = ms;
    },
    close() {
      for (const socket of connections) socket.destroy();
      for (const ds of dataServers) ds.close();
      server.close();
    },
  };
};
