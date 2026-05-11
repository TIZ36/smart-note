import { useEffect, useState } from "react";
import {
  FileText, BookOpen, Sparkles, Database, Hash, Network as NetworkIcon,
  RotateCw, Plus, X, Edit3,
} from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";

/* WorkspacePanel — workspace-level concerns extracted from the old
 * RAG (knowledge-processing) page:
 *
 *   1. 6-path retrieval status (FTS / vector / n-gram / substring /
 *      keyword / tag-meta) with per-path rebuild affordances.
 *   2. Workspace tag vocabulary CRUD (used by Enrich classifier).
 *   3. Rebuild entity graph trigger.
 *
 * These are not per-document — they apply to the whole workspace.
 * Library Docs renders this below the per-doc area as a collapsible
 * "Workspace" card so the merged surface keeps one mental model.
 */

type RetrievalPath = {
  key: string;
  name: string;
  desc: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  built: "embed" | "auto" | "query" | "enrich";
  rebuild?: { label: string; rationale: string };
};

const RETRIEVAL_PATHS: RetrievalPath[] = [
  { key: "vec",     name: "Vector",       desc: "Cosine similarity on chunk embedding.",                       icon: Sparkles, built: "embed",
    rebuild: { label: "Re-embed all", rationale: "Run after switching embedding model — old vectors won't match the new dimensionality." } },
  { key: "fts",     name: "FTS",          desc: "Postgres FTS token match. Auto-maintained by trigger; no manual rebuild needed.", icon: FileText, built: "auto" },
  { key: "ngram",   name: "N-gram",       desc: "Char-bigram overlap, computed at query time. No index to rebuild.",            icon: Hash,     built: "query" },
  { key: "sub",     name: "Substring",    desc: "LIKE substring match, computed at query time. No index to rebuild.",           icon: Database, built: "query" },
  { key: "kw",      name: "Keyword",      desc: "Token overlap on chunk.keywords. Populated by Enrich.",                        icon: Hash,     built: "enrich",
    rebuild: { label: "Re-extract", rationale: "Run after changing the Enrich prompt or model — keyword set will refresh across all chunks." } },
  { key: "tagmeta", name: "Tag-meta",     desc: "Chunk dimension/scope match. Populated by chapter splitter (wiki) + Enrich (note).", icon: BookOpen, built: "enrich",
    rebuild: { label: "Re-classify", rationale: "Run after changing classifier logic / tag schema — re-applies dimension+scope across all chunks." } },
];

const PATH_BUILT_LABEL: Record<string, string> = {
  embed:  "embed",
  auto:   "auto",
  query:  "query-time",
  enrich: "enrich",
};

type Props = {
  /** Runs the workspace-wide entity graph rebuild. Wired to
   *  useBulkRuns so the run shows up in the shared ProcessingPanel. */
  onRebuildGraph: () => void;
  graphBusy: boolean;
  onFlash: (msg: string, tone?: "ok" | "err") => void;
};

export function WorkspacePanel({ onRebuildGraph, graphBusy, onFlash }: Props) {
  const [tags, setTags] = useState<cloudApi.CloudTag[] | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editingTagDesc, setEditingTagDesc] = useState("");

  useEffect(() => {
    let alive = true;
    cloudApi.fetchTags()
      .then((t) => alive && setTags(t))
      .catch(() => alive && setTags([]));
    return () => { alive = false; };
  }, []);

  function broadcastTagsChanged() {
    try { window.dispatchEvent(new CustomEvent("smartnote:tags-changed")); } catch { /* silent */ }
  }

  async function addTag() {
    const name = tagDraft.trim();
    if (!name) return;
    try {
      await cloudApi.upsertTag({ name });
      setTagDraft("");
      const t = await cloudApi.fetchTags();
      setTags(t);
      broadcastTagsChanged();
    } catch (e) {
      onFlash(e instanceof Error ? e.message : String(e), "err");
    }
  }

  async function saveTagEdit(name: string) {
    try {
      await cloudApi.upsertTag({ name, description: editingTagDesc });
      setEditingTag(null);
      setEditingTagDesc("");
      const t = await cloudApi.fetchTags();
      setTags(t);
      broadcastTagsChanged();
    } catch (e) {
      onFlash(e instanceof Error ? e.message : String(e), "err");
    }
  }

  async function deleteTag(name: string) {
    if (!window.confirm(`Delete tag "${name}"? Existing tag-segments stay but won't be re-applied.`)) return;
    try {
      await cloudApi.deleteTag(name);
      const t = await cloudApi.fetchTags();
      setTags(t);
      broadcastTagsChanged();
    } catch (e) {
      onFlash(e instanceof Error ? e.message : String(e), "err");
    }
  }

  function rebuildPath(key: string) {
    onFlash(`${key} rebuild — backend endpoint coming Phase 4`);
  }

  return (
    <>
      {/* Entity graph rebuild — workspace-wide, not per-doc. */}
      <section className="proto-atelier-rag-section">
        <div className="proto-atelier-rag-section-head">
          <h3 className="proto-atelier-rag-section-title">Workspace · graph</h3>
          <div className="proto-atelier-rag-section-meta">
            Re-derive entities + co-occurrence edges across all docs.
          </div>
        </div>
        <button
          type="button"
          className="proto-atelier-rag-action proto-atelier-rag-action-nonllm"
          onClick={onRebuildGraph}
          disabled={graphBusy}
          style={{ alignSelf: "flex-start" }}
        >
          <span className="proto-atelier-rag-action-icon"><NetworkIcon size={14} /></span>
          <div className="proto-atelier-rag-action-body">
            <div className="proto-atelier-rag-action-head">
              <span className="proto-atelier-rag-action-title">
                {graphBusy ? "Rebuilding…" : "Rebuild entity graph"}
              </span>
              <span className="proto-atelier-rag-action-pill proto-atelier-rag-action-pill-cheap">workspace</span>
            </div>
            <div className="proto-atelier-rag-action-desc">
              Refreshes the global graph used for entity-aware retrieval.
            </div>
          </div>
        </button>
      </section>

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
                <span
                  className={`proto-atelier-rag-path-status proto-atelier-rag-path-status-${p.built}`}
                  title={
                    p.built === "embed"  ? "Built when you run Embedding."
                    : p.built === "auto"   ? "Maintained automatically by Postgres trigger."
                    : p.built === "query"  ? "Computed at query time. No index, nothing to rebuild."
                    :                        "Populated when you run Enrich."
                  }
                >
                  {PATH_BUILT_LABEL[p.built]}
                </span>
                {p.rebuild ? (
                  <button
                    type="button"
                    onClick={() => rebuildPath(p.key)}
                    className="proto-atelier-rag-path-btn"
                    title={p.rebuild.rationale}
                  >
                    <RotateCw size={11} strokeWidth={2} /> {p.rebuild.label}
                  </button>
                ) : (
                  <span
                    className="proto-atelier-rag-path-noop"
                    title={
                      p.built === "auto"  ? "Postgres trigger keeps this in sync — never needs rebuild."
                      : p.built === "query" ? "No index — recomputed on every search."
                      : "Auto-maintained."
                    }
                  >
                    no rebuild
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>

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
    </>
  );
}
