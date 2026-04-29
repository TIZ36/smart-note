import { useEffect, useMemo, useState } from "react";
import {
  FileText, BookOpen, Sparkles, Database, Hash, Network as NetworkIcon,
  CheckSquare, Square, RotateCw, Plus, X, Edit3,
} from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { cn } from "@/lib/cn";
import { RAGProcessingPanel } from "./RAGProcessingPanel";

/* RAG — knowledge processing center.
 *
 * Note + Library are read-only browse surfaces. RAG is where the AI
 * capabilities actually fire: pick notes/wiki sources (single, multi,
 * or all) and trigger:
 *   - Embedding (chunk + embed, no LLM)
 *   - Enrich (LLM classifier + tag generation + summaries)
 *   - Tag pass (refresh AI tags only)
 *   - Entity graph rebuild
 *
 * Below: 6-path retrieval status (FTS / vector / n-gram / substring /
 * keyword / tag-meta — the hybrid retrieval per docs/product-principles
 * P1-2). Each path has its own rebuild trigger.
 *
 * Bottom: workspace tag CRUD (was buried in old console; now lives
 * here so editing tags + processing knowledge is one place).
 */

type SourceKind = "note" | "wiki" | "doc";

type Source = {
  id: string;
  name: string;
  kind: SourceKind;
  byteSize: number;
  ingestedAt: string | null;
  updatedAt: string | null;
  embedded: boolean;   // chunks + embeddings present
  enriched: boolean;   // an enrich job ran to completion
  tagged:   boolean;   // AI tags / classification applied
};

export type RunKind = "embed" | "enrich" | "tag" | "graph";
export type RunStatus = {
  kind: RunKind;
  status: "queued" | "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /** Source name for display — captured at enqueue so we don't depend
   *  on the source list still containing this id. */
  name: string;
};

const RETRIEVAL_PATHS: {
  key: string;
  name: string;
  desc: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
}[] = [
  { key: "fts",     name: "FTS",          desc: "Full-text search · sqlite FTS5 token match",          icon: FileText },
  { key: "vec",     name: "Vector",       desc: "Cosine similarity on chunk embeddings",                 icon: Sparkles },
  { key: "ngram",   name: "N-gram",       desc: "Char-level n-gram for typo + partial-word recall",      icon: Hash },
  { key: "sub",     name: "Substring",    desc: "LIKE substring match · catches what FTS tokenizes out", icon: Database },
  { key: "kw",      name: "Keyword",      desc: "Keyword overlap · weighted by importance",              icon: Hash },
  { key: "tagmeta", name: "Tag metadata", desc: "Tag-segment topic / summary / keyword match",           icon: BookOpen },
];

