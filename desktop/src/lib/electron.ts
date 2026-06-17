import type { CmdResult, ViewsResult, MvpStatus, AppSettings } from "./types";

function getDesktop() {
  const d = window.desktop;
  if (!d) {
    throw new Error("Desktop API unavailable. Launch the SmartNote Electron app.");
  }
  return d;
}

export async function ingestRaw(
  rawPath: string,
  notePath: string,
  reset = false
): Promise<CmdResult> {
  return getDesktop().invoke("ingest_raw", {
    rawPath,
    notePath,
    reset: reset || undefined,
  }) as Promise<CmdResult>;
}

export async function appendTextToRaw(
  rawPath: string,
  text: string
): Promise<CmdResult> {
  return getDesktop().invoke("append_text_to_raw", { rawPath, text }) as Promise<CmdResult>;
}

export async function listViews(notePath: string): Promise<ViewsResult> {
  return getDesktop().invoke("list_views", { notePath }) as Promise<ViewsResult>;
}

export async function getMvpStatus(): Promise<MvpStatus> {
  return getDesktop().invoke("get_mvp_status") as Promise<MvpStatus>;
}

/* Direct LLM call via the user's local provider (Settings → Chat
 * provider). The api key is read inside the main process from
 * cloud-creds.json — it never enters the renderer context. Throws
 * if the local provider isn't configured. */
export type AiChatResult = {
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  finish_reason?: string;
};
export async function aiChat(req: {
  system: string;
  user: string;
  max_tokens?: number;
  temperature?: number;
}): Promise<AiChatResult> {
  return getDesktop().invoke("ai_chat", req) as Promise<AiChatResult>;
}

/* Streaming variant — emits separate "reasoning" and "content"
 * chunks as the provider streams. DeepSeek-Reasoner / o1 / Qwen-
 * thinking emit reasoning_content first (chain-of-thought), then
 * content (the final answer); chat models emit content only.
 *
 * Usage: pass a chunk callback. Returns an abort fn that cancels
 * the stream both client-side (no more chunks) and server-side
 * (sends a cancel IPC so the fetch aborts).
 */
export type AiChatChunk =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "done"; prompt_tokens: number; completion_tokens: number; total_tokens: number; finish_reason: string }
  | { type: "error"; err: string };

export function aiChatStream(
  req: { system: string; user: string; max_tokens?: number; temperature?: number },
  onChunk: (chunk: AiChatChunk) => void,
): () => void {
  const desktop = getDesktop();
  const id = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Subscribe to the global chunk channel and filter by id. The
  // preload exposes onAiChatChunk; fall back to invoke-only mode
  // if the build is older than the streaming preload (returns no-op).
  const onAi = (desktop as unknown as {
    onAiChatChunk?: (cb: (chunk: AiChatChunk & { id: string }) => void) => () => void;
  }).onAiChatChunk;
  let unsubscribe: () => void = () => {};
  if (onAi) {
    unsubscribe = onAi((chunk) => {
      if (chunk.id !== id) return;
      onChunk(chunk);
    });
  }
  // Kick off the stream — main returns immediately after handshake;
  // chunks land asynchronously via onAiChatChunk above.
  desktop.invoke("ai_chat_stream", { id, ...req }).catch((e) => {
    onChunk({ type: "error", err: e instanceof Error ? e.message : String(e) });
  });
  return () => {
    try { unsubscribe(); } catch {}
    desktop.invoke("ai_chat_stream:cancel", id).catch(() => {});
  };
}

export async function pickRawFile(): Promise<string | null> {
  return getDesktop().invoke("dialog_open_raw") as Promise<string | null>;
}

/* Notes-workspace helpers — for the multi-tab note page. The dir
 * is whatever folder the user's current rawPath lives in (or the
 * one they pick via pickNoteDir). */
