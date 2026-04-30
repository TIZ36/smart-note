import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, Trash2, Tag, Copy, FileText, Layers } from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { cn } from "@/lib/cn";
import type { ChannelId } from "@/lib/types";

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
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
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

  // Import: pick one or more text/markdown files, upload each as a
  // CloudDocument with smartnote_type=wiki_topic so it lands in the
  // wiki tree (and the chapter splitter applies tag_meta on ingest).
  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setBusy("import");
    let ok = 0;
    let lastId: string | null = null;
    for (const f of files) {
      try {
        const content = await f.text();
        const created = await cloudApi.createDocument({
          name: f.name.replace(/\.(md|txt)$/i, ""),
          content,
          kind: "markdown",
          metadata: { smartnote_type: "wiki_topic", imported_at: new Date().toISOString() },
        });
        lastId = created.id;
        ok++;
      } catch {
        /* per-file tolerant */
      }
    }
    setBusy(null);
    if (fileRef.current) fileRef.current.value = "";
    await reload();
    if (lastId) setActiveId(lastId);
    if (ok < files.length) {
      window.alert(`Imported ${ok}/${files.length}. ${files.length - ok} failed (cloud unreachable?).`);
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

  // Fetch KN payload (chunks + tag_segments + enrich_jobs) lazily —
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

  // Auto-refetch when a pipeline event lands for the doc currently
  // open in KN mode. The cloud emits doc-pipeline-changed via App.tsx
  // for wiki_abstract_done / chunk_embed_done / ai_enrich_done.
  useEffect(() => {
    if (viewMode !== "kn" || !activeId) return;
    function handler(ev: Event) {
      const detail = (ev as CustomEvent<{ document_id?: string }>).detail;
      if (!detail?.document_id || detail.document_id !== activeId) return;
      cloudApi.getDocumentKn(activeId).then((d) => setKnData(d)).catch(() => {});
    }
    window.addEventListener("smartnote:doc-pipeline-changed", handler);
    return () => window.removeEventListener("smartnote:doc-pipeline-changed", handler);
  }, [viewMode, activeId]);

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
          {grouped.map(([groupName, items]) => (
            <div key={groupName}>
              <div className="proto-library-group">
                <span>{groupName}</span>
                <span className="proto-library-group-count">{items.length}</span>
              </div>
              {items.map((d) => (
                <button
                  type="button"
                  key={d.id}
                  className="proto-library-tree-item"
                  aria-current={d.id === (active?.id ?? "")}
                  onClick={() => setActiveId(d.id)}
                >
                  <span className="proto-library-tree-item-name">{d.name}</span>
                  <span className="proto-library-tree-item-count">
                    {Math.round(d.byte_size / 1024)}k
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      {/* Right content */}
      <div className="proto-library-content">
        {active ? (
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
                  <pre className="proto-library-raw">{rawContent}</pre>
                )
              ) : (
                <KnView
                  doc={active}
                  knData={knData}
                  knLoading={knLoading}
                  knTab={knTab}
                  onKnTab={setKnTab}
                  isWiki={kindOf(active) === "wiki_topic"}
                />
              )}
            </div>
          </>
        ) : (
          <div className="proto-library-empty">
            Select a document on the left, or ingest a note from the Note tab.
          </div>
        )}
      </div>
    </div>
  );
}

/* KN view — top menu bar + per-tab body. Tab set differs by kind:
 *
 *   Note  → Pipeline · Chunks · Tag segments · Enrich
 *   Wiki  → Pipeline · Chunks · Chapters · Enrich
 *
 * Pipeline status badges read directly from the /v1/documents/{id}/kn
 * payload (chunks / tag_segments / wiki_chapters / enrich_jobs counts)
 * — NOT from metadata flags. metadata.enrich_status / ai_tags lag the
 * actual processing state, which is why KP and Library disagreed
 * before. Single source of truth = the KN endpoint.
 */
type KnTab = "pipeline" | "chunks" | "tags" | "chapters" | "runs";

function KnView({
  doc, knData, knLoading, knTab, onKnTab, isWiki,
}: {
  doc: cloudApi.CloudDocument;
  knData: cloudApi.DocumentKn | null;
  knLoading: boolean;
  knTab: KnTab;
  onKnTab: (t: KnTab) => void;
  isWiki: boolean;
}) {
  // Available tabs depend on kind. Keep order stable so users build
  // muscle memory: Pipeline first, content (chunks) next, AI output
  // (tags or chapters) third, history last.
  const tabs: { key: KnTab; label: string; count?: number }[] = [
    { key: "pipeline", label: "Pipeline" },
    { key: "chunks", label: "Chunks", count: knData?.chunks.length ?? 0 },
    isWiki
      ? { key: "chapters", label: "Chapters", count: knData?.wiki_chapters.length ?? 0 }
      : { key: "tags", label: "Tag segments", count: knData?.tag_segments.length ?? 0 },
    { key: "runs", label: "Runs", count: knData?.processing_runs?.length ?? 0 },
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
          >
            {t.label}
            {typeof t.count === "number" && (
              <span className="proto-library-kn-tab-count">{t.count}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="proto-library-kn-body">
        {knTab === "pipeline" && (
          <PipelineStatus doc={doc} knData={knData} knLoading={knLoading} isWiki={isWiki} />
        )}
        {knTab === "chunks" && (
          <ChunksTab knData={knData} knLoading={knLoading} />
        )}
        {knTab === "chapters" && isWiki && (
          <ChaptersTab knData={knData} knLoading={knLoading} />
        )}
        {knTab === "tags" && !isWiki && (
          <TagSegmentsTab knData={knData} knLoading={knLoading} />
        )}
        {knTab === "runs" && (
          <ProcessingRunsTab knData={knData} knLoading={knLoading} />
        )}
      </div>
    </div>
  );
}

function PipelineStatus({
  doc, knData, knLoading, isWiki,
}: {
  doc: cloudApi.CloudDocument;
  knData: cloudApi.DocumentKn | null;
  knLoading: boolean;
  isWiki: boolean;
}) {
  // Live wiki-abstract progress for THIS doc. wiki_abstract_progress
  // events from cloud arrive via App.tsx → CustomEvent. We snapshot
  // {summarized, failed, total} so the R badge can show "3/12" while
  // the run is in flight, without waiting for the terminal /kn
  // refetch (which only lands on _done).
  const [liveProgress, setLiveProgress] = useState<{
    summarized: number; failed: number; total: number;
  } | null>(null);
  useEffect(() => {
    function handler(ev: Event) {
      const detail = (ev as CustomEvent<{
        document_id?: string;
        phase?: string;
        total?: number;
        summarized?: number;
        failed?: number;
      }>).detail;
      if (!detail || detail.document_id !== doc.id) return;
      setLiveProgress({
        summarized: detail.summarized ?? 0,
        failed: detail.failed ?? 0,
        total: detail.total ?? 0,
      });
    }
    window.addEventListener("smartnote:wiki-abstract-progress", handler);
    function done(ev: Event) {
      const detail = (ev as CustomEvent<{ document_id?: string; kind?: string }>).detail;
      if (detail?.document_id === doc.id && detail?.kind === "wiki_abstract") {
        setLiveProgress(null);
      }
    }
    window.addEventListener("smartnote:doc-pipeline-changed", done);
    return () => {
      window.removeEventListener("smartnote:wiki-abstract-progress", handler);
      window.removeEventListener("smartnote:doc-pipeline-changed", done);
    };
  }, [doc.id]);
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
  // Truth from server: total chunk rows vs chunks with non-null vector.
  // Falls back to the bounded LIMIT-200 preview list when the count
  // fields are absent (older server build).
  const chunkTotal = knData?.chunk_total ?? knData?.chunks.length ?? 0;
  const embeddedCount = knData?.embedded_chunk_count ?? chunkTotal;
  const embedded = embeddedCount > 0 && embeddedCount === chunkTotal;
  const partiallyEmbedded = embeddedCount > 0 && embeddedCount < chunkTotal;

  const segmentCount = knData?.tag_segments.length ?? 0;
  const chapterCount = knData?.wiki_chapters.length ?? 0;
  const summarizedChapters = (knData?.wiki_chapters || []).filter((c) => c.summarized).length;
  // R-done fallback uses the canonical processing_runs ledger (not
  // enrich_jobs). Migration 025 backfilled historical rows so this
  // doesn't lose docs that were enriched before the cutover.
  const aiEnrichKind = isWiki ? "wiki_abstract" : "ai_enrich";
  const hasDoneRun = (knData?.processing_runs || []).some(
    (r) => r.kind === aiEnrichKind && r.status === "done",
  );

  // R = per-kind AI artifact existence
  const rDone = isWiki ? summarizedChapters > 0 : (segmentCount > 0 || hasDoneRun);
  const rLabel = isWiki ? "wiki-knowledge-sheet" : "aisegment";
  const rDetail = isWiki
    ? (chapterCount > 0
        ? `${summarizedChapters}/${chapterCount} chapters summarized`
        : "no chapters yet — wiki Phase A produces them on Embedding")
    : (segmentCount > 0
        ? `${segmentCount} segments`
        : (hasDoneRun ? "enrich run completed but no segments — provider returned empty" : "no enrich pass yet"));

  // G = info-graph. Driven by the real entity_count from /kn — entity
  // upsert is best-effort during enrich, and the LLM may return empty
  // entities for sparse content, so R-done does not imply G-done. We
  // surface the truth so users can tell when graph extraction quietly
  // produced nothing.
  const entityCount = knData?.entity_count ?? 0;
  const gDone = entityCount > 0;

  return (
    <div className="proto-library-card-list">
      <div className="proto-doc-card">
        <div className="proto-doc-card-head">
          <div className="proto-doc-card-title">Pipeline status</div>
          <div className="proto-doc-card-meta">{doc.id.slice(0, 8)}</div>
        </div>
        <div className="proto-doc-card-snippet">
          Created {fmtDate(doc.created_at)}
          {doc.updated_at && ` · updated ${fmtDate(doc.updated_at)}`}
          {knLoading && " · loading state…"}
        </div>
        <div className="proto-doc-card-tags">
          <span
            className={cn(
              "proto-tag",
              embedded && "proto-tag-accent",
              partiallyEmbedded && "proto-tag-warn",
            )}
            title={embedded
              ? `${embeddedCount} chunks indexed`
              : partiallyEmbedded
              ? `${embeddedCount}/${chunkTotal} chunks have vectors — re-run Embedding to fill the gap`
              : (chunkTotal > 0
                  ? `${chunkTotal} chunks exist but none are embedded yet`
                  : "no chunks yet — run Embedding from KP")}
          >
            E: embed
            {embedded
              ? ` (${embeddedCount})`
              : partiallyEmbedded
              ? ` (${embeddedCount}/${chunkTotal} · partial)`
              : " · pending"}
          </span>
          <span
            className={cn(
              "proto-tag",
              rDone && "proto-tag-accent",
              liveProgress && "proto-tag-running",
            )}
            title={liveProgress
              ? `${liveProgress.summarized}/${liveProgress.total} summarized · ${liveProgress.failed} failed (live)`
              : rDetail}
          >
            R: {rLabel}
            {liveProgress
              ? ` (${liveProgress.summarized}/${liveProgress.total}…)`
              : isWiki
              ? (summarizedChapters > 0 ? ` (${summarizedChapters}/${chapterCount})` : " · pending")
              : (segmentCount > 0 ? ` (${segmentCount})` : " · pending")}
          </span>
          <span
            className={cn("proto-tag", gDone && "proto-tag-accent")}
            title={gDone
              ? `${entityCount} entities linked from this doc's tags`
              : (rDone
                  ? "R completed but no entities landed — LLM returned empty entity arrays or upsert errored"
                  : "no entities yet — produced during R pass")}
          >
            G: info-graph{gDone ? ` (${entityCount})` : " · pending"}
          </span>
        </div>
      </div>

      {/* Compact metadata snapshot — same place as before but shown
          inside the Pipeline tab so it doesn't fight for attention. */}
      {doc.metadata && Object.keys(doc.metadata).length > 0 && (
        <div className="proto-doc-card">
          <div className="proto-doc-card-head">
            <div className="proto-doc-card-title">Metadata</div>
          </div>
          <div className="proto-doc-card-tags">
            {Object.entries(doc.metadata)
              .filter(([, v]) => typeof v !== "object")
              .slice(0, 12)
              .map(([k, v]) => (
                <span key={k} className="proto-tag" title={`${k}: ${String(v)}`}>
                  {k}: {String(v).slice(0, 40)}
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChunksTab({ knData, knLoading }: { knData: cloudApi.DocumentKn | null; knLoading: boolean }) {
  if (knLoading) return <KnEmpty msg="loading…" />;
  if (!knData || knData.chunks.length === 0) {
    return <KnEmpty msg="Not yet embedded. Run Embedding from KP." />;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {knData.chunks.slice(0, 50).map((c) => (
        <div key={c.id} style={{ padding: "6px 8px", borderRadius: 4, background: "var(--color-bg-soft)", fontSize: 11 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <span style={{ color: "var(--color-text-muted)", fontSize: 10, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>
              dim · {c.dimension}
            </span>
            <span style={{ color: "var(--color-text-muted)" }}>L{c.line_start}–{c.line_end}</span>
            {c.keywords.length > 0 && (
              <span style={{ color: "var(--color-text-muted)", fontSize: 10 }}>
                · {c.keywords.slice(0, 4).join(", ")}
              </span>
            )}
          </div>
          <div style={{ color: "var(--color-text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {c.text.slice(0, 160)}
          </div>
        </div>
      ))}
      {knData.chunks.length > 50 && (
        <div style={{ fontSize: 10, color: "var(--color-text-muted)", textAlign: "center", padding: 4 }}>
          +{knData.chunks.length - 50} more…
        </div>
      )}
    </div>
  );
}

function ChaptersTab({ knData, knLoading }: { knData: cloudApi.DocumentKn | null; knLoading: boolean }) {
  if (knLoading) return <KnEmpty msg="loading…" />;
  if (!knData || knData.wiki_chapters.length === 0) {
    return <KnEmpty msg="No chapters yet. Run Embedding from KP — Phase A splits the doc by H2 headings." />;
  }
  const summarized = knData.wiki_chapters.filter((c) => c.summarized).length;
  return (
    <>
      {summarized < knData.wiki_chapters.length && (
        <div className="proto-form-hint" style={{ marginBottom: 8 }}>
          {summarized} of {knData.wiki_chapters.length} chapters summarized.
          Run <em>Build wiki-abstract</em> from KP to fill in the rest.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {knData.wiki_chapters.map((ch) => (
          <div key={ch.id} style={{ padding: "8px 10px", borderRadius: 4, background: "var(--color-bg-soft)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 11 }}>
              <span style={{ fontWeight: 600 }}>{ch.title || "(untitled)"}</span>
              <span style={{ color: "var(--color-text-muted)", fontSize: 10 }}>
                H{ch.level} · L{ch.line_start}–{ch.line_end}
              </span>
              {ch.last_error && !ch.summarized && (
                <span
                  style={{ marginLeft: "auto", fontSize: 10, color: "var(--color-danger, #c0392b)" }}
                  title={ch.last_error}
                >
                  ● failed — {ch.last_error.length > 40 ? ch.last_error.slice(0, 40) + "…" : ch.last_error}
                </span>
              )}
              {!ch.summarized && !ch.last_error && (
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--color-text-muted)" }}>
                  pending abstract
                </span>
              )}
              {ch.summarized && (
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--color-success)" }}>
                  ✓ summarized
                </span>
              )}
            </div>
            {ch.summary && (
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 6, lineHeight: 1.55 }}>
                {ch.summary}
              </div>
            )}
            {ch.last_error && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--color-danger, #c0392b)",
                  marginTop: 6,
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  background: "color-mix(in oklab, var(--color-danger, #c0392b) 6%, transparent)",
                  padding: "4px 6px",
                  borderRadius: 3,
                }}
              >
                {ch.last_error}
              </div>
            )}
            {ch.keywords.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                {ch.keywords.slice(0, 8).map((k) => (
                  <span key={k} className="proto-tag">{k}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function TagSegmentsTab({ knData, knLoading }: { knData: cloudApi.DocumentKn | null; knLoading: boolean }) {
  if (knLoading) return <KnEmpty msg="loading…" />;
  if (!knData || knData.tag_segments.length === 0) {
    return <KnEmpty msg="No tag segments yet. Run Enrich from KP." />;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {knData.tag_segments.slice(0, 30).map((t) => (
        <div key={t.id} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 8px", borderRadius: 4, background: "var(--color-bg-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
            <span className="proto-tag proto-tag-accent">{t.tag}</span>
            <span style={{ color: "var(--color-text-muted)" }}>L{t.line_start}–{t.line_end}</span>
            {t.confidence > 0 && (
              <span style={{ color: "var(--color-text-muted)", fontSize: 10 }}>
                · {(t.confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>
          {t.summary && (
            <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{t.summary}</div>
          )}
        </div>
      ))}
      {knData.tag_segments.length > 30 && (
        <div style={{ fontSize: 10, color: "var(--color-text-muted)", textAlign: "center", padding: 4 }}>
          +{knData.tag_segments.length - 30} more…
        </div>
      )}
    </div>
  );
}

function ProcessingRunsTab({ knData, knLoading }: { knData: cloudApi.DocumentKn | null; knLoading: boolean }) {
  if (knLoading) return <KnEmpty msg="loading…" />;
  const runs = knData?.processing_runs ?? [];
  if (runs.length === 0) {
    return <KnEmpty msg="No processing runs recorded yet for this document." />;
  }
  // Group by kind so the chronological list is easier to scan when a
  // doc has been re-embedded + re-enriched several times.
  const kindLabel: Record<string, string> = {
    chunk_embed: "embed",
    ai_enrich: "enrich",
    wiki_abstract: "wiki abstract",
  };
  const statusTone: Record<string, string> = {
    done: "proto-tag-accent",
    partial: "proto-tag-warn",
    running: "proto-tag-running",
    queued: "proto-tag-running",
    failed: "",
    skipped_dedup: "",
    skipped_quota: "",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
      {runs.map((r) => (
        <div
          key={r.id}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "6px 8px", borderRadius: 4,
            background: "var(--color-bg-soft)",
            opacity: r.status.startsWith("skipped") ? 0.6 : 1,
          }}
        >
          <span className={cn("proto-tag")} style={{ minWidth: 88 }}>
            {kindLabel[r.kind] || r.kind}
          </span>
          <span className={cn("proto-tag", statusTone[r.status] || "")}>{r.status}</span>
          {r.executor && (
            <span style={{ color: "var(--color-text-muted)" }}>{r.executor}</span>
          )}
          {r.revision > 0 && (
            <span style={{ color: "var(--color-text-muted)", fontSize: 10 }}>
              rev {r.revision}
            </span>
          )}
          <span style={{ marginLeft: "auto", color: "var(--color-text-muted)", fontSize: 10 }}>
            {fmtDate(r.finished_at || r.started_at || r.created_at || "")}
          </span>
          {r.error && (
            <span
              title={r.error}
              style={{ color: "var(--color-danger, #c0392b)", cursor: "help" }}
            >
              ●
            </span>
          )}
        </div>
      ))}
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

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}