export function RAGPage() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [flash, setFlash] = useState<{ msg: string; tone: "ok" | "err" } | null>(null);
  // Real-time per-doc run map. Powers the Processing panel + the
  // bulk-action button progress label. Cloud-side ingest is synchronous
  // per doc, so we drive concurrency client-side and update this
  // map as each call returns.
  const [runs, setRuns] = useState<Map<string, RunStatus>>(new Map());

  // Tags
  const [tags, setTags] = useState<cloudApi.CloudTag[] | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editingTagDesc, setEditingTagDesc] = useState("");

  // Load sources (notes + wiki) from cloud, enriched with per-source
  // status badges derived from the enrich-jobs feed.
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) setSources([]);
          return;
        }
        const [docs, jobs] = await Promise.all([
          cloudApi.listDocuments(),
          cloudApi.listEnrichJobs().catch(() => [] as cloudApi.EnrichJob[]),
        ]);
        if (!alive) return;
        // Group jobs by document_id to compute per-source status.
        const byDoc = new Map<string, cloudApi.EnrichJob[]>();
        for (const j of jobs) {
          const arr = byDoc.get(j.document_id) || [];
          arr.push(j);
          byDoc.set(j.document_id, arr);
        }
        const mapped: Source[] = docs.documents.map((d) => {
          const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
          const snt = String(md.smartnote_type || "");
          // 3-tier kind:
          //   note  — explicit smartnote_type=note (desktop-synced personal notes)
          //   wiki  — explicit smartnote_type=wiki_topic (imported topical references)
          //   doc   — everything else (untyped uploads — user can re-classify
          //           via the Library Docs "Set type" action)
          const kind: SourceKind = snt === "wiki_topic"
            ? "wiki"
            : snt === "note"
              ? "note"
              : "doc";

          // For note kind, prefer the basename so the tree shows the
          // file name, not a full relative path. For wiki, the title
          // already reads naturally.
          const displayName = kind === "note"
            ? d.name.split("/").pop() || d.name
            : d.name;

          const docJobs = byDoc.get(d.id) || [];
          const lastDone = docJobs.find((j) => j.status === "done");
          const tagsApplied = Array.isArray(md.ai_tags)
            && (md as { ai_tags: unknown[] }).ai_tags.length > 0;

          // Tag-meta retrieval path is populated as soon as wiki
          // ingestion runs (chapter splitter sets chunk.dimension +
          // structural keywords). So for wiki, T lights with E. For
          // notes, real AI tagging requires LLM enrich.
          const tagged = kind === "wiki"
            ? d.ingested_at != null
            : (tagsApplied || !!lastDone);

          return {
            id: d.id,
            name: displayName,
            kind,
            byteSize: d.byte_size,
            ingestedAt: d.ingested_at,
            updatedAt: d.updated_at,
            embedded: d.ingested_at != null,
            enriched: !!lastDone,
            tagged,
          };
        });
        setSources(mapped);
      } catch {
        if (alive) setSources([]);
      }
    }
    load();
    // Re-poll periodically so badges flip after a job completes.
    const id = setInterval(load, 5_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Load tags
  useEffect(() => {
    let alive = true;
    cloudApi.fetchTags()
      .then((t) => alive && setTags(t))
      .catch(() => alive && setTags([]));
    return () => { alive = false; };
  }, []);

  const filtered = useMemo(() => {
    if (!sources) return [];
    if (!filter.trim()) return sources;
    const q = filter.toLowerCase();
    return sources.filter((s) => s.name.toLowerCase().includes(q));
  }, [sources, filter]);

  const counts = useMemo(() => {
    const all = sources?.length ?? 0;
    const notes = sources?.filter((s) => s.kind === "note").length ?? 0;
    const wiki = sources?.filter((s) => s.kind === "wiki").length ?? 0;
    const docs = sources?.filter((s) => s.kind === "doc").length ?? 0;
    return { all, notes, wiki, docs };
  }, [sources]);

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(filtered.map((s) => s.id)));
  }
  function selectNone() {
    setSelected(new Set());
  }
  function selectKind(kind: SourceKind) {
    setSelected(new Set(filtered.filter((s) => s.kind === kind).map((s) => s.id)));
  }

  // ── Bulk actions ────────────────────────────────────────────────
  function flashSet(msg: string, tone: "ok" | "err" = "ok") {
    setFlash({ msg, tone });
    setTimeout(() => setFlash(null), 2400);
  }

  function patchRun(id: string, patch: Partial<RunStatus>) {
    setRuns((prev) => {
      const next = new Map(prev);
      const cur = next.get(id);
      if (cur) next.set(id, { ...cur, ...patch });
      return next;
    });
  }

  // Generic concurrency-limited runner. Drives a per-doc workload at
  // CONC parallel calls, maintaining the runs map so the Processing
  // panel + button label reflect real-time progress (NOT a single
  // 20-doc-blocking HTTP call).
  async function runBulk(
    kind: RunKind,
    ids: string[],
    label: string,
    perDoc: (id: string) => Promise<unknown>,
    conc = 4,
  ) {
    if (ids.length === 0) return;
    const now = Date.now();
    setRuns((prev) => {
      const next = new Map(prev);
      // Strip prior entries for these ids so labels don't show stale done/failed.
      for (const id of ids) {
        const src = sources?.find((s) => s.id === id);
        next.set(id, { kind, status: "queued", startedAt: now, name: src?.name || id.slice(0, 8) });
      }
      return next;
    });
    let cursor = 0;
    let succ = 0;
    let fail = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const i = cursor++;
        const id = ids[i];
        patchRun(id, { status: "running", startedAt: Date.now() });
        try {
          await perDoc(id);
          succ++;
          patchRun(id, { status: "done", finishedAt: Date.now() });
        } catch (e) {
          fail++;
          patchRun(id, { status: "failed", finishedAt: Date.now(), error: e instanceof Error ? e.message : String(e) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(conc, ids.length) }, () => worker()));
    flashSet(
      fail === 0
        ? `${label} ${succ} source${succ === 1 ? "" : "s"}`
        : `${label} ${succ} ok · ${fail} failed`,
      fail === 0 ? "ok" : "err",
    );
  }

  async function runEmbedding() {
    if (selected.size === 0) return;
    // Per-doc parallel ingestDocument, NOT bulkIngest. The cloud's
    // /ingest/bulk runs all docs serially in a single request which
    // pegs the HTTP connection for minutes; per-doc calls let the UI
    // reflect each completion immediately + lets us bound concurrency.
    await runBulk("embed", [...selected], "Embedded", (id) => cloudApi.ingestDocument(id));
  }

  async function runEnrich() {
    if (selected.size === 0) return;
    await runBulk("enrich", [...selected], "Enrich-dispatched", (id) => cloudApi.runEnrich(id), 3);
  }

  async function runTagPass() {
    if (selected.size === 0) return;
    flashSet("Tag pass — Phase 4 backend (using existing enrich pipeline for now)");
  }

  async function runGraphRebuild() {
    const id = "__graph__";
    setRuns((prev) => {
      const next = new Map(prev);
      next.set(id, { kind: "graph", status: "running", startedAt: Date.now(), name: "Entity graph" });
      return next;
    });
    try {
      await cloudApi.fetchGraph();
      patchRun(id, { status: "done", finishedAt: Date.now() });
      flashSet("Entity graph refreshed");
    } catch (e) {
      patchRun(id, { status: "failed", finishedAt: Date.now(), error: e instanceof Error ? e.message : String(e) });
      flashSet(e instanceof Error ? e.message : String(e), "err");
    }
  }

  // Derive in-flight + completed counts per kind for the action tiles
  // and global "is anything running?" state.
  const runStats = useMemo(() => {
    const empty = { running: 0, done: 0, failed: 0, total: 0 };
    const by: Record<RunKind, typeof empty> = {
      embed:  { ...empty }, enrich: { ...empty }, tag: { ...empty }, graph: { ...empty },
    };
    for (const r of runs.values()) {
      const b = by[r.kind];
      b.total++;
      if (r.status === "running" || r.status === "queued") b.running++;
      else if (r.status === "done") b.done++;
      else if (r.status === "failed") b.failed++;
    }
    return by;
  }, [runs]);

  const busyKinds = new Set<RunKind>();
  for (const k of Object.keys(runStats) as RunKind[]) {
    if (runStats[k].running > 0) busyKinds.add(k);
  }

  // ── Per-path rebuild (placeholder until backend exposes per-path) ──
  function rebuildPath(key: string) {
    flashSet(`${key} rebuild — backend endpoint coming Phase 4`);
  }

  // ── Tag CRUD ────────────────────────────────────────────────────
  async function addTag() {
    const name = tagDraft.trim();
    if (!name) return;
    try {
      await cloudApi.upsertTag({ name });
      setTagDraft("");
      const t = await cloudApi.fetchTags();
      setTags(t);
    } catch (e) {
      flashSet(e instanceof Error ? e.message : String(e), "err");
    }
  }

  async function saveTagEdit(name: string) {
    try {
      await cloudApi.upsertTag({ name, description: editingTagDesc });
      setEditingTag(null);
      setEditingTagDesc("");
      const t = await cloudApi.fetchTags();
      setTags(t);
    } catch (e) {
      flashSet(e instanceof Error ? e.message : String(e), "err");
    }
  }

  async function deleteTag(name: string) {
    if (!window.confirm(`Delete tag "${name}"? Existing tag-segments stay but won't be re-applied.`)) return;
    try {
      await cloudApi.deleteTag(name);
      const t = await cloudApi.fetchTags();
      setTags(t);
    } catch (e) {
      flashSet(e instanceof Error ? e.message : String(e), "err");
    }
  }

  return (
    <div className="proto-atelier-rag">
      {/* Top header — subtle, sets context */}
      <header className="proto-atelier-rag-bar">
        <div className="proto-atelier-rag-bar-titles">
          <h2 className="proto-atelier-rag-title">Knowledge processing</h2>
          <div className="proto-atelier-rag-subtitle">
            Pick sources, trigger embedding / enrich / tag, manage the 6 retrieval paths and workspace tags.
            Note + Library stay read-only; this is where the pipeline runs.
          </div>
        </div>
        {flash && (
          <div className={cn(
            "proto-atelier-rag-flash",
            flash.tone === "err" && "proto-atelier-rag-flash-err",
          )}>
            {flash.msg}
          </div>
        )}
      </header>

      <div className="proto-atelier-rag-shell">
        {/* Left source tree (220px) */}
        <aside className="proto-atelier-rag-tree">
          <div className="proto-atelier-rag-tree-bar">
            <input
              type="text"
              className="proto-atelier-rag-tree-search"
              placeholder="Filter sources…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>

          {/* Quick selection helpers */}
          <div className="proto-atelier-rag-tree-quick">
            <button
              type="button"
              onClick={selectAll}
              className="proto-atelier-rag-quick-btn"
              disabled={!sources}
            >
              Select all ({counts.all})
            </button>
            <button
              type="button"
              onClick={() => selectKind("note")}
              className="proto-atelier-rag-quick-btn"
              disabled={!sources}
            >
              Notes only ({counts.notes})
            </button>
            <button
              type="button"
              onClick={() => selectKind("wiki")}
              className="proto-atelier-rag-quick-btn"
              disabled={!sources}
            >
              Wiki only ({counts.wiki})
            </button>
            <button
              type="button"
              onClick={() => selectKind("doc")}
              className="proto-atelier-rag-quick-btn"
              disabled={!sources}
            >
              Docs only ({counts.docs})
            </button>
            <button
              type="button"
              onClick={selectNone}
              className="proto-atelier-rag-quick-btn"
              disabled={selected.size === 0}
            >
              Clear
            </button>
          </div>

          <div className="proto-atelier-rag-tree-scroll">
            {sources === null && (
              <div className="proto-atelier-rag-tree-hint">loading…</div>
            )}
            {sources !== null && filtered.length === 0 && (
              <div className="proto-atelier-rag-tree-hint">
                No sources. Ingest a note or sync a wiki folder first.
              </div>
            )}

            {(["note", "wiki", "doc"] as SourceKind[]).map((kind) => {
              const items = filtered.filter((s) => s.kind === kind);
              if (items.length === 0) return null;
              const groupLabel = kind === "note" ? "Notes"
                : kind === "wiki" ? "Wiki topics"
                : "Docs · uncategorized";
              return (
                <div key={kind}>
                  <div className="proto-atelier-rag-tree-group">
                    <span>{groupLabel}</span>
                    <span className="proto-atelier-rag-tree-group-count">{items.length}</span>
                  </div>
                  {items.map((s) => {
                    const isSel = selected.has(s.id);
                    return (
                      <button
                        type="button"
                        key={s.id}
                        className={cn(
                          "proto-atelier-rag-tree-item",
                          isSel && "proto-atelier-rag-tree-item-selected",
                        )}
                        onClick={() => toggle(s.id)}
                      >
                        {isSel
                          ? <CheckSquare size={13} strokeWidth={2} />
                          : <Square size={13} strokeWidth={1.6} />}
                        <span className="proto-atelier-rag-tree-item-name">{s.name}</span>
                        <span className="proto-atelier-rag-tree-item-status">
                          <StatusDot on={s.embedded} title="Embedding" letter="E" />
                          <StatusDot on={s.enriched} title="Enriched"  letter="N" />
                          <StatusDot on={s.tagged}   title="AI tags"   letter="T" />
                        </span>
                        <span className="proto-atelier-rag-tree-item-meta">
                          {Math.round(s.byteSize / 1024)}k
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </aside>

        {/* Right scroll panel — bulk actions, 6 paths, tag CRUD */}
        <div className="proto-atelier-rag-panel">

          {/* Bulk actions */}
          <section className="proto-atelier-rag-section">
            <div className="proto-atelier-rag-section-head">
              <h3 className="proto-atelier-rag-section-title">Process selected</h3>
              <div className="proto-atelier-rag-section-meta">
                {selected.size === 0
                  ? "No sources selected"
                  : `${selected.size} source${selected.size === 1 ? "" : "s"} selected`}
              </div>
            </div>
            <div className="proto-atelier-rag-actions-grid">
              <ActionTile
                icon={<Database size={14} />}
                title="Embedding"
                tone="non-llm"
                desc="Re-chunk + re-embed selected sources. No LLM calls."
                disabled={selected.size === 0 || busyKinds.has("embed")}
                running={busyKinds.has("embed")}
                progress={runStats.embed.total > 0 ? { done: runStats.embed.done + runStats.embed.failed, total: runStats.embed.total } : undefined}
                onClick={runEmbedding}
              />
              <ActionTile
                icon={<Sparkles size={14} />}
                title="Enrich"
                tone="llm"
                desc="LLM classifier + tag generation + segment summaries."
                disabled={selected.size === 0 || busyKinds.has("enrich")}
                running={busyKinds.has("enrich")}
                progress={runStats.enrich.total > 0 ? { done: runStats.enrich.done + runStats.enrich.failed, total: runStats.enrich.total } : undefined}
                onClick={runEnrich}
              />
              <ActionTile
                icon={<Hash size={14} />}
                title="Tag pass"
                tone="llm"
                desc="Refresh AI tags on selected (subset of full enrich)."
                disabled={selected.size === 0}
                onClick={runTagPass}
              />
              <ActionTile
                icon={<NetworkIcon size={14} />}
                title="Rebuild entity graph"
                tone="non-llm"
                desc="Re-derive entities + relations across the workspace."
                disabled={busyKinds.has("graph")}
                running={busyKinds.has("graph")}
                onClick={runGraphRebuild}
                wholeWorkspace
              />
            </div>
          </section>

          {/* Live processing panel — auto-shows while jobs are
              running, fades after completion. Combines client-side
              real-time runs (embedding/enrich dispatched from this
              session) with cloud-polled enrich jobs (catches
              MCP-triggered runs from agents). */}
          <RAGProcessingPanel clientRuns={runs} onClearDone={() => {
            setRuns((prev) => {
              const next = new Map(prev);
              for (const [id, r] of prev) if (r.status === "done" || r.status === "failed") next.delete(id);
              return next;
            });
          }} />

          {/* 6 retrieval paths */}
          <section className="proto-atelier-rag-section">
            <div className="proto-atelier-rag-section-head">
              <h3 className="proto-atelier-rag-section-title">Retrieval paths · 6-path hybrid</h3>
              <div className="proto-atelier-rag-section-meta">
                Per <code>P1-2</code> · no path is the single source of rank
              </div>
            </div>
            <div className="proto-atelier-rag-paths">
              {RETRIEVAL_PATHS.map((p) => {
                const Icon = p.icon;
                return (
                  <div key={p.key} className="proto-atelier-rag-path">
                    <span className="proto-atelier-rag-path-icon"><Icon size={13} strokeWidth={1.7} /></span>
                    <div className="proto-atelier-rag-path-body">
                      <div className="proto-atelier-rag-path-name">{p.name}</div>
                      <div className="proto-atelier-rag-path-desc">{p.desc}</div>
                    </div>
                    <span className="proto-atelier-rag-path-status">live</span>
                    <button
                      type="button"
                      onClick={() => rebuildPath(p.key)}
                      className="proto-atelier-rag-path-btn"
                      title={`Rebuild ${p.name} index`}
                    >
                      <RotateCw size={11} strokeWidth={2} /> Rebuild
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Tags CRUD */}
          <section className="proto-atelier-rag-section">
            <div className="proto-atelier-rag-section-head">
              <h3 className="proto-atelier-rag-section-title">Workspace tags</h3>
              <div className="proto-atelier-rag-section-meta">
                {tags === null ? "loading…" : `${tags.length} tag${tags.length === 1 ? "" : "s"}`}
              </div>
            </div>

            <div className="proto-atelier-rag-tag-add">
              <input
                type="text"
                className="proto-atelier-rag-tag-input"
                placeholder="Add a tag (lowercase, dash-separated)…"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
              />
              <button
                type="button"
                onClick={addTag}
                disabled={!tagDraft.trim()}
                className="proto-atelier-rag-tag-add-btn"
              >
                <Plus size={12} strokeWidth={2} /> Add
              </button>
            </div>

            <div className="proto-atelier-rag-tag-list">
              {tags?.map((t) => (
                <div key={t.name} className="proto-atelier-rag-tag-row">
                  <span
                    className="proto-atelier-rag-tag-chip"
                    style={t.color ? { background: `${t.color}22`, color: t.color, borderColor: "transparent" } : undefined}
                  >
                    {t.name}
                  </span>
                  {editingTag === t.name ? (
                    <>
                      <input
                        type="text"
                        className="proto-atelier-rag-tag-edit-input"
                        value={editingTagDesc}
                        onChange={(e) => setEditingTagDesc(e.target.value)}
                        placeholder="Description…"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); saveTagEdit(t.name); }
                          if (e.key === "Escape") { setEditingTag(null); setEditingTagDesc(""); }
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => saveTagEdit(t.name)}
                        className="proto-atelier-rag-tag-icon-btn"
                        title="Save"
                      >
                        Save
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="proto-atelier-rag-tag-desc">
                        {t.description || <em style={{ opacity: 0.6 }}>no description</em>}
                      </span>
                      <button
                        type="button"
                        onClick={() => { setEditingTag(t.name); setEditingTagDesc(t.description || ""); }}
                        className="proto-atelier-rag-tag-icon-btn"
                        title="Edit description"
                      >
                        <Edit3 size={11} strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteTag(t.name)}
                        className="proto-atelier-rag-tag-icon-btn proto-atelier-rag-tag-icon-btn-danger"
                        title="Delete tag"
                      >
                        <X size={11} strokeWidth={2} />
                      </button>
                    </>
                  )}
                </div>
              ))}
              {tags !== null && tags.length === 0 && (
                <div className="proto-atelier-rag-tag-empty">
                  No tags yet. Add one above — these will show up as filter chips
                  on Stream rows and as classification targets during enrich.
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function StatusDot({ on, title, letter }: { on: boolean; title: string; letter: string }) {
  return (
    <span
      className={cn(
        "proto-atelier-rag-status-dot",
        on && "proto-atelier-rag-status-dot-on",
      )}
      title={`${title}: ${on ? "yes" : "no"}`}
      aria-label={`${title} ${on ? "applied" : "missing"}`}
    >
      {letter}
    </span>
  );
}

function ActionTile({
  icon, title, desc, tone, onClick, disabled, running, wholeWorkspace, progress,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  tone: "llm" | "non-llm";
  onClick: () => void;
  disabled?: boolean;
  running?: boolean;
  wholeWorkspace?: boolean;
  progress?: { done: number; total: number };
}) {
  const pct = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "proto-atelier-rag-action",
        tone === "llm" && "proto-atelier-rag-action-llm",
        tone === "non-llm" && "proto-atelier-rag-action-nonllm",
        running && "proto-atelier-rag-action-running",
      )}
    >
      <span className="proto-atelier-rag-action-icon">{icon}</span>
      <div className="proto-atelier-rag-action-body">
        <div className="proto-atelier-rag-action-head">
          <span className="proto-atelier-rag-action-title">{title}</span>
          {tone === "llm"
            ? <span className="proto-atelier-rag-action-pill">LLM</span>
            : <span className="proto-atelier-rag-action-pill proto-atelier-rag-action-pill-cheap">no-LLM</span>}
          {wholeWorkspace && <span className="proto-atelier-rag-action-pill proto-atelier-rag-action-pill-cheap">workspace</span>}
          {progress && (
            <span className="proto-atelier-rag-action-pill proto-atelier-rag-action-pill-progress">
              {progress.done}/{progress.total}
            </span>
          )}
        </div>
        <div className="proto-atelier-rag-action-desc">
          {running && progress
            ? `${progress.done}/${progress.total} done · running…`
            : running ? "running…" : desc}
        </div>
        {progress && (
          <div className="proto-atelier-rag-action-bar">
            <span
              className="proto-atelier-rag-action-bar-fill"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>
    </button>
  );
}
