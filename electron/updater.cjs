const path = require("node:path");

function createUpdater({
  app,
  dialog,
  prepareQuit,
  cancelQuit,
  isBusy,
  load = require,
  resumeGraceMs = 10000,
}) {
  let bridge;
  let win;
  let unavailable =
    "此构建未配置 Sparkle 更新，请安装 GitHub Releases 中的正式更新版。";
  const showError = (error) =>
    dialog.showErrorBox("Trident 更新", String(error.message || error));
  const busyError = () => new Error("存在活跃连接，请先断开所有连接后再更新。");
  // dialog 的 detail 只显示纯文本，GitHub Releases 的说明为 HTML，需先行转换
  const releaseText = (info) => {
    const notes = info?.releaseNotes;
    const raw =
      typeof notes === "string"
        ? notes
        : Array.isArray(notes)
          ? notes
              .map((item) => item?.note ?? "")
              .join("\n")
              .trim()
          : "";
    return raw
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?(p|div|h[1-6]|ul|ol)[^>]*>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };
  async function promptInstall() {
    // 下载完成时若仍处于忙碌状态，等待 refreshBusy 在空闲后再次触发
    if (!win?.downloaded || win.prompting || isBusy()) return;
    win.prompting = true;
    try {
      const info = win.info;
      const { response } = await dialog.showMessageBox({
        type: "info",
        message: `Trident ${info?.version || "新版本"} 已下载完成，是否立即重启安装？`,
        detail: releaseText(info) || undefined,
        buttons: ["立即重启安装", "稍后"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return;
      if (isBusy()) throw busyError();
      // NSIS 安装器只给应用约 1.3s 优雅退出窗口；先落盘并解除 before-quit
      // 拦截，使 app.quit() 立即生效，安装器随后才会按 --force-run 重启应用。
      if (!(await prepareQuit())) return;
      win.autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      showError(error);
    } finally {
      win.prompting = false;
    }
  }
  async function resume() {
    try {
      if (bridge?.state().pendingInstall && (await prepareQuit())) {
        bridge.setBusy(false);
        bridge.resume();
        // Sparkle 恢复安装的重启若未真正终止进程，不会回调 cancel-install，
        // 此处兜底恢复 IPC，避免应用留在永久拒绝请求的状态。
        setTimeout(() => {
          cancelQuit?.();
          showError(
            new Error("更新重启未能完成，已恢复应用；请手动重启以完成更新。"),
          );
        }, resumeGraceMs).unref();
      }
    } catch (error) {
      cancelQuit?.();
      showError(error);
    }
  }
  if (process.platform === "darwin" && app.isPackaged) {
    try {
      const directory = path.join(process.resourcesPath, "sparkle");
      if (load(path.join(directory, "config.json")).enabled) {
        bridge = load(path.join(directory, "sparkle-bridge.node"));
        bridge.start((event) => {
          if (event === "cancel-install") cancelQuit?.();
          else void resume();
        });
        bridge.setBusy(isBusy());
      }
    } catch (error) {
      bridge = undefined;
      unavailable = `更新组件未能启动：${error.message}`;
      console.error(unavailable);
    }
  }
  if (process.platform === "win32") {
    if (app.isPackaged) {
      try {
        const { autoUpdater } = load("electron-updater");
        win = { autoUpdater, downloaded: false, info: null, prompting: false };
        autoUpdater.autoDownload = true;
        autoUpdater.on("update-downloaded", (info) => {
          win.downloaded = true;
          win.info = info;
          void promptInstall();
        });
        autoUpdater.on("update-not-available", () => {
          void dialog.showMessageBox({
            type: "info",
            message: "已是最新版本。",
          });
        });
        autoUpdater.on("error", showError);
      } catch (error) {
        win = undefined;
        unavailable = `更新组件未能加载：${error.message}`;
        console.error(unavailable);
      }
    } else {
      unavailable = "更新仅对打包版生效，请从 GitHub Releases 下载安装包。";
    }
  }
  return {
    assertCanConnect() {
      if (bridge?.state().inProgress)
        throw new Error("正在检查或安装更新，请完成或关闭更新窗口后再连接。");
    },
    refreshBusy() {
      bridge?.setBusy(isBusy());
      if (win?.downloaded) void promptInstall();
    },
    menu() {
      if (process.platform === "win32")
        return [
          {
            label: "检查更新…",
            click() {
              if (!win) return showError(new Error(unavailable));
              if (isBusy()) return showError(busyError());
              if (win.downloaded) return void promptInstall();
              win.autoUpdater.checkForUpdates().catch(showError);
            },
          },
        ];
      return [
        {
          label: "检查更新…",
          click() {
            if (!bridge) return showError(new Error(unavailable));
            try {
              bridge.setBusy(isBusy());
              if (bridge.state().pendingInstall) return resume();
              bridge.check();
            } catch (error) {
              showError(error);
            }
          },
        },
        {
          label: "自动检查更新",
          type: "checkbox",
          enabled: !!bridge,
          checked: !!bridge?.state().automatic,
          click(item) {
            try {
              bridge?.setAutomatic(item.checked);
            } catch (error) {
              showError(error);
            }
          },
        },
      ];
    },
  };
}
module.exports = { createUpdater };
