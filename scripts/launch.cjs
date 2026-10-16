const { spawn } = require("node:child_process");
const environment = { ...process.env };
// IDEs and automation tools can set this flag for their own Electron processes.
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), process.argv.slice(2), {
  stdio: "inherit",
  env: environment,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
