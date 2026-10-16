// Reproducible UI workload. Run with scripts/launch.cjs; all data is temporary.
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const startFTP = require("../tests/helpers/ftp-server.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "trident-perf-"));
app.setPath("userData", temp);
let ftp;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => {
  console.error("Performance check timed out");
  app.exit(1);
}, 45000);
app.on("browser-window-created", (_event, win) => {
  win.webContents.once("did-finish-load", async () => {
    try {
      const run = (code) => win.webContents.executeJavaScript(code);
      const waitFor = async (code) => {
        for (let i = 0; i < 150; i++) {
          if (await run(code)) return;
          await sleep(100);
        }
        throw new Error(`Timed out: ${code}`);
      };
      await waitFor(`!!document.querySelector('.home')`);
      const root = path.join(temp, "remote");
      fs.mkdirSync(root);
      for (let i = 0; i < 5000; i++)
        fs.writeFileSync(
          path.join(root, `file-${String(i).padStart(5, "0")}.txt`),
          "test",
        );
      ftp = await startFTP(root);
      await run(
        `Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('快速连接')).click()`,
      );
      await waitFor(`!!document.querySelector('.modal select')`);
      await run(
        `(() => { const e = document.querySelector('.modal select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, 'ftp'); e.dispatchEvent(new Event('change', { bubbles: true })); })()`,
      );
      await sleep(100);
      await run(`(() => {
        const inputs = document.querySelectorAll('.modal input');
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        for (const [input, value] of [[inputs[0], 'Performance fixture'], [inputs[1], '127.0.0.1'], [document.querySelector('.modal input[type="number"]'), '${ftp.port}'], [document.querySelector('.modal input[type="password"]'), 'ftp-password']]) {
          set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()`);
      await sleep(100);
      const start = performance.now();
      await run(`document.querySelector('.modal form').requestSubmit()`);
      await waitFor(
        `document.querySelector('.file-hint')?.innerText.includes('5000')`,
      );
      const listingMs = Math.round(performance.now() - start);
      await sleep(500);
      app.getAppMetrics();
      await sleep(1500);
      const metrics = app.getAppMetrics();
      const result = {
        workload: "FTP directory with 5000 files; 1420x900 window",
        listingMs,
        ...(await run(
          `({ fileRows: document.querySelectorAll('.file-row').length, domNodes: document.querySelectorAll('*').length, jsHeapBytes: performance.memory?.usedJSHeapSize ?? null })`,
        )),
        workingSetKB: metrics.reduce(
          (sum, item) => sum + (item.memory?.workingSetSize ?? 0),
          0,
        ),
        idleCPUPercent: Number(
          metrics
            .reduce((sum, item) => sum + item.cpu.percentCPUUsage, 0)
            .toFixed(2),
        ),
      };
      console.log(JSON.stringify(result, null, 2));
      await run(
        `document.querySelector('.file-list').scrollTop = document.querySelector('.file-list').scrollHeight`,
      );
      await waitFor(
        `document.querySelector('.file-list')?.innerText.includes('file-04999.txt')`,
      );
      await run(`document.querySelector('.file-list').scrollTop = 0`);
      await waitFor(
        `document.querySelector('.file-list')?.innerText.includes('file-00000.txt')`,
      );
      if (process.argv[2])
        fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2));
      ftp.close();
      clearTimeout(timeout);
      app.exit(0);
    } catch (error) {
      console.error(error);
      ftp?.close();
      clearTimeout(timeout);
      app.exit(1);
    }
  });
});
require("../electron/main.cjs");
