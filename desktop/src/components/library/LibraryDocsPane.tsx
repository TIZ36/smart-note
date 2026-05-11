import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, Trash2, Tag, Copy, FileText, Layers, CheckSquare, Square, Loader2, Library } from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { onWsEvent } from "@/lib/electron";
import { cn } from "@/lib/cn";
import type { ChannelId } from "@/lib/types";
import { Database, Sparkles, Layers as LayersIcon, Network as NetworkIcon } from "lucide-react";
import { useBulkRuns, type BulkRuns } from "./useBulkRuns";
import { BulkActionBar } from "./BulkActionBar";
import { WorkspacePanel } from "./WorkspacePanel";
import { useDocPipelineStates, type DocStates, type StageState } from "./useDocPipelineStates";
import { StageDetailModal, type StageInfo, type StageStatus } from "./StageDetailModal";

// 3-tier kind: note (synced personal) · wiki_topic (topical
// reference) · doc (untyped — user can re-classify via Set type).
type DocKind = "note" | "wiki_topic" | "doc";

function kindOf(d: cloudApi.CloudDocument): DocKind {
  const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
  const snt = String(md.smartnote_type || "");
  if (snt === "wiki_topic") return "wiki_topic";
  if (snt === "note") return "note";
  return "doc";
}

function kindLabel(k: DocKind): string {
  if (k === "wiki_topic") return "Wiki topic";
  if (k === "note") return "Note";
  return "Doc";
}

/* Library · Docs pane — wiki documents grouped by AI topic.
 *
 * Left tree: AI / Files mode toggle, then groups of documents.
 *   - AI mode: groups by metadata.smartnote_type → category → name
 *   - Files mode: flat list of names
 * Right pane: title bar + meta + actions (View raw / Re-enrich /
 * Copy as MCP) + chunk-level preview list.
 *
 * Phase 3 stub-real: tree fetches real documents; right pane shows
 * the document's name + byte size + metadata. Chunk-level viewer
 * lands in Phase 5 alongside the source viewer's full reuse.
 */

type Mode = "ai" | "files";
type ViewMode = "raw" | "kn";

type Props = {
  onOpenSource: (channel: ChannelId) => void;
};

