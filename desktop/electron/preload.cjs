const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  invoke(channel, payload) {
    return ipcRenderer.invoke(channel, payload);
  },
  onIngestStatus(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("ingest:status", listener);
    return () => ipcRenderer.removeListener("ingest:status", listener);
  },
  onWikiIngestStatus(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("wiki-ingest:status", listener);
    return () => ipcRenderer.removeListener("wiki-ingest:status", listener);
  },
  onHotkeyPasted(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("hotkey:pasted", listener);
    return () => ipcRenderer.removeListener("hotkey:pasted", listener);
  },
});