export type DirListing = { ok: boolean; root?: string; files: Array<{ name: string; path: string }>; error?: string };
export async function listNoteDir(dir: string): Promise<DirListing> {
  return getDesktop().invoke("note:list_dir", { dir }) as Promise<DirListing>;
}
export async function createNewNote(dir: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  return getDesktop().invoke("note:create_new", { dir, name }) as Promise<{ ok: boolean; path?: string; error?: string }>;
}
export async function pickNoteDir(): Promise<string | null> {
  return getDesktop().invoke("note:pick_dir") as Promise<string | null>;
}

export async function pickNoteFile(): Promise<string | null> {
  return getDesktop().invoke("dialog_save_note") as Promise<string | null>;
}

export async function readClipboard(): Promise<string | null> {
  return getDesktop().invoke("clipboard_read_text") as Promise<string | null>;
}

export type IngestEvent = {
  status: "started" | "progress" | "completed" | "error";
  step: string;
  current: number;
  total: number;
  elapsed_ms: number;
  message: string;
  // Attribution: 'mcp:delegate' when produced by Claude via submit_enrichments,
  // 'provider:<model>' when backend LLM, otherwise absent/empty.
  actor?: string;
  // For enrich events: 'note_segments' | 'wiki_chunks' | 'wiki_topic' | 'doc_format'
  kind?: string;
};

export async function ingestRawAsync(
  rawPath: string,
  notePath: string,
  reset = false
): Promise<void> {
  await getDesktop().invoke("ingest_raw_async", {
    rawPath,
    notePath,
    reset: reset || undefined,
  });
}

export function onIngestStatus(
  handler: (event: IngestEvent) => void
): Promise<() => void> {
  return Promise.resolve(
    getDesktop().onIngestStatus((data) => handler(data as IngestEvent))
  );
}

export function onWikiIngestStatus(
  handler: (event: IngestEvent) => void
): Promise<() => void> {
  return Promise.resolve(
    getDesktop().onWikiIngestStatus((data) => handler(data as IngestEvent))
  );
}

/* Cloud-pushed event types streamed over the /v1/device/relay WS.
 * The desktop's main process forwards each one to renderers via
 * the "smartnote:ws-event" IPC channel; here we surface them with
 * a typed handler for ergonomic React consumption. */
export type WsEvent =
  | { type: "agent_active"; agent: string; tool: string; method: string; at: string }
  | {
      type: "processing_progress" | "processing_done";
      document_id: string;
      run_id?: string;
      stage?: string;
      status?: string;
      message?: string;
      progress?: { current?: number; total?: number };
      error?: string | { message?: string };
      at: string;
    }
  | { type: "memory_proposed"; proposal_id: string; agent?: string; at: string }
  | { type: "search_recorded"; query: string; author: string; at: string }
  | { type: "hello-ack"; workspace_id: string; device_id: string }
  | { type: string; [k: string]: unknown };

export function onWsEvent(
  handler: (event: WsEvent) => void
): () => void {
  const d = window.desktop as unknown as {
    onWsEvent?: (cb: (data: WsEvent) => void) => () => void;
  };
  if (!d?.onWsEvent) return () => {};  // browser preview / older preload
  return d.onWsEvent((data) => {
    // Diagnostic — confirms IPC main→renderer leg. Filter at tail
    // with `console.filter [ws-renderer]` in Electron DevTools.
    const t = (data as { type?: string })?.type;
    if (t && t !== "pong" && t !== "hello-ack") {
      // eslint-disable-next-line no-console
      console.log("[ws-renderer] event", t, data);
    }
    handler(data);
  });
}

/* File-watcher refused to clobber a foreign cloud edit. Fires for any
 * note whose cloud version was changed by MCP / console / another
 * desktop while the sync watcher had pending local content. NotePage
 * subscribes to this and flips its merge banner on. */
