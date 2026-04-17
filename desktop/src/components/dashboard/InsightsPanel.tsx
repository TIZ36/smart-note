import { useState, useEffect, useCallback, useMemo } from "react";
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  Search,
  Scissors,
  Clock,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  FileText,
  Info,
} from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";

type Props = {
  gatewayOnline: boolean;
  embeddingMode: string;
};

/**
 * Insights — one page that answers "what's going on in my knowledge base,
 * and what should I do about it?"
 *
 * Top: compressed status line.
 * Middle: action queue (conflicts resolve inline; others explain why).
 * Bottom: meta-memory (Claude's cross-session rules) + collapsible stats.
 */
export function InsightsPanel({ gatewayOnline, embeddingMode }: Props) {
  const [overview, setOverview] = useState<api.DashboardOverview | null>(null);
  const [conflicts, setConflicts] = useState<api.Conflict[]>([]);
  const [splits, setSplits] = useState<api.SplitSuggestion[]>([]);
  const [enrich, setEnrich] = useState<api.EnrichQueueSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, cf, sp, eq] = await Promise.all([
        api.fetchDashboardOverview(),
        api.fetchConflicts(),
        api.fetchSplitSuggestions(),
        api.fetchEnrichQueue(),
      ]);
      setOverview(ov);
      setConflicts(cf.conflicts);
      setSplits(sp.suggestions);
      setEnrich(eq);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function handleConflictResolved(id: number) {
    setConflicts((prev) => prev.filter((c) => c.id !== id));
  }

  const gapCount = overview?.recent_gaps.filter((g) => g.c >= 2).length ?? 0;
  const pendingBuilds = enrich?.note_segments?.pending_builds ?? 0;
  const pendingChunks = enrich?.note_segments?.builds.reduce((s, b) => s + b.chunks, 0) ?? 0;

  const totalActions = conflicts.length + splits.length + gapCount + (pendingBuilds > 0 ? 1 : 0);

  return (
    <div className="proto-dashboard">
      <div className="proto-dashboard-header">
        <h1 className="proto-dashboard-title">Insights</h1>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="proto-btn proto-btn-secondary"
          aria-label="Refresh"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
          <span>Refresh</span>
        </button>
      </div>

      {error && <p className="proto-dashboard-error">Failed to load: {error}</p>}

      <StatusLine
        overview={overview}
        gatewayOnline={gatewayOnline}
        embeddingMode={embeddingMode}
      />

      <section className="proto-dashboard-section">
        <h2 className="proto-section-label">
          Needs your attention
          {totalActions > 0 && (
            <span className="proto-section-label-count">{totalActions}</span>
          )}
        </h2>

        {totalActions === 0 && !loading && (
          <p className="proto-dashboard-empty">
            All clear — nothing waiting on you.
          </p>
        )}

        {conflicts.length > 0 && (
          <ActionGroup
            id="conflicts"
            icon={<AlertTriangle size={14} />}
            title={`${conflicts.length} classification ${conflicts.length === 1 ? "conflict" : "conflicts"}`}
            subtitle="The same lines got two different tags across ingests. Pick which one wins."
            severity="warn"
            defaultOpen
          >
            <p className="proto-insight-why">
              <strong>Why resolve:</strong> until you pick a side, the older tag
              sticks — new classifications (e.g. from a better model or new
              meta-memory rule) never take effect. Tag filters show the stale
              version.
            </p>
            <ul className="proto-insight-items">
              {conflicts.map((c) => (
                <ConflictRow key={c.id} conflict={c} onResolved={handleConflictResolved} />
              ))}
            </ul>
          </ActionGroup>
        )}

        {pendingBuilds > 0 && (
          <ActionGroup
            id="enrich"
            icon={<Clock size={14} />}
            title={`${pendingChunks} ${pendingChunks === 1 ? "chunk" : "chunks"} awaiting classification`}
            subtitle={`${pendingBuilds} ${pendingBuilds === 1 ? "ingest" : "ingests"} parked in delegate mode, waiting for Claude to assign tags.`}
          >
            <p className="proto-insight-why">
              <strong>Why resolve:</strong> chunks without a tag are invisible
              to tag filters and wiki-topic scopes. They still appear in full
              search, but filtering by "work" / "learn" / etc. misses them
              entirely. The system doesn't auto-fall-back — it waits.
            </p>
            <p className="proto-insight-action-hint">
              How to clear: open Claude Code in this repo and say{" "}
              <code className="proto-code">process pending enrichments</code>.
              Claude's MCP tools will read each chunk, classify it, and call{" "}
              <code className="proto-code">submit_enrichments</code>.
            </p>
            {enrich?.note_segments && enrich.note_segments.builds.length > 0 && (
              <ul className="proto-insight-items">
                {enrich.note_segments.builds.map((b) => (
                  <li key={b.build_id} className="proto-insight-row-compact">
                    <FileText size={11} />
                    <span className="proto-insight-row-primary">{b.source_file}</span>
                    <span className="proto-insight-row-trailing">
                      build {b.build_id.slice(-8)} · {b.chunks} chunks
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </ActionGroup>
        )}

        {splits.length > 0 && (
          <ActionGroup
            id="splits"
            icon={<Scissors size={14} />}
            title={`${splits.length} oversized ${splits.length === 1 ? "segment" : "segments"}`}
            subtitle="Single tag-segment covers 200+ lines with multiple sub-headings. Search treats the whole thing as one unit."
          >
            <p className="proto-insight-why">
              <strong>Why resolve:</strong> a query that matches any line in
              the segment gets the full 200+ line payload as evidence. Search
              still works, but precision drops — the LLM has to wade through
              tangential context, and the answer gets muddier.
            </p>
            <p className="proto-insight-action-hint">
              How to resolve: edit the raw file between the flagged lines —
              split the mega-section under its sub-headings into smaller
              sections — then re-ingest. No one-click available; content
              decisions are yours.
            </p>
            <ul className="proto-insight-items">
              {splits.slice(0, 6).map((s) => (
                <li key={s.segment_id} className="proto-insight-row-compact">
                  <span className="proto-insight-row-primary">
                    [{s.tag}] {s.topic_name || s.source_file.split("/").pop()}
                  </span>
                  <span className="proto-insight-row-trailing">
                    {s.source_file.split("/").pop()}:{s.line_start}–{s.line_end}
                    {" · "}
                    {s.line_count}L · {s.subheadings_at.length} sub-sections
                  </span>
                </li>
              ))}
              {splits.length > 6 && (
                <li className="proto-insight-row-compact proto-insight-row-more">
                  + {splits.length - 6} more
                </li>
              )}
            </ul>
          </ActionGroup>
        )}

        {gapCount > 0 && overview && (
          <ActionGroup
            id="gaps"
            icon={<Search size={14} />}
            title={`${gapCount} recurring empty ${gapCount === 1 ? "search" : "searches"}`}
            subtitle="Queries you've run multiple times with no useful hits. Signal your KB is missing content you actually need."
          >
            <p className="proto-insight-why">
              <strong>Why resolve:</strong> these aren't errors — search
              returned nothing. But repeated misses mean you keep reaching for
              something that isn't there. The fix is to import a source
              (URL / PDF / wiki doc) that covers the topic.
            </p>
            <p className="proto-insight-action-hint">
              How to resolve: open a Claude Code session and paste the query —
              Claude can search the web / Feishu and{" "}
              <code className="proto-code">import_wiki_doc</code> the result.
              Or use the Wiki import panel manually.
            </p>
            <ul className="proto-insight-items">
              {overview.recent_gaps
                .filter((g) => g.c >= 2)
                .slice(0, 8)
                .map((g, i) => (
                  <li key={`${i}-${g.query_text}`} className="proto-insight-row-compact">
                    <span className="proto-insight-row-primary">"{g.query_text}"</span>
                    <span className="proto-insight-row-trailing">×{g.c} misses</span>
                  </li>
                ))}
            </ul>
          </ActionGroup>
        )}
      </section>

      <MetaMemorySection />

      <StatsFooter overview={overview} />
    </div>
  );
}

// ── Top status line ───────────────────────────────────────────────

function StatusLine({
  overview,
  gatewayOnline,
  embeddingMode,
}: {
  overview: api.DashboardOverview | null;
  gatewayOnline: boolean;
  embeddingMode: string;
}) {
  const chunks = overview?.counts.chunks || 0;
  const cost = overview?.total_cost_cny ?? 0;

  return (
    <div className="proto-insight-status">
      <span className="proto-health-chip">
        <span className={cn("proto-status-dot", !gatewayOnline && "proto-status-dot-offline")} />
        <span className="proto-health-label">Gateway</span>
      </span>
      <span className="proto-insight-status-sep">·</span>
      <span className="proto-insight-status-item">
        <span className="proto-health-label">Embedding</span>
        <strong>{embeddingMode || "—"}</strong>
      </span>
      <span className="proto-insight-status-sep">·</span>
      <span className="proto-insight-status-item">
        <strong>{chunks.toLocaleString()}</strong>
        <span className="proto-health-label">chunks</span>
      </span>
      <span className="proto-insight-status-sep">·</span>
      <span className="proto-insight-status-item">
        <span className="proto-dashboard-lead-cost">¥{cost.toFixed(2)}</span>
      </span>
    </div>
  );
}

// ── Collapsible action group ──────────────────────────────────────

function ActionGroup({
  icon,
  title,
  subtitle,
  severity,
  defaultOpen,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  severity?: "warn" | "info";
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <div className={cn("proto-insight-group", severity === "warn" && "proto-insight-group--warn")}>
      <button
        type="button"
        className="proto-insight-group-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="proto-insight-group-icon">{icon}</span>
        <span className="proto-insight-group-head-text">
          <span className="proto-insight-group-title">{title}</span>
          <span className="proto-insight-group-subtitle">{subtitle}</span>
        </span>
        <span className="proto-insight-group-chev">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {open && <div className="proto-insight-group-body">{children}</div>}
    </div>
  );
}

// ── Conflict row — resolves inline ────────────────────────────────

function ConflictRow({
  conflict,
  onResolved,
}: {
  conflict: api.Conflict;
  onResolved: (id: number) => void;
}) {
  const [busy, setBusy] = useState<api.ConflictChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  async function loadPreview() {
    if (preview !== null) return;
    try {
      const fileName = conflict.source_file.split("/").pop() || conflict.source_file;
      const ref = `${fileName}:line:${conflict.line_start}:line`;
      const data = await api.fetchSource(ref);
      const lines = data.lines
        .filter((l) => l.line >= conflict.line_start && l.line <= conflict.line_end)
        .map((l) => `${l.line}  ${l.text}`);
      setPreview(lines.length > 0 ? lines : ["(preview unavailable)"]);
    } catch (e) {
      setPreview([`(failed to load: ${e})`]);
    }
  }

  async function choose(choice: api.ConflictChoice) {
    if (busy) return;
    setBusy(choice);
    setError(null);
    try {
      await api.resolveConflict(conflict.id, choice);
      onResolved(conflict.id);
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }

  const fileShort = conflict.source_file.split("/").pop() || conflict.source_file;

  return (
    <li className="proto-insight-conflict">
      <div className="proto-insight-conflict-head">
        <span className="proto-insight-conflict-loc">
          <FileText size={11} /> {fileShort}:{conflict.line_start}–{conflict.line_end}
        </span>
        <button
          type="button"
          className="proto-insight-preview-toggle"
          onClick={() => {
            setPreviewOpen((v) => !v);
            if (!previewOpen) loadPreview();
          }}
        >
          {previewOpen ? "Hide text" : "Show text"}
        </button>
      </div>

      {previewOpen && (
        <pre className="proto-insight-preview">
          {preview === null ? "Loading…" : preview.join("\n")}
        </pre>
      )}

      <div className="proto-insight-conflict-sides">
        <div className="proto-insight-side">
          <span className="proto-insight-side-label">Currently tagged</span>
          <div className="proto-insight-side-body">
            <code className="proto-code">{conflict.existing_tag}</code>
            {conflict.existing_topic && <span> · {conflict.existing_topic}</span>}
          </div>
        </div>
        <div className="proto-insight-side-divider" />
        <div className="proto-insight-side">
          <span className="proto-insight-side-label">New classification</span>
          <div className="proto-insight-side-body">
            <code className="proto-code">{conflict.incoming_tag}</code>
            {conflict.incoming_topic && <span> · {conflict.incoming_topic}</span>}
          </div>
          {conflict.incoming_summary && (
            <p className="proto-insight-side-summary">{conflict.incoming_summary}</p>
          )}
        </div>
      </div>

      <div className="proto-insight-conflict-actions">
        <button
          type="button"
          className="proto-btn proto-btn-secondary"
          disabled={!!busy}
          onClick={() => choose("keep_existing")}
          title="Keep the current tag. Discard the new classification."
        >
          {busy === "keep_existing" ? <Loader2 size={12} className="animate-spin" /> : null}
          Keep current
        </button>
        <button
          type="button"
          className="proto-btn proto-btn-primary"
          disabled={!!busy}
          onClick={() => choose("accept_incoming")}
          title="Replace the current tag with the new one. Updates tag_segments for this range."
        >
          {busy === "accept_incoming" ? <Loader2 size={12} className="animate-spin" /> : null}
          Accept new
        </button>
        <button
          type="button"
          className="proto-btn proto-btn-ghost"
          disabled={!!busy}
          onClick={() => choose("dismiss")}
          title="Ignore both. Use when neither classification is right."
        >
          {busy === "dismiss" ? <Loader2 size={12} className="animate-spin" /> : null}
          Dismiss
        </button>
      </div>

      {error && <p className="proto-dashboard-error">{error}</p>}
    </li>
  );
}

// ── Meta-memory (rules Claude learned) ────────────────────────────

const KIND_OPTIONS = ["rule", "vocab", "alias", "preference", "gotcha"];

function MetaMemorySection() {
  const [memories, setMemories] = useState<api.MetaMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newText, setNewText] = useState("");
  const [newKind, setNewKind] = useState("rule");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.fetchMetaMemories();
      setMemories(d.memories);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const recent = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return memories.filter((m) => {
      try {
        return new Date(m.updated_at.replace(" ", "T") + "Z").getTime() >= cutoff;
      } catch {
        return false;
      }
    });
  }, [memories]);

  const older = useMemo(
    () => memories.filter((m) => !recent.includes(m)),
    [memories, recent]
  );

  const visible = showAll ? memories : recent;

  async function handleAdd() {
    const text = newText.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      await api.addMetaMemory({ text, kind: newKind, scope: "global" });
      setNewText("");
      setAddOpen(false);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await api.deleteMetaMemory(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section className="proto-dashboard-section">
      <h2 className="proto-section-label">
        Rules Claude learned
        {memories.length > 0 && (
          <span className="proto-section-label-count">{memories.length}</span>
        )}
      </h2>
      <p className="proto-meta-subtitle">
        Durable rules (vocab, aliases, preferences) that get injected into every
        Claude session and expand search queries. Claude writes most of these
        via MCP; you can add or prune.
      </p>

      {error && <p className="proto-dashboard-error">{error}</p>}

      {memories.length === 0 && !loading && (
        <p className="proto-dashboard-empty">
          No rules yet. Claude adds these via{" "}
          <code className="proto-code">append_meta_memory</code>, or click +
          Add rule below.
        </p>
      )}

      {visible.length > 0 && (
        <ul className="proto-meta-list">
          {visible.map((m) => (
            <li key={m.id} className="proto-meta-item">
              <div className="proto-meta-item-head">
                <span className={cn("proto-meta-kind", `proto-meta-kind-${m.kind}`)}>
                  {m.kind}
                </span>
                {m.scope !== "global" && (
                  <span className="proto-meta-scope">{m.scope}</span>
                )}
                <span
                  className="proto-meta-hits"
                  title={`Activated ${m.hit_count} times`}
                >
                  ×{m.hit_count}
                </span>
                <span className="proto-meta-time">{formatRelative(m.updated_at)}</span>
                <button
                  type="button"
                  onClick={() => handleDelete(m.id)}
                  className="proto-meta-delete"
                  aria-label="Forget rule"
                  title="Forget this rule"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <p className="proto-meta-text">{m.text}</p>
            </li>
          ))}
        </ul>
      )}

      <div className="proto-insight-meta-footer">
        {!showAll && older.length > 0 && (
          <button
            type="button"
            className="proto-btn proto-btn-ghost"
            onClick={() => setShowAll(true)}
          >
            Show {older.length} older
          </button>
        )}
        {showAll && older.length > 0 && (
          <button
            type="button"
            className="proto-btn proto-btn-ghost"
            onClick={() => setShowAll(false)}
          >
            Show recent only
          </button>
        )}
        <button
          type="button"
          className="proto-btn proto-btn-secondary"
          onClick={() => setAddOpen((v) => !v)}
        >
          <Plus size={13} /> Add rule
        </button>
      </div>

      {addOpen && (
        <div className="proto-meta-add">
          <textarea
            className="proto-meta-add-textarea"
            placeholder='e.g. "When user says `回传 SQL` they usually mean v2_callback_sub_strategy"'
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
            }}
            rows={2}
            autoFocus
          />
          <div className="proto-meta-add-controls">
            <select
              className="proto-meta-add-select"
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
              aria-label="Rule kind"
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newText.trim() || adding}
              className="proto-btn proto-btn-primary"
            >
              {adding ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              <span>Save</span>
            </button>
          </div>
          <p className="proto-meta-hint">⌘↵ to save · dedup on exact-text match</p>
        </div>
      )}
    </section>
  );
}

// ── Stats footer (collapsed by default) ───────────────────────────

function StatsFooter({ overview }: { overview: api.DashboardOverview | null }) {
  const [open, setOpen] = useState(false);
  if (!overview) return null;
  const hasAttribution = Object.values(overview.build_attribution).some((n) => n > 0);

  return (
    <section className="proto-dashboard-section">
      <button
        type="button"
        className="proto-insight-stats-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <Info size={12} />
        <span>Details & stats</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>

      {open && (
        <div className="proto-insight-stats-body">
          <p className="proto-dashboard-lead">
            <strong>{overview.counts.chunks?.toLocaleString() || 0}</strong> chunks
            <span className="proto-dashboard-lead-sep">·</span>
            <strong>{overview.counts.tag_segments?.toLocaleString() || 0}</strong> segments
            <span className="proto-dashboard-lead-sep">·</span>
            <strong>{overview.counts.builds?.toLocaleString() || 0}</strong> builds
            <span className="proto-dashboard-lead-sep">·</span>
            <strong>{overview.answer_cache.entries.toLocaleString()}</strong> cached answers
            {overview.answer_cache.total_hits > 0 && (
              <> (served <strong>{overview.answer_cache.total_hits.toLocaleString()}</strong> times)</>
            )}
            {overview.last_ingest && (
              <span className="proto-dashboard-lead-aside">
                Last ingest {overview.last_ingest.id} by{" "}
                {overview.last_ingest.completed_by || "unknown"}.
              </span>
            )}
          </p>

          {hasAttribution && (
            <div style={{ marginTop: 20 }}>
              <h3 className="proto-section-label">Where the work came from</h3>
              <AttributionBar attribution={overview.build_attribution} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function AttributionBar({ attribution }: { attribution: Record<string, number> }) {
  const entries = Object.entries(attribution)
    .filter(([, n]) => n > 0)
    .sort(([, a], [, b]) => b - a);
  const total = entries.reduce((acc, [, n]) => acc + n, 0);
  if (total === 0) return null;

  const style = (key: string) => {
    if (key === "mcp:delegate") return { color: "var(--color-accent)", label: "Claude" };
    if (key === "mcp:auto_inherit")
      return { color: "color-mix(in oklab, var(--color-accent) 55%, var(--color-text-muted))", label: "auto-inherit" };
    if (key.startsWith("provider:"))
      return { color: "color-mix(in oklab, var(--color-text-secondary) 70%, var(--color-bg-primary))", label: key.slice("provider:".length) };
    if (key === "fallback") return { color: "var(--color-border)", label: "no AI" };
    return { color: "var(--color-border)", label: key || "unspecified" };
  };

  return (
    <>
      <div className="proto-dashboard-bar" role="img">
        {entries.map(([key, n]) => {
          const s = style(key);
          const pct = (n / total) * 100;
          return (
            <div
              key={key}
              className="proto-dashboard-bar-segment"
              style={{ width: `${pct}%`, background: s.color }}
              title={`${s.label}: ${n} (${pct.toFixed(0)}%)`}
            />
          );
        })}
      </div>
      <div className="proto-dashboard-bar-legend">
        {entries.map(([key, n]) => {
          const s = style(key);
          return (
            <span key={key} className="proto-dashboard-bar-legend-item">
              <span className="proto-dashboard-bar-legend-dot" style={{ background: s.color }} />
              {s.label}
              <span className="proto-dashboard-bar-legend-count">{n}</span>
            </span>
          );
        })}
      </div>
    </>
  );
}

// ── helpers ───────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso.replace(" ", "T") + "Z");
    const diff = Math.max(0, Date.now() - d.getTime());
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}
