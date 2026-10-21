const { contextBridge, ipcRenderer } = require("electron");
const invoke =
  (name) =>
  (...args) =>
    ipcRenderer.invoke(name, ...args);
// One IPC listener, routing by session before crossing contextBridge.
const sessionListeners = new Map();
ipcRenderer.on("session:event", (_event, payload) => {
  const listeners = sessionListeners.get(payload.id);
  if (listeners)
    for (const [callback, includeData] of listeners) {
      if (payload.type !== "data" || includeData) callback(payload);
    }
});
contextBridge.exposeInMainWorld("trident", {
  getTheme: invoke("theme:get"),
  setTheme: invoke("theme:set"),
  setTerminalTheme: invoke("theme:terminal-set"),
  onThemeChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("theme:changed", listener);
    return () => ipcRenderer.removeListener("theme:changed", listener);
  },
  onToggleFocus: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("ui:toggle-focus", listener);
    return () => ipcRenderer.removeListener("ui:toggle-focus", listener);
  },
  acknowledge: (id, bytes) => ipcRenderer.send("ssh:ack", id, bytes),
  onSessionEvent: (id, callback, includeData = false) => {
    if (!sessionListeners.has(id)) sessionListeners.set(id, new Map());
    const listeners = sessionListeners.get(id);
    listeners.set(callback, includeData);
    return () => {
      listeners.delete(callback);
      if (!listeners.size && sessionListeners.get(id) === listeners)
        sessionListeners.delete(id);
    };
  },
  profiles: invoke("profiles:list"),
  saveProfile: invoke("profiles:save"),
  deleteProfile: invoke("profiles:delete"),
  exportProfiles: invoke("profiles:export"),
  prepareImport: invoke("profiles:prepare-import"),
  commitImport: invoke("profiles:commit-import"),
  chooseKey: invoke("key:choose"),
  connect: invoke("ssh:connect"),
  disconnect: invoke("ssh:disconnect"),
  write: invoke("ssh:write"),
  resize: invoke("ssh:resize"),
  list: invoke("sftp:list"),
  upload: invoke("sftp:upload"),
  download: invoke("sftp:download"),
  mkdir: invoke("sftp:mkdir"),
  rename: invoke("files:rename"),
  remove: invoke("files:remove"),
});
