const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  invoke(channel, ...args) {
    return ipcRenderer.invoke(channel, ...args);
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
  // Long-lived cloud-pushed event stream from /v1/device/relay.
  // Payloads carry { type, ...fields } — see ws-presence.mjs.
  onWsEvent(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("smartnote:ws-event", listener);
    return () => ipcRenderer.removeListener("smartnote:ws-event", listener);
  },
});
