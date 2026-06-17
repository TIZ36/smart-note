import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, X, Check, Plus, Tag as TagIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import * as cloudApi from "@/lib/cloud-api";
import { useTags } from "@/hooks/useTags";
import type { ChannelId } from "@/lib/types";
import { SkeletonRows } from "./Skeleton";

/* Library · Notes pane (v3.6).
 *
 * Surface:
 *   left  — note list (filterable)
 *   right — title bar + KN tabs (Tags · Raw · Runs)
 *
 * The Tags tab is the primary value:
 *   userTags     — editable, source of truth
 *                  (lives in document.metadata.user_tags[])
 *   aiSuggested  — emitted by the cloud `note_classify` stage
 *                  (dict-constrained LLM); user accepts → moves to
 *                  userTags, dismisses → drops the suggestion. AI
 *                  never directly mutates userTags.
 *
 * Pipeline view + StageDetailModal integration follows the same
 * pattern as the Wiki pane (#8) — left as a follow-up tab to keep
 * v3.6's first cut focused on the auth/ai-suggestion flow.
 */

type Props = {
  onOpenSource: (channel: ChannelId) => void;
};

type KnTab = "tags" | "raw" | "runs";

export function LibraryNotesPane({ onOpenSource }: Props) {
  const [notes, setNotes] = useState<cloudApi.CloudDocument[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [knTab, setKnTab] = useState<KnTab>("tags");
  const [cloudOk, setCloudOk] = useState(true);

  // Per-note state (loaded when a note is selected).
  const [suggestions, setSuggestions] = useState<cloudApi.NoteSuggestion[]>([]);
  const [classifying, setClassifying] = useState(false);
  const [busyTag, setBusyTag] = useState<string | null>(null);
  const [rawContent, setRawContent] = useState<string>("");

  // Workspace tag dictionary — for the "+ Add tag" autocomplete.
  const { tags: dict, refreshTags } = useTags();

  // Initial load: every note in the workspace.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) { setNotes([]); setCloudOk(false); }
          return;
        }
        setCloudOk(true);
        refreshTags();
        const r = await cloudApi.listDocuments({ smartnote_type: "note" });
        if (!alive) return;
        // Sort newest first
        const sorted = [...r.documents].sort((a, b) =>
          (b.updated_at || b.created_at || "").localeCompare(a.updated_at || a.created_at || ""),
        );
        setNotes(sorted);
        if (sorted.length && !activeId) setActiveId(sorted[0].id);
      } catch {
        if (alive) setNotes([]);
      }
    })();
    return () => { alive = false; };
  }, [refreshTags]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh suggestions + raw content when the active note changes
  useEffect(() => {
    if (!activeId) { setSuggestions([]); setRawContent(""); return; }
    let alive = true;
    cloudApi.listNoteSuggestions(activeId)
      .then((r) => { if (alive) setSuggestions(r.suggestions); })
      .catch(() => { if (alive) setSuggestions([]); });
    cloudApi.getDocument(activeId)
      .then((d) => { if (alive) setRawContent((d as cloudApi.CloudDocumentFull).content || ""); })
      .catch(() => { if (alive) setRawContent(""); });
    return () => { alive = false; };
  }, [activeId]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q || !notes) return notes ?? [];
    return notes.filter((n) =>
      n.name.toLowerCase().includes(q) ||
      Object.values(n.metadata || {}).some((v) =>
        typeof v === "string" && v.toLowerCase().includes(q),
      ),
    );
  }, [notes, filter]);

  const active = filtered.find((n) => n.id === activeId) || filtered[0] || null;

  /* userTags lives in document.metadata.user_tags[] */
  const userTags = useMemo<string[]>(() => {
    const md = (active?.metadata && typeof active.metadata === "object" ? active.metadata : {}) as Record<string, unknown>;
    const t = md.user_tags;
    return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
  }, [active]);

  // ── Actions ──────────────────────────────────────────────────────

  const refreshActiveNote = async () => {
    if (!activeId) return;
    try {
      const fresh = await cloudApi.getDocument(activeId);
      setNotes((cur) => cur && cur.map((n) => (n.id === activeId ? fresh : n)));
    } catch { /* silent */ }
  };

  const reclassify = async () => {
    if (!active) return;
    setClassifying(true);
    try {
      await cloudApi.classifyNote(active.id);
      const r = await cloudApi.listNoteSuggestions(active.id);
      setSuggestions(r.suggestions);
    } finally { setClassifying(false); }
  };

  const accept = async (tag: string) => {
    if (!active) return;
    setBusyTag(tag);
    try {
      const r = await cloudApi.acceptNoteSuggestion(active.id, tag);
      // Optimistically: remove from suggestions, refresh user_tags from server result
      setSuggestions((cur) => cur.filter((s) => s.tag !== tag));
      setNotes((cur) => cur && cur.map((n) =>
        n.id === active.id
          ? { ...n, metadata: { ...(n.metadata as Record<string, unknown>), user_tags: r.user_tags } }
          : n,
      ));
    } finally { setBusyTag(null); }
  };

  const dismiss = async (tag: string) => {
    if (!active) return;
    setBusyTag(tag);
    try {
      await cloudApi.dismissNoteSuggestion(active.id, tag);
      setSuggestions((cur) => cur.filter((s) => s.tag !== tag));
    } finally { setBusyTag(null); }
  };

  const removeTag = async (tag: string) => {
    if (!active) return;
    // Remove via PATCH metadata
    setBusyTag(tag);
    try {
      const next = userTags.filter((t) => t !== tag);
      await cloudApi.patchDocument(active.id, {
        metadata: { ...(active.metadata as Record<string, unknown>), user_tags: next },
      });
      setNotes((cur) => cur && cur.map((n) =>
        n.id === active.id
          ? { ...n, metadata: { ...(n.metadata as Record<string, unknown>), user_tags: next } }
          : n,
      ));
    } finally { setBusyTag(null); }
  };

  const addTag = async (tag: string) => {
    if (!active || !tag.trim()) return;
    const norm = tag.trim();
    if (userTags.includes(norm)) return;
    setBusyTag(norm);
    try {
      const r = await cloudApi.addNoteUserTag(active.id, norm);
      setNotes((cur) => cur && cur.map((n) =>
        n.id === active.id
          ? { ...n, metadata: { ...(n.metadata as Record<string, unknown>), user_tags: r.user_tags } }
          : n,
      ));
    } finally { setBusyTag(null); }
  };

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="proto-library-pane-cols">
      <aside className="proto-library-tree">
        <div className="proto-library-tree-bar">
          <input
            className="proto-library-tree-search"
            placeholder="Filter notes…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="proto-library-tree-scroll">
          {!cloudOk && (
            <div className="proto-library-empty">
              Cloud not configured. Connect to see notes.
            </div>
          )}
          {cloudOk && notes === null && <SkeletonRows rows={5} />}
          {cloudOk && notes !== null && filtered.length === 0 && (
            <div className="proto-library-empty">
              {filter.trim() ? "No notes match this filter." : "No notes yet."}
            </div>
          )}
          {cloudOk && filtered.map((n) => (
            <button
              key={n.id}
              type="button"
              className={cn(
                "proto-library-tree-item",
                activeId === n.id && "proto-library-tree-item-selected",
              )}
              onClick={() => setActiveId(n.id)}
            >
              <span className="proto-library-tree-item-name">{n.name}</span>
              <span className="proto-library-tree-item-count">
                {fmtAgo(n.updated_at || n.created_at || "")}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="proto-library-main">
        {!active ? (
          <div className="proto-library-empty">
            Pick a note on the left to inspect tags, source, and runs.
          </div>
        ) : (
          <>
            <div className="proto-library-doc-bar">
              <div className="proto-library-doc-name" title={active.name}>{active.name}</div>
              <div className="proto-library-doc-meta">
                note · last edited {fmtAgo(active.updated_at || active.created_at || "")}
              </div>
              <button
                type="button"
                className="proto-library-action proto-library-doc-bar-action"
                onClick={() => onOpenSource(`source:${active.id}` as ChannelId)}
                title="Open in Note editor"
              >
                Open in editor
              </button>
            </div>

            <div className="proto-library-kn">
              <nav className="proto-library-kn-tabs" role="tablist" aria-label="Note view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={knTab === "tags"}
                  onClick={() => setKnTab("tags")}
                  className={cn("proto-library-kn-tab", knTab === "tags" && "proto-library-kn-tab-active")}
                >
                  Tags
                  <span className="proto-library-kn-tab-count">{userTags.length}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={knTab === "raw"}
                  onClick={() => setKnTab("raw")}
                  className={cn("proto-library-kn-tab", knTab === "raw" && "proto-library-kn-tab-active")}
                >
                  Raw
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={knTab === "runs"}
                  onClick={() => setKnTab("runs")}
                  className={cn("proto-library-kn-tab", knTab === "runs" && "proto-library-kn-tab-active")}
                >
                  Runs
                </button>
              </nav>

              <div className="proto-library-kn-body">
                {knTab === "tags" && (
                  <NoteTagsView
                    userTags={userTags}
                    suggestions={suggestions}
                    dict={dict.map((t) => t.name)}
                    classifying={classifying}
                    busyTag={busyTag}
                    onAccept={accept}
                    onDismiss={dismiss}
                    onRemove={removeTag}
                    onAdd={addTag}
                    onReclassify={reclassify}
                  />
                )}
                {knTab === "raw" && (
                  <pre className="proto-library-raw">{rawContent || "(empty)"}</pre>
                )}
                {knTab === "runs" && (
                  <NoteRunsBody documentId={active.id} />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Tags view ─── */

function NoteTagsView({
  userTags, suggestions, dict, classifying, busyTag,
  onAccept, onDismiss, onRemove, onAdd, onReclassify,
}: {
  userTags: string[];
  suggestions: cloudApi.NoteSuggestion[];
  dict: string[];
  classifying: boolean;
  busyTag: string | null;
  onAccept: (tag: string) => void;
  onDismiss: (tag: string) => void;
  onRemove: (tag: string) => void;
  onAdd: (tag: string) => void;
  onReclassify: () => void;
}) {
  return (
    <div className="proto-note-tags-block">
      <div className="proto-note-tag-row">
        <span className="proto-note-tag-label"><TagIcon size={11} /> Tags</span>
        {userTags.length === 0 && (
          <span className="proto-note-tag-empty">No tags yet — add one below or accept an AI suggestion.</span>
        )}
        {userTags.map((t) => (
          <span key={t} className="proto-note-user-tag">
            <span>{t}</span>
            <button
              type="button"
              className="proto-note-user-tag-x"
              aria-label={`Remove ${t}`}
              disabled={busyTag === t}
              onClick={() => onRemove(t)}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <AddTag dict={dict.filter((d) => !userTags.includes(d))} onAdd={onAdd} />
      </div>

      <div className="proto-note-tag-row ai">
        <span className="proto-note-tag-label">
          <Sparkles size={11} /> AI suggests
          {classifying && <Loader2 size={11} className="animate-spin" style={{ marginLeft: 8 }} />}
        </span>
        {suggestions.length === 0 && !classifying && (
          <>
            <span className="proto-note-tag-empty">No suggestions right now.</span>
            <button type="button" className="proto-stage-btn proto-stage-btn-ghost" onClick={onReclassify}>
              Re-classify
            </button>
          </>
        )}
        {suggestions.map((s) => (
          <span key={s.tag} className="proto-note-ai-sugg" title={s.reasoning || `confidence ${Math.round(s.confidence * 100)}%`}>
            <span>{s.tag}</span>
            <span className="proto-note-ai-conf">{Math.round(s.confidence * 100)}%</span>
            <button
              type="button"
              className="proto-note-ai-accept"
              aria-label={`Accept ${s.tag}`}
              disabled={busyTag === s.tag}
              onClick={() => onAccept(s.tag)}
            >
              <Check size={10} />
            </button>
            <button
              type="button"
              className="proto-note-ai-dismiss"
              aria-label={`Dismiss ${s.tag}`}
              disabled={busyTag === s.tag}
              onClick={() => onDismiss(s.tag)}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        {suggestions.length > 0 && (
          <span className="proto-note-tag-help">
            classified against your <b>{dict.length}-tag</b> dictionary
          </span>
        )}
      </div>
    </div>
  );
}

function AddTag({ dict, onAdd }: { dict: string[]; onAdd: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return dict
      .filter((t) => !qq || t.toLowerCase().includes(qq))
      .slice(0, 12);
  }, [dict, q]);

  const canCreate = q.trim() && !dict.includes(q.trim());

  return (
    <span className="proto-note-tag-add">
      <input
        ref={inputRef}
        className="proto-note-tag-add-input"
        placeholder="+ Add tag…"
        value={q}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { (e.target as HTMLInputElement).blur(); setOpen(false); }
          if (e.key === "Enter") {
            const first = filtered[0] || (canCreate ? q.trim() : null);
            if (first) { onAdd(first); setQ(""); setOpen(false); inputRef.current?.blur(); }
          }
        }}
        autoComplete="off"
      />
      {open && (
        <div className="proto-note-tag-add-menu">
          {filtered.length === 0 && !canCreate && (
            <div className="proto-note-tag-add-empty">No matching tags.</div>
          )}
          {filtered.map((t) => (
            <div
              key={t}
              className="proto-note-tag-add-item"
              onMouseDown={(e) => { e.preventDefault(); onAdd(t); setQ(""); setOpen(false); }}
            >
              <span>{t}</span>
            </div>
          ))}
          {canCreate && (
            <div
              className="proto-note-tag-add-item create"
              onMouseDown={(e) => { e.preventDefault(); onAdd(q.trim()); setQ(""); setOpen(false); }}
            >
              <Plus size={11} />
              <span>Create "{q.trim()}"</span>
            </div>
          )}
        </div>
      )}
    </span>
  );
}

/* ─── Notes Runs tab — note_classify run history for this doc ─── */

function NoteRunsBody({ documentId }: { documentId: string }) {
  const [runs, setRuns] = useState<cloudApi.RecentRun[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true);
      try {
        // Server-side filter doesn't exist yet — fetch the recent
        // window and filter client-side. At v3.6 scale, 100 rows per
        // workspace is plenty; future work: GET /v1/processing/recent
        // ?document_id=…&kind=… for proper paging.
        const all = await cloudApi.listRecentRuns(100);
        if (!alive) return;
        const mine = all.filter((r) =>
          r.document_id === documentId && r.kind === "note_classify",
        );
        setRuns(mine);
      } catch {
        if (alive) setRuns([]);
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    function onWs(ev: Event) {
      const detail = (ev as CustomEvent<{ document_id?: string; kind?: string }>).detail;
      if (detail?.document_id === documentId && detail?.kind === "note_classify") load();
    }
    window.addEventListener("smartnote:doc-pipeline-changed", onWs);
    return () => {
      alive = false;
      window.removeEventListener("smartnote:doc-pipeline-changed", onWs);
    };
  }, [documentId]);

  if (loading) {
    return <SkeletonRows rows={3} />;
  }
  if (!runs || !runs.length) {
    return (
      <div className="proto-library-empty">
        No <code>note_classify</code> runs yet. Use Re-classify in the
        Tags tab to start one.
      </div>
    );
  }
  return (
    <div className="proto-note-runs-list">
      {runs.map((r) => <NoteRunRow key={r.id} run={r} />)}
    </div>
  );
}

function NoteRunRow({ run: r }: { run: cloudApi.RecentRun }) {
  const result = (r.result || {}) as Record<string, unknown>;
  const cost = typeof result.cost_usd === "number" ? result.cost_usd : null;
  const model = typeof result.model === "string" ? result.model : null;
  const suggested = typeof result.suggested_count === "number" ? result.suggested_count : null;
  const dictSize = typeof result.dictionary_size === "number" ? result.dictionary_size : null;
  const dur = typeof result.duration_ms === "number" ? Math.round(result.duration_ms / 100) / 10 : null;
  const errorText = typeof r.error === "string"
    ? r.error
    : r.error
      ? JSON.stringify(r.error)
      : "";

  return (
    <div className={cn("proto-pipeline-row", "proto-note-run-row", `s-${r.status === "skipped_dedup" ? "skipped" : r.status}`)}>
      <span className="proto-pipeline-row-stamp">N</span>
      <div className="proto-pipeline-row-body">
        <div className="proto-pipeline-row-name proto-note-run-row-head">
          <span className="proto-note-run-row-id">{r.id.slice(0, 8)}</span>
          <span className="proto-note-run-row-status">{r.status}</span>
        </div>
        <div className="proto-pipeline-row-detail">
          {fmtAgo(r.finished_at || r.started_at || r.created_at || "")}
          {suggested != null && ` · ${suggested} suggestions`}
          {dictSize != null && ` from ${dictSize}-tag dict`}
          {dur != null && ` · ${dur}s`}
          {cost != null && ` · $${cost.toFixed(4)}`}
          {model && ` · ${model}`}
          {errorText && (
            <span className="proto-note-run-row-error" title={errorText}>
              · failed
            </span>
          )}
        </div>
      </div>
      <div />
    </div>
  );
}

function fmtAgo(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60)        return "just now";
  if (diff < 3600)      return Math.floor(diff / 60) + "m ago";
  if (diff < 86400)     return Math.floor(diff / 3600) + "h ago";
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + "d ago";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
