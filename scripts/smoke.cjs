// Run with Electron after building. Uses temporary app data and captures the UI.
const { app, dialog, Menu, nativeTheme } = require("electron");
const startFTP = require("../tests/helpers/ftp-server.cjs");
const startTerminal = require("../tests/helpers/terminal-server.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "trident-ui-"));
app.setPath("userData", temp);
let saveDestination = path.join(temp, "backup.json");
let openFiles = [saveDestination];
let ftpServer;
let sshServer;
// Exercise the app's real IPC and local credential storage, with deterministic native file choices.
let openPrompts = 0;
dialog.showSaveDialog = async () => ({
  canceled: false,
  filePath: saveDestination,
});
dialog.showOpenDialog = async () => {
  openPrompts++;
  return { canceled: false, filePaths: openFiles };
};
dialog.showMessageBox = async () => ({ response: 1 });
const timer = setTimeout(() => {
  console.error("UI smoke test timed out");
  app.exit(1);
}, 60000);
app.on("browser-window-created", (_event, window) => {
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.log("renderer:", message);
  });
  window.webContents.on("did-finish-load", async () => {
    try {
      const run = (source) => window.webContents.executeJavaScript(source);
      const waitFor = async (source) => {
        for (let count = 0; count < 80; count++) {
          if (await run(source)) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`UI condition timed out: ${source}`);
      };
      await new Promise((resolve) => setTimeout(resolve, 400));
      const snapshot = await window.webContents.executeJavaScript(
        `({ title: document.title, text: document.body.innerText, bridge: typeof window.trident?.connect, node: typeof window.require })`,
      );
      assert.equal(snapshot.title, "Trident");
      assert.equal(snapshot.bridge, "function");
      assert.equal(snapshot.node, "undefined");
      assert.ok(snapshot.text.includes("你的第一台服务器"));
      const selectTheme = async (mode) => {
        await run(
          `(() => { const select = document.querySelector('select[aria-label="主题"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, '${mode}'); select.dispatchEvent(new Event('change', { bubbles: true })); })()`,
        );
        await waitFor(
          `document.querySelector('select[aria-label="主题"]').value === '${mode}'`,
        );
      };
      await selectTheme("light");
      await waitFor(`document.documentElement.dataset.theme === 'light'`);
      assert.equal(nativeTheme.themeSource, "light");
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(temp, "preferences.json"), "utf8"))
          .theme,
        "light",
      );
      fs.writeFileSync(
        path.join(temp, "home-light.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      await selectTheme("dark");
      await waitFor(`document.documentElement.dataset.theme === 'dark'`);
      fs.writeFileSync(
        path.join(temp, "home-dark.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      await selectTheme("system");
      assert.equal(nativeTheme.themeSource, "system");
      await waitFor(
        `document.documentElement.dataset.theme === '${nativeTheme.shouldUseDarkColors ? "dark" : "light"}'`,
      );
      await selectTheme("light");
      await waitFor(`document.documentElement.dataset.theme === 'light'`);
      const emptyImage = await window.webContents.capturePage();
      fs.writeFileSync(path.join(temp, "home.png"), emptyImage.toPNG());
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('添加第一个连接')).click()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await window.webContents.executeJavaScript(`(() => {
        const inputs = document.querySelectorAll('.modal input');
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(inputs[0], '本机测试服务器'); inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        set.call(inputs[1], '127.0.0.1'); inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await window.webContents.executeJavaScript(
        `document.querySelector('.modal form').requestSubmit()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const saved = await window.webContents.executeJavaScript(
        `({ cards: document.querySelectorAll('.connection-card').length, modal: !!document.querySelector('.modal') })`,
      );
      assert.equal(saved.cards, 1);
      assert.equal(saved.modal, false);
      const ftpRoot = path.join(temp, "ftp-root");
      fs.mkdirSync(ftpRoot);
      ftpServer = await startFTP(ftpRoot);
      await run(
        `document.querySelector('.connection-card .card-actions button').click()`,
      );
      await waitFor(`!!document.querySelector('.modal select')`);
      await run(
        `(() => { const select = document.querySelector('.modal select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'ftp'); select.dispatchEvent(new Event('change', { bubbles: true })); })()`,
      );
      await waitFor(
        `document.querySelector('.modal input[type="number"]').value === '21'`,
      );
      await run(`(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        const port = document.querySelector('.modal input[type="number"]'); set.call(port, '${ftpServer.port}'); port.dispatchEvent(new Event('input', { bubbles: true }));
        const password = document.querySelector('.modal input[type="password"]'); set.call(password, 'ftp-password'); password.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.remember-option input').click();
      })()`);
      await new Promise((r) => setTimeout(r, 100));
      fs.writeFileSync(
        path.join(temp, "ftp-settings.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      await run(`document.querySelector('.modal form').requestSubmit()`);
      await waitFor(`!document.querySelector('.modal')`);
      const profiles = await run(`window.trident.profiles()`);
      assert.equal(profiles[0].protocol, "ftp");
      assert.equal(profiles[0].hasSavedCredentials, true);
      assert.equal(
        fs
          .readFileSync(path.join(temp, "connections.json"), "utf8")
          .includes("ftp-password"),
        true,
      );
      await run(
        `Array.from(document.querySelectorAll('button')).find(b => b.innerText === '导出连接').click()`,
      );
      await waitFor(`!!document.querySelector('.modal .remember-option')`);
      await run(
        `document.querySelector('.modal .remember-option input').click()`,
      );
      await waitFor(
        `document.querySelectorAll('.modal input[type="password"]').length === 2`,
      );
      await run(
        `(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; document.querySelectorAll('.modal input[type="password"]').forEach(input => { set.call(input, 'portable-test-password'); input.dispatchEvent(new Event('input', { bubbles: true })); }); })()`,
      );
      await new Promise((r) => setTimeout(r, 100));
      await run(`document.querySelector('.modal form').requestSubmit()`);
      await waitFor(`document.body.innerText.includes('连接备份已导出')`);
      assert.equal(
        fs.readFileSync(saveDestination, "utf8").includes("ftp-password"),
        false,
      );
      await run(
        `Array.from(document.querySelectorAll('.modal button')).find(b => b.innerText === '完成').click()`,
      );
      await run(
        `Array.from(document.querySelectorAll('button')).find(b => b.innerText === '导入连接').click()`,
      );
      await waitFor(
        `!!document.querySelector('.modal input[type="password"]')`,
      );
      await run(
        `(() => { const input = document.querySelector('.modal input[type="password"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'portable-test-password'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await new Promise((r) => setTimeout(r, 100));
      await run(`document.querySelector('.modal form').requestSubmit()`);
      await waitFor(`!!document.querySelector('.import-preview')`);
      await run(`document.querySelector('.modal form').requestSubmit()`);
      await waitFor(
        `document.querySelectorAll('.connection-card').length === 2 && !document.querySelector('.modal')`,
      );
      await run(`document.querySelector('.connection-nav .nav-edit').click()`);
      await waitFor(`!!document.querySelector('.modal')`);
      await run(
        `Array.from(document.querySelectorAll('.modal button')).find(b => b.innerText === '取消').click()`,
      );
      await waitFor(`!document.querySelector('.modal')`);
      await run(
        `document.querySelector('.connection-card .card-footer button').click()`,
      );
      await waitFor(
        `document.body.innerText.includes('FTP 已连接') && !!document.querySelector('.files-only .file-pane')`,
      );
      await waitFor(
        `!document.querySelector('.files-only .file-actions button').disabled`,
      );
      const source = path.join(temp, "ui-upload.txt");
      fs.writeFileSync(source, "GUI 文件传输验证");
      openFiles = [source];
      await run(
        `document.querySelector('.files-only .file-actions button').click()`,
      );
      await waitFor(
        `document.querySelector('.file-list')?.innerText.includes('ui-upload.txt')`,
      );
      assert.equal(
        fs.readFileSync(path.join(ftpRoot, "ui-upload.txt"), "utf8"),
        "GUI 文件传输验证",
      );
      assert.ok(
        await run(
          `document.querySelector('.file-table-heading')?.innerText.includes('权限')`,
        ),
      );
      const filePermissions = await run(
        `Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('ui-upload.txt'))?.querySelector('.file-permissions')?.innerText`,
      );
      assert.match(filePermissions, /^-[rwx-]{9}$/);
      saveDestination = path.join(temp, "ui-download.txt");
      await run(`document.querySelector('.file-row').click()`);
      await waitFor(
        `!document.querySelector('button[title="下载选中的文件或文件夹"]').disabled`,
      );
      await run(
        `document.querySelector('button[title="下载选中的文件或文件夹"]').click()`,
      );
      await waitFor(
        `document.querySelector('.transfer-item')?.innerText.includes('↓ ui-upload.txt') && document.querySelector('.transfer-item')?.innerText.includes('已完成')`,
      );
      assert.equal(
        fs.readFileSync(saveDestination, "utf8"),
        "GUI 文件传输验证",
      );
      await run(`document.querySelector('button[title="重命名"]').click()`);
      await waitFor(`!!document.querySelector('.new-folder input')`);
      await run(
        `(() => { const input = document.querySelector('.new-folder input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'renamed.txt'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await new Promise((r) => setTimeout(r, 100));
      await run(`document.querySelector('.new-folder').requestSubmit()`);
      await waitFor(
        `document.querySelector('.file-list')?.innerText.includes('renamed.txt')`,
      );
      fs.writeFileSync(
        path.join(temp, "ftp-files.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      await selectTheme("dark");
      await waitFor(`document.documentElement.dataset.theme === 'dark'`);
      assert.ok(await run(`document.body.innerText.includes('FTP 已连接')`));
      fs.writeFileSync(
        path.join(temp, "ftp-files-dark.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      await run(`document.querySelector('.file-row').click()`);
      await waitFor(
        `!document.querySelector('button[title="删除文件或空目录"]').disabled`,
      );
      await run(
        `document.querySelector('button[title="删除文件或空目录"]').click()`,
      );
      await waitFor(`document.querySelectorAll('.file-row').length === 0`);
      assert.equal(fs.existsSync(path.join(ftpRoot, "renamed.txt")), false);
      // Two downloads run as independent tasks and the file panel stays usable.
      const bigFiles = ["big-a.bin", "big-b.bin", "big-c.bin"].map((name) => {
        const target = path.join(ftpRoot, name);
        fs.writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, name));
        return target;
      });
      ftpServer.setIoDelay(30);
      await run(
        `document.querySelector('.file-toolbar button[title="刷新"]').click()`,
      );
      await waitFor(
        `document.querySelector('.file-list')?.innerText.includes('big-a.bin') && document.querySelector('.file-list')?.innerText.includes('big-b.bin')`,
      );
      saveDestination = path.join(temp, "big-a.out");
      const bigItem = (name) =>
        `Array.from(document.querySelectorAll('.transfer-item')).find((n) => n.innerText.includes('${name}'))`;
      await run(
        `Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-a.bin')).click()`,
      );
      await waitFor(
        `!!Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-a.bin') && r.getAttribute('aria-selected') === 'true')`,
      );
      await run(
        `document.querySelector('button[title="下载选中的文件或文件夹"]').click()`,
      );
      await waitFor(`!!${bigItem("big-a.bin")}`);
      saveDestination = path.join(temp, "big-b.out");
      await run(
        `Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-b.bin')).click()`,
      );
      await waitFor(
        `!!Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-b.bin') && r.getAttribute('aria-selected') === 'true')`,
      );
      await run(
        `document.querySelector('button[title="下载选中的文件或文件夹"]').click()`,
      );
      await waitFor(`!!${bigItem("big-a.bin")} && !!${bigItem("big-b.bin")}`);
      const parallel = await run(`({
        running: ['big-a.bin', 'big-b.bin'].filter((name) => Array.from(document.querySelectorAll('.transfer-item')).find((n) => n.innerText.includes(name))?.querySelector('.transfer-controls')).length,
        upload: document.querySelector('button[title="上传文件夹（含子目录）"]').disabled,
        mkdir: document.querySelector('button[title="新建文件夹"]').disabled,
        rename: document.querySelector('button[title="重命名"]').disabled,
        remove: document.querySelector('button[title="删除文件或空目录"]').disabled,
        download: document.querySelector('button[title="下载选中的文件或文件夹"]').disabled,
      })`);
      assert.equal(
        parallel.running,
        2,
        "both download tasks should be running",
      );
      assert.equal(parallel.upload, false);
      assert.equal(parallel.mkdir, false);
      assert.equal(parallel.rename, false);
      assert.equal(parallel.remove, false);
      assert.equal(parallel.download, false);
      for (
        let count = 0;
        count < 40 && ftpServer.stats().maxTransfers < 2;
        count++
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(
        ftpServer.stats().maxTransfers >= 2,
        "downloads should use separate FTP connections",
      );
      await waitFor(
        `${bigItem("big-a.bin")}?.querySelector('.transfer-final')?.innerText.includes('已完成') && ${bigItem("big-b.bin")}?.querySelector('.transfer-final')?.innerText.includes('已完成')`,
      );
      for (const [index, output] of ["big-a.out", "big-b.out"].entries())
        assert.equal(
          fs
            .readFileSync(path.join(temp, output))
            .equals(fs.readFileSync(bigFiles[index])),
          true,
        );
      ftpServer.setIoDelay(0);
      // Multi-select: plain click, shift range, ctrl toggle, select all and batch download.
      await run(
        `document.querySelector('.file-toolbar button[title="刷新"]').click()`,
      );
      await waitFor(
        `document.querySelectorAll('.file-row').length === 3 && !document.querySelector('.file-toolbar .spin')`,
      );
      const rowState = (name) =>
        `Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('${name}'))?.getAttribute('aria-selected') === 'true'`;
      assert.equal(
        await run(
          `document.querySelector('button[title="下载选中的文件或文件夹"]').disabled`,
        ),
        true,
        "未选择时下载入口应禁用",
      );
      await run(
        `Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-a.bin')).click()`,
      );
      await waitFor(rowState("big-a.bin"));
      assert.deepEqual(
        await run(`({
          download: document.querySelector('button[title="下载选中的文件或文件夹"]').disabled,
          rename: document.querySelector('button[title="重命名"]').disabled,
          remove: document.querySelector('button[title="删除文件或空目录"]').disabled,
          count: document.querySelector('.file-selected-count')?.innerText,
        })`),
        {
          download: false,
          rename: false,
          remove: false,
          count: "已选 1 项",
        },
      );
      // Shift 选择连续区间
      await run(`(() => {
        const row = Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-c.bin'));
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      })()`);
      await waitFor(`(() => {
        const rows = Array.from(document.querySelectorAll('.file-row'));
        return ['big-a.bin', 'big-b.bin', 'big-c.bin'].every((name) => rows.find((r) => r.innerText.includes(name))?.getAttribute('aria-selected') === 'true');
      })()`);
      // Cmd/Ctrl 切换单项
      await run(`(() => {
        const row = Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-b.bin'));
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, ctrlKey: true }));
      })()`);
      await waitFor(`!(${rowState("big-b.bin")})`);
      assert.equal(await run(rowState("big-a.bin")), true);
      // 复选框必须位于文件图标之上，否则真实鼠标点击会被透明图标拦截
      assert.equal(
        await run(`(() => {
          const row = Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-b.bin'));
          const box = row.querySelector('input[type="checkbox"]');
          const rect = box.getBoundingClientRect();
          return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === box;
        })()`),
        true,
        "复选框应可被鼠标直接点中",
      );
      // 复选框切换
      await run(`(() => {
        const row = Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-b.bin'));
        row.querySelector('input[type="checkbox"]').click();
      })()`);
      await waitFor(rowState("big-b.bin"));
      // 键盘空格切换
      await run(`(() => {
        const row = Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-b.bin'));
        row.querySelector('input[type="checkbox"]').click();
        row.focus();
        row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      })()`);
      await waitFor(rowState("big-b.bin"));
      // 全选与取消全选（键盘切换后三项均已选中）
      await run(
        `Array.from(document.querySelectorAll('.file-actions button')).find((b) => b.innerText === '取消全选').click()`,
      );
      await waitFor(
        `Array.from(document.querySelectorAll('.file-row')).every((r) => r.getAttribute('aria-selected') === 'false')`,
      );
      await run(
        `Array.from(document.querySelectorAll('.file-actions button')).find((b) => b.innerText === '全选').click()`,
      );
      await waitFor(
        `Array.from(document.querySelectorAll('.file-row')).every((r) => r.getAttribute('aria-selected') === 'true')`,
      );
      await run(
        `Array.from(document.querySelectorAll('.file-actions button')).find((b) => b.innerText === '取消全选').click()`,
      );
      await waitFor(
        `Array.from(document.querySelectorAll('.file-row')).every((r) => r.getAttribute('aria-selected') === 'false')`,
      );
      // 批量下载两个文件只弹出一次目标文件夹对话框并只创建一个任务
      await run(
        `Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-a.bin')).click()`,
      );
      await run(`(() => {
        const row = Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-b.bin'));
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, ctrlKey: true }));
      })()`);
      await waitFor(`(${rowState("big-a.bin")}) && (${rowState("big-b.bin")})`);
      const batchTarget = path.join(temp, "batch-target");
      fs.mkdirSync(batchTarget);
      openFiles = [batchTarget];
      openPrompts = 0;
      const batchItem = `Array.from(document.querySelectorAll('.transfer-item')).find((n) => n.innerText.includes('big-a.bin 等 2 项'))`;
      await run(
        `document.querySelector('button[title="下载选中的文件或文件夹"]').click()`,
      );
      await waitFor(`!!${batchItem}`);
      await waitFor(
        `${batchItem}?.querySelector('.transfer-final')?.innerText.includes('已完成')`,
      );
      assert.equal(openPrompts, 1, "批量下载只应弹出一个目标文件夹对话框");
      assert.equal(
        await run(
          `Array.from(document.querySelectorAll('.transfer-name')).filter((n) => n.innerText.includes('big-a.bin 等 2 项')).length`,
        ),
        1,
        "整批下载只应创建一个任务",
      );
      for (const name of ["big-a.bin", "big-b.bin"])
        assert.equal(
          fs
            .readFileSync(path.join(batchTarget, name))
            .equals(fs.readFileSync(path.join(ftpRoot, name))),
          true,
          `${name} 应完整写入批量目标文件夹`,
        );
      // Double-click still downloads a single file through the save dialog.
      saveDestination = path.join(temp, "big-c.out");
      await run(`(() => {
        const row = Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-c.bin'));
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      })()`);
      await waitFor(
        `${bigItem("big-c.bin")}?.querySelector('.transfer-final')?.innerText.includes('已完成')`,
      );
      assert.equal(
        fs
          .readFileSync(saveDestination)
          .equals(fs.readFileSync(path.join(ftpRoot, "big-c.bin"))),
        true,
        "双击普通文件仍应下载到保存对话框选择的位置",
      );
      fs.writeFileSync(
        path.join(temp, "transfer-tasks.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      // A failed task must explain itself in the task list, not only in the banner.
      saveDestination = path.join(temp, "missing-dir", "big-a.out");
      const failedItem = `Array.from(document.querySelectorAll('.transfer-item')).find((n) => n.querySelector('.transfer-error'))`;
      await run(
        `Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('big-a.bin')).click()`,
      );
      await run(
        `document.querySelector('button[title="下载选中的文件或文件夹"]').click()`,
      );
      await waitFor(`!!${failedItem}`);
      const failureText = await run(
        `${failedItem}?.querySelector('.transfer-error')?.innerText`,
      );
      assert.match(failureText, /big-a\.bin 下载失败/);
      await run(
        `${failedItem}?.querySelector('.transfer-final button').click()`,
      );
      await waitFor(`!${failedItem}`);
      const folder = path.join(temp, "ui-folder");
      fs.mkdirSync(path.join(folder, "nested"), { recursive: true });
      fs.writeFileSync(path.join(folder, "nested", "n.txt"), "递归上传验证");
      openFiles = [folder];
      await run(
        `document.querySelector('button[title="上传文件夹（含子目录）"]').click()`,
      );
      await waitFor(
        `Array.from(document.querySelectorAll('.transfer-name')).some((n) => n.innerText.includes('ui-folder'))`,
      );
      assert.equal(
        await run(
          `Array.from(document.querySelectorAll('.transfer-name')).some((n) => n.innerText.includes('nested/n.txt'))`,
        ),
        false,
        "任务标题应保持文件夹名，而不是当前文件",
      );
      await waitFor(
        `document.querySelector('.file-list')?.innerText.includes('ui-folder')`,
      );
      const folderPermissions = await run(
        `Array.from(document.querySelectorAll('.file-row')).find((r) => r.innerText.includes('ui-folder'))?.querySelector('.file-permissions')?.innerText`,
      );
      assert.match(folderPermissions, /^d[rwx-]{9}$/);
      assert.equal(
        fs.readFileSync(path.join(ftpRoot, "ui-folder/nested/n.txt"), "utf8"),
        "递归上传验证",
      );
      ftpServer.close();
      sshServer = await startTerminal();
      await run(`document.querySelector('.tab-add').click()`);
      await waitFor(`!!document.querySelector('.modal input[type="number"]')`);
      await run(`(() => {
        const inputs = document.querySelectorAll('.modal input');
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        for (const [input, value] of [[inputs[0], 'Terminal fixture'], [inputs[1], '127.0.0.1'], [document.querySelector('.modal input[type="number"]'), '${sshServer.port}'], [document.querySelector('.modal input[type="password"]'), 'test-password']]) {
          set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        document.querySelector('.remember-option input').click();
      })()`);
      await new Promise((r) => setTimeout(r, 100));
      await run(`document.querySelector('.modal form').requestSubmit()`);
      await waitFor(
        `document.querySelector('.xterm-screen')?.textContent.includes('TERMINAL_READY')`,
      );
      const terminalId = await run(
        `document.querySelector('.terminal-pane').closest('.session').dataset.sessionId`,
      );
      // The compact toolbar replaces the old heading, terminal bar and footer.
      assert.equal(
        await run(
          `document.querySelectorAll('.session-heading, .terminal-pane .pane-title, .session-footer').length`,
        ),
        0,
      );
      assert.ok(
        await run(
          `document.querySelector('.session-toolbar .session-address').textContent.includes('@127.0.0.1')`,
        ),
      );
      // Terminal find bar opens with the documented shortcut and searches scrollback.
      const findShortcutInit =
        process.platform === "darwin"
          ? "{ key: 'f', metaKey: true }"
          : "{ key: 'f', ctrlKey: true, shiftKey: true }";
      const pressFindShortcut = () =>
        run(
          `window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...${findShortcutInit} }))`,
        );
      assert.ok(await run(`!!document.querySelector('.terminal-find-toggle')`));
      await pressFindShortcut();
      await waitFor(
        `!!document.querySelector('.terminal-search') && document.activeElement === document.querySelector('.terminal-search input')`,
      );
      await run(`(() => {
        const input = document.querySelector('.terminal-search input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'TERMINAL_READY');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(
        `document.querySelector('.terminal-search-count')?.textContent === '1 / 1'`,
      );
      await waitFor(
        `!!document.querySelector('.xterm-find-result-decoration')`,
      );
      fs.writeFileSync(
        path.join(temp, "terminal-search.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      await run(
        `document.querySelector('.terminal-search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`,
      );
      await waitFor(
        `!document.querySelector('.terminal-search') && document.activeElement?.classList.contains('xterm-helper-textarea')`,
      );
      await run(`document.querySelector('.terminal-find-toggle').click()`);
      await waitFor(`!!document.querySelector('.terminal-search')`);
      await run(
        `document.querySelector('.terminal-search .icon-button:last-child').click()`,
      );
      await waitFor(`!document.querySelector('.terminal-search')`);
      // Focus mode hides navigation chrome and the file pane, then restores both.
      const sshFilePane = `.session[data-session-id="${terminalId}"] .file-pane`;
      await run(`document.querySelector('.focus-toggle').click()`);
      await waitFor(
        `(() => {
          const app = document.querySelector('.app');
          const display = (selector) => getComputedStyle(document.querySelector(selector)).display;
          return app.classList.contains('focus') && display('.sidebar') === 'none' && display('.tabbar') === 'none' && display('${sshFilePane}') === 'none' && display('.session[data-session-id="${terminalId}"] .session-toolbar') === 'none';
        })()`,
      );
      fs.writeFileSync(
        path.join(temp, "terminal-focus.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      await run(`document.querySelector('.focus-toggle').click()`);
      await waitFor(
        `!document.querySelector('.app').classList.contains('focus') && getComputedStyle(document.querySelector('.tabbar')).display !== 'none' && getComputedStyle(document.querySelector('${sshFilePane}')).display !== 'none'`,
      );
      // Focus shortcut is owned by the 显示 menu (⌘M / Ctrl+Shift+M).
      const focusAccelerator =
        process.platform === "darwin" ? "Command+M" : "Control+Shift+M";
      const menuItems = Menu.getApplicationMenu().items.flatMap(
        (item) => item.submenu?.items ?? [],
      );
      const focusItem = menuItems.find((item) => item.label === "专注模式");
      assert.ok(focusItem);
      assert.equal(focusItem.accelerator, focusAccelerator);
      if (process.platform === "darwin") {
        const minimizeItem = menuItems.find((item) => item.label === "最小化");
        assert.ok(minimizeItem);
        assert.notEqual(minimizeItem.accelerator, "Command+M");
      }
      focusItem.click(focusItem, window, {});
      await waitFor(
        `document.querySelector('.app').classList.contains('focus')`,
      );
      focusItem.click(focusItem, window, {});
      await waitFor(
        `!document.querySelector('.app').classList.contains('focus')`,
      );
      // Sidebar and file pane separators resize the panels and remember widths.
      const dragSeparator = async (separator, target, deltaX) => {
        const before = await run(
          `document.querySelector('${target}').getBoundingClientRect().width`,
        );
        await run(`(() => {
          const handle = document.querySelector('${separator}');
          const rect = handle.getBoundingClientRect();
          const init = { bubbles: true, cancelable: true, pointerId: 21, pointerType: 'mouse', button: 0, clientX: rect.x + 3, clientY: rect.y + rect.height / 2 };
          handle.dispatchEvent(new PointerEvent('pointerdown', init));
          window.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: init.clientX + ${deltaX} }));
          window.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: init.clientX + ${deltaX} }));
        })()`);
        await waitFor(
          `document.querySelector('${target}').getBoundingClientRect().width > ${before + Math.abs(deltaX) - 10}`,
        );
        return before;
      };
      const sidebarBefore = await dragSeparator(
        ".sidebar-resizer",
        ".sidebar",
        40,
      );
      const filePaneBefore = await dragSeparator(
        ".file-resizer",
        sshFilePane,
        -50,
      );
      assert.ok(sidebarBefore > 0 && filePaneBefore > 0);
      assert.ok(
        Number(await run(`localStorage.getItem('trident.sidebar-width')`)) >
          sidebarBefore,
      );
      assert.ok(
        Number(await run(`localStorage.getItem('trident.file-pane-width')`)) >
          filePaneBefore,
      );
      await selectTheme("light");
      await waitFor(`document.documentElement.dataset.theme === 'light'`);
      assert.ok(
        await run(
          `document.querySelector('.xterm-screen').textContent.includes('TERMINAL_READY')`,
        ),
      );
      // Changing colors must preserve the live terminal, output and app theme.
      await run(
        `window.terminalBeforePalette = document.querySelector('.xterm')`,
      );
      const selectTerminalTheme = async (id) => {
        await run(`(() => {
          const select = document.querySelector('select[aria-label="终端配色"]');
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, '${id}');
          select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitFor(
          `document.querySelector('select[aria-label="终端配色"]').value === '${id}' && !document.querySelector('select[aria-label="终端配色"]').disabled`,
        );
      };
      for (const [id, background] of [
        ["dark", "rgb(15, 23, 34)"],
        ["light", "rgb(255, 255, 255)"],
        ["dracula", "rgb(40, 42, 54)"],
        ["nord", "rgb(46, 52, 64)"],
        ["tokyo-night", "rgb(26, 27, 38)"],
        ["monokai", "rgb(39, 40, 34)"],
        ["solarized-light", "rgb(253, 246, 227)"],
      ]) {
        await selectTerminalTheme(id);
        await waitFor(
          `getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor === '${background}'`,
        );
        assert.ok(
          await run(
            `document.querySelector('.xterm') === window.terminalBeforePalette && document.querySelector('.xterm-screen').textContent.includes('TERMINAL_READY')`,
          ),
        );
        assert.equal(
          await run(
            `getComputedStyle(document.querySelector('.terminal-pane')).backgroundColor`,
          ),
          background,
        );
        assert.equal(
          await run(`document.documentElement.dataset.theme`),
          "light",
        );
        assert.equal(
          JSON.parse(
            fs.readFileSync(path.join(temp, "preferences.json"), "utf8"),
          ).terminalTheme,
          id,
        );
        if (id === "dracula")
          fs.writeFileSync(
            path.join(temp, "terminal-dracula.png"),
            (await window.webContents.capturePage()).toPNG(),
          );
      }
      await selectTheme("dark");
      assert.equal(
        await run(
          `getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor`,
        ),
        "rgb(253, 246, 227)",
      );
      await selectTerminalTheme("auto");
      await waitFor(
        `getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor === 'rgb(15, 23, 34)'`,
      );
      await selectTheme("light");
      await waitFor(
        `getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor === 'rgb(255, 255, 255)'`,
      );
      fs.writeFileSync(
        path.join(temp, "terminal-light.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      await run(
        `window.trident.write('${terminalId}', ${JSON.stringify("BULK\n")})`,
      );
      await waitFor(
        `document.querySelector('.xterm-screen')?.textContent.includes('BULK_DONE')`,
      );
      await selectTheme("dark");
      await waitFor(`document.documentElement.dataset.theme === 'dark'`);
      assert.ok(
        await run(
          `document.querySelector('.xterm-screen').textContent.includes('BULK_DONE')`,
        ),
      );
      // Hide without unmounting: retain panel state and resize the live terminal.
      const terminalWidth = await run(
        `document.querySelector('.terminal-host').clientWidth`,
      );
      await run(`(() => {
        window.sshPane = document.querySelector('.terminal-pane').closest('.session');
        window.savedFilePane = window.sshPane.querySelector('.file-pane');
        window.savedFilePane.querySelector('.checkbox input').click();
        window.savedFilePane.querySelector('button[aria-label="隐藏文件面板"]').click();
      })()`);
      await waitFor(
        `window.savedFilePane.hidden && window.savedFilePane.getBoundingClientRect().width === 0 && document.querySelector('.terminal-host').clientWidth > ${terminalWidth}`,
      );
      assert.ok(
        await run(
          `document.activeElement === window.sshPane.querySelector('.file-panel-toggle')`,
        ),
      );
      assert.equal(
        await run(`document.querySelector('.files-only .file-pane').hidden`),
        false,
      );
      const expandedWidth = await run(
        `document.querySelector('.terminal-host').clientWidth`,
      );
      await run(`window.savedSidebar = document.querySelector('.sidebar')`);
      assert.equal(
        await run(
          `getComputedStyle(document.querySelector('.sidebar-toggle')).getPropertyValue('-webkit-app-region')`,
        ),
        "no-drag",
      );
      const toggleSidebar = async () => {
        const point = await run(`(() => {
          const rect = document.querySelector('.sidebar-toggle').getBoundingClientRect();
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        })()`);
        window.webContents.sendInputEvent({
          type: "mouseDown",
          button: "left",
          clickCount: 1,
          ...point,
        });
        window.webContents.sendInputEvent({
          type: "mouseUp",
          button: "left",
          clickCount: 1,
          ...point,
        });
      };
      await toggleSidebar();
      await waitFor(
        `window.savedSidebar.hidden && window.savedSidebar.getBoundingClientRect().width === 0 && document.querySelector('.terminal-host').clientWidth > ${expandedWidth}`,
      );
      assert.equal(
        await run(
          `document.querySelector('.sidebar-toggle').getAttribute('aria-expanded')`,
        ),
        "false",
      );
      await run(`document.querySelector('.tabbar > button').click()`);
      await run(
        `window.trident.write('${terminalId}', ${JSON.stringify("BULK\n")})`,
      );
      await new Promise((r) => setTimeout(r, 1000));
      await run(
        `Array.from(document.querySelectorAll('.tab button')).find(b => b.innerText === 'Terminal fixture').click()`,
      );
      await run(
        `window.trident.write('${terminalId}', ${JSON.stringify("AFTER_BACKGROUND\n")})`,
      );
      await waitFor(
        `document.querySelector('.xterm-screen')?.textContent.includes('AFTER_BACKGROUND')`,
      );
      assert.ok(
        await run(
          `window.savedFilePane.hidden && window.savedSidebar.hidden && document.querySelector('.xterm') === window.terminalBeforePalette`,
        ),
      );
      fs.writeFileSync(
        path.join(temp, "terminal-both-panels-hidden.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      await toggleSidebar();
      await waitFor(
        `!window.savedSidebar.hidden && Math.abs(document.querySelector('.terminal-host').clientWidth - ${expandedWidth}) < 2`,
      );
      assert.ok(
        await run(
          `document.querySelector('.sidebar') === window.savedSidebar && window.savedSidebar.querySelectorAll('.connection-nav').length > 0`,
        ),
      );
      fs.writeFileSync(
        path.join(temp, "terminal-expanded.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      await run(`window.sshPane.querySelector('.file-panel-toggle').click()`);
      await waitFor(
        `!window.savedFilePane.hidden && Math.abs(document.querySelector('.terminal-host').clientWidth - ${terminalWidth}) < 2`,
      );
      assert.ok(
        await run(
          `window.sshPane.querySelector('.file-pane') === window.savedFilePane && window.savedFilePane.querySelector('.checkbox input').checked`,
        ),
      );
      await run(`window.sshPane.querySelector('.file-panel-toggle').click()`);
      await waitFor(`window.savedFilePane.hidden`);
      await run(`window.sshPane.querySelector('.file-panel-toggle').click()`);
      await waitFor(`!window.savedFilePane.hidden`);
      fs.writeFileSync(
        path.join(temp, "terminal-dark.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      // Tab context menu: copy the current tab, plus close actions and their disabled states.
      const openTabMenu = (name) =>
        run(`(() => {
          const tab = Array.from(document.querySelectorAll('.tabbar .tab')).find((t) => t.innerText.includes(${JSON.stringify(name)}));
          if (!tab) return false;
          const rect = tab.getBoundingClientRect();
          tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + 24, clientY: rect.y + 12 }));
          return true;
        })()`);
      const menuLabels = () =>
        run(
          `Array.from(document.querySelectorAll('.tab-menu button')).map((b) => ({ label: b.innerText, disabled: b.disabled }))`,
        );
      assert.ok(await openTabMenu("本机测试服务器"));
      await waitFor(`!!document.querySelector('.tab-menu')`);
      const ftpMenu = await menuLabels();
      assert.deepEqual(
        ftpMenu.map((item) => item.label),
        [
          "拷贝标签页",
          "关闭",
          "关闭其他标签页",
          "关闭右侧标签页",
          "关闭所有标签页",
        ],
      );
      assert.equal(ftpMenu[3].disabled, false);
      await run(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
      );
      await waitFor(`!document.querySelector('.tab-menu')`);
      assert.ok(await openTabMenu("Terminal fixture"));
      await waitFor(`!!document.querySelector('.tab-menu')`);
      assert.equal(
        (await menuLabels())[3].disabled,
        true,
        "关闭右侧标签页 should be disabled for the last tab",
      );
      fs.writeFileSync(
        path.join(temp, "tab-menu.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      const tabsBeforeCopy = await run(
        `document.querySelectorAll('.tabbar .tab').length`,
      );
      await run(
        `Array.from(document.querySelectorAll('.tab-menu button')).find((b) => b.innerText === '拷贝标签页').click()`,
      );
      await waitFor(
        `document.querySelectorAll('.tabbar .tab').length === ${tabsBeforeCopy + 1} && !document.querySelector('.tab-menu')`,
      );
      assert.deepEqual(
        await run(
          `Array.from(document.querySelectorAll('.tabbar .tab')).map((t) => (t.querySelector('button') ?? t).innerText)`,
        ),
        [
          "连接管理",
          "本机测试服务器",
          "Terminal fixture",
          "Terminal fixture (2)",
        ],
        "copy should be inserted after the source tab with a unique name",
      );
      await waitFor(
        `(() => { const active = document.querySelector('.session[style*="display: flex"]'); return !!active?.querySelector('.xterm-screen')?.textContent.includes('TERMINAL_READY'); })()`,
      );
      assert.equal(
        await run(
          `document.querySelector('.session[style*="display: flex"] .session-identity strong').textContent`,
        ),
        "Terminal fixture (2)",
      );
      // Opening the same saved connection again should receive the next suffix.
      assert.ok(
        await run(`(() => {
          const item = Array.from(document.querySelectorAll('.sidebar .connection-nav')).find((n) => n.innerText.includes('Terminal fixture'));
          if (!item) return false;
          item.click();
          return true;
        })()`),
      );
      await waitFor(
        `(() => { const active = document.querySelector('.session[style*="display: flex"]'); return active?.querySelector('.session-identity strong')?.textContent === 'Terminal fixture (3)' && active.querySelector('.xterm-screen')?.textContent.includes('TERMINAL_READY'); })()`,
      );
      assert.deepEqual(
        await run(
          `Array.from(document.querySelectorAll('.tabbar .tab')).map((t) => (t.querySelector('button') ?? t).innerText)`,
        ),
        [
          "连接管理",
          "本机测试服务器",
          "Terminal fixture",
          "Terminal fixture (2)",
          "Terminal fixture (3)",
        ],
        "opening a saved connection with a duplicate name should get the next suffix",
      );
      // Close every tab from the context menu, confirming the renderer prompt.
      await run(`window.confirm = () => true; undefined`);
      assert.ok(await openTabMenu("Terminal fixture (3)"));
      await waitFor(`!!document.querySelector('.tab-menu')`);
      assert.equal((await menuLabels())[4].label, "关闭所有标签页");
      await run(
        `Array.from(document.querySelectorAll('.tab-menu button')).find((b) => b.innerText === '关闭所有标签页').click()`,
      );
      await waitFor(
        `document.querySelectorAll('.tabbar .tab').length === 1 && !!document.querySelector('.home')`,
      );
      sshServer.close();
      const savedImage = await window.webContents.capturePage();
      fs.writeFileSync(path.join(temp, "connections.png"), savedImage.toPNG());
      console.log(
        `UI smoke passed: app/terminal themes, tab context menu, terminal find bar, focus mode, resizable/collapsible sidebar and file panel, FTP operations, local credentials/encrypted backups, SSH bulk output and background tabs. Screenshots: ${temp}`,
      );
      clearTimeout(timer);
      // Exit directly: destroying the last window first triggers app.quit() on
      // Windows, which can block on the active-session confirmation dialog.
      // app.exit() closes all windows without the interactive quit handlers.
      app.exit(0);
    } catch (error) {
      ftpServer?.close();
      sshServer?.close();
      console.error(error);
      clearTimeout(timer);
      app.exit(1);
    }
  });
});
require(process.argv[2] || "../electron/main.cjs");
