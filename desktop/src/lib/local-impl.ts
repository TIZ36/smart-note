/* Renderer-side IPC client for local-mode.
 *
 * Mirrors the cloud-api surface 1:1 in shape. The dispatch layer in
 * cloud-api.ts checks `isLocalMode()` and routes here when true.
 *
 * No HTTP — every call is `desktop.invoke("local:X", payload)` →
 * the matching IPC handler in
 * desktop/electron/services/local-db/ipc.mjs.
 *
 * Errors thrown from main propagate through Electron's IPC and
 * surface as plain Error in the renderer; the dispatcher passes
 * them through unchanged so existing try/catch in UI components
 * still works.
 */

import type {
  CloudDocument, CloudDocumentFull, DocumentKn,
  Memory, MemoriesList,
  Proposal, ProposalsList,
  RecentRun, ProcessingRunResult,
  NoteSuggestion, NoteSuggestionsList,
} from "./cloud-api";

type Desktop = {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
};
function dt(): Desktop {
  const d = (window as unknown as { desktop?: Desktop }).desktop;
  if (!d) throw new Error("desktop bridge unavailable (renderer outside Electron)");
  return d;
}

/* ── documents ─────────────────────────────────────────────────── */

export const listDocuments = (params?: { since?: string; smartnote_type?: string }) =>
  dt().invoke<{ documents: CloudDocument[]; total: number }>("local:listDocuments", params || {});

export const getDocument = (id: string) =>
  dt().invoke<CloudDocumentFull>("local:getDocument", id);

export const deleteDocument = (id: string) =>
  dt().invoke<{ deleted: boolean; id: string }>("local:deleteDocument", id);

export const getDocumentKn = (id: string) =>
  dt().invoke<DocumentKn>("local:getDocumentKn", id);

export const patchDocument = (
  id: string,
  patch: { name?: string; kind?: string; metadata?: Record<string, unknown> },
) => dt().invoke<CloudDocument>("local:patchDocument", { id, patch });

export const createDocument = (req: {
  name: string;
  content?: string;
  smartnote_type?: string;
  metadata?: Record<string, unknown>;
}) => dt().invoke<CloudDocument>("local:createDocument", req);

/* ── pipeline runs ─────────────────────────────────────────────── */

export const buildWikiAbstract = (id: string, force = true) =>
  dt().invoke<ProcessingRunResult>("local:runStage", {
    document_id: id, kind: "wiki_abstract", force,
  });

export const runDocumentEnrich = (id: string, force = true) =>
  dt().invoke<ProcessingRunResult>("local:runStage", {
    document_id: id, kind: "ai_enrich", force,
  });

export const runDocumentChunkEmbed = (id: string, force = true) =>
  dt().invoke<ProcessingRunResult>("local:runStage", {
    document_id: id, kind: "chunk_embed", force,
  });

export const buildWikiSmartsheet = buildWikiAbstract;

export const listRecentRuns = (limit = 50) =>
  dt().invoke<RecentRun[]>("local:listRecentRuns", limit);

/* ── memories + proposals ──────────────────────────────────────── */

export const listProposals = (
  limitOrOpts: number | { limit?: number; status?: "pending" | "rejected" | "all"; kind?: string } = 20,
) => {
  const opts = typeof limitOrOpts === "number" ? { limit: limitOrOpts } : limitOrOpts;
  return dt().invoke<ProposalsList>("local:listProposals", opts);
};

export const acceptProposal = (id: string) =>
  dt().invoke<{ ok: boolean; id: string }>("local:acceptProposal", id);

export const rejectProposal = (id: string, reason?: string) =>
  dt().invoke<{ ok: boolean; id: string }>("local:rejectProposal", { id, reason });

export const batchAcceptProposals = (ids: string[]) =>
  dt().invoke<{ ok: boolean; accepted: number; requested: number }>(
    "local:batchAcceptProposals", ids,
  );

export const listMemories = (
  opts: { kind?: string; scope?: string; limit?: number; offset?: number } = {},
) => dt().invoke<MemoriesList>("local:listMemories", opts);

/* ── notes (classify + suggestions) ────────────────────────────── */

export const classifyNote = (documentId: string) =>
  dt().invoke<{ run_id: string; status: string; suggested_count: number }>(
    "local:classifyNote", documentId,
  );

export const listNoteSuggestions = (documentId: string) =>
  dt().invoke<NoteSuggestionsList>("local:listNoteSuggestions", documentId);

export const acceptNoteSuggestion = (documentId: string, tag: string) =>
  dt().invoke<{ tag: string; user_tags: string[] }>(
    "local:acceptNoteSuggestion", { document_id: documentId, tag },
  );

export const dismissNoteSuggestion = (documentId: string, tag: string) =>
  dt().invoke<{ tag: string; dismissed: boolean }>(
    "local:dismissNoteSuggestion", { document_id: documentId, tag },
  );

export const addNoteUserTag = (documentId: string, tag: string) =>
  dt().invoke<{ tag: string; user_tags: string[] }>(
    "local:addNoteUserTag", { document_id: documentId, tag },
  );

/* ── isCloudConfigured: in local mode it's always "configured" ── */

export async function isCloudConfigured(): Promise<boolean> {
  // Local mode is self-contained; UI gates that previously checked
  // cloud-configured should treat local as "ready".
  return true;
}

// Re-export the same types so callers don't change imports.
export type {
  CloudDocument, CloudDocumentFull, DocumentKn,
  Memory, MemoriesList,
  Proposal, ProposalsList,
  RecentRun, ProcessingRunResult,
  NoteSuggestion, NoteSuggestionsList,
};