export type CloudConflict = {
  relPath: string;
  docId: string | null;
  cloudMs: number;
  by: string;
};
export function onCloudConflict(handler: (c: CloudConflict) => void): () => void {
  const d = window.desktop as unknown as {
    onCloudConflict?: (cb: (data: CloudConflict) => void) => () => void;
  };
  if (!d?.onCloudConflict) return () => {};
  return d.onCloudConflict(handler);
}

/* After a successful merge-then-push from NotePage, tell the watcher
 * to clear the conflict and resume auto-syncing this file. */
export async function clearSyncConflict(relPath: string, newCloudMs?: number): Promise<void> {
  await getDesktop().invoke("native:sync:clear-conflict", { relPath, newCloudMs });
}

export async function getIngestStatus(): Promise<{ noteIngestRunning: boolean; wikiIngestRunning: boolean }> {
  return getDesktop().invoke("get_ingest_status") as Promise<{ noteIngestRunning: boolean; wikiIngestRunning: boolean }>;
}

export async function readSettings(): Promise<AppSettings> {
  return getDesktop().invoke("read_settings") as Promise<AppSettings>;
}

export async function writeSettings(settings: AppSettings): Promise<CmdResult> {
  return getDesktop().invoke("write_settings", { newSettings: settings }) as Promise<CmdResult>;
}

export async function openPath(path: string): Promise<void> {
  await getDesktop().invoke("shell_open_path", { path });
}

/** Full file read for the Note editor; previews use gateway `/source` or `/tags/.../source` (line ranges). */
export async function readFileFull(path: string): Promise<CmdResult> {
  return getDesktop().invoke("read_file_full", { path }) as Promise<CmdResult>;
}

// ── Special Knowledge Ingest ──

export async function specialIngestAsync(opts: { folderPath?: string; filePath?: string; topicName?: string }): Promise<void> {
  await getDesktop().invoke("special_ingest_async", {
    folderPath: opts.folderPath,
    filePath: opts.filePath,
    topicName: opts.topicName || undefined,
  });
}

export async function mcpImportAsync(opts: { serverName: string; docUrl?: string; documentId?: string; topicName?: string }): Promise<void> {
  await getDesktop().invoke("mcp_import_async", {
    serverName: opts.serverName,
    docUrl: opts.docUrl,
    documentId: opts.documentId,
    topicName: opts.topicName || undefined,
  });
}

export async function pickFolder(): Promise<string | null> {
  return getDesktop().invoke("dialog_open_folder") as Promise<string | null>;
}

export async function pickPdf(): Promise<string | null> {
  return getDesktop().invoke("dialog_open_pdf") as Promise<string | null>;
}

// ── Global Hotkey ──

export async function getHotkey(): Promise<string> {
  return getDesktop().invoke("get_hotkey") as Promise<string>;
}

export async function setHotkey(hotkey: string): Promise<{ ok: boolean; hotkey: string }> {
  return getDesktop().invoke("set_hotkey", { hotkey }) as Promise<{ ok: boolean; hotkey: string }>;
}

export async function saveRawPathForHotkey(rawPath: string): Promise<void> {
  await getDesktop().invoke("save_raw_path_for_hotkey", { rawPath });
}

export async function writeFile(path: string, content: string): Promise<void> {
  await getDesktop().invoke("write_file", { path, content });
}

export function onHotkeyPasted(
  handler: (data: { rawPath: string; lineCount: number }) => void
): () => void {
  return getDesktop().onHotkeyPasted(handler);
}

// ── Cloud stack lifecycle (docker compose) ─────────────────────────

export type CloudStackService = {
  name: string;
  service: string;
  state: string;          // "running" | "exited" | "restarting" | ...
  status: string;         // "Up 3 hours (healthy)" etc.
  health?: string;
};

export type CloudStackStatus = {
  ok: boolean;
  services: CloudStackService[];
  error?: string;
};

