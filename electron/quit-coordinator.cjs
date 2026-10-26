// Guards the updater flows that must finish writing state and close sessions
// before the process is replaced (Sparkle pending install, Windows relaunch).
// Menu quit (Cmd+Q) is deliberately not routed through here: it is a force
// quit and terminates the process without waiting for anything.
function createQuitCoordinator({ confirm, flush, disconnect, showError }) {
  let prepared = false;
  let pending;
  let closing = false;
  let generation = 0;
  async function prepare() {
    if (prepared) return true;
    if (pending) return pending;
    const current = generation;
    pending = (async () => {
      try {
        if (!(await confirm())) return false;
        if (generation === current) closing = true;
        await flush();
        if (generation !== current) return false;
        disconnect();
        prepared = true;
        return true;
      } catch (error) {
        showError(error);
        return false;
      } finally {
        if (generation === current) closing = prepared;
      }
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  }
  return {
    prepare,
    cancelPreparation() {
      generation++;
      prepared = false;
      closing = false;
    },
    get prepared() {
      return prepared;
    },
    assertOpen() {
      if (closing) throw new Error("应用正在保存数据并退出，请稍候。");
    },
  };
}
module.exports = { createQuitCoordinator };
