/**
 * Renderer ⇄ main IPC handlers for local-mode.
 *
 * Channel naming: `local:<verb>` — flat, no nesting, easy to grep
 * for in renderer code (search "local:" reveals every call site).
 *
 * The renderer-side `local-impl.ts` calls `desktop.invoke("local:X", ...)`
 * which lands here. Return shapes match the cloud-api equivalents
 * 1:1 so the dispatcher in `cloud-api.ts` can swap implementations
 * without UI components knowing.
 *
 * Heavy lifting (LLM calls, embedding, chunking) lives in sibling
 * modules (./pipeline/*.mjs); this file is mostly thin glue.
 */

import { ipcMain } from "electron";

let _registered = false;
let _initError = null;
let _docs = null;
let _memories = null;
let _runs = null;

/** Called from main.mjs AFTER the DB initialized successfully. Plugs
 * the real CRUD modules in. If the DB never inits (sqlite-vec
 * missing, file perms, etc.), the IPC handlers still answer — they
 * just throw a clear "local DB not ready" message instead of the
 * generic "No handler registered". */
export async function attachModules() {
  _docs = await import("./documents.mjs");
  _memories = await import("./memories.mjs");
  _runs = await import("./runs.mjs");
}

export function setInitError(e) { _initError = e; }

function ready() {
  if (_initError) {
    const msg = String(_initError?.message || _initError || "unknown init error");
    throw new Error(`local DB not ready: ${msg}. Did you run \`npm install\` in desktop/?`);
  }
  if (!_docs || !_memories || !_runs) {
    throw new Error("local DB still initializing — try again in a moment");
  }
}

export function register() {
  if (_registered) return;
  _registered = true;
  // Bind via closures + the lazy `ready()` gate. Handlers are
  // registered immediately at startup so `ipcMain.handle('local:X')`
  // never lands on "No handler registered" — only "DB not ready"
  // with an actionable message.
  const docs = () => { ready(); return _docs; };
  const memories = () => { ready(); return _memories; };
  const runs = () => { ready(); return _runs; };

  // ── documents ─────────────────────────────────────────────────
  ipcMain.handle("local:listDocuments", (_e, opts) => docs().listDocuments(opts));
  ipcMain.handle("local:getDocument", (_e, id) => docs().getDocument(id));
  ipcMain.handle("local:createDocument", (_e, req) => docs().createDocument(req));
  ipcMain.handle("local:patchDocument", (_e, { id, patch }) => docs().patchDocument(id, patch));
  ipcMain.handle("local:deleteDocument", (_e, id) => docs().deleteDocument(id));
  ipcMain.handle("local:getDocumentKn", (_e, id) => docs().getDocumentKn(id));
  // Replaces the legacy POST 127.0.0.1:8787/note/save + /note/load.
  ipcMain.handle("local:saveNote", (_e, body) => docs().saveNote(body));
  ipcMain.handle("local:loadNote", (_e, raw_path) => docs().loadNote(raw_path));

  // ── memories ──────────────────────────────────────────────────
  ipcMain.handle("local:listProposals", (_e, opts) => memories().listProposals(opts));
  ipcMain.handle("local:listMemories", (_e, opts) => memories().listMemories(opts));
  ipcMain.handle("local:acceptProposal", (_e, id) => memories().acceptProposal(id));
  ipcMain.handle("local:rejectProposal", (_e, { id, reason }) => memories().rejectProposal(id, reason));
  ipcMain.handle("local:batchAcceptProposals", (_e, ids) => memories().batchAcceptProposals(ids));

  // ── pipeline runs ─────────────────────────────────────────────
  ipcMain.handle("local:listRecentRuns", (_e, limit) => runs().listRecentRuns(limit));
  ipcMain.handle("local:runStage", (_e, { document_id, kind, force }) =>
    runs().runStage({ document_id, kind, force }),
  );

  // ── note classify ─────────────────────────────────────────────
  ipcMain.handle("local:classifyNote", (_e, document_id) =>
    runs().runStage({ document_id, kind: "note_classify", force: true }),
  );
  ipcMain.handle("local:listNoteSuggestions", (_e, document_id) =>
    memories().listNoteSuggestions(document_id),
  );
  ipcMain.handle("local:acceptNoteSuggestion", (_e, { document_id, tag }) =>
    memories().acceptNoteSuggestion(document_id, tag),
  );
  ipcMain.handle("local:dismissNoteSuggestion", (_e, { document_id, tag }) =>
    memories().dismissNoteSuggestion(document_id, tag),
  );
  ipcMain.handle("local:addNoteUserTag", (_e, { document_id, tag }) =>
    memories().addNoteUserTag(document_id, tag),
  );

  // ── pipeline events / log channel ─────────────────────────────
  ipcMain.handle("local:logsRecentRuns", (_e, limit) => runs().recentRunsForLogs(limit));
  ipcMain.handle("local:logsRunChain", (_e, run_id) => runs().runChain(run_id));
  ipcMain.handle("local:logsSearch", (_e, opts) => runs().searchEvents(opts));
  ipcMain.handle("local:logsStats", () => runs().statsRollup());

  // ── health: check LLM + embed reachability ─────────────────────
  ipcMain.handle("local:health", async () => {
    const settingsMod = await import("../settings.mjs");
    const s = await settingsMod.read();
    const llm_configured = !!(s.provider_base_url && s.provider_api_key && s.provider_chat_model);
    const embed_url = process.env.EMBED_URL || "http://localhost:8009";
    let embed_reachable = false;
    try {
      const r = await fetch(`${embed_url}/health`, { signal: AbortSignal.timeout(2000) });
      embed_reachable = r.ok;
    } catch { /* unreachable */ }
    return {
      mode: "local",
      llm_configured,
      llm_model: llm_configured ? s.provider_chat_model : null,
      embed_url,
      embed_reachable,
      db_path: (await import("./db.mjs")).dbPath(),
    };
  });

  console.log("[local-db.ipc] handlers registered");
}
