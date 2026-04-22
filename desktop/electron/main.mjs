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

/** Server root: `server/` directory containing the Python backend. */
function serverRoot() {
  if (process.env.SERVER_ROOT) return path.resolve(process.env.SERVER_ROOT);
  return path.join(__dirname, "..", "..", "server");
}

/** Cloud infra root — where docker-compose.yml lives. */
function cloudInfraRoot() {
  if (process.env.CLOUD_INFRA_ROOT) return path.resolve(process.env.CLOUD_INFRA_ROOT);
  return path.join(__dirname, "..", "..", "cloud", "infra");
}

function pythonBin() {
  const venv = path.join(serverRoot(), ".venv", "bin", "python");
  if (fs.existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

function readEmbeddingMode() {
  const envPath = path.join(serverRoot(), ".env");
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
  const proc = spawn(pythonBin(), args, { cwd: serverRoot() });
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
    cwd: serverRoot(),
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

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    const u = devUrl.endsWith("/") ? devUrl.slice(0, -1) : devUrl;
    mainWindow.loadURL(u).catch((err) => console.error("[electron] loadURL failed", err));
  } else {
    const indexHtml = path.join(__dirname, "..", "dist", "index.html");
    mainWindow.loadFile(indexHtml).catch((err) => console.error("[electron] loadFile failed", err));
  }
}

app.whenReady().then(() => {
  // Set dock icon (macOS dev mode)
  if (process.platform === "darwin" && app.dock) {
    const iconPath = path.join(__dirname, "..", "public", "icon.png");
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }
  createWindow();
  loadHotkeyConfig();
  registerHotkey();
  connectIngestSse();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
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
  const proc = spawn(pythonBin(), args, { cwd: serverRoot(), stdio: ["ignore", "pipe", "pipe"] });

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
  const proc = spawn(pythonBin(), args, { cwd: serverRoot(), stdio: ["ignore", "pipe", "pipe"] });

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

ipcMain.handle("get_mvp_status", async () => ({
  gateway_online: await isGatewayOnline(),
  embedding_mode: readEmbeddingMode(),
}));

/**
 * Read settings with DB-over-.env precedence.
 *
 * The backend owns an `app_settings` table that's the authoritative store
 * (edits made via the inline "Save credentials" button, MCP tools, or any
 * POST /settings call land there directly — never touch .env). The .env
 * file is just the bootstrap fallback for when the backend isn't running.
 *
 * So on read we try GET /settings first, only fall back to .env parsing
 * if the backend is unreachable. This fixes the "I saved Cloud Sync creds
 * but they're gone next launch" bug, which used to happen because the
 * old read path never consulted the DB.
 */
async function fetchLiveSettings() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: 8787, path: "/settings", method: "GET", timeout: 1000 },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { buf += c; });
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(buf)); } catch { resolve(null); }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

ipcMain.handle("read_settings", async () => {
  const live = await fetchLiveSettings();
  if (live && typeof live === "object") {
    // Backend is the source of truth. Coerce booleans since the backend
    // returns them typed already but we defensively normalize.
    return {
      embedding_mode: live.embedding_mode ?? "local",
      ai_features_enabled: live.ai_features_enabled !== false,
      provider_base_url: live.provider_base_url ?? "https://api.openai.com/v1",
      provider_api_key: live.provider_api_key ?? "",
      provider_chat_model: live.provider_chat_model ?? "gpt-4o-mini",
      embed_base_url: live.embed_base_url ?? "",
      embed_api_key: live.embed_api_key ?? "",
      provider_embed_model: live.provider_embed_model ?? "text-embedding-3-small",
      ingest_ai_enabled: !!live.ingest_ai_enabled,
      ingest_ai_model: live.ingest_ai_model ?? "",
      cloud_sync_enabled: !!live.cloud_sync_enabled,
      cloud_sync_url: live.cloud_sync_url ?? "",
      cloud_sync_api_key: live.cloud_sync_api_key ?? "",
    };
  }
  // Backend offline — fall back to .env. Covers first-launch and the case
  // where the user opens Settings before the gateway has started.
  const envPath = path.join(serverRoot(), ".env");
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const map = parseEnvFile(content);
  const ingestAi = map.get("INGEST_AI_ENABLED")?.toLowerCase() ?? "";
  const aiFeatures = map.get("AI_FEATURES_ENABLED")?.toLowerCase() ?? "true";
  const cloudSyncEnabled = map.get("CLOUD_SYNC_ENABLED")?.toLowerCase() ?? "";
  return {
    embedding_mode: map.get("EMBEDDING_MODE") ?? "local",
    ai_features_enabled: !["false", "0", "no"].includes(aiFeatures),
    provider_base_url: map.get("PROVIDER_BASE_URL") ?? "https://api.openai.com/v1",
    provider_api_key: map.get("PROVIDER_API_KEY") ?? "",
    provider_chat_model: map.get("PROVIDER_CHAT_MODEL") ?? "gpt-4o-mini",
    embed_base_url: map.get("EMBED_BASE_URL") ?? "",
    embed_api_key: map.get("EMBED_API_KEY") ?? "",
    provider_embed_model: map.get("PROVIDER_EMBED_MODEL") ?? "text-embedding-3-small",
    ingest_ai_enabled: ["true", "1", "yes"].includes(ingestAi),
    ingest_ai_model: map.get("INGEST_AI_MODEL") ?? "",
    cloud_sync_enabled: ["true", "1", "yes"].includes(cloudSyncEnabled),
    cloud_sync_url: map.get("CLOUD_SYNC_URL") ?? "",
    cloud_sync_api_key: map.get("CLOUD_SYNC_API_KEY") ?? "",
  };
});