export function LibraryDocsPane({ onOpenSource }: Props) {
  const [docs, setDocs] = useState<cloudApi.CloudDocument[] | null>(null);
  const [mode, setMode] = useState<Mode>("ai");
  const [activeId, setActiveId] = useState<string | null>(null);
  // Multi-select for bulk knowledge-processing actions (Embed/Enrich/
  // Wiki-smartsheet). Decoupled from activeId — single-click selects
  // for viewing, checkbox toggles for bulk. Workspace panel appears
  // below the per-doc viewer; it's always visible regardless of
  // selection size.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const bulk = useBulkRuns({ docs });
  /* Per-doc rolled-up stage state for the tree-row bits. Background-
   * polled + WS-driven; cheap (single workspace-wide query). */
  const docPipelineStates = useDocPipelineStates();
  const [viewMode, setViewMode] = useState<ViewMode>("raw");
  const [rawContent, setRawContent] = useState<string | null>(null);
  const [knData, setKnData] = useState<cloudApi.DocumentKn | null>(null);
  const [knLoading, setKnLoading] = useState(false);
  const [copiedRef, setCopiedRef] = useState(false);
  // Sub-tab inside the KN view. Tab set varies by document kind:
  //   Note  → Pipeline · Chunks · Tag segments · Enrich history
  //   Wiki  → Pipeline · Chunks · Chapters · Enrich history
  // Resets to "pipeline" whenever the active doc changes so the user
  // doesn't land on a wiki-only tab after switching to a note (and v.v.).
  const [knTab, setKnTab] = useState<KnTab>("pipeline");
  const fileRef = useRef<HTMLInputElement>(null);

  async function reload() {
    try {
      if (!(await cloudApi.isCloudConfigured())) {
        setDocs([]);
        return;
      }
      const res = await cloudApi.listDocuments();
      setDocs(res.documents);
    } catch {
      setDocs([]);
    }
  }

  useEffect(() => { reload(); }, []);

  /* Default-select the first doc when the tree finishes loading.
   * Without this, opening the Library tab lands on an empty
   * right-pane until the user picks a row — the prototype shows
   * the topmost note pre-opened so the surface feels populated. */
  useEffect(() => {
    if (activeId) return;
    if (!docs || docs.length === 0) return;
    // Prefer Notes first, then Wiki, then Docs — same order as the
    // tree groups (kindOf returns "note" | "wiki_topic" | "doc").
    const order = (k: string) => k === "note" ? 0 : k === "wiki_topic" ? 1 : 2;
    const firstByKind = [...docs].sort((a, b) => order(kindOf(a)) - order(kindOf(b)))[0];
    if (firstByKind) setActiveId(firstByKind.id);
  }, [docs, activeId]);

  /* Import flow:
   *   1. POST /v1/documents per file (createDocument) — fast.
   *   2. Auto-fire chunk_embed for the newly-uploaded docs so the
   *      user sees the "Splitting wiki into chapters" → "Embedded
   *      N/M chunks" → "Writing chunks" progress immediately.
   *      Without this, the user sees an empty Pipeline tab and
   *      thinks nothing is happening — the chapter parsing is part
   *      of chunk_embed, not a separate "ingest" step.
   *   3. Activate the first new doc so its Pipeline tab is what
   *      they're looking at while the run unfolds.
   */
  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setBusy("import");
    let ok = 0;
    let firstId: string | null = null;
    const newIds: string[] = [];
    for (const f of files) {
      try {
        const content = await f.text();
        const created = await cloudApi.createDocument({
          name: f.name.replace(/\.(md|txt)$/i, ""),
          content,
          kind: "markdown",
          metadata: { smartnote_type: "wiki_topic", imported_at: new Date().toISOString() },
        });
        if (!firstId) firstId = created.id;
        newIds.push(created.id);
        ok++;
      } catch {
        /* per-file tolerant */
      }
    }
    setBusy(null);
    if (fileRef.current) fileRef.current.value = "";
    await reload();
    if (firstId) setActiveId(firstId);
    if (ok < files.length) {
      window.alert(`Imported ${ok}/${files.length}. ${files.length - ok} failed (cloud unreachable?).`);
    }
    if (newIds.length > 0) {
      // Hand off to bulk runner — it tracks per-doc progress in
      // the runs map so the Pipeline tab's Embed row shows live
      // "Splitting wiki into chapters" → "Embedded N/M chunks"
      // messages as the cloud emits processing_progress events.
      bulk.flashSet(
        `Imported ${newIds.length} file${newIds.length === 1 ? "" : "s"} · parsing chapters & embedding…`,
      );
      bulk.runStage("chunk_embed", newIds, { autoTail: false });
    }
  }

  async function handleDelete() {
    if (!active) return;
    if (!window.confirm(`Delete "${active.name}"? Chunks + memories tied to this document are also dropped.`)) return;
    setBusy("delete");
    try {
      await cloudApi.deleteDocument(active.id);
      setActiveId(null);
      await reload();
    } catch (e) {
      window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const filtered = useMemo(() => {
    if (!docs) return [];
    if (!filter.trim()) return docs;
    const q = filter.toLowerCase();
    return docs.filter((d) => d.name.toLowerCase().includes(q));
  }, [docs, filter]);

  const grouped = useMemo(() => {
    const map = new Map<string, cloudApi.CloudDocument[]>();
    for (const d of filtered) {
      const key = mode === "ai"
        // Friendly label per 3-tier kind. Uncategorized goes to
        // "Docs" so user sees them as a separate bucket and can
        // re-classify via the Set type action.
        ? (kindOf(d) === "wiki_topic" ? "Wiki topics"
          : kindOf(d) === "note"      ? "Notes"
          :                              "Docs · uncategorized")
        : "All files";
      const list = map.get(key) || [];
      list.push(d);
      map.set(key, list);
    }
    // Stable sort: Notes → Wiki → Docs → other when in AI mode.
    const order = ["Notes", "Wiki topics", "Docs · uncategorized"];
    return Array.from(map.entries()).sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      if (ai !== -1 || bi !== -1) {
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      }
      return a[0].localeCompare(b[0]);
    });
  }, [filtered, mode]);

  // Fetch the doc's full markdown body when the active selection
  // changes. Cache result keyed by doc id so flipping back from KN
  // mode doesn't re-fetch.
  useEffect(() => {
    if (!activeId) { setRawContent(null); setKnData(null); return; }
    let alive = true;
    setRawContent(null);
    setKnData(null);
    setKnTab("pipeline");  // reset KN sub-tab on doc change
    cloudApi.getDocument(activeId)
      .then((d) => alive && setRawContent(d.content || ""))
      .catch(() => alive && setRawContent("(failed to load content — cloud unreachable?)"));
    return () => { alive = false; };
  }, [activeId]);

  // Fetch KN payload (chunks + tag_segments + processing_runs) lazily —
  // only when the user opens KN mode. Cached per activeId so flipping
  // back from Raw doesn't re-fetch.
  useEffect(() => {
    if (viewMode !== "kn" || !activeId) return;
    if (knData && knData.document_id === activeId) return;
    let alive = true;
    setKnLoading(true);
    cloudApi.getDocumentKn(activeId)
      .then((d) => { if (alive) { setKnData(d); setKnLoading(false); } })
      .catch(() => { if (alive) { setKnData(null); setKnLoading(false); } });
    return () => { alive = false; };
  }, [viewMode, activeId, knData]);

  // Realtime: when a processing pass completes for the active doc, the
  // /kn payload is now stale (segments / chapters / runs all change).
  // Re-fetch immediately on the cloud's processing_done WS event
  // instead of waiting for the next manual interaction. We also bump
  // the docs list so the tree's ingested/badge state catches up.
  useEffect(() => {
    const off = onWsEvent((e) => {
      if (e.type !== "processing_done") return;
      const ev = e as { document_id?: string };
      if (!ev.document_id) return;
      reload();
      if (ev.document_id === activeId) {
        cloudApi.getDocumentKn(activeId)
          .then(setKnData)
          .catch(() => {});
      }
    });
    return off;
  }, [activeId]);

  // Jump-to-line state: TagSegmentsTab and ChaptersTab dispatch this
  // when the user clicks a segment / chapter row. The Raw view reads
  // it on mount + viewMode flip and scrolls to the corresponding
  // line anchor. Clearing on consumption keeps the highlight tied to
  // the click, not to whatever was last opened.
  const [jumpTarget, setJumpTarget] = useState<{ start: number; end: number } | null>(null);
  function handleJumpToLine(start: number, end: number) {
    setJumpTarget({ start, end });
    setViewMode("raw");
  }

  // Direct reference — a stable URI that, when pasted into a Claude /
  // Cursor prompt, lets the agent resolve THIS exact document via
  // SmartNote MCP. Uses smartnote:// scheme + full UUID for unambiguity
  // + name slug for human readability. Keeping the format pattern-
  // matchable so the MCP server can intercept via a regex tool.
  function buildDirectRef(d: cloudApi.CloudDocument): string {
    const slug = d.name
      .toLowerCase()
      .replace(/[\s/]+/g, "-")
      .replace(/[^\w一-鿿\-_.]/g, "")
      .slice(0, 60);
    return `@smartnote://doc/${d.id}/${slug}`;
  }
  async function handleCopyDirectRef() {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(buildDirectRef(active));
      setCopiedRef(true);
      setTimeout(() => setCopiedRef(false), 1600);
    } catch {
      window.alert(buildDirectRef(active));
    }
  }

  // Re-classify the active document by setting metadata.smartnote_type.
  // Existing metadata is merged so we don't drop other fields like
  // ai_tags, relative_path, imported_at, etc.
  async function setKind(target: DocKind) {
    if (!active) return;
    setBusy("retype");
    try {
      const md = (active.metadata && typeof active.metadata === "object"
        ? { ...active.metadata }
        : {}) as Record<string, unknown>;
      if (target === "doc") {
        delete md.smartnote_type;
      } else {
        md.smartnote_type = target;
      }
      await cloudApi.patchDocument(active.id, { metadata: md });
      await reload();
    } catch (e) {
      window.alert(`Re-classify failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const active = filtered.find((d) => d.id === activeId) || filtered[0];

  /* Selection is kind-locked — checking a row of a different kind
   * clears prior selections in other kinds. Mirrors prototype §5.1
   * and integration doc §5.1: bulk actions are kind-specific so
   * mixing kinds in a selection is always a mistake.
   *
   * Implementation: when toggling ON a row whose kind differs from
   * any currently-checked row, drop the others first. Toggling OFF
   * is unconstrained. */
  function toggleSelect(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const targetDoc = docs?.find((x) => x.id === id);
    if (!targetDoc) return;
    const targetKind = kindOf(targetDoc);
    setSelected((cur) => {
      if (cur.has(id)) {
        // Toggle off — no kind enforcement needed.
        const next = new Set(cur);
        next.delete(id);
        return next;
      }
      // Toggle on — drop any selected rows of a different kind.
      const next = new Set<string>();
      for (const sel of cur) {
        const d = docs?.find((x) => x.id === sel);
        if (d && kindOf(d) === targetKind) next.add(sel);
      }
      next.add(id);
      return next;
    });
  }
  function selectAllVisible() {
    setSelected(new Set(filtered.map((d) => d.id)));
  }
  function clearSelection() { setSelected(new Set()); }

  return (
    <div className="proto-library-pane-cols">
      {/* Left tree */}
      <aside className="proto-library-tree">
        <div className="proto-library-tree-bar">
          <input
            className="proto-library-tree-search"
            placeholder="Filter topics…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="proto-library-tree-mode" role="tablist" aria-label="Tree mode">
            <button
              type="button"
              aria-pressed={mode === "ai"}
              title="AI-classified topics"
              onClick={() => setMode("ai")}
            >
              AI
            </button>
            <button
              type="button"
              aria-pressed={mode === "files"}
              title="Filesystem mirror"
              onClick={() => setMode("files")}
            >
              Files
            </button>
          </span>
        </div>
        {/* Import — pick one or more .md / .txt files and upload as
            wiki_topic documents. Chapter splitter applies tag-meta
            on ingest so they're query-ready immediately. */}
        <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--color-border)" }}>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.txt,.markdown"
            multiple
            style={{ display: "none" }}
            onChange={handleImport}
          />
          <button
            type="button"
            className="proto-library-btn"
            disabled={busy === "import"}
            onClick={() => fileRef.current?.click()}
            style={{ width: "100%", justifyContent: "center" }}
            title="Pick markdown / text files to import as wiki documents"
          >
            <Upload size={11} strokeWidth={2} />
            {busy === "import" ? "Uploading…" : "Import files"}
          </button>
        </div>
        <div className="proto-library-tree-scroll">
          {docs === null && (
            <div style={{ padding: 12, fontSize: 11, color: "var(--color-text-muted)" }}>
              loading…
            </div>
          )}
          {docs !== null && filtered.length === 0 && (
            <div style={{ padding: 12, fontSize: 11, color: "var(--color-text-muted)" }}>
              No documents yet. Ingest a note or sync a wiki folder.
            </div>
          )}
          {grouped.map(([groupName, items]) => {
            // Per-group Select all / Invert (same-kind locked) per
            // prototype §tree-group + §group-helpers. Kind is derived
            // from the first row's metadata.smartnote_type — every
            // row in the same group shares it.
            const groupKind = items[0] ? kindOf(items[0]) : "doc";
            const groupIds = items.map((d) => d.id);
            const allSelected = groupIds.length > 0 && groupIds.every((id) => selected.has(id));
            const onSelectAllGroup = () => {
              setSelected((cur) => {
                // Same-kind lock: clear other kinds first.
                const next = new Set<string>();
                for (const id of cur) {
                  const d = docs?.find((x) => x.id === id);
                  if (d && kindOf(d) === groupKind) next.add(id);
                }
                groupIds.forEach((id) => next.add(id));
                return next;
              });
            };
            const onInvertGroup = () => {
              setSelected((cur) => {
                const next = new Set<string>();
                // Keep currently-selected from the same kind, except
                // those in this group (those are flipped below).
                for (const id of cur) {
                  const d = docs?.find((x) => x.id === id);
                  if (d && kindOf(d) === groupKind && !groupIds.includes(id)) next.add(id);
                }
                for (const id of groupIds) {
                  if (!cur.has(id)) next.add(id);
                }
                return next;
              });
            };
            return (
            <div key={groupName} className="proto-library-tree-group">
              <div className="proto-library-group">
                <span>{groupName}</span>
                <span className="proto-library-group-count">{items.length}</span>
              </div>
              <div className="proto-library-group-helpers">
                <button
                  type="button"
                  className="proto-library-group-helper"
                  onClick={onSelectAllGroup}
                  data-active={allSelected ? "true" : undefined}
                >
                  {allSelected ? "Selected all" : `Select all (${items.length})`}
                </button>
                <button
                  type="button"
                  className="proto-library-group-helper"
                  onClick={onInvertGroup}
                >
                  Invert
                </button>
              </div>
              {items.map((d) => {
                const isChecked = selected.has(d.id);
                const ds = docPipelineStates.get(d.id);
                const { bits, label: bitsLabel } = treeBitsFor(d, ds);
                const ageMs = d.updated_at ? Date.now() - new Date(d.updated_at).getTime() : null;
                const ageStr = ageMs == null ? "" :
                  ageMs < 60_000 ? "now"
                  : ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)}m`
                  : ageMs < 86_400_000 ? `${Math.round(ageMs / 3_600_000)}h`
                  : `${Math.round(ageMs / 86_400_000)}d`;
                return (
                  <button
                    type="button"
                    key={d.id}
                    className="proto-library-tree-item"
                    aria-current={d.id === (active?.id ?? "")}
                    onClick={() => setActiveId(d.id)}
                  >
                    <span
                      className="proto-library-tree-item-check"
                      role="checkbox"
                      aria-checked={isChecked}
                      tabIndex={0}
                      onClick={(e) => toggleSelect(d.id, e)}
                      onKeyDown={(e) => {
                        if (e.key === " " || e.key === "Enter") {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleSelect(d.id, e as unknown as React.MouseEvent);
                        }
                      }}
                      title={isChecked ? "Uncheck for bulk actions" : "Check for bulk Embed / Enrich"}
                      style={{ color: isChecked ? "var(--color-accent)" : "var(--color-text-muted)", cursor: "pointer" }}
                    >
                      {isChecked
                        ? <CheckSquare size={12} strokeWidth={2} />
                        : <Square size={12} strokeWidth={1.6} />}
                    </span>
                    <span className="proto-library-tree-item-name">{d.name}</span>
                    <span className="proto-library-tree-item-meta">
                      <span>{Math.round(d.byte_size / 1024)}k</span>
                      {ageStr && <span>{ageStr}</span>}
                    </span>
                    <span
                      className="proto-library-tree-item-bits"
                      title={`Stages: ${bits.map((b) => b || "·").join("")}  ·  ${bitsLabel.text}`}
                    >
                      <span className="proto-library-tree-item-bits-dots">
                        {bits.map((b, i) => (
                          <span key={i} className={b || undefined} />
                        ))}
                      </span>
                      <span className={cn(
                        "proto-library-tree-item-bits-label",
                        bitsLabel.tone === "fail" && "fail",
                        bitsLabel.tone === "run" && "run",
                      )}>
                        {bitsLabel.text}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            );
          })}
        </div>
      </aside>

      {/* Right content — flex column: bulk bar (when selection) ·
          per-doc viewer (existing) · processing feed · workspace panel.
          Workspace panel is always visible so tag-CRUD + retrieval-path
          status stay accessible without leaving Library. */}
      <div className="proto-library-content" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {bulk.flash && (
          <div className={cn(
            "proto-atelier-rag-flash",
            bulk.flash.tone === "err" && "proto-atelier-rag-flash-err",
          )} style={{ margin: "8px 12px 0" }}>
            {bulk.flash.msg}
          </div>
        )}
        {selected.size > 0 && docs && (
          <div style={{ padding: "10px 14px 0" }}>
            <BulkActionBar
              selected={selected}
              docs={docs}
              bulk={bulk}
              onClearSelection={clearSelection}
            />
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {/* Bulk view replaces single-doc detail when ≥1 doc checked.
            Single-doc UI is ambiguous in multi-select mode (which
            doc owns the tabs/state?), so we swap to the bulk plan. */}
        {selected.size > 0 && docs ? (
          <BulkView
            selected={selected}
            docs={docs}
            statesMap={docPipelineStates}
            bulk={bulk}
            onClearSelection={clearSelection}
          />
        ) : active ? (
          <>
            <div className="proto-library-content-bar">
              <div className="proto-library-content-title">{active.name}</div>
              <div className="proto-library-content-meta">
                {kindLabel(kindOf(active))} · {Math.round(active.byte_size / 1024)} KB
                {active.ingested_at && " · ingested"}
              </div>
              <div className="proto-library-content-actions">
                {/* Raw / KN view-mode toggle. Raw = source markdown
                    read-only (default); KN = knowledge view with
                    pipeline status, chunks, smartsheet (for wiki). */}
                <span className="proto-library-view-toggle" role="tablist" aria-label="View mode">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "raw"}
                    onClick={() => setViewMode("raw")}
                    title="Source markdown (read-only)"
                  >
                    <FileText size={11} strokeWidth={2} /> Raw
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "kn"}
                    onClick={() => setViewMode("kn")}
                    title="Knowledge view: pipeline status + chunks + smartsheet"
                  >
                    <Layers size={11} strokeWidth={2} /> KN
                  </button>
                </span>

                {/* Library is a viewer surface only — all KP/AI
                    capabilities (Embedding, Enrich, Build wiki-smartsheet)
                    live on the RAG (KP) page where bulk-selection
                    semantics make sense. */}
                <button
                  type="button"
                  className="proto-library-btn"
                  onClick={handleCopyDirectRef}
                  title="Copy a stable @smartnote URI — paste into Claude / Cursor prompts to reference this exact document"
                >
                  <Copy size={11} strokeWidth={2} />
                  {copiedRef ? "Copied" : "Copy direct-ref"}
                </button>

                {/* Re-classify dropdown */}
                <span className="proto-library-set-type">
                  <Tag size={11} strokeWidth={2} />
                  <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Type:</span>
                  <select
                    className="proto-library-set-type-select"
                    value={kindOf(active)}
                    disabled={busy === "retype"}
                    onChange={(e) => setKind(e.target.value as DocKind)}
                    title="Re-classify this document"
                  >
                    <option value="note">Note</option>
                    <option value="wiki_topic">Wiki topic</option>
                    <option value="doc">Doc (uncategorized)</option>
                  </select>
                </span>

                <button
                  type="button"
                  className="proto-library-btn"
                  disabled={busy === "delete"}
                  onClick={handleDelete}
                  title={`Delete "${active.name}" from the workspace`}
                  style={{ color: "var(--color-danger)", borderColor: "color-mix(in oklab, var(--color-danger) 30%, var(--color-border))" }}
                >
                  <Trash2 size={11} strokeWidth={2} />
                  {busy === "delete" ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
            <div className={cn(
              "proto-library-content-scroll",
              viewMode === "raw" && "proto-library-content-scroll-raw",
            )}>
              {viewMode === "raw" ? (
                rawContent === null ? (
                  <div style={{ padding: 24, fontSize: 12, color: "var(--color-text-muted)" }}>
                    loading content…
                  </div>
                ) : (
                  <RawView
                    content={rawContent}
                    jumpTarget={jumpTarget}
                    onConsumeJump={() => setJumpTarget(null)}
                  />
                )
              ) : (
                <KnView
                  doc={active}
                  knData={knData}
                  knLoading={knLoading}
                  knTab={knTab}
                  onKnTab={setKnTab}
                  isWiki={kindOf(active) === "wiki_topic"}
                  isNote={kindOf(active) === "note"}
                  bulk={bulk}
                  onJumpToLine={handleJumpToLine}
                />
              )}
            </div>
          </>
        ) : (docs && docs.length === 0) ? (
          // Workspace has zero docs — show an onboarding landing
          // that explains the processing model + offers a single
          // clear path forward (Import files). Workspace controls
          // (graph rebuild / re-embed / tags) would be no-ops here
          // because they need docs to operate on; hiding them
          // avoids the "looks operational but does nothing" trap.
          <LibraryLanding onImport={() => fileRef.current?.click()} importing={busy === "import"} />
        ) : (
          // Docs exist but none currently selected (rare — the
          // default-select effect catches this on tree load).
          // Show workspace-scope controls so the user has somewhere
          // to act while picking a doc.
          <div style={{ overflow: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="proto-library-empty" style={{ padding: 0, marginBottom: 4 }}>
              Select a document on the left to inspect its pipeline, or use the workspace controls below.
            </div>
            <WorkspacePanel
              onRebuildGraph={bulk.runGraph}
              graphBusy={bulk.busyKinds.has("graph")}
              onFlash={bulk.flashSet}
            />
          </div>
        )}
        </div>
      </div>

      {/* Inspector right column intentionally removed. The 320px
          context panel was attempting to surface state that the
          Pipeline tab + the stage-detail modal already cover more
          clearly. Clicking a stage row in Pipeline opens the modal
          with live progress + cloud association + result, so the
          passive right-side inspector was duplicating signal at
          lower fidelity. Surface area reclaimed for the main pane. */}
    </div>
  );
}

/* KN view — top menu bar + per-tab body. Tab set differs by kind:
 *
 *   Note  → Pipeline · Chunks · Tag segments · Enrich
 *   Wiki  → Pipeline · Chunks · Chapters · Enrich
 *
 * Pipeline status badges read directly from the /v1/documents/{id}/kn
  * payload (chunks / tag_segments / wiki_chapters / processing_runs counts)
 * — NOT from metadata flags. metadata.enrich_status / ai_tags lag the
 * actual processing state, which is why KP and Library disagreed
 * before. Single source of truth = the KN endpoint.
 */
/* KN tab keys — match prototype 1:1 (library-redesign-b.html
 * §kn-tabs). Crucially:
 *   "segments" = chunk_enrich output (semantic line-range tags)
 *   "tags"     = note_classify output (user-tag suggestion review)
 *   "chapters" = wiki_abstract output (per-chapter summaries)
 *   "graph"    = graph_topology output (related docs + workspace)
 * No standalone "Runs" tab — run history lives at the bottom of
 * the Pipeline tab as the mini-runs list. */
type KnTab = "pipeline" | "chunks" | "segments" | "tags" | "chapters" | "graph";

function KnView({
  doc, knData, knLoading, knTab, onKnTab, isWiki, isNote, bulk, onJumpToLine,
}: {
  doc: cloudApi.CloudDocument;
  knData: cloudApi.DocumentKn | null;
  knLoading: boolean;
  knTab: KnTab;
  onKnTab: (t: KnTab) => void;
  isWiki: boolean;
  isNote: boolean;
  bulk: BulkRuns;
  onJumpToLine: (start: number, end: number) => void;
}) {
  // Available tabs depend on kind:
  //   note kind  → +Tag suggestions (note_classify review queue)
  //   wiki kind  → +Chapters (wiki_abstract output) instead of Segments
  //   plain doc  → just Segments
  // Keep order stable so users build muscle memory.
  const pendingSuggestions = (knData?.note_tag_suggestions || [])
    .filter((s) => s.status === "pending").length;
  /* Chapter count splits into structure (existence after chunk_embed
   * splits by H2) vs summarized (after wiki_abstract LLM pass). The
   * tab label shows summarized/total when they differ — without this,
   * "Chapters 14" looks like the LLM ran when only the structure
   * exists. */
  const totalChapters = knData?.wiki_chapters?.length ?? 0;
  const summarizedChapterCount =
    (knData?.wiki_chapters || []).filter((c) => c.summarized).length;
  const chaptersLabel = totalChapters > 0 && summarizedChapterCount < totalChapters
    ? `${summarizedChapterCount}/${totalChapters}`
    : undefined;

  const tabs: { key: KnTab; label: string; count?: number; subCount?: string }[] = [
    { key: "pipeline", label: "Pipeline" },
    // chunk_total is the authoritative count from cloud; chunks[] is
    // capped (currently 2000) so use the rolled-up number for the
    // tab badge — otherwise a 467-chunk doc reads as "200" forever.
    { key: "chunks", label: "Chunks", count: knData?.chunk_total ?? knData?.chunks.length ?? 0 },
    // chunk_enrich output — only for note + plain doc (wiki uses
    // wiki_abstract instead).
    ...(isWiki ? [] : [{ key: "segments" as KnTab, label: "Segments", count: knData?.tag_segments.length ?? 0 }]),
    // note_classify output — note kind only.
    ...(isNote ? [{ key: "tags" as KnTab, label: "Tag suggestions", count: pendingSuggestions }] : []),
    // wiki_abstract output — wiki kind only. Chapter STRUCTURE
    // exists after embed; SUMMARIES exist only after wiki_abstract.
    // Show "0/14" so the user sees how many are LLM-summarized.
    ...(isWiki ? [{
      key: "chapters" as KnTab,
      label: "Chapters",
      count: totalChapters || undefined,
      subCount: chaptersLabel,
    }] : []),
    { key: "graph", label: "Graph", count: knData?.document_links?.length ?? 0 },
  ];
  // Snap back to pipeline if the active tab disappeared (e.g. doc
  // re-classified from note → wiki while open).
  if (!tabs.some((t) => t.key === knTab)) {
    onKnTab("pipeline");
  }

  return (
    <div className="proto-library-kn">
      <nav className="proto-library-kn-tabs" role="tablist" aria-label="Knowledge view">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={knTab === t.key}
            onClick={() => onKnTab(t.key)}
            className={cn("proto-library-kn-tab", knTab === t.key && "proto-library-kn-tab-active")}
            title={t.subCount ? `${t.subCount} summarized — run wiki_abstract to fill in the rest` : undefined}
          >
            {t.label}
            {t.subCount ? (
              <span className="proto-library-kn-tab-count proto-library-kn-tab-count-partial">
                {t.subCount}
              </span>
            ) : typeof t.count === "number" && (
              <span className="proto-library-kn-tab-count">{t.count}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="proto-library-kn-body">
        {knTab === "pipeline" && (
          <PipelineStatus
            doc={doc}
            knData={knData}
            knLoading={knLoading}
            isWiki={isWiki}
            isNote={isNote}
            bulk={bulk}
          />
        )}
        {knTab === "chunks" && (
          <ChunksTab knData={knData} knLoading={knLoading} />
        )}
        {knTab === "chapters" && isWiki && (
          <ChaptersTab knData={knData} knLoading={knLoading} onJumpToLine={onJumpToLine} />
        )}
        {knTab === "segments" && !isWiki && (
          <TagSegmentsTab knData={knData} knLoading={knLoading} onJumpToLine={onJumpToLine} />
        )}
        {knTab === "tags" && isNote && (
          <TagSuggestionsTab
            doc={doc}
            knData={knData}
            bulk={bulk}
          />
        )}
        {knTab === "graph" && (
          <GraphTab
            doc={doc}
            knData={knData}
            onRunEnrich={() => {
              bulk.runStage(isWiki ? "wiki_abstract" : "chunk_enrich", [doc.id], { force: true });
            }}
            onRunTopology={() => {
              bulk.runStage("graph_topology", [doc.id], { force: true });
            }}
          />
        )}
      </div>
    </div>
  );
}

function PipelineStatus({
  doc, knData, knLoading, isWiki, isNote, bulk,
}: {
  doc: cloudApi.CloudDocument;
  knData: cloudApi.DocumentKn | null;
  knLoading: boolean;
  isWiki: boolean;
  isNote: boolean;
  bulk: BulkRuns;
}) {
  // Per-doc trigger handlers — wrap the bulk runner with this doc's
  // single id. Same code path as the multi-select bar; this just
  // gives the user a one-click affordance from inside the doc view.
  /* Per-stage triggers · the "Re-X" / "Update X" affordances on
   * already-done rows must FORCE a fresh run. Without force the
   * cloud dedups against input_sha and silently keeps the prior
   * artefact, leaving the user wondering why nothing happened.
   * Decision rule: if the artefact already exists (computed below
   * after stages are derived), pass force=true. */
  // Force whenever there's a prior done run — the artefact may be
  // missing (e.g. wiki chunks where chunk_blobs cache reuse left
  // chunks.embedding NULL) yet cloud's input_sha-based dedup would
  // otherwise short-circuit and return the stale done row, so the
  // re-run never actually fires. Tying force to "previous done"
  // matches user intent: clicking Re-embed when something is already
  // done explicitly means "do it again".
  const onEmbed = () => bulk.runStage("chunk_embed", [doc.id], {
    force: latestEmbedRun?.status === "done" || latestEmbedRun?.status === "partial",
  });
  const onEnrich = () => bulk.runStage("chunk_enrich", [doc.id], { force: (knData?.tag_segments?.length ?? 0) > 0 });
  const onWikiSmartsheet = () => bulk.runStage("wiki_abstract", [doc.id], { force: true });
  const onNoteClassify = () => bulk.runStage("note_classify", [doc.id], { force: (knData?.note_tag_suggestions?.length ?? 0) > 0 });

  /* Modal state · clicking a stage row opens StageDetailModal with
   * live progress + cloud association. Replaces the passive right-
   * column Run inspector — modal is on-demand and shows actionable
   * detail (concurrency · tokens · phase log · Re-run / Retry). */
  const [modalKind, setModalKind] = useState<cloudApi.ProcessingKind | null>(null);
  const onCloseModal = () => setModalKind(null);
  // ── Source-of-truth derivation ──
  // All badges read from the /v1/documents/{id}/kn payload, NOT from
  // metadata flags. metadata can lag the actual processed state.
  //
  // Three pipeline artifacts, two different labels per kind:
  //
  //   Note kind:
  //     E (embed)              — chunks exist in the vector index
  //     R (aisegment)          — line-range tag segments produced by enrich
  //     G (info-graph)         — entities + co-occurrence edges in the graph
  //
  //   Wiki kind:
  //     E (embed)              — chunks exist in the vector index
  //     R (wiki-knowledge-sheet) — per-chapter summary + keywords (Phase B)
  //     G (info-graph)         — entities extracted from chapter abstracts
  //
  // R and G ride the same enrich/Phase-B pass (entity extraction is
  // baked into the segment / chapter writer), so G ≈ R today. Kept
  // as a separate badge because the conceptual artifact is different
  // and they will diverge once graph-rebuild becomes incremental.
  const chunkCount = knData?.chunk_total ?? knData?.chunks.length ?? 0;
  const embeddedChunkCount = knData?.embedded_chunk_count ?? chunkCount;
  const embedded = embeddedChunkCount > 0;

  const segmentCount = knData?.tag_segments.length ?? 0;
  const chapterCount = knData?.wiki_chapters.length ?? 0;
  const summarizedChapters = (knData?.wiki_chapters || []).filter((c) => c.summarized).length;
  const runs = knData?.processing_runs ?? [];
  const clientRun = bulk.runs.get(doc.id);
  const latestRun = (kind: string) => runs.find((r) => r.kind === kind);
  const latestEmbedRun = latestRun("chunk_embed");
  const latestRRun = latestRun(isWiki ? "wiki_abstract" : "chunk_enrich");
  const isRunningStatus = (s?: string | null) => s === "queued" || s === "running" || s === "dispatched";
  const embedRunning = clientRun?.kind === "embed" && (clientRun.status === "running" || clientRun.status === "queued");
  const embedStatus = embedRunning ? clientRun.status : latestEmbedRun?.status;
  const embedProgress = embedRunning && clientRun.progressTotal
    ? { current: clientRun.progressCurrent ?? 0, total: clientRun.progressTotal }
    : undefined;
  const hasDoneJob = runs.some((j) => j.kind === "chunk_enrich" && j.status === "done");

  // R = per-kind AI artifact existence
  const rRunning = isRunningStatus(latestRRun?.status);
  const rFailed = latestRRun?.status === "failed";
  const rDone = isWiki ? summarizedChapters > 0 : (segmentCount > 0 || hasDoneJob);
  const rLabel = isWiki ? "wiki-knowledge-sheet" : "aisegment";
  const rDetail = isWiki
    ? (chapterCount > 0
        ? `${summarizedChapters}/${chapterCount} chapters summarized`
        : "no chapters yet — wiki Phase A produces them on Embedding")
    : (segmentCount > 0
        ? `${segmentCount} segments`
        : (hasDoneJob ? "enrich job done but no segments" : "no enrich pass yet"));

  // G = info-graph. Same truth as R for now — entity upsert rides
  // segment / chapter writes. Future: separate truth when rebuild
  // becomes per-doc incremental.
  const gDone = rDone;

  const cloudReady = bulk.cloudProviderReady;
  const enrichDisabled = bulk.busyKinds.has("enrich") || cloudReady === false;
  const embedDisabled = bulk.busyKinds.has("embed");
  const wikiDisabled = bulk.busyKinds.has("tag") || cloudReady === false;
  const cloudHint = cloudReady === false
    ? "Cloud AI provider not configured — open Cloud panel to add one."
    : null;

  /* Stale flags · cloud-derived authoritative source.
   * /v1/documents/{id}/kn returns stages[kind].stale = true when the
   * stage's last successful run used inputs that no longer match
   * (typically: document content_sha changed, or upstream stage
   * re-ran after this one). The desktop renders stale visually but
   * never auto-fires — user clicks Update explicitly (doc §6.1). */
  const stages = knData?.stages ?? {};
  const embedStale  = !!stages.chunk_embed?.stale;
  const rStale      = !!stages[isWiki ? "wiki_abstract" : "chunk_enrich"]?.stale;
  const topoStale   = !!stages.graph_topology?.stale;
  const topoStatus  = stages.graph_topology?.status;
  const topoRunning = topoStatus === "running" || topoStatus === "queued" || topoStatus === "dispatched";
  const topoFailed  = topoStatus === "failed";
  const topoDone    = topoStatus === "done";
  const linksCount  = knData?.document_links?.length ?? 0;
  // Topology force-run · the Update button always wants a fresh
  // recompute (user clicked because they noticed it's stale).
  const onTopologyUpdate = () => bulk.runStage("graph_topology", [doc.id], { force: true });

  // note_classify state for the Note group (note kind only)
  const ncState     = stages.note_classify;
  const ncStatus    = ncState?.status;
  const ncStale     = !!ncState?.stale;
  const ncRunning   = ncStatus === "running" || ncStatus === "queued" || ncStatus === "dispatched";
  const ncFailed    = ncStatus === "failed";
  const pendingSuggestions = (knData?.note_tag_suggestions ?? [])
    .filter((s) => s.status === "pending").length;
  const ncDone      = ncStatus === "done" || pendingSuggestions > 0;
  const ncDisabled  = bulk.busyKinds.has("tag") || cloudReady === false;

  return (
    <div className="proto-library-card-list">
      <div className="proto-doc-card">
        <div className="proto-doc-card-head">
          <div className="proto-doc-card-title">Pipeline status</div>
          <div className="proto-doc-card-meta">
            {fmtDate(doc.created_at)}
            {doc.updated_at && ` · updated ${fmtDate(doc.updated_at)}`}
            {knLoading && " · loading…"}
          </div>
        </div>

        {/* Stage rows · grouped by category in dependency order
            (Chunk → kind-specific → Graph). Triggers live next to
            the row that owns them; the group head is a soft label
            that gives users a quick read of "what stages exist". */}
        <div className="proto-pipeline-stages">

          <div className="proto-pipeline-stage-group">
            <div className="proto-pipeline-stage-group-head">
              <span className="proto-pipeline-stage-group-name">Chunk</span>
              <span className="proto-pipeline-stage-group-applies-to">embed → enrich</span>
            </div>
            <StageRow
              onClick={() => setModalKind("chunk_embed")}
              letter="E"
              label="embed"
              done={embedded}
              stale={embedStale}
              status={embedStatus}
              message={embedRunning ? clientRun.message : undefined}
              progress={embedProgress}
              count={embedded ? chunkCount : undefined}
              detail={embedded
                ? `${embeddedChunkCount}/${chunkCount} chunks embedded`
                : (errorText(latestEmbedRun?.error) || "no chunks yet")}
              action={
                <RunBtn
                  icon={<Database size={12} />}
                  label={embedStale && embedded ? "Update embed" : (embedded ? "Re-embed" : "Embed")}
                  tone="non-llm"
                  running={bulk.busyKinds.has("embed")}
                  disabled={embedDisabled}
                  onClick={onEmbed}
                  title="Chunk + embed this doc. No LLM calls."
                />
              }
            />
            {/* chunk_enrich · note + plain doc only. Wiki uses
                wiki_abstract instead and rejects chunk_enrich at the
                cloud level. */}
            {!isWiki && (
              <StageRow
                onClick={() => setModalKind("chunk_enrich")}
                letter="R"
                label={rLabel}
                done={rDone}
                stale={rStale}
                status={rRunning ? latestRRun?.status : (rFailed ? "failed" : latestRRun?.status)}
                count={segmentCount > 0 ? segmentCount : undefined}
                detail={errorText(latestRRun?.error) || rDetail}
                action={
                  <RunBtn
                    icon={<Sparkles size={12} />}
                    label={rStale && rDone ? "Update enrich" : (rDone ? "Re-enrich" : "Enrich")}
                    tone="llm"
                    running={bulk.busyKinds.has("enrich")}
                    disabled={enrichDisabled}
                    onClick={onEnrich}
                    title={cloudHint || "LLM classifier + tag generation + segment summaries."}
                  />
                }
              />
            )}
          </div>

          {/* Wiki · per-chapter summaries, wiki kind only. */}
          {isWiki && (
            <div className="proto-pipeline-stage-group">
              <div className="proto-pipeline-stage-group-head">
                <span className="proto-pipeline-stage-group-name">Wiki</span>
                <span className="proto-pipeline-stage-group-applies-to">per-chapter summaries</span>
              </div>
              <StageRow
                onClick={() => setModalKind("wiki_abstract")}
                letter="A"
                label={rLabel}
                done={rDone}
                stale={rStale}
                status={rRunning ? latestRRun?.status : (rFailed ? "failed" : latestRRun?.status)}
                count={summarizedChapters > 0 ? summarizedChapters : undefined}
                detail={errorText(latestRRun?.error) || rDetail}
                action={
                  <RunBtn
                    icon={<LayersIcon size={12} />}
                    label={rStale && summarizedChapters > 0
                      ? "Update abstract"
                      : (summarizedChapters > 0 ? "Rebuild abstract" : "Build abstract")}
                    tone="llm"
                    running={bulk.busyKinds.has("tag")}
                    disabled={wikiDisabled}
                    onClick={onWikiSmartsheet}
                    title={cloudHint || "Per-chapter concept matrix (entities × claims × refs)."}
                  />
                }
              />
            </div>
          )}

          {/* Note · maps line ranges → user custom tags. Note kind only. */}
          {isNote && (
            <div className="proto-pipeline-stage-group">
              <div className="proto-pipeline-stage-group-head">
                <span className="proto-pipeline-stage-group-name">Note</span>
                <span className="proto-pipeline-stage-group-applies-to">user custom tags · review queue</span>
              </div>
              <StageRow
                onClick={() => setModalKind("note_classify")}
                letter="C"
                label="tag-classify"
                done={ncDone}
                stale={ncStale}
                status={ncRunning ? "running" : (ncFailed ? "failed" : undefined)}
                count={pendingSuggestions > 0 ? pendingSuggestions : undefined}
                detail={pendingSuggestions > 0
                  ? `${pendingSuggestions} pending suggestion${pendingSuggestions === 1 ? "" : "s"} — review in Tag suggestions tab`
                  : (ncDone ? "all suggestions reviewed" : "writes note_tag_suggestions for review")}
                action={
                  <RunBtn
                    icon={<Sparkles size={12} />}
                    label={ncStale && ncDone ? "Update classify" : (ncDone ? "Re-classify" : "Run tag-classify")}
                    tone="llm"
                    running={bulk.busyKinds.has("tag")}
                    disabled={ncDisabled}
                    onClick={onNoteClassify}
                    title={cloudHint || "Match line ranges to your workspace custom tags. LLM-powered."}
                  />
                }
              />
            </div>
          )}

          {/* Graph · per-doc topology — runs LAST because it depends
              on Chunk + kind-specific output above. No auto-rerun;
              user clicks Update explicitly when stale (doc §6.1). */}
          <div className="proto-pipeline-stage-group">
            <div className="proto-pipeline-stage-group-head">
              <span className="proto-pipeline-stage-group-name">Graph</span>
              <span className="proto-pipeline-stage-group-applies-to">depends on chunk + kind-specific output above</span>
            </div>
            <StageRow
              onClick={() => setModalKind("graph_topology")}
              letter="T"
              label="topology"
              done={topoDone || linksCount > 0}
              stale={topoStale}
              status={topoRunning ? "running" : (topoFailed ? "failed" : undefined)}
              count={linksCount > 0 ? linksCount : undefined}
              detail={topoStale
                ? "upstream changed since last run · click Update"
                : (topoDone || linksCount > 0
                    ? `${linksCount} cross-doc link${linksCount === 1 ? "" : "s"}`
                    : "no links yet — runs after enrich/abstract/classify")}
              action={
                <RunBtn
                  icon={<NetworkIcon size={12} />}
                  label={topoStale ? "Update topology" : (topoDone || linksCount > 0 ? "Re-run" : "Run")}
                  tone="non-llm"
                  running={bulk.busyKinds.has("graph")}
                  disabled={bulk.busyKinds.has("graph")}
                  onClick={onTopologyUpdate}
                  title="Recompute this doc's relations to others. No LLM calls."
                />
              }
            />
          </div>
        </div>

        {cloudHint && (
          <p className="proto-pipeline-runs-hint">{cloudHint}</p>
        )}
      </div>

      {/* Runs · separate card from Pipeline triggers. The triggers
          are about "what to do next"; this is "what's happened" —
          two distinct mental models so they get their own surfaces. */}
      <div className="proto-doc-card">
        <div className="proto-doc-card-head">
          <div className="proto-doc-card-title">Runs</div>
          <div className="proto-doc-card-meta">history + live progress</div>
        </div>
        <RunHistory
          docId={doc.id}
          clientRuns={bulk.runs}
          processingRuns={knData?.processing_runs ?? []}
          onRetry={(kind, lowerConcurrency) => {
            // Lower-concurrency retry halves max_concurrency for the
            // run; doc §9.3. force is true so the cloud doesn't dedup
            // against the failed input_sha.
            const cloudOptions = lowerConcurrency
              ? { max_concurrency: 4 }
              : undefined;
            bulk.runStage(kind, [doc.id], { force: true, cloudOptions });
          }}
        />
      </div>

      {/* Compact metadata footer — small chrome since contents are
          usually 3-6 short fields and don't deserve a full card. */}
      {doc.metadata && Object.keys(doc.metadata).length > 0 && (
        <div className="proto-pipeline-metadata">
          <span className="proto-pipeline-metadata-label">Metadata</span>
          {Object.entries(doc.metadata)
            .filter(([, v]) => typeof v !== "object")
            .slice(0, 12)
            .map(([k, v]) => (
              <span key={k} className="proto-pipeline-metadata-chip" title={`${k}: ${String(v)}`}>
                <span className="proto-pipeline-metadata-key">{k}</span>
                <span className="proto-pipeline-metadata-val">{String(v).slice(0, 40)}</span>
              </span>
            ))}
        </div>
      )}

      {/* Stage detail modal — opens on stage row click. Carries the
          current /kn stage state + any live client run progress
          so the user sees phase messages (Splitting wiki into
          chapters / Embedded N/M / Writing chunks) and the cloud
          association (endpoint, body, tables touched) in one place. */}
      <StageDetailModal
        open={modalKind !== null}
        stage={modalKind ? buildStageInfo(modalKind, doc, knData, bulk) : null}
        onClose={onCloseModal}
        onRerun={() => {
          if (!modalKind) return;
          bulk.runStage(modalKind, [doc.id], { force: true });
          onCloseModal();
        }}
        onRetry={() => {
          if (!modalKind) return;
          bulk.runStage(modalKind, [doc.id], { force: false });
          onCloseModal();
        }}
      />
    </div>
  );
}

/* Build a StageDetailModal-shaped StageInfo from current state.
 * Pulls authoritative status from knData.stages[kind], live progress
 * from the bulk runs map, and renders the right cost / compute card
 * by kind. Called on demand when the user clicks a stage row. */
function buildStageInfo(
  kind: cloudApi.ProcessingKind,
  doc: cloudApi.CloudDocument,
  knData: cloudApi.DocumentKn | null,
  bulk: BulkRuns,
): StageInfo {
  const stages = knData?.stages || {};
  const stage = stages[kind];
  const runs = (knData?.processing_runs || []).filter((r) => r.kind === kind);
  const latest = runs[0];
  const result = (latest?.result || {}) as Record<string, unknown>;
  // Live client-run for this doc, only when its kind matches —
  // otherwise the running progress would belong to a different stage.
  const clientRun = bulk.runs.get(doc.id);
  const clientRunMatches =
    clientRun
    && (
      (kind === "chunk_embed"    && clientRun.kind === "embed")
      || (kind === "chunk_enrich"  && clientRun.kind === "enrich")
      || (kind === "graph_topology"&& clientRun.kind === "graph")
      || ((kind === "wiki_abstract" || kind === "note_classify") && clientRun.kind === "tag")
    );
  const live = clientRunMatches ? clientRun! : null;

  // Status: prefer live > cloud stage > "pending" fallback.
  const rawStatus =
    (live && (live.status === "queued" || live.status === "running") ? "running"
      : live?.status === "failed" ? "failed"
      : live?.status === "done"   ? "done"
      : stage?.status)
    || (latest?.status as StageStatus | undefined)
    || "pending";
  const normStatus: StageStatus =
    rawStatus === "skipped_dedup" || rawStatus === "skipped_quota" ? "skipped"
    : (rawStatus as StageStatus);

  const NAMES: Record<cloudApi.ProcessingKind, string> = {
    chunk_embed:    "Chunk · Embed",
    chunk_enrich:   "Chunk · Enrich",
    graph_topology: "Graph · Topology",
    wiki_abstract:  "Wiki · Abstract",
    note_classify:  "Note · Tag-classify",
  };
  const STAMPS: Record<cloudApi.ProcessingKind, string> = {
    chunk_embed: "E", chunk_enrich: "R", graph_topology: "T",
    wiki_abstract: "A", note_classify: "C",
  };

  // Cost vs compute card — LLM stages get token totals; fast stages
  // get a "self-hosted compute" pane. Tokens come from result blob.
  const isLlm = kind === "chunk_enrich" || kind === "wiki_abstract" || kind === "note_classify";
  const tokensTotal = typeof result.total_tokens === "number" ? result.total_tokens : null;
  const tokensIn  = typeof result.prompt_tokens === "number" ? result.prompt_tokens : null;
  const tokensOut = typeof result.completion_tokens === "number" ? result.completion_tokens : null;

  const startedMs = live?.startedAt
    ?? (latest?.started_at ? new Date(latest.started_at).getTime() : null);
  const finishedMs = latest?.finished_at ? new Date(latest.finished_at).getTime() : null;
  const durationMs = startedMs && finishedMs ? finishedMs - startedMs : null;

  const errMsg = (() => {
    if (live?.error) return live.error;
    if (typeof latest?.error === "string") return latest.error;
    if (latest?.error && typeof latest.error === "object") {
      const o = latest.error as { message?: unknown };
      if (typeof o.message === "string") return o.message;
    }
    return null;
  })();

  return {
    name: NAMES[kind],
    cloudStage: kind,
    cloudEvent: normStatus === "done" || normStatus === "failed" ? "processing_done" : "processing_progress",
    status: normStatus,
    stamp: STAMPS[kind],
    executor: latest?.executor ?? null,
    purpose: undefined,
    cost: isLlm && tokensTotal != null ? {
      model: typeof result.model === "string" ? result.model : "cloud_pool",
      input_tokens: tokensIn ?? 0,
      output_tokens: tokensOut ?? 0,
      cost_usd: typeof result.cost_usd === "number" ? result.cost_usd : 0,
    } : null,
    compute: !isLlm ? {
      label: kind === "chunk_embed" ? "Self-hosted embedding" : "Deterministic",
      detail: typeof result.chunk_count === "number"
        ? `${result.chunk_count} chunks indexed`
        : (kind === "graph_topology"
            ? `${(knData?.document_links || []).length} links`
            : "—"),
      node: latest?.executor || undefined,
    } : null,
    err: errMsg,
    progressCurrent: live?.progressCurrent,
    progressTotal: live?.progressTotal,
    durationMs,
    payload: latest ? { kind, status: normStatus, result, error: latest.error } : undefined,
    runId: live?.runId ?? latest?.id ?? null,
    documentId: doc.id,
    workspaceId: undefined,
    schemaVersion: 1,
    at: latest?.finished_at ?? latest?.started_at ?? null,
    runStartedAt: startedMs,
    stale: !!stage?.stale,
  };
}

/* StageRow — one row per E/R/G pipeline stage. Letter chip + label +
 * count (when applicable) on the left, trigger button(s) on the
 * right. Replaces the standalone "Run pipeline" toolbar so the
 * action and the state it modifies share visual space.
 */
function StageRow({
  letter, label, done, status, stale, message, progress, count, detail, action, onClick,
}: {
  letter: string;
  label: string;
  done: boolean;
  status?: string;
  /** Cloud-derived: true when the artefact exists but its inputs
   *  changed since last run. Read from knData.stages[kind].stale. */
  stale?: boolean;
  message?: string;
  progress?: { current: number; total: number };
  count?: number;
  detail: string;
  action: React.ReactNode;
  /** Click anywhere on the row body (NOT the action button area) to
   *  open the stage-detail modal. */
  onClick?: () => void;
}) {
  const running = status === "queued" || status === "running" || status === "dispatched";
  const visibleStatus = status === "failed"
    ? "failed"
    : running
      ? status
      : stale && done
        ? "stale"
        : done ? null : "pending";
  const progressPct = progress && progress.total > 0
    ? Math.max(4, Math.min(100, Math.round((progress.current / progress.total) * 100)))
    : undefined;
  return (
    <div
      className={cn(
        "proto-pipeline-stage",
        done && !stale && "proto-pipeline-stage-done",
        running && "proto-pipeline-stage-running",
        stale && done && "proto-pipeline-stage-stale",
        status === "failed" && "proto-pipeline-stage-failed",
        onClick && "proto-pipeline-stage-clickable",
      )}
      onClick={onClick ? (e) => {
        // Don't fire when the click started on an action button — those
        // own their own handlers and would be ambiguous if we also opened
        // the modal in parallel.
        if ((e.target as HTMLElement).closest(".proto-pipeline-stage-actions")) return;
        onClick();
      } : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      } : undefined}
    >
      <span className="proto-pipeline-stage-letter" aria-hidden="true">{letter}</span>
      <span className="proto-pipeline-stage-main">
        <span className="proto-pipeline-stage-label" title={detail}>
          {label}
          {typeof count === "number" && (
            <span className="proto-pipeline-stage-count">·&nbsp;{count}</span>
          )}
          {visibleStatus && (
            <span className="proto-pipeline-stage-pending">·&nbsp;{visibleStatus}</span>
          )}
        </span>
        {running && (
          <span className="proto-pipeline-stage-live">
            <span>{message || "Cloud is working"}</span>
            {progress && progress.total > 0 && (
              <span>{progress.current}/{progress.total}</span>
            )}
          </span>
        )}
        {running && (
          <span className="proto-pipeline-stage-progress" aria-hidden="true">
            <span style={{ width: progressPct ? `${progressPct}%` : undefined }} />
          </span>
        )}
      </span>
      <span className="proto-pipeline-stage-actions">{action}</span>
    </div>
  );
}

/* RunHistory — collapsible feed of all runs that touched this doc.
 *
 * Sources merged:
 *   1. clientRuns from useBulkRuns (this session, instant).
 *   2. cloud processing_runs from /v1/documents/{id}/kn (persistent —
 *      includes runs from previous sessions and MCP-triggered ones).
 *
 * Sort is recency-first; the top row is auto-expanded so the user
 * sees the latest result without a click. Older rows collapse to a
 * single status line and expand on click.
 */
/* Map a free-form cloud error string to the typed code we use for
 * recovery routing. Cloud doesn't ship typed error envelopes yet
 * (doc §9.1 / §10), so the desktop pattern-matches the legacy
 * messages. Once cloud lands the typed envelope, switch to reading
 * the code field directly. */
type ErrorCode =
  | "provider_timeout"
  | "provider_rate_limit"
  | "provider_auth"
  | "no_executor_available"
  | "no_user_tags"
  | "input_too_large"
  | "internal"
  | "unknown";

function inferErrorCode(error?: string | null): ErrorCode {
  if (!error) return "unknown";
  const s = error.toLowerCase();
  if (s.includes("timeout") || s.includes("timed out") || s.includes("readtimeout")) return "provider_timeout";
  if (s.includes("rate limit") || s.includes("429") || s.includes("too many requests")) return "provider_rate_limit";
  if (s.includes("unauthorized") || s.includes("invalid api key") || s.includes("401") || s.includes("403")) return "provider_auth";
  if (s.includes("no executor") || s.includes("no provider") || s.includes("412")) return "no_executor_available";
  if (s.includes("no user tags") || s.includes("no_user_tags")) return "no_user_tags";
  if (s.includes("too large") || s.includes("input_too_large") || s.includes("413")) return "input_too_large";
  return "internal";
}

function recoveryHintFor(code: ErrorCode): string | null {
  switch (code) {
    case "provider_timeout":     return "Provider timed out. Retry with lower concurrency or raise the timeout.";
    case "provider_rate_limit":  return "Hit provider rate limit. Retry shortly or check your provider quota.";
    case "provider_auth":        return "Provider rejected the API key. Open provider settings.";
    case "no_executor_available":return "No executor available. Configure a Cloud AI provider.";
    case "no_user_tags":         return "Note classify needs at least one custom tag. Open tag settings.";
    case "input_too_large":      return "Document too large for this model. Try a smaller doc or a different provider.";
    case "internal":             return "Cloud-side error. Retry once; if it persists, copy the run id for support.";
    default:                     return null;
  }
}

function openCloudPanel() {
  // Loose-coupling: AtelierShell listens for this custom event and
  // opens the Cloud modal. Falls back to a no-op when nothing's
  // wired up (still safe for the prototype).
  try { window.dispatchEvent(new CustomEvent("smartnote:open-cloud")); } catch { /* silent */ }
}

function RunHistory({
  docId, clientRuns, processingRuns, onRetry,
}: {
  docId: string;
  clientRuns: Map<string, import("./bulkTypes").RunStatus>;
  processingRuns: NonNullable<cloudApi.DocumentKn["processing_runs"]>;
  /** Trigger a retry of `kind` for this doc. `lowerConcurrency` is
   *  set when the user picks the "lower concurrency" recovery CTA. */
  onRetry: (kind: cloudApi.ProcessingKind, lowerConcurrency?: boolean) => void;
}) {
  type Row = {
    id: string;
    /** Cloud-persisted run_id when known. Client-only rows from
     *  bulk dispatch may not have one yet (the WS event back-fills
     *  it). Used for the visible short id column. */
    runId?: string;
    kind: string;
    status: "queued" | "running" | "done" | "failed";
    when: number;
    durationMs?: number;
    detail: string;
    error?: string;
    extra?: Record<string, string | number>;
  };

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    // Client-side runs scoped to this doc.
    for (const [id, r] of clientRuns) {
      if (id !== docId) continue;
      const finished = r.finishedAt ?? Date.now();
      out.push({
        id: `client:${id}:${r.startedAt}`,
        runId: r.runId,
        kind: r.kind,
        status: r.status,
        when: r.startedAt,
        durationMs: r.finishedAt ? r.finishedAt - r.startedAt : undefined,
        detail: r.status === "running" ? "in progress" : r.status,
        error: r.error,
        extra: {
          source: "client",
          ...(r.message ? { message: r.message } : {}),
          ...(r.progressTotal ? { progress: `${r.progressCurrent ?? 0}/${r.progressTotal}` } : {}),
        },
      });
      void finished;
    }
    // Cloud-persisted processing ledger.
    for (const r of processingRuns) {
      const started = r.started_at || r.created_at;
      const startedMs = started ? new Date(started).getTime() : 0;
      const finishedMs = r.finished_at ? new Date(r.finished_at).getTime() : undefined;
      const result = (r.result || {}) as Record<string, unknown>;
      out.push({
        id: `run:${r.id}`,
        runId: r.id,
        kind: r.kind,
        status: normalizeRunStatus(r.status),
        when: startedMs,
        durationMs: finishedMs && startedMs ? finishedMs - startedMs : undefined,
        detail: r.executor || "—",
        error: typeof r.error === "string" ? r.error : r.error?.message ? String(r.error.message) : undefined,
        extra: {
          executor: r.executor || "—",
          ...(typeof result.chunk_count === "number" ? { chunks: result.chunk_count } : {}),
          ...(typeof result.total_tokens === "number" ? { tokens: result.total_tokens.toLocaleString() } : {}),
          ...(r.revision ? { revision: r.revision } : {}),
        },
      });
    }
    return out.sort((a, b) => b.when - a.when);
  }, [docId, clientRuns, processingRuns]);

  if (rows.length === 0) {
    return (
      <div className="proto-pipeline-runs-empty">
        No runs yet for this document.
      </div>
    );
  }

  // Compose a one-line "detail" for each row that combines what the
  // prototype's `desc` column shows: executor, key result fields, and
  // tokens. The prototype is a flat table — no expand-collapse, no
  // KV grid — so all signal must live in this one cell.
  function describe(r: Row): string {
    const parts: string[] = [];
    if (r.extra?.executor) parts.push(String(r.extra.executor));
    if (r.extra?.chunks)   parts.push(`${r.extra.chunks} chunks`);
    if (r.extra?.tokens)   parts.push(`${r.extra.tokens} tokens`);
    if (r.extra?.progress) parts.push(`progress ${r.extra.progress}`);
    if (r.extra?.message)  parts.push(String(r.extra.message));
    if (r.error)           parts.push(r.error);
    return parts.join(" · ") || r.detail || "—";
  }

  return (
    <div className="proto-pipeline-runs-mini">
      <div className="proto-pipeline-runs-mini-head">
        <span>id</span>
        <span>kind</span>
        <span>status</span>
        <span>detail</span>
        <span style={{ textAlign: "right" }}>when</span>
        <span style={{ textAlign: "right" }}>dur</span>
      </div>
      <div className="proto-pipeline-runs-mini-scroll">
      {rows.map((r) => {
        const errorCode = r.status === "failed" ? inferErrorCode(r.error) : null;
        const hint = errorCode ? recoveryHintFor(errorCode) : null;
        const kind = r.kind as cloudApi.ProcessingKind;
        const isProcKind = ([
          "chunk_embed", "chunk_enrich", "graph_topology", "wiki_abstract", "note_classify",
        ] as const).includes(kind as never);
        return (
          <div
            key={r.id}
            className={cn(
              "proto-pipeline-runs-mini-row",
              `proto-pipeline-runs-mini-row-${r.status}`,
            )}
          >
            <span className="proto-pipeline-runs-mini-runid" title={r.runId ? `run_id ${r.runId}` : undefined}>
              {r.runId ? r.runId.slice(0, 8) : "—"}
            </span>
            <span className="proto-pipeline-runs-mini-kind">{r.kind.toUpperCase()}</span>
            <span className="proto-pipeline-runs-mini-status">{r.status}</span>
            <span className="proto-pipeline-runs-mini-desc" title={describe(r)}>
              {describe(r)}
            </span>
            <span className="proto-pipeline-runs-mini-when">{fmtRelative(r.when)}</span>
            <span className="proto-pipeline-runs-mini-dur">
              {typeof r.durationMs === "number" ? fmtDuration(r.durationMs) : "—"}
            </span>
            {/* Failed row · inline recovery line. Same row container
                so the visual remains a single row in the table; the
                recovery actions wrap to a second line via the CSS
                grid-column: 1 / -1 in atelier.css. */}
            {r.status === "failed" && (
              <div className="proto-pipeline-runs-mini-recovery" onClick={(e) => e.stopPropagation()}>
                {hint && <span className="hint">{hint}</span>}
                {isProcKind && (
                  <button type="button" className="proto-library-btn" onClick={() => onRetry(kind)}>
                    Retry
                  </button>
                )}
                {isProcKind && errorCode === "provider_timeout" && (
                  <button type="button" className="proto-library-btn" onClick={() => onRetry(kind, true)}>
                    Lower concurrency
                  </button>
                )}
                {(errorCode === "provider_timeout"
                  || errorCode === "provider_rate_limit"
                  || errorCode === "provider_auth"
                  || errorCode === "no_executor_available") && (
                  <button type="button" className="proto-library-btn" onClick={openCloudPanel}>
                    Provider settings
                  </button>
                )}
                {errorCode === "no_user_tags" && (
                  <button type="button" className="proto-library-btn" onClick={openCloudPanel}>
                    Open tag settings
                  </button>
                )}
                {r.runId && (
                  <button
                    type="button"
                    className="proto-library-btn"
                    onClick={() => navigator.clipboard?.writeText(r.runId!).catch(() => {})}
                    title="Copy full run id"
                  >
                    Copy run id
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}

/* LibraryLanding · zero-docs onboarding screen.
 *
 * Replaces the workspace-controls panel when the workspace is empty
 * — those controls (graph rebuild, re-embed, tags) need docs to
 * operate on, so showing them on an empty Library reads as "things
 * I should do" when really they'd no-op. This screen instead
 * explains the processing model and offers a single Import CTA.
 *
 * Triggered visibility: docs.length === 0 (post-load, not just
 * mid-fetch — the loading state shows a lighter "loading…" line).
 */
function LibraryLanding({ onImport, importing }: { onImport: () => void; importing: boolean }) {
  return (
    <div className="proto-library-landing">
      <div className="proto-library-landing-hero">
        <div className="proto-library-landing-icon" aria-hidden="true">
          <Library size={22} strokeWidth={1.5} />
        </div>
        <h2 className="proto-library-landing-title">Welcome to your Library</h2>
        <p className="proto-library-landing-sub">
          Bring documents in and SmartNote will chunk, embed, classify, and link them
          into a retrieval-ready knowledge base.
        </p>
        <div className="proto-library-landing-cta">
          <button
            type="button"
            className="proto-library-btn proto-library-btn-primary"
            onClick={onImport}
            disabled={importing}
          >
            <Upload size={12} strokeWidth={2} />
            {importing ? "Uploading…" : "Import .md / .txt files"}
          </button>
          <span className="proto-library-landing-or">
            or sync a note from the <b>Note</b> tab.
          </span>
        </div>
      </div>

      <div className="proto-library-landing-section">
        <h3>How processing works</h3>
        <p>
          Each document runs through up to four stages, in order. Stages depend on
          the document kind — notes get classification, wiki topics get chapter
          abstracts. Topology runs last to link this document to the rest.
        </p>
      </div>

      <div className="proto-library-landing-stages">
        <LandingStage
          letter="E"
          name="Embed"
          tone="fast"
          mark="FAST · NO LLM"
          desc="Cuts the document into chunks and stores their vector representations. Powers semantic retrieval (the V in 6-path)."
        />
        <LandingStage
          letter="R"
          name="Enrich"
          tone="llm"
          mark="LLM · TOKEN COST"
          desc="Per-segment tag classification + summaries + entity extraction. Populates Segments and the entity graph for non-wiki docs."
        />
        <LandingStage
          letter="A"
          name="Wiki Abstract"
          tone="llm"
          mark="LLM · TOKEN COST · WIKI ONLY"
          desc="Per-chapter summary + keywords for wiki-topic docs. Replaces Enrich for wiki kind — chapter abstracts are the natural unit."
        />
        <LandingStage
          letter="C"
          name="Tag-classify"
          tone="custom"
          mark="LLM · USER TAGS · NOTE ONLY"
          desc="For notes only. Reviews each line range against your custom tags and queues suggestions you Accept or Dismiss."
        />
        <LandingStage
          letter="T"
          name="Topology"
          tone="fast"
          mark="FAST · NO LLM"
          desc="Links this document to others via shared entities, shared tags, semantic similarity, or shared topic. Refreshes after upstream changes."
        />
      </div>

      <div className="proto-library-landing-section">
        <h3>What the right column shows</h3>
        <p>
          Once a document is open, the Inspector on the right reflects the current
          tab — run state for Pipeline, neighbours for Chunks, accept/dismiss for Tag
          suggestions, evidence for Graph links.
        </p>
      </div>
    </div>
  );
}

function LandingStage({
  letter, name, tone, mark, desc,
}: { letter: string; name: string; tone: "fast" | "llm" | "custom"; mark: string; desc: string }) {
  return (
    <div className={cn("proto-library-landing-stage", `proto-library-landing-stage-${tone}`)}>
      <span className="proto-library-landing-stage-letter">{letter}</span>
      <div className="proto-library-landing-stage-body">
        <div className="proto-library-landing-stage-head">
          <span className="proto-library-landing-stage-name">{name}</span>
          <span className={cn("proto-library-landing-stage-mark", `mark-${tone}`)}>{mark}</span>
        </div>
        <p className="proto-library-landing-stage-desc">{desc}</p>
      </div>
    </div>
  );
}

/* Bulk View — replaces the single-doc detail when ≥1 doc is checked.
 *
 * Per integration doc §5: lists every selected file with its
 * per-stage execution plan (run / re-run / retry / skip / auto)
 * so the user sees exactly what "Run" will dispatch. The execution
 * order panel makes dependency direction explicit (chunk → kind-
 * specific → topology). */
type BulkVerdict = "run" | "rerun" | "retry" | "skip" | "auto";
type BulkKind = "notes" | "wiki" | "doc";

const BULK_STAGES: Record<BulkKind, { kind: cloudApi.ProcessingKind; label: string }[]> = {
  notes: [
    { kind: "chunk_embed", label: "embed" },
    { kind: "chunk_enrich", label: "enrich" },
    { kind: "note_classify", label: "tag-classify" },
    { kind: "graph_topology", label: "topology" },
  ],
  wiki: [
    { kind: "chunk_embed", label: "embed" },
    { kind: "wiki_abstract", label: "abstract" },
    { kind: "graph_topology", label: "topology" },
  ],
  doc: [
    { kind: "chunk_embed", label: "embed" },
    { kind: "chunk_enrich", label: "enrich" },
    { kind: "graph_topology", label: "topology" },
  ],
};

function bulkVerdict(state: StageState | undefined, isTopology: boolean, upstreamReady: boolean): BulkVerdict {
  if (state === "failed") return "retry";
  if (state === "running" || state === "queued") return "run";   // de-dup waits server-side
  if (state === "done" || state === "partial" || state === "skipped") {
    return "skip";
  }
  if (isTopology && !upstreamReady) return "auto";
  return "run";
}

function selectionKind(docs: cloudApi.CloudDocument[]): BulkKind {
  if (docs.length === 0) return "doc";
  const k = kindOf(docs[0]);
  return k === "wiki_topic" ? "wiki" : k === "note" ? "notes" : "doc";
}

function BulkView({
  selected, docs, statesMap, bulk, onClearSelection,
}: {
  selected: Set<string>;
  docs: cloudApi.CloudDocument[];
  statesMap: Map<string, DocStates>;
  bulk: BulkRuns;
  onClearSelection: () => void;
}) {
  const selectedDocs = useMemo(
    () => docs.filter((d) => selected.has(d.id)),
    [docs, selected],
  );
  const kind = selectionKind(selectedDocs);
  const stages = BULK_STAGES[kind];

  // Per-stage verdict counts — drive the execution-order summary.
  const counts: Record<string, Record<BulkVerdict, number>> = {};
  for (const s of stages) counts[s.kind] = { run: 0, rerun: 0, retry: 0, skip: 0, auto: 0 };

  // Per-file rows
  const rows = selectedDocs.map((d) => {
    const ds = statesMap.get(d.id);
    // Upstream is ready when the kind-specific stage finished. For
    // notes the upstream of topology = note_classify (or chunk_enrich
    // if note_classify hasn't run); for wiki it's wiki_abstract; for
    // doc it's chunk_enrich. Defensive default: if any upstream is
    // queued/running, mark topology as `auto`.
    const upstreamRunning = stages
      .filter((s) => s.kind !== "graph_topology" && s.kind !== "chunk_embed")
      .some((s) => {
        const st = ds?.[stageKey(s.kind)];
        return st === "running" || st === "queued";
      });
    const upstreamReady = !upstreamRunning;
    const stageVerdicts = stages.map((s) => {
      const st = ds?.[stageKey(s.kind)];
      const v = bulkVerdict(st, s.kind === "graph_topology", upstreamReady);
      counts[s.kind][v]++;
      return { stage: s, verdict: v };
    });
    const ageMs = d.updated_at ? Date.now() - new Date(d.updated_at).getTime() : null;
    const ageStr = ageMs == null ? "—" :
      ageMs < 3_600_000 ? `${Math.max(1, Math.round(ageMs / 60_000))}m`
      : ageMs < 86_400_000 ? `${Math.round(ageMs / 3_600_000)}h`
      : `${Math.round(ageMs / 86_400_000)}d`;
    return { d, stageVerdicts, ageStr };
  });

  return (
    <div className="proto-bulk-view">
      <div className="proto-bulk-head">
        <div>
          <h2>{selectedDocs.length} {kind === "wiki" ? "wiki" : kind === "notes" ? "note" : "doc"}{selectedDocs.length === 1 ? "" : "s"} · bulk processing</h2>
          <div className="sub">
            Stages run in dependency order — Topology runs last.
            <button
              type="button"
              onClick={onClearSelection}
              style={{ marginLeft: 10, fontSize: 11, textDecoration: "underline", background: "none", border: "none", color: "var(--color-text-muted)", cursor: "pointer" }}
            >
              clear selection
            </button>
          </div>
        </div>
        <div>
          <h5>Execution order</h5>
          <div className="proto-bulk-order">
            {stages.map((s, i) => {
              const c = counts[s.kind];
              const parts: string[] = [];
              if (c.run)   parts.push(`${c.run} run`);
              if (c.rerun) parts.push(`${c.rerun} re-run`);
              if (c.retry) parts.push(`${c.retry} retry`);
              if (c.skip)  parts.push(`${c.skip} skip`);
              if (c.auto)  parts.push(`${c.auto} auto`);
              return (
                <div key={s.kind} className="proto-bulk-order-step">
                  <span className="num">{i + 1}</span>
                  <span className="kind">{s.label}</span>
                  <span className="verdict">{parts.join(" · ") || "—"}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="proto-bulk-files">
        {rows.map(({ d, stageVerdicts, ageStr }) => (
          <div key={d.id} className={cn("proto-bulk-file", kind === "wiki" && "wiki")}>
            <div className="proto-bulk-file-head">
              <span className="proto-bulk-file-name">{d.name}</span>
              <span className="proto-bulk-file-meta">{Math.round(d.byte_size / 1024)}k · {ageStr}</span>
            </div>
            <div className="proto-bulk-stages">
              {stageVerdicts.map(({ stage, verdict }) => (
                <span key={stage.kind} className={cn("proto-bulk-stage", verdict)}>
                  {stage.label} · {verdict}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* Helper · DocStates property name for a ProcessingKind. The map's
 * keys are ProcessingKind names directly with the legacy ai_enrich
 * fallback for chunk_enrich. */
function stageKey(kind: cloudApi.ProcessingKind): keyof DocStates {
  return kind as keyof DocStates;
}

/* Tree row bit composition.
 *
 * Notes →  [chunk_embed][chunk_enrich][graph_topology][note_classify]
 * Wiki  →  [chunk_embed][wiki_abstract][graph_topology]
 * Doc   →  [chunk_embed][chunk_enrich][graph_topology]
 *
 * Each bit's class:
 *   on    — done
 *   run   — queued/running (blinks)
 *   fail  — failed
 *   gtop  — special tint for completed graph_topology so users spot
 *           docs that have joined the cross-doc network at a glance
 *   ""    — not run yet
 */
type BitKind = "on" | "run" | "fail" | "gtop" | "";

function bitOf(state: StageState | undefined, isTopology: boolean): BitKind {
  if (state === "running" || state === "queued") return "run";
  if (state === "failed")  return "fail";
  if (state === "done" || state === "partial" || state === "skipped") {
    return isTopology ? "gtop" : "on";
  }
  return "";
}

function treeBitsFor(d: cloudApi.CloudDocument, ds: DocStates | undefined): {
  bits: BitKind[];
  label: { text: string; tone?: "fail" | "run" };
} {
  const kind = kindOf(d);
  // chunk_enrich is the canonical name; ai_enrich kept as a legacy
  // mirror in older runs.
  const enrich = ds?.chunk_enrich ?? ds?.ai_enrich;
  const embed   = ds?.chunk_embed;
  const topo    = ds?.graph_topology;
  const wikiAb  = ds?.wiki_abstract;
  const note    = ds?.note_classify;

  const bits: BitKind[] = kind === "wiki_topic"
    ? [bitOf(embed, false), bitOf(wikiAb, false), bitOf(topo, true)]
    : kind === "note"
      ? [bitOf(embed, false), bitOf(enrich, false), bitOf(topo, true), bitOf(note, false)]
      : [bitOf(embed, false), bitOf(enrich, false), bitOf(topo, true)];

  // Derive a one-liner status label that matches user mental model.
  if (bits.includes("run"))  return { bits, label: { text: "processing", tone: "run" } };
  if (bits.includes("fail")) {
    const failed = enrich === "failed" ? "enrich failed"
      : embed === "failed" ? "embed failed"
      : wikiAb === "failed" ? "abstract failed"
      : note === "failed" ? "classify failed"
      : topo === "failed" ? "topology failed"
      : "run failed";
    return { bits, label: { text: failed, tone: "fail" } };
  }
  const done = bits.filter((b) => b === "on" || b === "gtop").length;
  if (done === 0) return { bits, label: { text: "not processed" } };
  if (done === bits.length) return { bits, label: { text: "all done" } };
  if (bits[0] === "on" && done === 1) return { bits, label: { text: "embed only" } };
  return { bits, label: { text: `${done}/${bits.length} done` } };
}

function fmtRelative(ms: number): string {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function normalizeRunStatus(status: string): "queued" | "running" | "done" | "failed" {
  if (status === "done" || status === "skipped_dedup" || status === "skipped_quota") return "done";
  if (status === "queued") return "queued";
  if (status === "running" || status === "dispatched") return "running";
  return "failed";
}

function errorText(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || "");
  }
  return String(error);
}

/* GraphTab — workspace entity graph viewer. The "Rebuild graph"
 * trigger that used to live on the Pipeline tab was misleading
 * (it just re-fetched). This tab renders the actual graph data:
 * nodes ranked by mention count, plus the strongest relations.
 *
 * Workspace-scope by design — the cloud /v1/graph endpoint returns
 * the whole graph. Filtering down to "this doc's neighborhood" is
 * a future enhancement once the API exposes per-doc node ids.
 */
function GraphTab({ doc, knData, onRunEnrich, onRunTopology }: {
  doc: cloudApi.CloudDocument;
  knData: cloudApi.DocumentKn | null;
  onRunEnrich?: () => void;
  onRunTopology?: () => void;
}) {
  const [data, setData] = useState<cloudApi.CloudGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    cloudApi.fetchGraph(150)
      .then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch((e) => {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => { alive = false; };
  }, []);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const d = await cloudApi.fetchGraph(150);
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  /* Per-doc related section · pulls from /kn document_links (graph_topology
   * output for THIS doc). Empty when topology hasn't run, when there's
   * only 1 doc in workspace, or when the run found no shared entities/
   * tags/topics. We explain WHY in the empty state — a generic "no
   * data" message confused users who expected "I just ran topology". */
  const links = knData?.document_links || [];
  const topoStage = knData?.stages?.graph_topology;
  const topoStatus = topoStage?.status;
  const topoNeverRan = !topoStatus || topoStatus === "idle" || topoStatus === "unavailable";
  const topoRunning = topoStatus === "running" || topoStatus === "queued" || topoStatus === "dispatched";
  const totalDocs = data?.stats.total_chunks ? null : null; // (no doc_count yet; fall back to candidates)
  const candidates = topoStage?.result && typeof topoStage.result === "object"
    ? (topoStage.result as { candidates?: number }).candidates
    : null;
  // The real reason topology produces 0 links: this doc has no
  // segments/chapters yet, so it has no entities for topology to
  // match against. Surface that explicitly so the user knows to
  // run Enrich (or wiki_abstract) FIRST, not Topology again.
  const enrichStage = knData?.stages?.chunk_enrich;
  const wikiStage = knData?.stages?.wiki_abstract;
  const enrichDone = enrichStage?.status === "done" || enrichStage?.status === "partial";
  const wikiDone = wikiStage?.status === "done" || wikiStage?.status === "partial";
  const isWikiDoc = (knData?.kind || "") === "wiki_topic";
  const semanticDone = isWikiDoc ? wikiDone : enrichDone;
  const semanticStageLabel = isWikiDoc ? "wiki_abstract" : "chunk_enrich";

  return (
    <div className="proto-pipeline-graph">

      {/* SECTION 1 · This document · related (per-doc graph_topology) */}
      <div className="proto-pipeline-graph-head">
        <div>
          <div className="proto-pipeline-graph-title">This document · related</div>
          <div className="proto-pipeline-graph-stats">
            graph_topology · {links.length.toLocaleString()} cross-doc link{links.length === 1 ? "" : "s"}
            {topoStatus && ` · status: ${topoStatus}`}
          </div>
        </div>
      </div>

      {links.length > 0 ? (
        <div className="proto-related-list">
          {[...links].sort((a, b) => b.score - a.score).map((l, i) => {
            // Best-effort evidence string from link.evidence jsonb.
            const ev = (l.evidence || {}) as Record<string, unknown>;
            const ents = Array.isArray(ev.entities) ? (ev.entities as string[]) : [];
            const tags = Array.isArray(ev.tags) ? (ev.tags as string[]) : [];
            const evidencePill =
              l.relation_type === "shared_entity" ? "shared entities" :
              l.relation_type === "shared_tag" ? "shared tags" :
              l.relation_type === "same_topic" ? "same topic" :
              l.relation_type === "references" ? "references" :
              l.relation_type === "semantic_similarity" ? "cosine" :
              l.relation_type.replace(/_/g, " ");
            const evidenceText = ents.length
              ? ents.slice(0, 4).join(" · ")
              : tags.length
                ? tags.slice(0, 4).join(" · ")
                : "";
            return (
              <div key={`${l.target_document_id}-${l.relation_type}-${i}`} className="proto-rel-row">
                <div>
                  <div className="proto-rel-name">{l.target_name}</div>
                  <div className="proto-rel-evidence">
                    <span className="proto-rel-pill">{evidencePill}</span>
                    {evidenceText && <span>{evidenceText}</span>}
                  </div>
                </div>
                <span className="proto-rel-type">{l.relation_type.toUpperCase()}</span>
                <span className="proto-rel-score">{l.score.toFixed(2)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="proto-pipeline-graph-empty">
          {topoRunning && "Topology is running — links will appear when it completes."}
          {topoNeverRan && !semanticDone && (
            <>
              <p style={{ margin: "0 0 8px" }}>
                Topology hasn't run yet for this doc. Cross-doc links need entities, which come from <b>{semanticStageLabel}</b>.
              </p>
              <p style={{ margin: "0 0 10px", color: "var(--color-text-muted)" }}>
                Order: <b>chunk_embed → {semanticStageLabel} → graph_topology</b>. Without the middle step there are no entities to match across documents.
              </p>
              {onRunEnrich && (
                <button type="button" className="proto-library-btn" onClick={onRunEnrich}>
                  ▶ Run {semanticStageLabel}
                </button>
              )}
            </>
          )}
          {topoNeverRan && semanticDone && (
            <>
              <p style={{ margin: "0 0 10px" }}>
                {semanticStageLabel} is done. Now run topology to compute links to other docs.
              </p>
              {onRunTopology && (
                <button type="button" className="proto-library-btn" onClick={onRunTopology}>
                  ▶ Run graph_topology
                </button>
              )}
            </>
          )}
          {!topoRunning && !topoNeverRan && !semanticDone && (
            <>
              <p style={{ margin: "0 0 6px" }}>
                Topology ran but found <b>0 links</b> — this doc has no <b>{semanticStageLabel}</b> output yet, so there are no entities to match.
              </p>
              <p style={{ margin: "0 0 10px", color: "var(--color-text-muted)" }}>
                Fix: run <b>{semanticStageLabel}</b> first, then re-run topology. The "0 candidates" you may see is misleading — it's gated on entity extraction, not document count.
              </p>
              {onRunEnrich && (
                <button type="button" className="proto-library-btn" onClick={onRunEnrich}>
                  ▶ Run {semanticStageLabel}
                </button>
              )}
            </>
          )}
          {!topoRunning && !topoNeverRan && semanticDone && (
            <>
              <p style={{ margin: "0 0 6px" }}>
                Topology ran but found <b>{candidates ?? 0}</b> candidate{(candidates ?? 0) === 1 ? "" : "s"} — <b>0 links produced</b>.
              </p>
              <p style={{ margin: 0, color: "var(--color-text-muted)" }}>
                Cross-doc links need <b>2+ documents</b> in the workspace with shared entities, tags, or semantic similarity. Add more docs and run {semanticStageLabel} on them.
              </p>
            </>
          )}
        </div>
      )}

      {/* SECTION 2 · Workspace knowledge graph (entity-level rollup) */}
      <div className="proto-pipeline-graph-head" style={{ marginTop: 18 }}>
        <div>
          <div className="proto-pipeline-graph-title">Workspace knowledge graph</div>
          <div className="proto-pipeline-graph-stats">
            {loading
              ? "loading…"
              : error
                ? `error: ${error}`
                : data
                  ? `${data.stats.total_entities.toLocaleString()} entities · ${data.stats.total_chunks.toLocaleString()} chunks · ${data.edges.length.toLocaleString()} edges (top 150)`
                  : "—"}
          </div>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="proto-library-btn"
          disabled={loading}
          title="Re-fetch the latest workspace graph from the cloud"
        >
          {loading
            ? <Loader2 size={11} className="animate-spin" />
            : <NetworkIcon size={11} strokeWidth={2} />}
          Refresh
        </button>
      </div>

      {(() => {
        if (loading) return <KnEmpty msg="loading workspace graph…" />;
        if (error)   return <KnEmpty msg={`Could not load graph: ${error}`} />;
        if (!data || data.nodes.length === 0) {
          return (
            <div className="proto-pipeline-graph-empty">
              <p style={{ margin: 0, color: "var(--color-text-muted)" }}>
                No entities in the workspace yet. Run <b>Enrich</b> (chunk_enrich / wiki_abstract / note_classify) on docs to populate entities.
              </p>
            </div>
          );
        }
        return null;
      })()}

      {data && data.nodes.length > 0 && (() => {
        const topNodes = [...data.nodes].sort((a, b) => b.mentions - a.mentions).slice(0, 24);
        const topEdges = [...data.edges].sort((a, b) => b.weight - a.weight).slice(0, 20);
        const maxMentions = topNodes[0]?.mentions || 1;
        return <GraphSections topNodes={topNodes} topEdges={topEdges} maxMentions={maxMentions} />;
      })()}
    </div>
  );
}

/* GraphSections — workspace-level entity graph, rendered as a
 * 2-column grid per the prototype (Top entities ◇ Doc-Doc edges).
 * Each column is a bordered card with a small monospaced header. */
function GraphSections({ topNodes, topEdges, maxMentions }: {
  topNodes: cloudApi.CloudGraphNode[];
  topEdges: cloudApi.CloudGraphEdge[];
  maxMentions: number;
}) {
  return (
    <div className="proto-graph-cols">
      <section className="proto-graph-card">
        <h4 className="proto-graph-card-head">Top entities · by mention</h4>
        <div className="proto-graph-card-body">
          {topNodes.map((n) => (
            <div key={n.id} className="proto-gnode" title={`${n.name} (${n.type}) · ${n.mentions} mentions`}>
              <span className="proto-gnode-name">{n.name}</span>
              <span className="proto-gnode-type">{n.type}</span>
              <span className="proto-gnode-bar" aria-hidden="true">
                <span
                  className="proto-gnode-bar-fill"
                  style={{ width: `${Math.round((n.mentions / maxMentions) * 100)}%` }}
                />
              </span>
              <span className="proto-gnode-count">{n.mentions}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="proto-graph-card">
        <h4 className="proto-graph-card-head">Document ↔ Document · graph_topology</h4>
        <div className="proto-graph-card-body">
          {topEdges.length === 0 && (
            <div className="proto-graph-empty-row">
              No edges yet. Run Topology on multiple docs to build the link map.
            </div>
          )}
          {topEdges.map((e, i) => (
            <div key={`${e.source}-${e.target}-${i}`} className="proto-gedge">
              <span className="proto-gedge-from">{e.source_name}</span>
              <span className="proto-gedge-rel">{e.relation || "co-mention"}</span>
              <span className="proto-gedge-to">{e.target_name}</span>
              <span className="proto-gedge-w">{e.weight.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ChunksTab — matches prototypes/library-redesign-b.html § CHUNKS.
 *
 * Two tables stacked:
 *   1. Embedding · chunk_embed    → # / Dim / Lines / Preview / Chars / Source
 *   2. Enrichment overlay         → # / Lines / Topic / Keywords / Status
 *      (rendered from tag_segments for notes/docs, wiki_chapters for wikis)
 */
function ChunksTab({ knData, knLoading }: { knData: cloudApi.DocumentKn | null; knLoading: boolean }) {
  if (knLoading) return <KnEmpty msg="loading…" />;
  if (!knData || knData.chunks.length === 0) {
    return <KnEmpty msg="Not yet embedded. Run Embedding from KP." />;
  }

  const totalChars = knData.chunks.reduce((n, c) => n + (c.text?.length || 0), 0);
  const embedDim = knData.chunks[0]?.dimension || "";

  // Enrichment overlay rows. Prototype shows topic + keywords + status
  // per chunk. Our chunk_enrich produces *segments* (not per-chunk
  // overlay), so we surface segments (notes/docs) or chapters (wiki)
  // as the closest equivalent. Empty when neither has data yet.
  type EnrichRow = { idx: number; lines: string; topic: string; keywords: string[]; status: string };
  const enrichRows: EnrichRow[] = [];
  if (knData.tag_segments && knData.tag_segments.length > 0) {
    knData.tag_segments.slice(0, 50).forEach((t, i) => {
      const meta = (t.meta || {}) as Record<string, unknown>;
      const kws = Array.isArray(meta.keywords) ? (meta.keywords as string[]) : [];
      const topic = (typeof meta.topic_name === "string" && meta.topic_name) || t.tag || "—";
      enrichRows.push({
        idx: i + 1,
        lines: `L${t.line_start}–L${t.line_end}`,
        topic,
        keywords: kws.slice(0, 6),
        status: "done",
      });
    });
  } else if (knData.wiki_chapters && knData.wiki_chapters.length > 0) {
    knData.wiki_chapters.slice(0, 50).forEach((ch, i) => {
      enrichRows.push({
        idx: i + 1,
        lines: `L${ch.line_start}–L${ch.line_end}`,
        topic: ch.title || "(untitled)",
        keywords: (ch.keywords || []).slice(0, 6),
        status: ch.summarized ? "done" : "queued",
      });
    });
  }

  return (
    <div className="proto-chunks">
      {/* SECTION 1 · chunk_embed table */}
      <div className="proto-chunks-section-head">
        <h3 className="proto-chunks-section-title">Embedding · chunk_embed</h3>
        <span className="proto-chunks-section-meta">
          {knData.chunks.length} chunks · dim {embedDim} · {Math.round(totalChars / 1024)} KB total · cloud_embed
        </span>
      </div>
      <div className="proto-chunks-table proto-chunks-table-embed">
        <div className="proto-chunks-thead">
          <div>#</div><div>Dim</div><div>Lines</div><div>Preview</div><div className="proto-chunks-th-r">Chars</div><div className="proto-chunks-th-r">Source</div>
        </div>
        {knData.chunks.slice(0, 50).map((c, i) => (
          <div key={c.id} className="proto-chunks-trow">
            <div className="proto-chunks-idx">{String(i + 1).padStart(2, "0")}</div>
            <div className="proto-chunks-mono">{c.dimension.includes(":") ? c.dimension.split(":")[0] : c.dimension}</div>
            <div className="proto-chunks-mono">L{c.line_start}–L{c.line_end}</div>
            <div className="proto-chunks-preview">{(c.text || "").replace(/\s+/g, " ").slice(0, 140)}</div>
            <div className="proto-chunks-mono proto-chunks-r">{c.text?.length ?? 0}</div>
            <div className="proto-chunks-mono proto-chunks-r">d-{c.dimension.length > 8 ? c.dimension.slice(0, 8) : c.dimension}</div>
          </div>
        ))}
        {knData.chunks.length > 50 && (
          <div className="proto-chunks-more">+{knData.chunks.length - 50} more chunks</div>
        )}
      </div>

      {/* SECTION 2 · chunk_enrich / wiki_abstract overlay table */}
      <div className="proto-chunks-section-head proto-chunks-section-head-2">
        <h3 className="proto-chunks-section-title">
          Enrichment overlay · {knData.wiki_chapters && knData.wiki_chapters.length > 0 ? "wiki_abstract" : "chunk_enrich"}
        </h3>
        <span className="proto-chunks-section-meta">
          {enrichRows.length > 0
            ? `${enrichRows.length} ${knData.wiki_chapters?.length ? "chapter" : "segment"}${enrichRows.length === 1 ? "" : "s"} enriched`
            : "no enrichment yet — run Enrich / Build abstract from the Pipeline tab"}
        </span>
      </div>
      {enrichRows.length > 0 && (
        <div className="proto-chunks-table proto-chunks-table-enrich">
          <div className="proto-chunks-thead">
            <div>#</div><div>Lines</div><div>Topic</div><div>Keywords / entities</div><div className="proto-chunks-th-r">Status</div>
          </div>
          {enrichRows.map((r) => (
            <div key={`${r.idx}-${r.lines}`} className="proto-chunks-trow">
              <div className="proto-chunks-idx">{String(r.idx).padStart(2, "0")}</div>
              <div className="proto-chunks-mono">{r.lines}</div>
              <div className="proto-chunks-topic">{r.topic}</div>
              <div className="proto-chunks-kw">
                {r.keywords.length === 0 && <span className="proto-chunks-kw-empty">—</span>}
                {r.keywords.map((k) => (
                  <span key={k} className="proto-chunks-kw-chip">{k}</span>
                ))}
              </div>
              <div className={cn(
                "proto-chunks-mono proto-chunks-r",
                r.status === "done" && "proto-chunks-status-done",
                r.status === "queued" && "proto-chunks-status-queued",
                r.status === "running" && "proto-chunks-status-running",
              )}>{r.status}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChaptersTab({
  knData, knLoading, onJumpToLine,
}: {
  knData: cloudApi.DocumentKn | null;
  knLoading: boolean;
  onJumpToLine: (start: number, end: number) => void;
}) {
  if (knLoading) return <KnEmpty msg="loading…" />;
  if (!knData || knData.wiki_chapters.length === 0) {
    return <KnEmpty msg="No chapters yet. Run Embed from the Pipeline tab — Phase A splits the doc by H2 headings." />;
  }
  const summarized = knData.wiki_chapters.filter((c) => c.summarized).length;
  return (
    <>
      {summarized < knData.wiki_chapters.length && (
        <div className="proto-form-hint" style={{ marginBottom: 8 }}>
          {summarized} of {knData.wiki_chapters.length} chapters summarized.
          Run <em>Build smartsheet</em> from the Pipeline tab to fill in the rest.
        </div>
      )}
      <div className="proto-pipeline-segments">
        {knData.wiki_chapters.map((ch) => (
          <button
            type="button"
            key={ch.id}
            onClick={() => onJumpToLine(ch.line_start, ch.line_end)}
            className="proto-pipeline-segment"
            title={`Jump to lines ${ch.line_start}–${ch.line_end} in the raw view`}
          >
            <div className="proto-pipeline-segment-head">
              <span className="proto-pipeline-segment-title">{ch.title || "(untitled)"}</span>
              <span className="proto-pipeline-segment-lines">H{ch.level} · L{ch.line_start}–{ch.line_end}</span>
              {ch.summarized
                ? <span className="proto-pipeline-segment-status proto-pipeline-segment-status-ok">✓ summarized</span>
                : <span className="proto-pipeline-segment-status">pending abstract</span>}
            </div>
            {ch.summary && (
              <div className="proto-pipeline-segment-summary">{ch.summary}</div>
            )}
            {ch.keywords.length > 0 && (
              <div className="proto-pipeline-segment-keywords">
                {ch.keywords.slice(0, 8).map((k) => (
                  <span key={k} className="proto-pipeline-segment-kw">{k}</span>
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
    </>
  );
}

function TagSegmentsTab({
  knData, knLoading, onJumpToLine,
}: {
  knData: cloudApi.DocumentKn | null;
  knLoading: boolean;
  onJumpToLine: (start: number, end: number) => void;
}) {
  if (knLoading) return <KnEmpty msg="loading…" />;
  if (!knData || knData.tag_segments.length === 0) {
    return <KnEmpty msg="No tag segments yet. Run Enrich from the Pipeline tab." />;
  }
  return (
    <div className="proto-pipeline-segments">
      {knData.tag_segments.slice(0, 30).map((t) => {
        // meta is JSON from the cloud; pull a couple of useful
        // arrays defensively (shape varies across enrich versions).
        const meta = (t.meta || {}) as Record<string, unknown>;
        const keywords = Array.isArray(meta.keywords) ? (meta.keywords as string[]).slice(0, 6) : [];
        const secondary = Array.isArray(meta.secondary_tags) ? (meta.secondary_tags as string[]).slice(0, 4) : [];
        return (
          <button
            type="button"
            key={t.id}
            onClick={() => onJumpToLine(t.line_start, t.line_end)}
            className="proto-pipeline-segment"
            title={`Jump to lines ${t.line_start}–${t.line_end} in the raw view`}
          >
            <div className="proto-pipeline-segment-head">
              <span className="proto-tag proto-tag-accent">{t.tag}</span>
              {secondary.map((s) => (
                <span key={s} className="proto-tag">{s}</span>
              ))}
              <span className="proto-pipeline-segment-lines">L{t.line_start}–{t.line_end}</span>
              {t.confidence > 0 && (
                <span className="proto-pipeline-segment-conf">
                  {(t.confidence * 100).toFixed(0)}%
                </span>
              )}
            </div>
            {t.summary && (
              <div className="proto-pipeline-segment-summary">{t.summary}</div>
            )}
            {keywords.length > 0 && (
              <div className="proto-pipeline-segment-keywords">
                {keywords.map((k) => (
                  <span key={k} className="proto-pipeline-segment-kw">{k}</span>
                ))}
              </div>
            )}
          </button>
        );
      })}
      {knData.tag_segments.length > 30 && (
        <div className="proto-pipeline-segments-more">
          +{knData.tag_segments.length - 30} more…
        </div>
      )}
    </div>
  );
}

/* TagSuggestionsTab — note_classify review queue.
 *
 * Reads from /v1/notes/{id}/suggestions for the live pending list
 * (preferred — orders by confidence). Falls back to /kn payload's
 * note_tag_suggestions when a fetch fails. Inline Accept / Dismiss
 * per row hits the dedicated cloud endpoints; the review-bar's
 * "Accept ≥ 90%" loops over the local list client-side (no bulk
 * cloud route yet — doc §2.7 calls one out as a future addition).
 *
 * Empty states:
 *   - cloud_provider_ready === false → CTA to open Cloud panel
 *   - workspace has no user tags     → CTA + disable run note_classify
 *   - all suggestions reviewed       → encourage re-run
 */
/* Inline tag-create UI used as the "no custom tags yet" empty
 * state for the Tag-suggestions tab. Previously this offered a
 * button that opened the Cloud panel — wrong destination (that's
 * sync settings, not the workspace tag manager) so the user had
 * no way to actually create a tag from here. Inline creation
 * keeps them on the same page and unblocks note_classify in one
 * step. Reuses the existing /v1/tags POST endpoint. */
function NoUserTagsEmpty({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function create(suggested?: string) {
    const value = (suggested ?? name).trim();
    if (!value) return;
    setBusy(true);
    setErr(null);
    try {
      await cloudApi.upsertTag({ name: value });
      setName("");
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  // A handful of common starter tags so the user doesn't have to
  // think hard the first time. Clicking creates instantly.
  const suggestions = ["learn", "work", "todo", "reference", "idea", "personal"];
  return (
    <div className="proto-pipeline-empty-state">
      <h3>No custom tags yet</h3>
      <p style={{ marginBottom: 14 }}>
        Tag-classify needs at least one custom tag to know what to look for in your notes.
        Add one below to enable note_classify on this doc.
      </p>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <input
          type="text"
          className="proto-form-input"
          placeholder="Tag name (e.g. work, learn, todo)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") create(); }}
          disabled={busy}
          autoFocus
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          type="button"
          className="proto-library-btn proto-library-btn-primary"
          onClick={() => create()}
          disabled={busy || !name.trim()}
        >
          {busy ? "…" : "Create tag"}
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: "var(--color-text-muted)", marginRight: 4 }}>
          Quick start:
        </span>
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            className="proto-tag"
            onClick={() => create(s)}
            disabled={busy}
            style={{ cursor: "pointer" }}
          >
            + {s}
          </button>
        ))}
      </div>
      {err && <div style={{ fontSize: 11, color: "var(--color-danger)" }}>{err}</div>}
      <p style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 14 }}>
        Tip: open the Workspace panel (deselect this doc on the left) to manage all tags — rename, recolor, reorder.
      </p>
    </div>
  );
}

function TagSuggestionsTab({
  doc, knData, bulk,
}: {
  doc: cloudApi.CloudDocument;
  knData: cloudApi.DocumentKn | null;
  bulk: BulkRuns;
}) {
  const [suggestions, setSuggestions] = useState<cloudApi.NoteTagSuggestion[] | null>(null);
  const [tags, setTags] = useState<cloudApi.CloudTag[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Load pending suggestions + workspace user tags. Re-fetch when the
  // bulk runner reports a note_classify run ended for this doc, so
  // newly-arrived suggestions show up without manual refresh.
  const clientRun = bulk.runs.get(doc.id);
  const lastRunStamp = clientRun?.finishedAt ?? clientRun?.startedAt ?? 0;
  useEffect(() => {
    let alive = true;
    setErr(null);
    cloudApi.listNoteSuggestions(doc.id)
      .then((r) => alive && setSuggestions(r.suggestions))
      .catch((e) => {
        if (!alive) return;
        // Fallback to whatever /kn returned at last refetch.
        const fromKn = (knData?.note_tag_suggestions || [])
          .filter((s) => s.status === "pending");
        setSuggestions(fromKn);
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [doc.id, lastRunStamp]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    cloudApi.fetchTags()
      .then((t) => alive && setTags(t))
      .catch(() => alive && setTags([]));
    return () => { alive = false; };
  }, []);

  async function accept(tag: string) {
    setBusy(tag);
    try {
      await cloudApi.acceptNoteSuggestion(doc.id, tag);
      setSuggestions((cur) => (cur || []).filter((s) => s.tag !== tag));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(tag: string) {
    setBusy(tag);
    try {
      await cloudApi.dismissNoteSuggestion(doc.id, tag);
      setSuggestions((cur) => (cur || []).filter((s) => s.tag !== tag));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function acceptAllHighConfidence(min = 0.9) {
    const pool = (suggestions || []).filter((s) => s.confidence >= min);
    if (pool.length === 0) return;
    setBusy("__bulk__");
    try {
      // Cloud doesn't expose a bulk_decision endpoint yet (doc §2.7).
      // Loop client-side with bounded concurrency.
      const conc = 4;
      let cursor = 0;
      const worker = async () => {
        while (cursor < pool.length) {
          const idx = cursor++;
          const s = pool[idx];
          try { await cloudApi.acceptNoteSuggestion(doc.id, s.tag); }
          catch { /* per-row tolerant */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(conc, pool.length) }, () => worker()));
      setSuggestions((cur) => (cur || []).filter((s) => s.confidence < min));
    } finally {
      setBusy(null);
    }
  }

  async function dismissAll() {
    const pool = suggestions || [];
    if (pool.length === 0) return;
    if (!window.confirm(`Dismiss all ${pool.length} pending suggestions for this doc?`)) return;
    setBusy("__bulk__");
    try {
      const conc = 4;
      let cursor = 0;
      const worker = async () => {
        while (cursor < pool.length) {
          const idx = cursor++;
          const s = pool[idx];
          try { await cloudApi.dismissNoteSuggestion(doc.id, s.tag); }
          catch { /* per-row tolerant */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(conc, pool.length) }, () => worker()));
      setSuggestions([]);
    } finally {
      setBusy(null);
    }
  }

  const noUserTags = tags !== null && tags.length === 0;
  const pending = suggestions ?? [];
  const highConfPending = pending.filter((s) => s.confidence >= 0.9).length;

  if (noUserTags) {
    return <NoUserTagsEmpty onCreated={() => cloudApi.fetchTags().then(setTags).catch(() => {})} />;
  }

  if (suggestions === null) {
    return <KnEmpty msg="loading suggestions…" />;
  }

  if (pending.length === 0) {
    return (
      <div className="proto-pipeline-empty-state">
        <h3>No pending suggestions</h3>
        <p>{err ? `Could not reach cloud: ${err}` : "All suggestions are reviewed. Run note_classify again from the Pipeline tab to look for new matches."}</p>
      </div>
    );
  }

  return (
    <>
      <div className="proto-pipeline-review-bar">
        <span className="proto-pipeline-review-stat">
          <b>{pending.length}</b> pending
        </span>
        <span className="proto-pipeline-review-stat">·</span>
        <span className="proto-pipeline-review-stat">
          <b>{highConfPending}</b> ≥ 90% confidence
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="proto-library-btn"
          onClick={dismissAll}
          disabled={busy !== null}
        >
          Dismiss all
        </button>
        <button
          type="button"
          className="proto-library-btn proto-library-btn-primary"
          onClick={() => acceptAllHighConfidence(0.9)}
          disabled={busy !== null || highConfPending === 0}
        >
          Accept all ≥ 90%
        </button>
      </div>

      <div className="proto-pipeline-segments">
        {pending.map((s) => (
          <div key={s.tag} className="proto-pipeline-segment proto-pipeline-segment-suggestion">
            <div className="proto-pipeline-segment-head">
              <span className="proto-tag proto-tag-accent">{s.tag}</span>
              <span className="proto-pipeline-segment-conf">
                {(s.confidence * 100).toFixed(0)}%
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="proto-library-btn"
                onClick={() => dismiss(s.tag)}
                disabled={busy !== null}
                title="Dismiss this suggestion (won't be re-suggested)"
              >
                ✗ Dismiss
              </button>
              <button
                type="button"
                className="proto-library-btn proto-library-btn-primary"
                onClick={() => accept(s.tag)}
                disabled={busy !== null}
                title={`Accept and add ${s.tag} to this note's user_tags`}
              >
                ✓ Accept
              </button>
            </div>
            {s.reasoning && (
              <div className="proto-pipeline-segment-summary">{s.reasoning}</div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function EnrichHistoryTab({ knData, knLoading }: { knData: cloudApi.DocumentKn | null; knLoading: boolean }) {
  if (knLoading) return <KnEmpty msg="loading…" />;
  const rows = knData?.processing_runs ?? [];
  if (!rows.length) {
    return <KnEmpty msg="No processing runs yet." />;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
      {rows.map((j) => {
        const tokens = typeof j.result?.total_tokens === "number" ? j.result.total_tokens : 0;
        return (
        <div key={j.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 4, background: "var(--color-bg-soft)" }}>
          <span className={cn("proto-tag", j.status === "done" && "proto-tag-accent")}>{j.status}</span>
          <span style={{ color: "var(--color-text-muted)", fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>{j.kind}</span>
          <span style={{ color: "var(--color-text-muted)" }}>{j.executor || "—"}</span>
          {tokens > 0 && (
            <span style={{ color: "var(--color-text-muted)" }}>· {tokens.toLocaleString()} tok</span>
          )}
          <span style={{ marginLeft: "auto", color: "var(--color-text-muted)", fontSize: 10 }}>
            {fmtDate(j.finished_at || j.started_at || j.created_at || "")}
          </span>
          {j.error && <span title={errorText(j.error)} style={{ color: "var(--color-danger)" }}>!</span>}
        </div>
      );})}
    </div>
  );
}

function KnEmpty({ msg }: { msg: string }) {
  return (
    <div style={{ padding: 24, fontSize: 12, color: "var(--color-text-muted)", textAlign: "center" }}>
      {msg}
    </div>
  );
}

/* RawView — line-anchored markdown viewer.
 *
 * Splits the source on \n once and renders each line as its own row
 * with `data-line={n}` so the parent can scroll to a specific line
 * range when the user clicks a tag segment / wiki chapter in the KN
 * tabs. The scroll target is the FIRST line; lines in the [start,end]
 * range get a transient highlight class that fades on its own (CSS
 * animation) so the eye lands on the right area without permanent
 * visual noise.
 *
 * For very large docs we split lazily — splitting 200k chars on \n
 * is still cheap so we don't bother memoizing across renders.
 */
function RawView({
  content, jumpTarget, onConsumeJump,
}: {
  content: string;
  jumpTarget: { start: number; end: number } | null;
  onConsumeJump: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => content.split("\n"), [content]);

  useEffect(() => {
    if (!jumpTarget || !containerRef.current) return;
    const el = containerRef.current.querySelector<HTMLElement>(
      `[data-line="${jumpTarget.start}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    // Drop the jump after we've scrolled so flipping back to KN and
    // re-opening doesn't snap to the same line again.
    const t = setTimeout(onConsumeJump, 1400);
    return () => clearTimeout(t);
  }, [jumpTarget, onConsumeJump]);

  return (
    <div ref={containerRef} className="proto-library-raw proto-library-raw-lines">
      {lines.map((line, i) => {
        const n = i + 1;
        const inRange = jumpTarget && n >= jumpTarget.start && n <= jumpTarget.end;
        return (
          <div
            key={n}
            data-line={n}
            className={cn(
              "proto-library-raw-line",
              inRange && "proto-library-raw-line-flash",
            )}
          >
            <span className="proto-library-raw-lineno">{n}</span>
            <span className="proto-library-raw-linetext">{line || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

function RunBtn({
  icon, label, tone, onClick, disabled, running, title,
}: {
  icon: React.ReactNode;
  label: string;
  tone: "llm" | "non-llm";
  onClick: () => void;
  disabled?: boolean;
  running?: boolean;
  title?: string;
}) {
  // LLM tone is now visually loud (gold-tinted background + ⚡ icon
  // + cost callout in tooltip) since the previous subtle "uses Cloud
  // LLM" hint wasn't enough to remind users that a click costs
  // tokens. fast-tone runs (chunk_embed / graph_topology) keep the
  // calmer ghost-button style — they're free.
  const isLlm = tone === "llm";
  const composedTitle = isLlm
    ? `${title || ""} · LLM stage · uses Cloud AI tokens (~$0.001–0.01 per 1k chunks · billed to your provider)`
    : title
      ? `${title} · no LLM`
      : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={running || undefined}
      data-tone={tone}
      title={composedTitle}
      className="proto-library-btn proto-pipeline-run-btn"
    >
      <span className="proto-pipeline-run-icon">
        {running
          ? <Loader2 size={12} strokeWidth={2} className="animate-spin" />
          : icon}
      </span>
      <span>{label}</span>
      {isLlm && !running && (
        <span className="proto-pipeline-run-llm-mark" aria-label="LLM stage — costs tokens">⚡ LLM</span>
      )}
    </button>
  );
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}
