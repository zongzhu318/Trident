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
  let unavailable =
    "此构建未配置 Sparkle 更新，请安装 GitHub Releases 中的正式更新版。";
  const showError = (error) =>
    dialog.showErrorBox("Trident 更新", String(error.message || error));
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
  return {
    assertCanConnect() {
      if (bridge?.state().inProgress)
        throw new Error("正在检查或安装更新，请完成或关闭更新窗口后再连接。");
    },
    refreshBusy() {
      bridge?.setBusy(isBusy());
    },
    menu() {
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