ipcMain.handle("write_settings", async (_, { newSettings }) => {
  const envPath = path.join(serverRoot(), ".env");
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const aiEnabledStr = newSettings.ingest_ai_enabled ? "true" : "false";
  const aiFeaturesStr = newSettings.ai_features_enabled === false ? "false" : "true";
  const cloudSyncEnabledStr = newSettings.cloud_sync_enabled ? "true" : "false";
  const updates = new Map([
    ["EMBEDDING_MODE", newSettings.embedding_mode],
    ["AI_FEATURES_ENABLED", aiFeaturesStr],
    ["PROVIDER_BASE_URL", newSettings.provider_base_url],
    ["PROVIDER_API_KEY", newSettings.provider_api_key],
    ["PROVIDER_CHAT_MODEL", newSettings.provider_chat_model],
    ["EMBED_BASE_URL", newSettings.embed_base_url ?? ""],
    ["EMBED_API_KEY", newSettings.embed_api_key ?? ""],
    ["PROVIDER_EMBED_MODEL", newSettings.provider_embed_model],
    ["INGEST_AI_ENABLED", aiEnabledStr],
    ["INGEST_AI_MODEL", newSettings.ingest_ai_model],
    // Cloud sync — mirrored to .env so a restart with the backend down
    // still boots with the right config.
    ["CLOUD_SYNC_ENABLED", cloudSyncEnabledStr],
    ["CLOUD_SYNC_URL", newSettings.cloud_sync_url ?? ""],
    ["CLOUD_SYNC_API_KEY", newSettings.cloud_sync_api_key ?? ""],
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

  // Hot-apply to the running backend via /settings. Backend persists values in
  // the `app_settings` DB table and updates the Settings singleton in place,
  // so changes take effect without restart. If the gateway is offline, the
  // .env write above will be picked up on next backend start.
  let applied = false;
  try {
    const body = JSON.stringify({
      embedding_mode: newSettings.embedding_mode,
      ai_features_enabled: newSettings.ai_features_enabled !== false,
      provider_base_url: newSettings.provider_base_url,
      provider_api_key: newSettings.provider_api_key,
      provider_chat_model: newSettings.provider_chat_model,
      embed_base_url: newSettings.embed_base_url ?? "",
      embed_api_key: newSettings.embed_api_key ?? "",
      provider_embed_model: newSettings.provider_embed_model,
      ingest_ai_enabled: !!newSettings.ingest_ai_enabled,
      ingest_ai_model: newSettings.ingest_ai_model,
      cloud_sync_enabled: !!newSettings.cloud_sync_enabled,
      cloud_sync_url: newSettings.cloud_sync_url ?? "",
      cloud_sync_api_key: newSettings.cloud_sync_api_key ?? "",
    });
    applied = await new Promise((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: 8787,
          path: "/settings",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: 1500,
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve(res.statusCode === 200));
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    });
  } catch { /* ignore */ }

  return {
    ok: true,
    output: applied
      ? "Settings saved and applied live."
      : "Settings saved. Backend is offline — changes will apply on next start.",
  };
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

ipcMain.handle("shell_open_path", async (_, { path: target }) => {
  const err = await shell.openPath(target);
  if (err) throw new Error(err);
});

// ── Global Hotkey: Clipboard → Paste to raw → Save → Incremental ingest ──

const HOTKEY_CONFIG_FILE = path.join(serverRoot(), "data", "hotkey.json");
let currentHotkey = "CommandOrControl+Shift+V";

function loadHotkeyConfig() {
  try {
    if (fs.existsSync(HOTKEY_CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(HOTKEY_CONFIG_FILE, "utf8"));
      if (data.hotkey) currentHotkey = data.hotkey;
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
  const prefsFile = path.join(serverRoot(), "data", "prefs.json");
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

function registerHotkey() {
  globalShortcut.unregisterAll();
  try {
    const ok = globalShortcut.register(currentHotkey, pasteClipboardToRaw);
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
  const prefsFile = path.join(serverRoot(), "data", "prefs.json");
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
    default:
      // Claude Code & Cursor share the same shape.
      return { url: endpoint, headers };
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
  const prefsFile = path.join(serverRoot(), "data", "prefs.json");
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
