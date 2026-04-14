import type { CmdResult, ViewsResult, MvpStatus, AppSettings } from "./types";

function getDesktop() {
  const d = window.desktop;
  if (!d) {
    throw new Error("Desktop API unavailable. Launch the IntelliNote Electron app.");
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

export async function readTextFile(path: string): Promise<CmdResult> {
  return getDesktop().invoke("read_text_file", { path }) as Promise<CmdResult>;
}

export async function getMvpStatus(): Promise<MvpStatus> {
  return getDesktop().invoke("get_mvp_status") as Promise<MvpStatus>;
}

export async function pickRawFile(): Promise<string | null> {
  return getDesktop().invoke("dialog_open_raw") as Promise<string | null>;
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

export async function readSettings(): Promise<AppSettings> {
  return getDesktop().invoke("read_settings") as Promise<AppSettings>;
}

export async function writeSettings(settings: AppSettings): Promise<CmdResult> {
  return getDesktop().invoke("write_settings", { newSettings: settings }) as Promise<CmdResult>;
}

export async function openPath(path: string): Promise<void> {
  await getDesktop().invoke("shell_open_path", { path });
}

export async function readFileFull(path: string): Promise<CmdResult> {
  return getDesktop().invoke("read_file_full", { path }) as Promise<CmdResult>;
}

// ── Special Knowledge Ingest ──

export async function specialIngestAsync(folderPath: string, topicName?: string): Promise<void> {
  await getDesktop().invoke("special_ingest_async", { folderPath, topicName: topicName || undefined });
}

export async function pickFolder(): Promise<string | null> {
  return getDesktop().invoke("dialog_open_folder") as Promise<string | null>;
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

export function onHotkeyPasted(
  handler: (data: { rawPath: string; lineCount: number }) => void
): () => void {
  return getDesktop().onHotkeyPasted(handler);
}
