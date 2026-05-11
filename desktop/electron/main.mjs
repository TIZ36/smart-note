import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, Menu } from "electron";
import electron from "electron";
const { globalShortcut, Notification } = electron;
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import net from "net";
import http from "http";
import { spawn } from "child_process";
import readline from "readline";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Legacy server root — historically `<repo>/server/` held the Python
 * backend and its data dir. The backend itself is gone (commit
 * `feat: rm server`), but a few writers (hotkey config, raw-path
 * prefs, feature-flag .env) were still writing there, which caused
 * the directory to silently reappear every time the user saved
 * anything. Kept as a read-only source for one-shot migration into
 * `userData/`; do not write to this path in new code. */
function legacyServerRoot() {
  if (process.env.SERVER_ROOT) return path.resolve(process.env.SERVER_ROOT);
  return path.join(__dirname, "..", "..", "server");
}

/** Canonical user-data root. Standard Electron convention — survives
 * uninstall/reinstall of the app, isn't tied to the source tree.
 * Hotkey config, raw-path prefs, .env all live here now. */
function userDataRoot() {
  // Wrapped in a function (not a top-level const) so this file can
  // still be required from a context where `app` isn't ready yet
  // (eg. test harnesses) — call sites only fire inside IPC / lifecycle.
  return app.getPath("userData");
}
function userDataPrefsDir() {
  const dir = path.join(userDataRoot(), "prefs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

// One-shot migration: if a legacy `<repo>/server/` config is found
// and the userData equivalent is empty, copy each file over once.
// We avoid deleting the source so the user can sanity-check the
// migration succeeded before they `rm -rf server` themselves.
function migrateLegacyServerConfig() {
  const legacy = legacyServerRoot();
  if (!fs.existsSync(legacy)) return;
  const pairs = [
    [path.join(legacy, ".env"),               path.join(userDataPrefsDir(), ".env")],
    [path.join(legacy, "data", "hotkey.json"), path.join(userDataPrefsDir(), "hotkey.json")],
    [path.join(legacy, "data", "prefs.json"),  path.join(userDataPrefsDir(), "prefs.json")],
  ];
  for (const [src, dst] of pairs) {
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    } catch { /* best-effort */ }
  }
}

/** Cloud infra root — where docker-compose.yml lives. */
function cloudInfraRoot() {
  if (process.env.CLOUD_INFRA_ROOT) return path.resolve(process.env.CLOUD_INFRA_ROOT);
  return path.join(__dirname, "..", "..", "cloud", "infra");
}

function pythonBin() {
  // Legacy Python CLI binary lookup — server tree is gone, so this
  // always falls through to the system python. Spawn paths that
  // depend on this fail noisily at call time; that's intentional —
  // those code paths are dead but still reachable from a few UI
  // affordances, which we'll clean up separately.
  return process.platform === "win32" ? "python" : "python3";
}

function envFile() {
  return path.join(userDataPrefsDir(), ".env");
}

function readEmbeddingMode() {
  const envPath = envFile();
  if (!fs.existsSync(envPath)) return "unknown";
  try {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (t.startsWith("EMBEDDING_MODE=")) {
        return t.split("=", 2)[1]?.trim() ?? "unknown";
      }
    }
  } catch {
    /* ignore */
  }
  return "unknown";
}

function isGatewayOnline() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: 8787, timeout: 250 });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function parseEnvFile(content) {
  const map = new Map();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) map.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  return map;
}

function runIngestCmd(rawPath, notePath, doReset) {
  // UI-triggered: use LLM API directly (no delegate).
  const args = ["-m", "app.cli", "ingest", "--raw", rawPath, "--note", notePath];
  if (doReset) args.push("--reset");
  const proc = spawn(pythonBin(), args, { cwd: legacyServerRoot() });
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (c) => {
    stdout += c.toString();
  });
  proc.stderr?.on("data", (c) => {
    stderr += c.toString();
  });
  return new Promise((resolve) => {
    proc.on("close", (code) => {
      let message = "";
      try {
        const parsed = JSON.parse(stdout.trim());
        message = parsed?.message ?? stdout.trim();
      } catch {
        if (stdout.trim()) message = stdout.trim();
        else if (stderr.trim()) message = stderr.trim();
        else message = "Ingest completed.";
      }
      resolve({ ok: code === 0, output: message });
    });
    proc.on("error", (e) => {
      resolve({ ok: false, output: `Failed to start ingest: ${e.message}` });
    });
  });
}

// Track running ingest state so renderer can recover after reload
let noteIngestRunning = false;
let wikiIngestRunning = false;

function emitIngest(win, payload) {
  if (win && !win.isDestroyed()) win.webContents.send("ingest:status", payload);
}

function emitWikiIngest(win, payload) {
  if (win && !win.isDestroyed()) win.webContents.send("wiki-ingest:status", payload);
}

// ── Gateway SSE bridge ──
// Mirrors ingest progress from the FastAPI process (e.g. MCP-triggered ingest)
// into the same IPC channels the CLI-spawned path uses, so the editor pipeline
// panel lights up regardless of how ingest was started.
let sseReconnectTimer = null;

function forwardSseEvent(event) {
  const w = BrowserWindow.getAllWindows()[0] ?? mainWindow;
  if (!w || w.isDestroyed()) return;
  const step = event.step ?? "";
  const channel = event.channel === "wiki" ? "wiki" : "note";
  const isStore = step === "store" && Number(event.current || 0) === 0;
  const isDone = step === "done";
  const isError = step === "error";
  const status = isDone ? "completed" : isError ? "error" : "progress";

  // Synthesize a 'started' event on the first sign of activity so the UI
  // resets step state to match a fresh run.
  if (channel === "note") {
    if (step === "parse" && Number(event.current || 0) === 0 && !noteIngestRunning) {
      noteIngestRunning = true;
      emitIngest(w, {
        status: "started",
        step: "parse",
        current: 0,
        total: 0,
        elapsed_ms: 0,
        message: event.detail || "Ingest started",
      });
    }
    emitIngest(w, {
      status,
      step,
      current: Number(event.current ?? 0) || 0,
      total: Number(event.total ?? 0) || 0,
      elapsed_ms: Number(event.elapsed_ms ?? 0) || 0,
      message: event.detail ?? "",
      actor: event.actor ?? undefined,
      kind: event.kind ?? undefined,
    });
    if (isDone || isError) noteIngestRunning = false;
  } else {
    if (!wikiIngestRunning && (step === "parse" || step === "fetch") && Number(event.current || 0) === 0) {
      wikiIngestRunning = true;
      emitWikiIngest(w, {
        status: "started",
        step,
        current: 0,
        total: 0,
        elapsed_ms: 0,
        message: event.detail || "Wiki ingest started",
      });
    }
    emitWikiIngest(w, {
      status,
      step,
      current: Number(event.current ?? 0) || 0,
      total: Number(event.total ?? 0) || 0,
      elapsed_ms: Number(event.elapsed_ms ?? 0) || 0,
      message: event.detail ?? "",
      actor: event.actor ?? undefined,
      kind: event.kind ?? undefined,
    });
    if (isDone || isError) wikiIngestRunning = false;
  }
  // `isStore` is intentionally unused — kept for future UI needs.
  void isStore;
}

function connectIngestSse() {
  const req = http.request(
    { host: "127.0.0.1", port: 8787, path: "/events/ingest", method: "GET", headers: { Accept: "text/event-stream" } },
    (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        scheduleSseReconnect();
        return;
      }
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              forwardSseEvent(JSON.parse(payload));
            } catch {
              /* ignore malformed frames */
            }
          }
        }
      });
      res.on("end", scheduleSseReconnect);
      res.on("error", scheduleSseReconnect);
    },
  );
  req.on("error", scheduleSseReconnect);
  req.end();
}

