import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from "electron";
import electron from "electron";
const { globalShortcut, Notification } = electron;
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import net from "net";
import { spawn } from "child_process";
import readline from "readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root: `mvp/` (parent of `desktop/`). Override with MVP_ROOT when packaged. */
function appRoot() {
  if (process.env.MVP_ROOT) return path.resolve(process.env.MVP_ROOT);
  return path.join(__dirname, "..", "..");
}

function pythonBin() {
  const venv = path.join(appRoot(), ".venv", "bin", "python");
  if (fs.existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

function readEmbeddingMode() {
  const envPath = path.join(appRoot(), ".env");
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
  const args = ["-m", "app.cli", "ingest", "--raw", rawPath, "--note", notePath];
  if (doReset) args.push("--reset");
  const proc = spawn(pythonBin(), args, { cwd: appRoot() });
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

function emitIngest(win, payload) {
  if (win && !win.isDestroyed()) win.webContents.send("ingest:status", payload);
}

function ingestRawAsync(win, rawPath, notePath, doReset) {
  emitIngest(win, {
    status: "started",
    step: "parse",
    current: 0,
    total: 0,
    elapsed_ms: 0,
    message: doReset ? "Rebuilding knowledge base..." : "Ingesting new content...",
  });

  const args = ["-m", "app.cli", "ingest", "--raw", rawPath, "--note", notePath];
  if (doReset) args.push("--reset");
  const proc = spawn(pythonBin(), args, {
    cwd: appRoot(),
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
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#faf9f7",
    webPreferences: {
      // CommonJS preload：ESM preload 在部分环境下会加载失败 → 白屏/黑屏且 window.desktop 不存在
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox 与 ESM preload 组合曾导致 preload 不执行；桌面端关闭 sandbox 更稳
      sandbox: false,
    },
  });

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
  createWindow();
  loadHotkeyConfig();
  registerHotkey();
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

ipcMain.handle("ingest_raw_async", async (event, { rawPath, notePath, reset }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  ingestRawAsync(win, rawPath, notePath, !!reset);
});

ipcMain.handle("append_text_to_raw", async (_, { rawPath, text }) => {
  const p = path.resolve(rawPath);
  const parent = path.dirname(p);
  fs.mkdirSync(parent, { recursive: true });
  fs.appendFileSync(p, text, "utf8");
  fs.appendFileSync(p, "\n", "utf8");
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

ipcMain.handle("read_text_file", async (_, { path: filePath }) => {
  const content = fs.readFileSync(filePath, "utf8");
  const preview = content.slice(0, 4000);
  return { ok: true, output: preview };
});

ipcMain.handle("get_mvp_status", async () => ({
  gateway_online: await isGatewayOnline(),
  embedding_mode: readEmbeddingMode(),
}));

ipcMain.handle("read_settings", async () => {
  const envPath = path.join(appRoot(), ".env");
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const map = parseEnvFile(content);
  const ingestAi = map.get("INGEST_AI_ENABLED")?.toLowerCase() ?? "";
  return {
    embedding_mode: map.get("EMBEDDING_MODE") ?? "local",
    provider_base_url: map.get("PROVIDER_BASE_URL") ?? "https://api.openai.com/v1",
    provider_api_key: map.get("PROVIDER_API_KEY") ?? "",
    provider_chat_model: map.get("PROVIDER_CHAT_MODEL") ?? "gpt-4o-mini",
    provider_embed_model: map.get("PROVIDER_EMBED_MODEL") ?? "text-embedding-3-small",
    ingest_ai_enabled: ["true", "1", "yes"].includes(ingestAi),
    ingest_ai_model: map.get("INGEST_AI_MODEL") ?? "",
  };
});

ipcMain.handle("write_settings", async (_, { newSettings }) => {
  const envPath = path.join(appRoot(), ".env");
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const aiEnabledStr = newSettings.ingest_ai_enabled ? "true" : "false";
  const updates = new Map([
    ["EMBEDDING_MODE", newSettings.embedding_mode],
    ["PROVIDER_BASE_URL", newSettings.provider_base_url],
    ["PROVIDER_API_KEY", newSettings.provider_api_key],
    ["PROVIDER_CHAT_MODEL", newSettings.provider_chat_model],
    ["PROVIDER_EMBED_MODEL", newSettings.provider_embed_model],
    ["INGEST_AI_ENABLED", aiEnabledStr],
    ["INGEST_AI_MODEL", newSettings.ingest_ai_model],
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
  return { ok: true, output: "Settings saved. Restart the backend for changes to take effect." };
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

ipcMain.handle("write_file", async (_, { path: filePath, content }) => {
  fs.writeFileSync(filePath, content, "utf8");
  return { ok: true };
});

ipcMain.handle("shell_open_path", async (_, { path: target }) => {
  const err = await shell.openPath(target);
  if (err) throw new Error(err);
});

// ── Global Hotkey: Clipboard → Paste to raw → Save → Incremental ingest ──

const HOTKEY_CONFIG_FILE = path.join(appRoot(), "data", "hotkey.json");
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
  const prefsFile = path.join(appRoot(), "data", "prefs.json");
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
    new Notification({ title: "IntelliNote", body: "No raw file configured. Open Raw Input to set one." }).show();
    return;
  }

  const text = clipboard.readText();
  if (!text || !text.trim()) {
    new Notification({ title: "IntelliNote", body: "Clipboard is empty." }).show();
    return;
  }

  // Check file type compatibility (text-based files only)
  const ext = path.extname(rawPath).toLowerCase();
  const textExts = [".md", ".txt", ".rtf", ".org", ".rst", ""];
  if (!textExts.includes(ext)) {
    new Notification({ title: "IntelliNote", body: `File type ${ext} not supported for paste.` }).show();
    return;
  }

  try {
    const dir = path.dirname(rawPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(rawPath, `\n${text.trim()}\n`, "utf8");

    new Notification({ title: "IntelliNote", body: `Pasted ${text.trim().split("\n").length} lines to raw file.` }).show();

    // Notify renderer to trigger incremental ingest
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("hotkey:pasted", { rawPath, lineCount: text.trim().split("\n").length });
    }
  } catch (err) {
    new Notification({ title: "IntelliNote", body: `Paste failed: ${err.message}` }).show();
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
  const prefsFile = path.join(appRoot(), "data", "prefs.json");
  const dir = path.dirname(prefsFile);
  fs.mkdirSync(dir, { recursive: true });
  let prefs = {};
  try {
    if (fs.existsSync(prefsFile)) prefs = JSON.parse(fs.readFileSync(prefsFile, "utf8"));
  } catch {}
  prefs.rawPath = rawPath;
  fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2), "utf8");
});
