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
  // Streaming AI chat chunks — pushed from main when ai_chat_stream
  // is active. Payloads include the request id so multiple concurrent
  // streams can be routed correctly.
  onAiChatChunk(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("smartnote:ai-chat-chunk", listener);
    return () => ipcRenderer.removeListener("smartnote:ai-chat-chunk", listener);
  },
  // Global ⌘K → main process focuses the window and emits this so
  // the renderer opens the Spotlight palette overlay.
  onSpotlightOpen(callback) {
    const listener = () => callback();
    ipcRenderer.on("smartnote:spotlight-open", listener);
    return () => ipcRenderer.removeListener("smartnote:spotlight-open", listener);
  },
  // Spotlight (separate window) picked a result → main forwards
  // the channel id to the main window so it can navigate.
  onOpenSource(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("smartnote:open-source", listener);
    return () => ipcRenderer.removeListener("smartnote:open-source", listener);
  },
  // File-watcher refused to push because the cloud doc was changed by
  // someone else (MCP, console, another desktop). Payload: { relPath,
  // docId, cloudMs, by }. NotePage uses it to flag merge-needed.
  onCloudConflict(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("smartnote:cloud-conflict", listener);
    return () => ipcRenderer.removeListener("smartnote:cloud-conflict", listener);
  },
});