function scheduleSseReconnect() {
  if (sseReconnectTimer) return;
  sseReconnectTimer = setTimeout(() => {
    sseReconnectTimer = null;
    connectIngestSse();
  }, 2000);
}

function ingestRawAsync(win, rawPath, notePath, doReset) {
  noteIngestRunning = true;
  emitIngest(win, {
    status: "started",
    step: "parse",
    current: 0,
    total: 0,
    elapsed_ms: 0,
    message: doReset ? "Rebuilding knowledge base..." : "Ingesting new content...",
  });

  // UI-triggered: use LLM API directly (INGEST_AI_ENABLED controls whether
  // AI runs; no --ai-delegate so the backend classifies inline).
  const args = ["-m", "app.cli", "ingest", "--raw", rawPath, "--note", notePath];
  if (doReset) args.push("--reset");
  const proc = spawn(pythonBin(), args, {
    cwd: legacyServerRoot(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.on("error", (e) => {
    emitIngest(win, {
      status: "error",
      step: "",
      current: 0,
      total: 0,
      elapsed_ms: 0,
      message: `Failed to start ingest: ${e.message}`,
    });
  });

  if (proc.stderr) {
    const rl = readline.createInterface({ input: proc.stderr });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        const step = parsed.step ?? "";
        const current = Number(parsed.current ?? 0) || 0;
        const total = Number(parsed.total ?? 0) || 0;
        const detail = parsed.detail ?? "";
        const elapsedMs = Number(parsed.elapsed_ms ?? 0) || 0;
        emitIngest(win, {
          status: step === "done" ? "completed" : "progress",
          step,
          current,
          total,
          elapsed_ms: elapsedMs,
          message: detail,
        });
      } catch {
        /* ignore non-JSON stderr */
      }
    });
  }

  let stdoutBuf = "";
  proc.stdout?.on("data", (c) => {
    stdoutBuf += c.toString();
  });

  proc.on("close", (code) => {
    noteIngestRunning = false;
    const ok = code === 0;
    let message = "Ingest completed.";
    try {
      const parsed = JSON.parse(stdoutBuf.trim());
      message = parsed?.message ?? message;
    } catch {
      if (stdoutBuf.trim()) message = stdoutBuf.trim();
    }
    emitIngest(win, {
      status: ok ? "completed" : "error",
      step: "done",
      current: 0,
      total: 0,
      elapsed_ms: 0,
      message,
    });
  });
}

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#faf9f7",
    icon: path.join(__dirname, "..", "public", "icon.png"),
    webPreferences: {
      // CommonJS preload：ESM preload 在部分环境下会加载失败 → 白屏/黑屏且 window.desktop 不存在
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox 与 ESM preload 组合曾导致 preload 不执行；桌面端关闭 sandbox 更稳
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("[electron] did-fail-load", { code, desc, url });
  });

  /* DevTools shortcuts — the app menu is suppressed (proto layout
   * owns the chrome) so the standard View → Toggle Developer Tools
   * is unreachable. Wire the conventional accelerators directly:
   *   ⌘⌥I (mac) / Ctrl+Shift+I (win/linux)  → toggle devtools
   *   ⌘R / Ctrl+R                            → reload renderer
   *   F12                                    → toggle devtools (uniform)
   * Also auto-open in dev mode so the first error is never silent. */
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const cmdOrCtrl = input.meta || input.control;
    const key = input.key.toLowerCase();
    // Toggle devtools
    if ((cmdOrCtrl && input.alt && key === "i") || key === "f12") {
      mainWindow?.webContents.toggleDevTools();
      event.preventDefault();
      return;
    }
    // Reload (helpful when the renderer paints white from a recoverable
    // error after a hot-update mismatch)
    if (cmdOrCtrl && !input.alt && !input.shift && key === "r") {
      mainWindow?.webContents.reload();
      event.preventDefault();
    }
  });

  if (process.env.VITE_DEV_SERVER_URL || process.env.SMARTNOTE_DEVTOOLS === "1") {
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow?.webContents.openDevTools({ mode: "detach" });
    });
  }

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    const u = devUrl.endsWith("/") ? devUrl.slice(0, -1) : devUrl;
    mainWindow.loadURL(u).catch((err) => console.error("[electron] loadURL failed", err));
  } else {
    const indexHtml = path.join(__dirname, "..", "dist", "index.html");
    mainWindow.loadFile(indexHtml).catch((err) => console.error("[electron] loadFile failed", err));
  }
}

/* Re-applied dock icon. Extracted into a function so we can call
 * it not just at startup but also when the macOS app activation
 * state has been disturbed (e.g. after the spotlight window's
 * transparent+alwaysOnTop frame unsettles the dock and reverts the
 * icon to Electron's default atom). */
function applyDockIcon() {
  if (process.platform !== "darwin" || !app.dock) return;
  try {
    const iconPath = path.join(__dirname, "..", "public", "icon.png");
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  } catch {}
}

app.whenReady().then(() => {
  // One-shot: copy any leftover `<repo>/server/{,.env,data/*.json}`
  // into `userData/prefs/` so users coming from an older build don't
  // lose their hotkey customisation or saved rawPath. After this
  // runs once the legacy directory is dead weight and can be deleted.
  migrateLegacyServerConfig();

  applyDockIcon();
  createWindow();
  // Pre-create spotlight (hidden) so the first ⌘K is just as fast
  // as every later one — no loadURL or React-mount on the first
  // press. The window does a brief showInactive→hide cycle once
  // its renderer is ready (see createSpotlightWindow) so Cocoa
  // pre-allocates the surface, eliminating the first-show flicker.
  createSpotlightWindow();
  loadHotkeyConfig();
  registerHotkey();
  // connectIngestSse() removed — the SSE producer lived in the
  // retired :8787 Python gateway. Calling it now just churns
  // reconnect timers forever. Ingest events flow through the
  // electron-internal "smartnote:ws-event" channel.
  // Start cloud heartbeat (no-op if cloud not configured). Pings
  // /v1/devices/heartbeat every 30s so the workspace registry can
  // honestly reflect this device as online while the desktop runs.
  // Lazy-imported to avoid the module-init order dance with the
  // service file declared further down.
  import("./services/sync.mjs").then((m) => m.startHeartbeat()).catch(() => {});

  // Start the long-lived WS to /v1/device/relay. Carries real-time
  // events (agent_active, enrich_done, memory_proposed, search_recorded)
  // FROM cloud TO renderer. Bound to the focused window's webContents
  // — events are forwarded as IPC "smartnote:ws-event".
  import("./services/ws-presence.mjs").then((m) => {
    m.setEmit((payload) => {
      const allWindows = BrowserWindow.getAllWindows();
      for (const w of allWindows) {
        try { w.webContents.send("smartnote:ws-event", payload); } catch {}
      }
    });
    m.start();
  }).catch(() => {});

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  // Stop heartbeat + WS cleanly so the device shows offline within
  // the 60s window after the user quits.
  import("./services/sync.mjs").then((m) => m.stopHeartbeat()).catch(() => {});
  import("./services/ws-presence.mjs").then((m) => m.stop()).catch(() => {});
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("ingest_raw", async (_, { rawPath, notePath, reset }) => {
  const doReset = !!reset;
  return runIngestCmd(rawPath, notePath, doReset);
});

ipcMain.handle("special_ingest_async", async (event, { folderPath, filePath, topicName }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  wikiIngestRunning = true;
  const inputPath = filePath || folderPath;
  const label = topicName || path.basename(inputPath);
  emitWikiIngest(win, { status: "started", step: "parse", current: 0, total: 0, elapsed_ms: 0, message: `Ingesting: ${label}` });

  const args = ["-m", "app.cli", "special-ingest"];
  if (filePath) {
    args.push("--file", filePath);
  } else {
    args.push("--folder", folderPath);
  }
  if (topicName) args.push("--topic", topicName);
  const proc = spawn(pythonBin(), args, { cwd: legacyServerRoot(), stdio: ["ignore", "pipe", "pipe"] });

  proc.on("error", (e) => {
    emitWikiIngest(win, { status: "error", step: "", current: 0, total: 0, elapsed_ms: 0, message: `Failed: ${e.message}` });
  });

  if (proc.stderr) {
    const rl = readline.createInterface({ input: proc.stderr });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        emitWikiIngest(win, {
          status: parsed.step === "done" ? "completed" : "progress",
          step: parsed.step ?? "",
          current: Number(parsed.current ?? 0),
          total: Number(parsed.total ?? 0),
          elapsed_ms: Number(parsed.elapsed_ms ?? 0),
          message: parsed.detail ?? "",
        });
      } catch {}
    });
  }

  let stdoutBuf = "";
  proc.stdout?.on("data", (c) => { stdoutBuf += c.toString(); });
  proc.on("close", (code) => {
    wikiIngestRunning = false;
    let message = "Wiki ingest completed.";
    try { message = JSON.parse(stdoutBuf.trim())?.message ?? message; } catch {}
    emitWikiIngest(win, { status: code === 0 ? "completed" : "error", step: "done", current: 0, total: 0, elapsed_ms: 0, message });
  });
});

