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
dialog.showSaveDialog = async () => ({
  canceled: false,
  filePath: saveDestination,
});
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: openFiles });
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
      saveDestination = path.join(temp, "ui-download.txt");
      await run(`document.querySelector('.file-row').click()`);
      await waitFor(
        `!document.querySelector('button[title="下载选中文件"]').disabled`,
      );
      await run(
        `document.querySelector('button[title="下载选中文件"]').click()`,
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
      sshServer.close();
      const savedImage = await window.webContents.capturePage();
      fs.writeFileSync(path.join(temp, "connections.png"), savedImage.toPNG());
      console.log(
        `UI smoke passed: app/terminal themes, terminal find bar, focus mode, resizable/collapsible sidebar and file panel, FTP operations, local credentials/encrypted backups, SSH bulk output and background tabs. Screenshots: ${temp}`,
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
