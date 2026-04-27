/* Renderer-side bindings for the Electron native services (Phase 3).
 *
 * Mirrors `electron/services/*.mjs`. Each call returns `{ ok, value }`
 * or `{ ok: false, error }` — callers branch on `ok` rather than
 * throwing through IPC, because the renderer can decide to fall back
 * to the legacy Python gateway when the native handler is missing
 * (older Electron build, dev preview, etc.).
 *
 * `NATIVE_AVAILABLE` is true when the preload exposed `window.desktop`
 * AND the user (or build) hasn't disabled native mode via the
 * SMARTNOTE_NATIVE feature flag in localStorage.
 */
type NativeOk<T> = { ok: true; value: T };
type NativeErr = { ok: false; error: string };
type NativeResult<T> = NativeOk<T> | NativeErr;

// Use window.desktop type from vite-env.d.ts.

export const NATIVE_AVAILABLE = (() => {
  if (typeof window === "undefined" || !window.desktop) return false;
  // Default-on in builds; flip OFF by setting localStorage SMARTNOTE_NATIVE=0.
  try {
    const v = window.localStorage?.getItem("SMARTNOTE_NATIVE");
    if (v === "0" || v === "false") return false;
  } catch { /* private mode */ }
  return true;
})();

async function call<T>(channel: string, payload?: unknown): Promise<NativeResult<T>> {
  if (!window.desktop) return { ok: false, error: "no electron bridge" };
  return await window.desktop.invoke(channel, payload) as NativeResult<T>;
}

export const native = {
  settings: {
    read:  () => call<Record<string, unknown>>("native:settings:read"),
    write: (patch: Record<string, unknown>) => call<Record<string, unknown>>("native:settings:write", patch),
  },
  notes: {
    read:  (path: string) => call<{ path: string; content: string; mtime: number; size: number }>("native:notes:read", { path }),
    write: (path: string, content: string) => call<{ path: string; mtime: number; size: number }>("native:notes:write", { path, content }),
    list:  () => call<{ path: string; rel_path: string; name: string; mtime: number; size: number }[]>("native:notes:list"),
  },
  search: {
    query:    (query: string, limit = 20) => call<{ rel_path: string; line_no: number; content: string; score: number }[]>("native:search:query", { query, limit }),
    reindex:  (rel_path: string, content: string) => call<void>("native:search:reindex", { rel_path, content }),
  },
  sync: {
    start:  () => call<{ running: boolean; notes_dir: string | null; pending: number }>("native:sync:start"),
    stop:   () => call<{ running: boolean }>("native:sync:stop"),
    status: () => call<{ running: boolean; notes_dir: string | null; pending: number; last_push_at: number | null; last_error: string | null }>("native:sync:status"),
  },
};
