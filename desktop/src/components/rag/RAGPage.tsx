import React, { useEffect, useMemo, useState } from "react";
import {
  Sparkles, Database, Network as NetworkIcon,
  CheckSquare, Square, Plus, X, Edit3,
} from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { cn } from "@/lib/cn";
import { useKPSession, KPSessionPanel, type KPDocRef } from "./KPSession";

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
  tagCount: number;
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

export function RAGPage() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [flash, setFlash] = useState<{ msg: string; tone: "ok" | "err" } | null>(null);
  // Real-time per-doc run map. Powers the Processing panel + the
  // bulk-action button progress label. Cloud-side ingest is synchronous
  // per doc, so we drive concurrency client-side and update this
  // map as each call returns.
  const [runs, setRuns] = useState<Map<string, RunStatus>>(new Map());
  // Cloud provider availability — drives whether the Enrich /
  // Wiki-abstract tiles are clickable. Both burn cloud LLM tokens, so
  // without an api_key on /v1/enrich/provider they 412 anyway. Better
  // to gate up-front + tell the user where to fix it.
  const [cloudProviderReady, setCloudProviderReady] = useState<boolean | null>(null);

  // Tags
  const [tags, setTags] = useState<cloudApi.CloudTag[] | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editingTagDesc, setEditingTagDesc] = useState("");

  // Cloud provider readiness — fetch once on mount. Refreshed when
  // the user explicitly retries an action (the run* functions catch
  // 412 / 409 from the cloud and re-check). Polling on a timer was
  // causing a churn of failed fetches when cloud was unreachable.
  useEffect(() => {
    let alive = true;
    cloudApi.fetchEnrichProvider()
      .then((cfg) => { if (alive) setCloudProviderReady(!!cfg.has_api_key); })
      .catch(() => { if (alive) setCloudProviderReady(false); });
    return () => { alive = false; };
  }, []);

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

          // T = AI tags applied. Only Enrich (LLM classification +
          // tag generation) sets real AI tags — wiki's chapter
          // splitter writes structural tag_meta (chunk.dimension /
          // scope), which is queryable but is NOT the same as user-
          // facing AI tags. So T lights only when enrich has run,
          // regardless of kind.
          const tagged = tagsApplied || !!lastDone;

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
            tagCount: Array.isArray(md.ai_tags) ? (md.ai_tags as unknown[]).length : 0,
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

  useEffect(() => {
    if (!sources || sources.length === 0) return;
    if (activeSourceId && sources.some((s) => s.id === activeSourceId)) return;
    setActiveSourceId(sources[0].id);
    setSelected(new Set([sources[0].id]));
  }, [sources, activeSourceId]);

  const activeSource = useMemo(() => {
    if (!sources || sources.length === 0) return null;
    return sources.find((s) => s.id === activeSourceId) || sources[0];
  }, [sources, activeSourceId]);

  const counts = useMemo(() => {
    const all = sources?.length ?? 0;
    const notes = sources?.filter((s) => s.kind === "note").length ?? 0;
    const wiki = sources?.filter((s) => s.kind === "wiki").length ?? 0;
    const docs = sources?.filter((s) => s.kind === "doc").length ?? 0;
    return { all, notes, wiki, docs };
  }, [sources]);

  function toggle(id: string) {
    setActiveSourceId(id);
    setSelected(new Set([id]));
  }

  function selectAll() {
    setSelected(new Set(filtered.map((s) => s.id)));
    if (filtered[0]) setActiveSourceId(filtered[0].id);
  }
  function selectNone() {
    setSelected(new Set());
  }
  function selectKind(kind: SourceKind) {
    const items = filtered.filter((s) => s.kind === kind);
    setSelected(new Set(items.map((s) => s.id)));
    if (items[0]) setActiveSourceId(items[0].id);
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

  // Resolve doc id → KPDocRef for the session panel. Captured here
  // so the session keeps the doc name even after the source list
  // refreshes mid-flight.
  function _kpDocs(ids: Iterable<string>): KPDocRef[] {
    const byId = new Map((sources ?? []).map((s) => [s.id, s]));
    return [...ids].flatMap((id) => {
      const s = byId.get(id);
      return s ? [{ id: s.id, name: s.name, kind: s.kind }] : [];
    });
  }

  // Lift session state above the action handlers so the inline "Run
  // Embedding now" fix on a wiki preflight blocker can call back into
  // this same submitter.
  const session = useKPSession({
    cloudProviderReady,
    runEmbedding: async (docIds: string[]) => {
      session.submit("embed", _kpDocs(docIds));
    },
  });

  async function runEmbedding() {
    if (selected.size === 0) return;
    session.submit("embed", _kpDocs(selected));
  }

  async function runEnrich() {
    if (selected.size === 0) return;
    session.submit("enrich", _kpDocs(selected), { force: true });
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

  // For each action, count how many of the SELECTED sources are
  // "fresh" (never had this stage) vs "already done" (need re-run
  // semantics). The action tile uses these counts to:
  //   - flip its label between "Embedding" and "Re-embed"
  //   - show a "(N new · M refresh)" hint when the selection mixes
  // Source.embedded / .enriched / .tagged are the truth markers.
  const selectionAnalysis = useMemo(() => {
    const sel = sources?.filter((s) => selected.has(s.id)) ?? [];
    const total = sel.length;
    const embFresh = sel.filter((s) => !s.embedded).length;
    const embDone  = sel.filter((s) =>  s.embedded).length;
    const enrFresh = sel.filter((s) => !s.enriched).length;
    const enrDone  = sel.filter((s) =>  s.enriched).length;
    const tagFresh = sel.filter((s) => !s.tagged).length;
    const tagDone  = sel.filter((s) =>  s.tagged).length;
    return { total, embFresh, embDone, enrFresh, enrDone, tagFresh, tagDone };
  }, [sources, selected]);

  function actionLabel(stage: "embed" | "enrich" | "tag"): { title: string; desc: string } {
    const a = selectionAnalysis;
    const fresh = stage === "embed" ? a.embFresh : stage === "enrich" ? a.enrFresh : a.tagFresh;
    const done  = stage === "embed" ? a.embDone  : stage === "enrich" ? a.enrDone  : a.tagDone;
    const baseTitle = stage === "embed" ? "Embedding" : stage === "enrich" ? "Enrich" : "Tag pass";
    if (a.total === 0) {
      const baseDesc =
        stage === "embed"  ? "Re-chunk + re-embed selected sources. No LLM calls."
        : stage === "enrich" ? "LLM classifier + tag generation + segment summaries."
        :                       "Refresh AI tags on selected (subset of full enrich).";
      return { title: baseTitle, desc: baseDesc };
    }
    if (fresh === 0 && done > 0) {
      // All selected are already done → re-run semantics
      const verb = stage === "embed" ? "Re-embed" : stage === "enrich" ? "Re-enrich" : "Re-tag";
      return {
        title: verb,
        desc: `All ${done} already complete. Click to re-run from scratch (idempotent — replaces existing).`,
      };
    }
    if (fresh > 0 && done > 0) {
      // Mixed selection
      return {
        title: baseTitle,
        desc: `${fresh} new · ${done} refresh. Click to process all selected.`,
      };
    }
    // All fresh
    return {
      title: baseTitle,
      desc:
        stage === "embed"  ? `${fresh} source${fresh === 1 ? "" : "s"} not yet embedded — chunk + embed (no LLM).`
        : stage === "enrich" ? `${fresh} source${fresh === 1 ? "" : "s"} not yet enriched — LLM classifier + tag generation.`
        :                       `${fresh} source${fresh === 1 ? "" : "s"} not yet tagged — AI tag pass.`,
    };
  }

  // ── Tag CRUD ────────────────────────────────────────────────────
  // Notify the rest of the app (Note top-strip, etc.) that the
  // workspace tag vocabulary changed. Window-event broadcast keeps
  // the contract loose so we don't have to thread callbacks down.
  const _broadcastTagsChanged = () => {
    try { window.dispatchEvent(new CustomEvent("smartnote:tags-changed")); } catch { /* silent */ }
  };

  async function addTag() {
    const name = tagDraft.trim();
    if (!name) return;
    try {
      await cloudApi.upsertTag({ name });
      setTagDraft("");
      const t = await cloudApi.fetchTags();
      setTags(t);
      _broadcastTagsChanged();
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
      _broadcastTagsChanged();
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
      _broadcastTagsChanged();
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
                          {/* Three-letter pipeline state — matches Library KN
                              badges so KP and Library agree. R label varies
                              by kind: note → "aisegment", wiki → "wiki-knowledge-sheet". */}
                          <StatusDot on={s.embedded} title="Embed — chunks indexed" letter="E" />
                          <StatusDot
                            on={s.enriched}
                            title={s.kind === "wiki" ? "Wiki knowledge-sheet — per-chapter summaries" : "AI segment — line-range tag classification"}
                            letter="A"
                          />
                          <StatusDot
                            on={s.enriched}
                            title="Info-graph — entities + co-occurrence edges (rides R)"
                            letter="G"
                          />
                        </span>
                        <span className="proto-atelier-rag-tree-item-meta">
                          Tags {s.tagCount}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </aside>

        {/* Right scroll panel — selected-file workbench + supporting surfaces */}
        <div className="proto-atelier-rag-panel">

          <section className="proto-atelier-rag-workbench">
            <div className="proto-atelier-rag-workbench-head">
              <div>
                <h3 className="proto-atelier-rag-section-title">KP Workbench</h3>
                <div className="proto-atelier-rag-section-meta">
                  {activeSource ? activeSource.name : "Select a file to inspect its knowledge process"}
                </div>
              </div>
              <div className="proto-atelier-rag-actions-row">
              {(() => { const e = actionLabel("embed"); return (
                <ActionTile
                  icon={<Database size={14} />}
                  title={e.title}
                  tone="non-llm"
                  desc={e.desc}
                  disabled={selected.size === 0 || busyKinds.has("embed")}
                  running={busyKinds.has("embed")}
                  progress={runStats.embed.total > 0 ? { done: runStats.embed.done + runStats.embed.failed, total: runStats.embed.total } : undefined}
                  onClick={runEmbedding}
                />
              ); })()}
              {(() => { const e = actionLabel("enrich"); return (
                <ActionTile
                  icon={<Sparkles size={14} />}
                  title={e.title}
                  tone="llm"
                  desc={activeSource?.kind === "wiki"
                    ? "Wiki uses LOCAL AI, then uploads a Cloud artifact. Notes use Cloud AI enrich."
                    : cloudProviderReady === false
                    ? "Cloud AI provider not set — wiki still uses LOCAL AI; notes need Cloud AI."
                    : e.desc}
                  disabled={selected.size === 0 || busyKinds.has("enrich")}
                  running={busyKinds.has("enrich")}
                  progress={runStats.enrich.total > 0 ? { done: runStats.enrich.done + runStats.enrich.failed, total: runStats.enrich.total } : undefined}
                  onClick={runEnrich}
                />
              ); })()}
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
            </div>
            <KPFileInspector source={activeSource} turns={session.turns} />
            <div className="proto-atelier-rag-workbench-lower">
              <KPSessionPanel session={session} />
              {activeSource?.kind === "note" && (
          <section className="proto-atelier-rag-tags-section">
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

function KPFileInspector({
  source,
  turns,
}: {
  source: Source | null;
  turns: ReturnType<typeof useKPSession>["turns"];
}) {
  if (!source) {
    return (
      <div className="proto-atelier-rag-inspector-empty">
        Select a file to inspect its knowledge process.
      </div>
    );
  }
  const activeTurn = turns.find((t) => t.docs.some((d) => d.id === source.id));
  const isWiki = source.kind === "wiki";
  const aiSource = isWiki ? "LOCAL AI · Desktop llmapi" : "Cloud AI · enrich provider";
  const artifact = isWiki ? "Cloud artifact · wiki_chapters" : "Cloud artifact · tag_segments";
  const steps = activeTurn?.steps.filter((s) => !s.id.startsWith("preflight")) || [];
  return (
    <div className="proto-atelier-rag-inspector">
      <div className="proto-atelier-rag-inspector-main">
        <div className="proto-atelier-rag-file-head">
          <div>
            <div className="proto-atelier-rag-file-kind">{source.kind}</div>
            <h4>{source.name}</h4>
          </div>
          <div className="proto-atelier-rag-file-badges">
            <span className="proto-atelier-rag-file-badge">{aiSource}</span>
            <span className="proto-atelier-rag-file-badge proto-atelier-rag-file-badge-cloud">{artifact}</span>
          </div>
        </div>
        <div className="proto-atelier-rag-inspector-process">
          {(steps.length > 0 ? steps : [
            { id: "idle-parse", label: "Parse sections", status: source.embedded ? "done" : "pending", detail: source.embedded ? "Chunks available" : "Run Embedding first for chunks" },
            { id: "idle-ai", label: isWiki ? "Summarize chapters" : "Classify note segments", status: source.enriched ? "done" : "pending", detail: source.enriched ? "Artifact exists" : "Run Enrich to build artifact" },
            { id: "idle-upload", label: "Upload cloud artifact", status: source.enriched ? "done" : "pending", detail: artifact },
            { id: "idle-graph", label: "Graph status", status: source.enriched ? "done" : "pending", detail: source.enriched ? "Entities ready" : "Waiting for enrich artifact" },
          ] as Array<{ id: string; label: string; status: string; detail?: string; progress?: { current: number; total: number } }>).map((s, index) => (
            <div key={s.id} className={cn("proto-atelier-rag-inspector-step", `proto-atelier-rag-inspector-step-${s.status}`)}>
              <span className="proto-atelier-rag-inspector-step-index">
                {s.status === "done" ? "✓" : s.status === "failed" ? "×" : s.status === "running" ? "▸" : index + 1}
              </span>
              <span className="proto-atelier-rag-inspector-step-body">
                <strong>{s.label}</strong>
                {s.detail && <em>{s.detail}</em>}
                {s.progress && s.progress.total > 0 && (
                  <small>{s.progress.current}/{s.progress.total}</small>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
      <aside className="proto-atelier-rag-inspector-side">
        <div className="proto-atelier-rag-state-grid">
          <span>Embedding</span><strong>{source.embedded ? "Complete" : "Pending"}</strong>
          <span>Artifact</span><strong>{source.enriched ? "Available" : "Missing"}</strong>
          <span>Graph</span><strong>{source.enriched ? "Ready" : "Pending"}</strong>
          <span>Tags</span><strong>{source.tagCount}</strong>
          <span>AI source</span><strong>{aiSource}</strong>
          <span>Cloud</span><strong>Storage only</strong>
        </div>
        <div className="proto-atelier-rag-recovery-box">
          <strong>Recovery</strong>
          <span>{activeTurn?.status === "failed" ? "Failed steps can be continued from this file." : "No failed chapters for this file."}</span>
          <div>
            <button type="button" disabled={activeTurn?.status !== "failed"}>Continue failed only</button>
            <button type="button">Re-run all</button>
          </div>
        </div>
      </aside>
    </div>
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
