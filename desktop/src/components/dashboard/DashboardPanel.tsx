import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Scissors, Copy, Check } from "lucide-react";
import * as api from "@/lib/api";

/**
 * Dashboard — surfaces the otherwise-invisible state of the feedback loops:
 * build attribution, answer-cache hits, knowledge gaps, top-trust chunks.
 * Data comes from a single /dashboard/overview call; no polling — the
 * refresh button is explicit so we don't noisify SSE traffic.
 */
export function DashboardPanel() {
  const [data, setData] = useState<api.DashboardOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .fetchDashboardOverview()
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="proto-dashboard">
      <div className="proto-dashboard-header">
        <h1 className="proto-dashboard-title">Dashboard</h1>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="proto-btn proto-btn-secondary"
          aria-label="Refresh dashboard"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
          <span>Refresh</span>
        </button>
      </div>

      {error && <p className="proto-dashboard-error">Failed to load: {error}</p>}

      {data && <DashboardLead data={data} />}

      {data && Object.keys(data.build_attribution).length > 0 && (
        <section className="proto-dashboard-section proto-dashboard-section--loose">
          <h2 className="proto-section-label">Where the work came from</h2>
          <AttributionBar attribution={data.build_attribution} />
        </section>
      )}

      {data && (
        <div className="proto-dashboard-grid">
          {data.trust_top_chunks.length > 0 && (
            <section className="proto-dashboard-section proto-dashboard-section--tight">
              <h2 className="proto-section-label">Top trust chunks</h2>
              <ul className="proto-dashboard-list">
                {data.trust_top_chunks.map((c) => (
                  <li key={c.id} className="proto-dashboard-list-row">
                    <span className="proto-dashboard-list-primary">{c.source_ref}</span>
                    <span className="proto-dashboard-list-trailing">+{c.trust_score.toFixed(1)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.recent_gaps.length > 0 && (
            <section className="proto-dashboard-section proto-dashboard-section--tight">
              <h2 className="proto-section-label">Knowledge gaps</h2>
              <ul className="proto-dashboard-list">
                {data.recent_gaps.map((g, i) => (
                  <li key={`${i}-${g.query_text}`} className="proto-dashboard-list-row">
                    <span className="proto-dashboard-list-primary">"{g.query_text}"</span>
                    <span className="proto-dashboard-list-trailing">×{g.c}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <SplitSuggestionsSection />
        </div>
      )}
    </div>
  );
}

// ── Lead narrative ────────────────────────────────────────────────
// Stats as a prose-ish sentence, not a tile grid. Earned density per
// Linear's issue list — information-dense, no chrome.

function DashboardLead({ data }: { data: api.DashboardOverview }) {
  const n = (v: number) => v.toLocaleString();
  const chunks = data.counts.chunks || 0;
  const builds = data.counts.builds || 0;
  const segments = data.counts.tag_segments || 0;
  const cacheEntries = data.answer_cache.entries || 0;
  const cacheHits = data.answer_cache.total_hits || 0;
  const misses = data.counts.search_misses || 0;
  const conflicts = data.counts.conflict_pending || 0;

  return (
    <p className="proto-dashboard-lead">
      <strong>{n(chunks)}</strong> note chunks
      <span className="proto-dashboard-lead-sep">·</span>
      <strong>{n(segments)}</strong> tag segments
      <span className="proto-dashboard-lead-sep">·</span>
      <strong>{n(builds)}</strong> {builds === 1 ? "build" : "builds"}.
      {cacheEntries > 0 && (
        <>
          {" "}
          <strong>{n(cacheEntries)}</strong> cached {cacheEntries === 1 ? "answer" : "answers"}
          {cacheHits > 0 && (
            <> served <strong>{n(cacheHits)}</strong> {cacheHits === 1 ? "time" : "times"}</>
          )}.
        </>
      )}
      {" "}
      <span className="proto-dashboard-lead-cost">¥{data.total_cost_cny.toFixed(2)}</span>
      <span style={{ color: "var(--color-text-muted)", marginLeft: 4 }}>accrued.</span>
      {(misses > 0 || conflicts > 0 || data.last_ingest) && (
        <span className="proto-dashboard-lead-aside">
          {data.last_ingest && <>Last ingest {data.last_ingest.id} by {data.last_ingest.completed_by || "unknown"}. </>}
          {misses > 0 && <>{n(misses)} search {misses === 1 ? "miss" : "misses"} tracked. </>}
          {conflicts > 0 && (
            <span style={{ color: "var(--color-warning)" }}>
              {n(conflicts)} {conflicts === 1 ? "conflict" : "conflicts"} awaiting review.
            </span>
          )}
        </span>
      )}
    </p>
  );
}

// ── Attribution bar ───────────────────────────────────────────────
// Proportional horizontal strip + legend below. Replaces the 4-row
// list — same data, scans in one glance. Claude segment uses the accent
// so the "by Claude" narrative gets weight without shouting.

type AttributionStyle = { color: string; label: string };

function attributionStyle(key: string): AttributionStyle {
  if (key === "mcp:delegate") return { color: "var(--color-accent)", label: "Claude" };
  if (key === "mcp:auto_inherit") return { color: "color-mix(in oklab, var(--color-accent) 55%, var(--color-text-muted))", label: "auto-inherit" };
  if (key.startsWith("provider:")) return { color: "color-mix(in oklab, var(--color-text-secondary) 70%, var(--color-bg-primary))", label: key.slice("provider:".length) };
  if (key === "fallback") return { color: "var(--color-border)", label: "no AI" };
  if (!key || key === "(unknown)") return { color: "var(--color-border)", label: "unspecified" };
  return { color: "var(--color-border)", label: key };
}

function AttributionBar({ attribution }: { attribution: Record<string, number> }) {
  const entries = Object.entries(attribution)
    .filter(([, n]) => n > 0)
    .sort(([, a], [, b]) => b - a);
  const total = entries.reduce((acc, [, n]) => acc + n, 0);
  if (total === 0) return null;

  return (
    <>
      <div
        className="proto-dashboard-bar"
        role="img"
        aria-label={`Attribution: ${entries.map(([k, n]) => `${attributionStyle(k).label} ${n}`).join(", ")}`}
      >
        {entries.map(([key, n]) => {
          const s = attributionStyle(key);
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
          const s = attributionStyle(key);
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

// ── Split suggestions ─────────────────────────────────────────────

function SplitSuggestionsSection() {
  const [items, setItems] = useState<api.SplitSuggestion[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    api.fetchSplitSuggestions()
      .then((d) => setItems(d.suggestions))
      .catch((e) => setErr(String(e)));
  }, []);

  function copyPrompt(s: api.SplitSuggestion) {
    const prompt =
      `Please split tag_segment id=${s.segment_id} into finer segments.\n` +
      `Context: tag="${s.tag}", topic="${s.topic_name}", ` +
      `file=${s.source_file}, lines ${s.line_start}-${s.line_end} ` +
      `(${s.line_count} lines). Sub-headings at lines: ${s.subheadings_at.join(", ")}.\n\n` +
      `Use \`read_source\` to read the raw content, then call ` +
      `\`submit_enrichments(kind='note_segments', items=[...])\` with one item per sub-section, ` +
      `covering the full ${s.line_start}-${s.line_end} range without gaps.`;
    navigator.clipboard.writeText(prompt).then(() => {
      setCopiedId(s.segment_id);
      setTimeout(() => setCopiedId(null), 1200);
    }).catch(() => {});
  }

  if (err) return null;
  if (!items || items.length === 0) return null;

  return (
    <section className="proto-dashboard-section proto-dashboard-section--tight">
      <h2 className="proto-section-label">Split candidates</h2>
      <ul className="proto-dashboard-list">
        {items.map((s) => (
          <li key={s.segment_id} className="proto-dashboard-list-row">
            <span className="proto-dashboard-list-primary">
              <Scissors size={11} style={{ display: "inline", marginRight: 6, opacity: 0.6 }} />
              [{s.tag}] {s.topic_name || s.source_file.split("/").pop()}
            </span>
            <span className="proto-dashboard-list-trailing" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>{s.line_count}L · {s.subheadings_at.length} heads</span>
              <button
                type="button"
                onClick={() => copyPrompt(s)}
                className="proto-meta-delete"
                aria-label="Copy Claude prompt"
                title="Copy Claude prompt"
              >
                {copiedId === s.segment_id ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
