// Covers menu quit, Sparkle's Cocoa termination request and pending install.
// Never permit termination until settings are durable; do not double-prompt.
function createQuitCoordinator({ app, confirm, flush, disconnect, showError }) {
  let prepared = false;
  let pending;
  let closing = false;
  let generation = 0;
  async function prepare() {
    if (prepared) return true;
    if (pending) return pending;
    closing = true;
    const current = generation;
    pending = (async () => {
      try {
        if (!(await confirm())) return false;
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
  app.on("before-quit", (event) => {
    if (prepared) return;
    event.preventDefault();
    if (!pending)
      void prepare().then((ok) => {
        if (ok) app.quit();
      });
  });
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
