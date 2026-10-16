const { Server } = require("ssh2");
const { generateKeyPairSync } = require("node:crypto");
const { once } = require("node:events");
module.exports = async function terminalServer() {
  const hostKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ type: "pkcs1", format: "pem" });
  const clients = new Set();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) =>
      ctx.method === "password" && ctx.password === "test-password"
        ? ctx.accept()
        : ctx.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept) => accept());
        session.on("window-change", (accept) => accept?.());
        session.on("sftp", (_accept, reject) => reject());
        session.on("shell", (accept) => {
          const stream = accept();
          stream.write("TERMINAL_READY 中文\r\n");
          stream.on("data", (data) => {
            if (data.toString().includes("BULK"))
              stream.write(
                "日志 0123456789 abcdefghijklmnopqrstuvwxyz\r\n".repeat(20000) +
                  "\r\nBULK_DONE 中文\r\n",
              );
            else stream.write(`ECHO:${data.toString()}\r\n`);
          });
        });
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    close() {
      for (const client of clients) client.end();
      server.close();
    },
  };
};