ipcMain.handle("mcp_import_async", async (event, { serverName, docUrl, documentId, topicName }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  wikiIngestRunning = true;
  emitWikiIngest(win, { status: "started", step: "fetch", current: 0, total: 0, elapsed_ms: 0, message: "Fetching document via MCP..." });

  const args = ["-m", "app.cli", "mcp-import", "--server", serverName];
  if (docUrl) args.push("--url", docUrl);
  if (documentId) args.push("--doc-id", documentId);
  if (topicName) args.push("--topic", topicName);
  const proc = spawn(pythonBin(), args, { cwd: legacyServerRoot(), stdio: ["ignore", "pipe", "pipe"] });

  proc.on("error", (e) => {
    wikiIngestRunning = false;
    emitWikiIngest(win, { status: "error", step: "", current: 0, total: 0, elapsed_ms: 0, message: `Failed: ${e.message}` });
  });

  if (proc.stderr) {
    const rl = readline.createInterface({ input: proc.stderr });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        emitWikiIngest(win, {
          status: parsed.step === "done" ? "completed" : "progress",
          step: parsed.step ?? "",
          current: Number(parsed.current ?? 0),
          total: Number(parsed.total ?? 0),
          elapsed_ms: 0,
          message: parsed.detail ?? "",
        });
      } catch {}
    });
  }

  let stdoutBuf = "";
  proc.stdout?.on("data", (c) => { stdoutBuf += c.toString(); });
  proc.on("close", (code) => {
    wikiIngestRunning = false;
    let message = "MCP import completed.";
    try { message = JSON.parse(stdoutBuf.trim())?.message ?? message; } catch {}
    emitWikiIngest(win, { status: code === 0 ? "completed" : "error", step: "done", current: 0, total: 0, elapsed_ms: 0, message });
  });
});

ipcMain.handle("dialog_open_folder", async () => {
  const r = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ["openDirectory"],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle("dialog_open_pdf", async () => {
  const r = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ["openFile"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle("ingest_raw_async", async (event, { rawPath, notePath, reset }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  ingestRawAsync(win, rawPath, notePath, !!reset);
});

ipcMain.handle("append_text_to_raw", async (_, { rawPath, text }) => {
  const p = path.resolve(rawPath);
  const parent = path.dirname(p);
  fs.mkdirSync(parent, { recursive: true });
  // Append to bottom — preserves line numbers for segment jumps
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const sep = existing.length > 0 && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
  fs.writeFileSync(p, `${existing}${sep}${text.trim()}\n`, "utf8");
  return { ok: true, output: "appended" };
});

ipcMain.handle("list_views", async (_, { notePath }) => {
  const note = path.resolve(notePath);
  const base = path.dirname(note);
  const viewsDir = path.join(base, "views");
  const views = [];
  if (fs.existsSync(viewsDir)) {
    for (const name of fs.readdirSync(viewsDir)) {
      if (!name.endsWith(".md")) continue;
      const fp = path.join(viewsDir, name);
      const full = fs.readFileSync(fp, "utf8");
      const first = full.split("\n")[0] ?? "";
      let title = first.startsWith("# ") ? first.slice(2).trim() : name.replace(/\.md$/i, "").replace(/-/g, " ");
      views.push({ name: title, path: fp });
    }
  }
  views.sort((a, b) => a.name.localeCompare(b.name));
  return { views };
});

/** Full read for Note editor; search/tag previews use gateway line-range APIs. */
ipcMain.handle("read_file_full", async (_, { path: filePath }) => {
  const content = fs.readFileSync(filePath, "utf8");
  return { ok: true, output: content };
});

/* ── Native services (Phase 3 / decision L) ─────────────────────────
   Single-binary mode: the renderer can call these IPC handlers
   instead of the Python gateway. Handlers stay best-effort: an error
   surfaces as { ok: false, error } so the renderer can fall back. */

import * as nativeSettings from "./services/settings.mjs";
import * as nativeNotes from "./services/notes.mjs";
import * as nativeSearch from "./services/local-search.mjs";
import * as nativeSync from "./services/sync.mjs";

function _wrap(fn) {
  return async (...args) => {
    try { return { ok: true, value: await fn(...args) }; }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  };
}

ipcMain.handle("native:settings:read",  _wrap(() => nativeSettings.read()));
ipcMain.handle("native:settings:write", _wrap((_, p) => nativeSettings.write(p ?? {})));

ipcMain.handle("native:notes:read",  _wrap((_, p) => nativeNotes.read(p?.path ?? p)));
ipcMain.handle("native:notes:write", _wrap((_, p) => nativeNotes.write(p?.path, p?.content)));
ipcMain.handle("native:notes:list",  _wrap(() => nativeNotes.list()));

ipcMain.handle("native:search:query",   _wrap((_, p) => nativeSearch.search(p?.query ?? "", p?.limit ?? 20)));
ipcMain.handle("native:search:reindex", _wrap((_, p) => nativeSearch.indexFile(p?.rel_path, p?.content)));

ipcMain.handle("native:sync:start",  _wrap(() => nativeSync.start()));
ipcMain.handle("native:sync:stop",   _wrap(() => nativeSync.stop()));
ipcMain.handle("native:sync:status", _wrap(() => nativeSync.status()));

/* AI chat completion via the user's local provider (Settings → Chat
 * provider). OpenAI-compatible /chat/completions only. Returns the
 * assistant content string + token usage. Renderer calls this via
 * IPC so the api key never crosses into the browser context. */
ipcMain.handle("ai_chat", _wrap(async (_e, { system, user, max_tokens, temperature }) => {
  const creds = _readUserCreds();
  const baseUrl = (creds.provider_base_url || "").replace(/\/+$/, "");
  const apiKey = creds.provider_api_key || "";
  const model = creds.provider_chat_model || "";
  if (!baseUrl || !apiKey || !model) {
    throw new Error("local provider not configured (Settings → Chat provider)");
  }
  const ctrl = new AbortController();
  // Reasoner models (DeepSeek-Reasoner / o1 / Qwen-thinking) can take
  // 30s+ purely on the "thinking" phase before any visible token; bump
  // the wall-clock cap accordingly. 60s was tight even for chat models.
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const isReasoner = /reasoner|o1|o3|thinking/i.test(model);
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: String(system || "") },
          { role: "user", content: String(user || "") },
        ],
        // Reasoners burn most of their budget on hidden chain-of-thought
        // (reasoning_content) before emitting visible content. 600
        // tokens runs out before they ever finish thinking. Provide a
        // much larger cap for those, and an OK cap for chat models.
        max_tokens: max_tokens ?? (isReasoner ? 4096 : 1200),
        temperature: temperature ?? 0.2,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`provider ${r.status}: ${txt.slice(0, 200) || "no body"}`);
    }
    const j = await r.json();
    // Provider response shape varies more than the OpenAI spec
    // implies. Cover four real-world cases:
    //   1. Standard OpenAI/DeepSeek-chat: choices[0].message.content
    //   2. DeepSeek-reasoner / o1: reasoning_content + (sometimes empty) content
    //   3. Anthropic-compatible bridge: choices[0].message.content[].text
    //   4. Legacy completions: choices[0].text
    const choice = j?.choices?.[0] || {};
    const msg = choice.message || {};
    let content = msg.content;
    if (Array.isArray(content)) {
      // OpenAI vision-style content array
      content = content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
    }
    if (!content || (typeof content === "string" && !content.trim())) {
      content = msg.reasoning_content || choice.text || "";
    }
    if (!content) {
      console.warn("[ai_chat] empty content; full response keys:",
        Object.keys(j || {}), "choice keys:", Object.keys(choice));
      console.warn("[ai_chat] dump:", JSON.stringify(j).slice(0, 1500));
    }
    const usage = j?.usage || {};
    return {
      content: String(content || ""),
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      // Diagnostic — surfaces in the renderer if content is empty so
      // the user can see why nothing rendered.
      finish_reason: choice.finish_reason || "",
    };
  } finally {
    clearTimeout(timer);
  }
}));