/** Sentinel value in `error` when the running Electron main process
 *  predates the stack-lifecycle IPC handlers. The UI uses this to hide
 *  stack controls silently instead of surfacing a scary "No handler
 *  registered" error to the user. */
export const STACK_IPC_UNAVAILABLE = "__stack_ipc_unavailable__";

function isMissingHandlerError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message || err);
  return msg.includes("No handler registered");
}

export async function fetchCloudStackStatus(): Promise<CloudStackStatus> {
  try {
    return (await getDesktop().invoke("cloud_stack_status")) as CloudStackStatus;
  } catch (e) {
    if (isMissingHandlerError(e)) {
      return { ok: false, error: STACK_IPC_UNAVAILABLE, services: [] };
    }
    return { ok: false, error: String(e), services: [] };
  }
}

export async function startCloudStack(
  opts: { rebuild?: boolean } = {},
): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    return (await getDesktop().invoke("cloud_stack_start", opts)) as { ok: boolean; output?: string; error?: string };
  } catch (e) {
    if (isMissingHandlerError(e)) {
      return { ok: false, error: STACK_IPC_UNAVAILABLE };
    }
    return { ok: false, error: String(e) };
  }
}

export async function stopCloudStack(): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    return (await getDesktop().invoke("cloud_stack_stop")) as { ok: boolean; output?: string; error?: string };
  } catch (e) {
    if (isMissingHandlerError(e)) {
      return { ok: false, error: STACK_IPC_UNAVAILABLE };
    }
    return { ok: false, error: String(e) };
  }
}

// ── MCP config installer (one-click install to Cursor/Claude Code) ─

export type McpInstallerAgentStatus = {
  available: boolean;
  path?: string;
  exists?: boolean;
  installed?: boolean;
  malformed?: boolean;
};

export async function fetchMcpInstallerStatus(): Promise<{
  ok: boolean;
  agents: Record<string, McpInstallerAgentStatus>;
}> {
  try {
    return (await getDesktop().invoke("mcp_installer_status")) as { ok: boolean; agents: Record<string, McpInstallerAgentStatus> };
  } catch (e) {
    if (isMissingHandlerError(e)) {
      return { ok: false, agents: {} };
    }
    throw e;
  }
}

export async function installMcpForAgent(
  agent: string,
  url: string,
  apiKey: string,
): Promise<{ ok: boolean; path?: string; replaced?: boolean; error?: string }> {
  try {
    return (await getDesktop().invoke("mcp_installer_install", { agent, url, apiKey })) as { ok: boolean; path?: string; replaced?: boolean; error?: string };
  } catch (e) {
    if (isMissingHandlerError(e)) {
      return { ok: false, error: STACK_IPC_UNAVAILABLE };
    }
    return { ok: false, error: String(e) };
  }
}

export async function uninstallMcpForAgent(
  agent: string,
): Promise<{ ok: boolean; removed?: boolean; error?: string }> {
  try {
    return (await getDesktop().invoke("mcp_installer_uninstall", { agent })) as { ok: boolean; removed?: boolean; error?: string };
  } catch (e) {
    if (isMissingHandlerError(e)) {
      return { ok: false, error: STACK_IPC_UNAVAILABLE };
    }
    return { ok: false, error: String(e) };
  }
}

// ── First-run onboarding ──

export async function fetchFirstRunState(): Promise<{
  isFirstRun: boolean;
  sampleAlreadyInstalled: boolean;
  sampleTargetPath: string;
}> {
  try {
    return (await getDesktop().invoke("first_run_state")) as {
      isFirstRun: boolean;
      sampleAlreadyInstalled: boolean;
      sampleTargetPath: string;
    };
  } catch {
    // Stale main process — assume not first-run to avoid nagging.
    return { isFirstRun: false, sampleAlreadyInstalled: false, sampleTargetPath: "" };
  }
}

export async function installSampleNote(): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    return (await getDesktop().invoke("install_sample_note")) as { ok: boolean; path?: string; error?: string };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