/* Streaming variant — opens an SSE stream to the provider's
 * /chat/completions, parses each `data: {...}` line, and pushes
 * typed chunks back to the renderer via webContents.send.
 *
 * Chunk shape (sent on channel "smartnote:ai-chat-chunk"):
 *   { id, type: "reasoning" | "content", text }
 *   { id, type: "done", prompt_tokens, completion_tokens,
 *                       total_tokens, finish_reason }
 *   { id, type: "error", err }
 *
 * The id is generated by the renderer so it can route chunks to the
 * right pending request when multiple streams overlap.
 *
 * DeepSeek-Reasoner / o1 / Qwen-thinking emit reasoning_content
 * BEFORE the actual content — see chaya-engine's openai_llm.go for
 * the same dual-stream pattern. Treating them as separate streams
 * lets the UI render a "thinking" block above the answer.
 */
const _aiStreamCtrls = new Map();  // id → AbortController

ipcMain.handle("ai_chat_stream:cancel", (_e, id) => {
  const c = _aiStreamCtrls.get(id);
  if (c) { try { c.abort(); } catch {} _aiStreamCtrls.delete(id); }
  return { cancelled: !!c };
});

ipcMain.handle("ai_chat_stream", async (event, { id, system, user, max_tokens, temperature }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const send = (chunk) => {
    try { win?.webContents.send("smartnote:ai-chat-chunk", { id, ...chunk }); } catch {}
  };
  const creds = _readUserCreds();
  const baseUrl = (creds.provider_base_url || "").replace(/\/+$/, "");
  const apiKey = creds.provider_api_key || "";
  const model = creds.provider_chat_model || "";
  if (!baseUrl || !apiKey || !model) {
    send({ type: "error", err: "local provider not configured (Settings → Chat provider)" });
    return { started: false };
  }

  const ctrl = new AbortController();
  _aiStreamCtrls.set(id, ctrl);
  const isReasoner = /reasoner|o1|o3|thinking/i.test(model);
  const timer = setTimeout(() => ctrl.abort(), 180_000);

  // Run async without awaiting — return started:true so the renderer
  // knows IPC handshake worked. Chunks land via the chunk channel.
  (async () => {
    try {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "Accept": "text/event-stream",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: String(system || "") },
            { role: "user", content: String(user || "") },
          ],
          max_tokens: max_tokens ?? (isReasoner ? 4096 : 1200),
          temperature: temperature ?? 0.2,
          stream: true,
        }),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        send({ type: "error", err: `provider ${r.status}: ${txt.slice(0, 200) || "no body"}` });
        return;
      }
      if (!r.body) {
        send({ type: "error", err: "provider returned no stream body" });
        return;
      }

      // SSE parser — accumulate by lines, split on \n\n event boundaries.
      // Each event is one or more `data: {...}` lines; we only consume
      // the JSON payload and ignore everything else.
      let usage = null;
      let finish_reason = "";
      let buffered = "";
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        // Process complete events — split on double-newline boundary.
        let idx;
        while ((idx = buffered.indexOf("\n\n")) !== -1) {
          const evt = buffered.slice(0, idx);
          buffered = buffered.slice(idx + 2);
          for (const line of evt.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let j;
            try { j = JSON.parse(payload); } catch { continue; }
            const choice = j?.choices?.[0] || {};
            const delta = choice.delta || {};
            // DeepSeek-Reasoner / o1 / Qwen-thinking
            if (delta.reasoning_content) {
              send({ type: "reasoning", text: String(delta.reasoning_content) });
            }
            // Standard
            if (delta.content) {
              if (Array.isArray(delta.content)) {
                const t = delta.content.map((p) => typeof p === "string" ? p : p?.text || "").join("");
                if (t) send({ type: "content", text: t });
              } else {
                send({ type: "content", text: String(delta.content) });
              }
            }
            if (choice.finish_reason) finish_reason = choice.finish_reason;
            if (j.usage) usage = j.usage;
          }
        }
      }
      send({
        type: "done",
        prompt_tokens: usage?.prompt_tokens || 0,
        completion_tokens: usage?.completion_tokens || 0,
        total_tokens: usage?.total_tokens || 0,
        finish_reason,
      });
    } catch (e) {
      const msg = e?.name === "AbortError" ? "cancelled" : (e?.message || String(e));
      send({ type: "error", err: msg });
    } finally {
      clearTimeout(timer);
      _aiStreamCtrls.delete(id);
    }
  })();

  return { started: true };
});

ipcMain.handle("get_mvp_status", async () => ({
  gateway_online: await isGatewayOnline(),
  embedding_mode: readEmbeddingMode(),
}));

/**
 * Settings live in two places now:
 *   - userData/cloud-creds.json — credentials (cloud_sync_*, provider_*, embed_*)
 *   - server/.env — feature-flag prefs (EMBEDDING_MODE, AI_FEATURES_ENABLED, ...)
 *
 * The old local Python gateway on :8787 used to be the authoritative
 * store, but that whole `server/` tree was retired (see commit
 * `feat: rm server`). Probing it here was bad: if the user happened
 * to still have that process running, it would 500 on POST /settings
 * (its own DB.connect path was broken) and surface as a failed save
 * in the UI even though the file writes succeeded.
 *
 * Returning null skips straight to the .env fallback below.
 */
async function fetchLiveSettings() {
  return null;
}

// Per-user credential file. Contains BOTH the SmartNote Cloud
// connection (URL + workspace API key) AND any LLM provider keys
// (deepseek / openai for chat + embedding). All sensitive secrets
// live here so a dev's .env never leaks into a fresh user's app.
function _readUserCreds() {
  const empty = {
    cloud_sync_url: "",
    cloud_sync_api_key: "",
    cloud_sync_enabled: false,
    provider_base_url: "",
    provider_api_key: "",
    provider_chat_model: "",
    embed_base_url: "",
    embed_api_key: "",
    provider_embed_model: "",
  };
  try {
    const credsPath = path.join(app.getPath("userData"), "cloud-creds.json");
    if (!fs.existsSync(credsPath)) return empty;
    const raw = JSON.parse(fs.readFileSync(credsPath, "utf8"));
    return {
      cloud_sync_url: typeof raw.cloud_sync_url === "string" ? raw.cloud_sync_url : "",
      cloud_sync_api_key: typeof raw.cloud_sync_api_key === "string" ? raw.cloud_sync_api_key : "",
      cloud_sync_enabled: !!raw.cloud_sync_enabled,
      provider_base_url: typeof raw.provider_base_url === "string" ? raw.provider_base_url : "",
      provider_api_key: typeof raw.provider_api_key === "string" ? raw.provider_api_key : "",
      provider_chat_model: typeof raw.provider_chat_model === "string" ? raw.provider_chat_model : "",
      embed_base_url: typeof raw.embed_base_url === "string" ? raw.embed_base_url : "",
      embed_api_key: typeof raw.embed_api_key === "string" ? raw.embed_api_key : "",
      provider_embed_model: typeof raw.provider_embed_model === "string" ? raw.provider_embed_model : "",
    };
  } catch {
    return empty;
  }
}

ipcMain.handle("read_settings", async () => {
  // ALL credential fields (cloud_sync_*, provider_*, embed_*) come
  // exclusively from per-user storage. Non-cred settings (embedding
  // mode, hotkey, model name preferences) still flow through the
  // backend live-settings or .env fallback as before.
  const userCreds = _readUserCreds();

  const live = await fetchLiveSettings();
  if (live && typeof live === "object") {
    return {
      embedding_mode: live.embedding_mode ?? "local",
      ai_features_enabled: live.ai_features_enabled !== false,
      // Provider creds: per-user only. Default URL is the OpenAI
      // base — user must add their own key. Models default if user
      // hasn't picked one.
      provider_base_url: userCreds.provider_base_url || "https://api.openai.com/v1",
      provider_api_key: userCreds.provider_api_key,
      provider_chat_model: userCreds.provider_chat_model || "gpt-4o-mini",
      embed_base_url: userCreds.embed_base_url,
      embed_api_key: userCreds.embed_api_key,
      provider_embed_model: userCreds.provider_embed_model || "text-embedding-3-small",
      ingest_ai_enabled: !!live.ingest_ai_enabled,
      ingest_ai_model: live.ingest_ai_model ?? "",
      cloud_sync_enabled: userCreds.cloud_sync_enabled,
      cloud_sync_url: userCreds.cloud_sync_url,
      cloud_sync_api_key: userCreds.cloud_sync_api_key,
    };
  }
  // Backend offline — fall back to .env for non-cred settings.
  const envPath = envFile();
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const map = parseEnvFile(content);
  const ingestAi = map.get("INGEST_AI_ENABLED")?.toLowerCase() ?? "";
  const aiFeatures = map.get("AI_FEATURES_ENABLED")?.toLowerCase() ?? "true";
  return {
    embedding_mode: map.get("EMBEDDING_MODE") ?? "local",
    ai_features_enabled: !["false", "0", "no"].includes(aiFeatures),
    provider_base_url: userCreds.provider_base_url || "https://api.openai.com/v1",
    provider_api_key: userCreds.provider_api_key,
    provider_chat_model: userCreds.provider_chat_model || "gpt-4o-mini",
    embed_base_url: userCreds.embed_base_url,
    embed_api_key: userCreds.embed_api_key,
    provider_embed_model: userCreds.provider_embed_model || "text-embedding-3-small",
    ingest_ai_enabled: ["true", "1", "yes"].includes(ingestAi),
    ingest_ai_model: map.get("INGEST_AI_MODEL") ?? "",
    cloud_sync_enabled: userCreds.cloud_sync_enabled,
    cloud_sync_url: userCreds.cloud_sync_url,
    cloud_sync_api_key: userCreds.cloud_sync_api_key,
  };
});

ipcMain.handle("write_settings", async (_, { newSettings }) => {
  const envPath = envFile();
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const aiEnabledStr = newSettings.ingest_ai_enabled ? "true" : "false";
  const aiFeaturesStr = newSettings.ai_features_enabled === false ? "false" : "true";
  // ALL credentials persist PER-USER in userData/cloud-creds.json,
  // NOT to .env. A fresh install never inherits dev / shared
  // credentials — every user enters their own SmartNote Cloud URL +
  // workspace key AND their own LLM provider keys (deepseek / openai)
  // via Settings.
  try {
    const credsPath = path.join(app.getPath("userData"), "cloud-creds.json");
    fs.writeFileSync(credsPath, JSON.stringify({
      cloud_sync_enabled: !!newSettings.cloud_sync_enabled,
      cloud_sync_url: newSettings.cloud_sync_url ?? "",
      cloud_sync_api_key: newSettings.cloud_sync_api_key ?? "",
      provider_base_url: newSettings.provider_base_url ?? "",
      provider_api_key: newSettings.provider_api_key ?? "",
      provider_chat_model: newSettings.provider_chat_model ?? "",
      embed_base_url: newSettings.embed_base_url ?? "",
      embed_api_key: newSettings.embed_api_key ?? "",
      provider_embed_model: newSettings.provider_embed_model ?? "",
      saved_at: new Date().toISOString(),
    }, null, 2), "utf8");
    try { fs.chmodSync(credsPath, 0o600); } catch { /* best-effort */ }
  } catch (e) {
    console.warn("Failed to persist user creds:", e);
  }

  // Cloud sync URL / API key may have just changed. Bounce the
  // realtime WS so the new creds take effect immediately, instead
  // of users wondering why "No devices online" persists until they
  // restart Electron.
  import("./services/ws-presence.mjs").then((m) => m.restart()).catch(() => {});

  // .env now only carries non-cred prefs — feature flags, model
  // selection. Sensitive values (provider keys, cloud sync key)
  // never touch .env any more.
  const updates = new Map([
    ["EMBEDDING_MODE", newSettings.embedding_mode],
    ["AI_FEATURES_ENABLED", aiFeaturesStr],
    ["INGEST_AI_ENABLED", aiEnabledStr],
    ["INGEST_AI_MODEL", newSettings.ingest_ai_model],
    // PROVIDER_* / EMBED_* / CLOUD_SYNC_* live in userData/cloud-creds.json
  ]);
  const writtenKeys = new Set();
  const lines = [];
  for (const line of existing.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) {
      const i = t.indexOf("=");
      if (i > 0) {
        const key = t.slice(0, i).trim();
        if (updates.has(key)) {
          lines.push(`${key}=${updates.get(key)}`);
          writtenKeys.add(key);
          continue;
        }
      }
    }
    lines.push(line);
  }
  for (const [key, val] of updates) {
    if (!writtenKeys.has(key)) lines.push(`${key}=${val}`);
  }
  fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf8");

  // Old hot-apply POST to :8787/settings was removed alongside the
  // retired Python gateway. Credentials persist via cloud-creds.json
  // (written above) and feature-flag prefs land in server/.env (also
  // written above). Both take effect on next read — no live RPC step.
  return { ok: true, output: "Settings saved." };
});

ipcMain.handle("dialog_open_raw", async () => {
  const r = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ["openFile"],
    filters: [{ name: "Raw Files", extensions: ["txt", "md", "rtf"] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle("dialog_save_note", async () => {
  const r = await dialog.showSaveDialog(mainWindow ?? undefined, {
    defaultPath: "note.md",
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath;
});

ipcMain.handle("clipboard_read_text", async () => clipboard.readText() || null);

ipcMain.handle("get_ingest_status", async () => ({
  noteIngestRunning,
  wikiIngestRunning,
}));

ipcMain.handle("write_file", async (_, { path: filePath, content }) => {
  fs.writeFileSync(filePath, content, "utf8");
  return { ok: true };
});

/* Lightweight notes-workspace helpers — used by the multi-tab Note
 * page. The notes path is whatever the user is currently editing;
 * for the file tree we just list .md/.txt siblings in the same dir.
 * No symlink chase / recursion / FS watcher — keep it cheap. */
ipcMain.handle("note:list_dir", async (_, { dir }) => {
  if (!dir || typeof dir !== "string") return { ok: false, files: [] };
  try {
    const stat = fs.statSync(dir);
    const root = stat.isFile() ? path.dirname(dir) : dir;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && /\.(md|txt|markdown)$/i.test(e.name))
      .map((e) => ({
        name: e.name,
        path: path.join(root, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, root, files };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), files: [] };
  }
});

ipcMain.handle("note:create_new", async (_, { dir, name }) => {
  if (!dir || !name) return { ok: false, error: "dir and name required" };
  let filename = String(name).trim();
  if (!filename) return { ok: false, error: "name required" };
  if (!/\.(md|txt|markdown)$/i.test(filename)) filename += ".md";
  // Prevent path traversal — accept basename only.
  filename = path.basename(filename);
  const full = path.join(dir, filename);
  if (fs.existsSync(full)) return { ok: false, error: "file already exists", path: full };
  try {
    fs.writeFileSync(full, "", "utf8");
    return { ok: true, path: full };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("note:pick_dir", async () => {
  const r = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle("shell_open_path", async (_, { path: target }) => {
  const err = await shell.openPath(target);
  if (err) throw new Error(err);
});

// ── Global Hotkey: Clipboard → Paste to raw → Save → Incremental ingest ──

// Hotkey config — lives in userData so saving a hotkey doesn't
// silently recreate the legacy `<repo>/server/` directory every
// time the app boots. See migrateLegacyServerConfig().
const HOTKEY_CONFIG_FILE = path.join(userDataPrefsDir(), "hotkey.json");
// Spotlight-style global hotkey. ⌘K matches the convention of every
// modern command palette (Linear, Raycast, GitHub, Slack), and is
// the most muscle-memory'd shortcut for "search anything from
// anywhere". The previous Cmd+Shift+V → paste-clipboard-to-raw flow
// has been retired — that affordance now lives inside Note as part
// of the editor, not as a global hotkey.
let currentHotkey = "CommandOrControl+K";

function loadHotkeyConfig() {
  try {
    if (fs.existsSync(HOTKEY_CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(HOTKEY_CONFIG_FILE, "utf8"));
      if (data.hotkey) {
        // Migrate the legacy default — Cmd+Shift+V was the old paste-
        // to-raw shortcut, which has been retired in favor of the ⌘K
        // Spotlight palette. If the user customized to something else,
        // honor it; only sweep the literal old default.
        if (data.hotkey === "CommandOrControl+Shift+V") {
          currentHotkey = "CommandOrControl+K";
          saveHotkeyConfig(currentHotkey);
        } else {
          currentHotkey = data.hotkey;
        }
      }
    }
  } catch {}
}

function saveHotkeyConfig(hotkey) {
  const dir = path.dirname(HOTKEY_CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HOTKEY_CONFIG_FILE, JSON.stringify({ hotkey }, null, 2), "utf8");
}

function getRawPathFromPrefs() {
  // Read from the renderer's localStorage isn't possible here,
  // so we read from a shared prefs file
  const prefsFile = path.join(userDataPrefsDir(), "prefs.json");
  try {
    if (fs.existsSync(prefsFile)) {
      const data = JSON.parse(fs.readFileSync(prefsFile, "utf8"));
      return data.rawPath || null;
    }
  } catch {}
  return null;
}

function pasteClipboardToRaw() {
  const rawPath = getRawPathFromPrefs();
  if (!rawPath) {
    new Notification({ title: "SmartNote", body: "No raw file configured. Open Raw Input to set one." }).show();
    return;
  }

  const text = clipboard.readText();
  if (!text || !text.trim()) {
    new Notification({ title: "SmartNote", body: "Clipboard is empty." }).show();
    return;
  }

  // Check file type compatibility (text-based files only)
  const ext = path.extname(rawPath).toLowerCase();
  const textExts = [".md", ".txt", ".rtf", ".org", ".rst", ""];
  if (!textExts.includes(ext)) {
    new Notification({ title: "SmartNote", body: `File type ${ext} not supported for paste.` }).show();
    return;
  }

  try {
    const dir = path.dirname(rawPath);
    fs.mkdirSync(dir, { recursive: true });
    // Append to bottom — preserves line numbers for segment jumps
    const existing = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, "utf8") : "";
    const sep = existing.length > 0 && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
    fs.writeFileSync(rawPath, `${existing}${sep}${text.trim()}\n`, "utf8");

    new Notification({ title: "SmartNote", body: `Pasted ${text.trim().split("\n").length} lines to raw file.` }).show();

    // Notify renderer to trigger incremental ingest
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("hotkey:pasted", { rawPath, lineCount: text.trim().split("\n").length });
    }
  } catch (err) {
    new Notification({ title: "SmartNote", body: `Paste failed: ${err.message}` }).show();
  }
}

/* Spotlight is a SEPARATE window — frameless, transparent, always
 * on top, doesn't open or focus the main app window. Click a result
 * inside Spotlight → main window comes up navigated to that source.
 *
 * The Spotlight renderer lives at the same Vite URL with a `?spotlight=1`
 * query param so main.tsx can branch and mount only the palette
 * component (no rail, no canvas — just the floating panel).
 *
 * Lazy-created on first ⌘K, then reused on subsequent presses. Hidden
 * on blur or Esc; never destroyed during the app lifetime. */
let spotlightWindow = null;

/* Build the Spotlight window ONCE at app startup (after mainWindow)
 * and keep it alive forever. ⌘K only toggles visibility — no
 * loadURL, no React mount, no animation churn. First press is just
 * as fast as every subsequent press.
 *
 * The macOS-side hazards (dock icon revert, alwaysOnTop residue
 * eating clicks) are addressed at the show/hide boundary rather
 * than by destroy: see openSpotlight / closeSpotlight. */
function createSpotlightWindow() {
  if (spotlightWindow && !spotlightWindow.isDestroyed()) return spotlightWindow;
  spotlightWindow = new BrowserWindow({
    width: 720,
    height: 480,
    frame: false,
    transparent: true,
    // Start NOT alwaysOnTop. Only flip the bit when shown so the
    // dormant window can't intercept clicks or steal activation.
    alwaysOnTop: false,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    // No native shadow — the CSS panel handles rounded corners and
    // we don't want a double-shadow look (native + box-shadow). The
    // CSS box-shadow stays since it scales with our radius.
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    const u = devUrl.endsWith("/") ? devUrl.slice(0, -1) : devUrl;
    spotlightWindow.loadURL(`${u}/?spotlight=1`).catch(() => {});
  } else {
    const indexHtml = path.join(__dirname, "..", "dist", "index.html");
    spotlightWindow.loadFile(indexHtml, { query: { spotlight: "1" } }).catch(() => {});
  }

  // Pre-warm: when the renderer finishes its first paint, this
  // resolves and subsequent show()s have no first-paint cost.
  spotlightWindow.webContents.once("did-finish-load", () => {
    if (!spotlightWindow || spotlightWindow.isDestroyed()) return;
    // Force a cycle of show+hide to make Cocoa allocate the window
    // surface ahead of time. show() with focus pulled to mainWindow
    // immediately so the user never sees the warm-up frame.
    try {
      spotlightWindow.showInactive();
      setImmediate(() => {
        if (spotlightWindow && !spotlightWindow.isDestroyed()) {
          spotlightWindow.hide();
        }
      });
    } catch {}
  });

  spotlightWindow.on("blur", () => {
    // Only hide if currently visible AND the user hasn't just
    // clicked one of our action buttons (which fires its own
    // close path). isVisible guard catches both.
    if (spotlightWindow && !spotlightWindow.isDestroyed() && spotlightWindow.isVisible()) {
      closeSpotlight();
    }
  });

  spotlightWindow.on("closed", () => { spotlightWindow = null; });
  return spotlightWindow;
}

function ensureSpotlightWindow() {
  if (!spotlightWindow || spotlightWindow.isDestroyed()) {
    return createSpotlightWindow();
  }
  return spotlightWindow;
}

function openSpotlight() {
  const w = ensureSpotlightWindow();
  // Flip alwaysOnTop ON only while shown — otherwise the dormant
  // hidden window can interfere with the main window's activation
  // (dock icon, click-through layer).
  w.setAlwaysOnTop(true);
  w.center();
  w.show();
  w.focus();
  try { w.webContents.send("smartnote:spotlight-open"); } catch {}
}

/* Hide (don't destroy) for instant re-open. The window-server side
 * effects we used to fight by destroying — dock-icon revert,
 * alwaysOnTop residue, activation-cycle confusion — are addressed
 * by:
 *   1. Toggling alwaysOnTop OFF when hiding (kills the invisible
 *      click-intercept layer).
 *   2. Re-applying the dock icon defensively (macOS sometimes
 *      reverts it after a transparent-window state change).
 */
function closeSpotlight() {
  if (!spotlightWindow || spotlightWindow.isDestroyed()) return;
  try {
    spotlightWindow.setAlwaysOnTop(false);
    if (spotlightWindow.isVisible()) spotlightWindow.hide();
  } catch {}
  applyDockIcon();
}

/* Spotlight → main: a result was picked. Bring up the main window
 * navigated to the selected source. Spotlight hides itself first
 * so the focus transfer feels instant.
 *
 * macOS quirks worked around here:
 *   - .show() on a hidden, non-foreground window doesn't always
 *     raise it above the dock — call app.show() too.
 *   - moveTop() forces the window above the spotlight's previous
 *     "floating" alwaysOnTop layer in case macOS still has it
 *     ranked above us mid-transition.
 *   - Send the navigation IPC AFTER the window is visible so the
 *     renderer's listener (which only mounts once App is up) has
 *     a chance to catch it. The window's already alive in our
 *     case so this is belt-and-suspenders.
 */
ipcMain.handle("spotlight:pick", (_e, { channel }) => {
  closeSpotlight();
  // Re-create main window if user closed it — they pressed ⌘K
  // expecting SmartNote to come back, not silently no-op.
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    try { mainWindow.webContents.send("smartnote:open-source", { channel }); } catch {}
  }
  return { ok: true };
});

ipcMain.handle("spotlight:close", () => {
  closeSpotlight();
  return { ok: true };
});

function registerHotkey() {
  globalShortcut.unregisterAll();
  try {
    const ok = globalShortcut.register(currentHotkey, openSpotlight);
    if (!ok) console.warn(`[hotkey] Failed to register ${currentHotkey}`);
    else console.log(`[hotkey] Registered: ${currentHotkey}`);
  } catch (err) {
    console.warn(`[hotkey] Registration error: ${err.message}`);
  }
}

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// IPC: get/set hotkey + save prefs for raw path
ipcMain.handle("get_hotkey", () => currentHotkey);

ipcMain.handle("set_hotkey", async (_, { hotkey }) => {
  currentHotkey = hotkey;
  saveHotkeyConfig(hotkey);
  registerHotkey();
  return { ok: true, hotkey: currentHotkey };
});

ipcMain.handle("save_raw_path_for_hotkey", async (_, { rawPath }) => {
  const prefsFile = path.join(userDataPrefsDir(), "prefs.json");
  const dir = path.dirname(prefsFile);
  fs.mkdirSync(dir, { recursive: true });
  let prefs = {};
  try {
    if (fs.existsSync(prefsFile)) prefs = JSON.parse(fs.readFileSync(prefsFile, "utf8"));
  } catch {}
  prefs.rawPath = rawPath;
  fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2), "utf8");
});

// ── Cloud stack lifecycle (docker compose) ─────────────────────────
//
// The cloud stack is opt-in and lives at cloud/infra/docker-compose.yml.
// Users reported it "disappearing" — usually means:
//   1. docker compose down was run (by them or by our test scripts)
//   2. Docker Desktop's resource saver paused containers
//   3. Host rebooted; Docker Desktop restarted but containers that were
//      explicitly stopped don't come back on their own.
//
// These handlers let the UI detect + restart the stack without the user
// dropping to a terminal. Nothing touches user data — `up -d` is a no-op
// when the stack is already healthy.

function runDockerCompose(args) {
  return new Promise((resolve) => {
    const cwd = cloudInfraRoot();
    if (!fs.existsSync(path.join(cwd, "docker-compose.yml"))) {
      resolve({ ok: false, error: "docker-compose.yml not found at " + cwd });
      return;
    }
    // Seed .env if missing — compose defaults reference it.
    const envFile = path.join(cwd, ".env");
    if (!fs.existsSync(envFile)) {
      const example = path.join(cwd, ".env.example");
      if (fs.existsSync(example)) {
        try { fs.copyFileSync(example, envFile); } catch { /* best effort */ }
      }
    }
    const proc = spawn("docker", ["compose", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => {
      resolve({ ok: false, error: `docker not found: ${err.message}. Is Docker Desktop installed and running?` });
    });
    proc.on("close", (code) => {
      if (code === 0) resolve({ ok: true, output: stdout || stderr });
      else resolve({ ok: false, error: stderr || stdout || `docker compose exited with ${code}` });
    });
  });
}

ipcMain.handle("cloud_stack_status", async () => {
  const r = await runDockerCompose(["ps", "--format", "json"]);
  if (!r.ok) return { ok: false, error: r.error, services: [] };
  // `docker compose ps --format json` streams one JSON object per line.
  const services = [];
  for (const line of (r.output || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      services.push({
        name: obj.Name || obj.Service,
        service: obj.Service,
        state: obj.State,          // "running" | "exited" | ...
        status: obj.Status,        // human-readable "Up 3 hours (healthy)"
        health: obj.Health || "",
      });
    } catch { /* skip malformed line */ }
  }
  return { ok: true, services };
});

ipcMain.handle("cloud_stack_start", async (_, payload = {}) => {
  // `up -d` without --build is the fast path: Docker only builds when
  // no image exists yet (first launch after a fresh clone) or when the
  // Dockerfile / sources changed. --build forces a rebuild every time
  // which reruns pip install etc. (5+ min on a slow link) — we only
  // want that when the user explicitly asks via the "Rebuild" action.
  const args = ["up", "-d"];
  if (payload && payload.rebuild) args.push("--build");
  return runDockerCompose(args);
});

ipcMain.handle("cloud_stack_stop", async () => {
  // `stop` (not `down`) preserves the network + volumes so a later
  // `start` is instant. If the user really wants to wipe, they can
  // run `docker compose down -v` manually.
  return runDockerCompose(["stop"]);
});

// ── MCP config installer ───────────────────────────────────────────
//
// Writes SmartNote Cloud's MCP server entry into the target agent's
// config file (Claude Code user-scope `~/.claude.json`, Cursor
// user-scope `~/.cursor/mcp.json`, OpenCode `~/.config/opencode/opencode.json`).
//
// We intentionally merge into the existing config rather than
// overwrite — other MCP servers the user registered must survive.
// On conflict (entry with our reserved name already exists), the
// handler returns `{ ok: true, replaced: true }` so the UI can show
// "Updated existing config" rather than "Added new".

function agentConfigPath(agent) {
  const home = os.homedir();
  switch (agent) {
    case "claude-code":
      // Claude Code stores user-scope MCP in ~/.claude.json (same
      // file that holds other CLI settings). We only touch the
      // mcpServers key.
      return path.join(home, ".claude.json");
    case "cursor":
      return path.join(home, ".cursor", "mcp.json");
    case "opencode":
      return path.join(home, ".config", "opencode", "opencode.json");
    default:
      return null;
  }
}

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    // File exists but isn't valid JSON — don't clobber it.
    return { __malformed: true };
  }
}

function writeJsonPretty(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Backup existing before write so a merge bug can't lose the
  // other MCP entries the user registered. One rolling `.bak` is
  // enough; we're not versioning here.
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, file + ".bak"); } catch { /* best effort */ }
  }
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/**
 * Compose the MCP server entry for a given agent.
 *
 * Claude Code & Cursor speak streamable-HTTP directly, so we emit
 * the remote-URL form. OpenCode also supports it as `type: "remote"`.
 * Either way the URL + Authorization header are the only required
 * bits — no local Python process, no absolute paths to a venv.
 */
function buildMcpEntry(agent, url, apiKey) {
  const endpoint = url.replace(/\/$/, "") + "/mcp/";
  const headers = { Authorization: `Bearer ${apiKey}` };
  switch (agent) {
    case "opencode":
      return {
        type: "remote",
        url: endpoint,
        headers,
        enabled: true,
      };
    case "claude-code":
      // Claude Code's MCP schema requires an explicit `type`. Without
      // it the runtime emits "Does not adhere to MCP server
      // configuration schema" and refuses to load the server. Use
      // `http` for streamable-HTTP endpoints (the cloud's transport).
      return { type: "http", url: endpoint, headers };
    case "cursor":
      // Cursor accepts the bare {url, headers} form but `type: "http"`
      // is also valid and self-documents. Match Claude Code for
      // consistency across agents.
      return { type: "http", url: endpoint, headers };
    default:
      return { type: "http", url: endpoint, headers };
  }
}

ipcMain.handle("mcp_installer_status", async () => {
  // Report which configs already contain our entry so the UI can
  // flip the button from "Install" to "Reinstall" / "Already set".
  const agents = ["claude-code", "cursor", "opencode"];
  const out = {};
  for (const agent of agents) {
    const file = agentConfigPath(agent);
    if (!file) { out[agent] = { available: false }; continue; }
    const cfg = readJsonSafe(file);
    const installed = Boolean(
      cfg && !cfg.__malformed && (cfg.mcpServers || cfg.mcp)?.["smartnote-cloud"]
    );
    out[agent] = {
      available: true,
      path: file,
      exists: fs.existsSync(file),
      installed,
      malformed: Boolean(cfg && cfg.__malformed),
    };
  }
  return { ok: true, agents: out };
});

ipcMain.handle("mcp_installer_install", async (_, { agent, url, apiKey }) => {
  if (!agent || !url || !apiKey) {
    return { ok: false, error: "agent, url, and apiKey are required" };
  }
  const file = agentConfigPath(agent);
  if (!file) return { ok: false, error: `unknown agent: ${agent}` };

  const existing = readJsonSafe(file) ?? {};
  if (existing.__malformed) {
    return { ok: false, error: `${file} exists but is not valid JSON. Fix or delete it, then try again.` };
  }

  const entry = buildMcpEntry(agent, url, apiKey);
  // OpenCode's config uses `mcp`, the others use `mcpServers`. Both
  // are flat dicts keyed by server name.
  const key = agent === "opencode" ? "mcp" : "mcpServers";
  const next = { ...existing };
  const prior = { ...(next[key] || {}) };
  const replaced = Boolean(prior["smartnote-cloud"]);
  prior["smartnote-cloud"] = entry;
  next[key] = prior;

  try {
    writeJsonPretty(file, next);
  } catch (e) {
    return { ok: false, error: `failed to write ${file}: ${e.message}` };
  }
  return { ok: true, path: file, replaced };
});

ipcMain.handle("mcp_installer_uninstall", async (_, { agent }) => {
  const file = agentConfigPath(agent);
  if (!file) return { ok: false, error: `unknown agent: ${agent}` };
  const existing = readJsonSafe(file);
  if (!existing || existing.__malformed) return { ok: false, error: "config not found or malformed" };
  const key = agent === "opencode" ? "mcp" : "mcpServers";
  if (!existing[key] || !existing[key]["smartnote-cloud"]) {
    return { ok: true, removed: false };
  }
  const next = { ...existing, [key]: { ...existing[key] } };
  delete next[key]["smartnote-cloud"];
  try {
    writeJsonPretty(file, next);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, removed: true };
});

// ── First-run sample note installer ────────────────────────────────
//
// Users report: opening the app the first time, there's no signal
// what to do. The sample note bypasses "pick a file" friction — we
// copy a curated sample into the user's Documents folder and return
// the path so the renderer can immediately open it.

function sampleSourcePath() {
  // `sample-note.md` ships inside the electron directory so it's
  // bundled with the app.
  return path.join(__dirname, "sample-note.md");
}

function userSampleTargetPath() {
  // Documents folder on macOS / Linux / Windows. `home` fallback
  // covers esoteric setups.
  const home = os.homedir();
  const docs = path.join(home, "Documents");
  const dir = fs.existsSync(docs) ? docs : home;
  return path.join(dir, "smartnote-sample.md");
}

ipcMain.handle("first_run_state", async () => {
  // "Has this user ever had a raw_path set?" is the cheapest signal
  // for first-run. If prefs.json has rawPath, they've used the app
  // before, so we don't foist a sample on them again.
  const prefsFile = path.join(userDataPrefsDir(), "prefs.json");
  let isFirstRun = true;
  try {
    if (fs.existsSync(prefsFile)) {
      const prefs = JSON.parse(fs.readFileSync(prefsFile, "utf8"));
      if (prefs && typeof prefs.rawPath === "string" && prefs.rawPath.trim()) {
        isFirstRun = false;
      }
    }
  } catch { /* treat unreadable prefs as first-run */ }
  const target = userSampleTargetPath();
  return {
    isFirstRun,
    sampleAlreadyInstalled: fs.existsSync(target),
    sampleTargetPath: target,
  };
});

ipcMain.handle("install_sample_note", async () => {
  const source = sampleSourcePath();
  if (!fs.existsSync(source)) {
    return { ok: false, error: `sample file missing at ${source}` };
  }
  const target = userSampleTargetPath();
  try {
    // Don't overwrite an existing sample — the user may have edited it.
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, path: target };
});
