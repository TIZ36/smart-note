import { useEffect, useState } from "react";
import { Sparkles, Info } from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { cn } from "@/lib/cn";
import type { ChannelId } from "@/lib/types";

/* ContextPanel "Detail" mode — structured sections that match the
 * prototype's right pane:
 *
 *   ┌─────────────────────────────┐
 *   │ For this <kind>             │  (header)
 *   │                             │
 *   │ AI TAGS                     │
 *   │ [chip] [chip] [chip] ...    │  (tag stats: top 6 by segment count)
 *   │                             │
 *   │ RELATED FROM YOUR LIBRARY   │
 *   │ ┌── card ──┐ ┌── card ──┐   │  (recent docs)
 *   │ └──────────┘ └──────────┘   │
 *   │                             │
 *   │ PENDING MEMORIES · n        │
 *   │ ┌── expandable card ──┐     │  (proposals, expand on click)
 *   │ └─────────────────────┘     │
 *   │                             │
 *   │ LAST ENRICHMENT             │
 *   │ <fact line>                 │  (latest done enrich job)
 *   └─────────────────────────────┘
 *
 * All sections silently empty when cloud isn't configured or there's
 * nothing to show. The point is for the panel to feel honest about
 * what it knows — never to fill with placeholder text.
 */

type Props = {
  activeChannel: ChannelId;
  onSelect: (channel: ChannelId) => void;
};

type Snapshot = {
  topTags: { name: string; segments: number }[];
  related: cloudApi.CloudDocument[];
  proposals: cloudApi.Proposal[];
  lastEnrich: cloudApi.EnrichJob | null;
};

const POLL_MS = 15_000;

export function ContextDetail({ activeChannel, onSelect }: Props) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) setSnap({ topTags: [], related: [], proposals: [], lastEnrich: null });
          return;
        }
        const [stats, docs, proposalsRes, jobs] = await Promise.all([
          cloudApi.fetchTagStats().catch(() => null),
          cloudApi.listDocuments().catch(() => ({ documents: [] as cloudApi.CloudDocument[] })),
          cloudApi.listProposals(8).catch(() => ({ proposals: [] as cloudApi.Proposal[], total: 0 })),
          cloudApi.listEnrichJobs("done").catch(() => [] as cloudApi.EnrichJob[]),
        ]);
        if (!alive) return;
        const topTags = stats
          ? [...stats.tags].sort((a, b) => b.segments - a.segments).slice(0, 6)
          : [];
        // Related = the 3 most-recently-touched docs of any kind. P3
        // can replace this with `searchChunks(currentDocTitle)` so it's
        // genuinely "documents related to *this* doc".
        const related = [...docs.documents]
          .sort((a, b) => {
            const ta = Date.parse(a.ingested_at || a.created_at);
            const tb = Date.parse(b.ingested_at || b.created_at);
            return tb - ta;
          })
          .slice(0, 3);
        const lastEnrich = jobs[0] || null;
        setSnap({
          topTags: topTags.map((t) => ({ name: t.name, segments: t.segments })),
          related,
          proposals: proposalsRes.proposals,
          lastEnrich,
        });
      } catch { /* silent — panel never error-flashes */ }
    }
    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (snap === null) {
    return <div className="proto-atelier-ctx-empty">Loading…</div>;
  }

  const channelKind = describeKind(activeChannel);
  const everythingEmpty =
    snap.topTags.length === 0 &&
    snap.related.length === 0 &&
    snap.proposals.length === 0 &&
    snap.lastEnrich === null;

  if (everythingEmpty) {
    return (
      <div className="proto-atelier-ctx-empty">
        <Info size={12} strokeWidth={2} style={{ marginRight: 6, verticalAlign: "-2px" }} />
        Once your workspace has documents, tags, or pending memories,
        this panel becomes the at-a-glance summary for whatever you're
        looking at — currently <em>{channelKind}</em>.
      </div>
    );
  }

  return (
    <div className="proto-atelier-ctx-sections">
      {/* ── AI tags ─────────────────────────────────────── */}
      {snap.topTags.length > 0 && (
        <section className="proto-atelier-ctx-section">
          <div className="proto-atelier-ctx-section-title">AI tags</div>
          <div className="proto-atelier-ctx-tagrow">
            {snap.topTags.map((t, i) => (
              <span
                key={t.name}
                className={cn(
                  "proto-atelier-ctx-chip",
                  i === 0 && "proto-atelier-ctx-chip-active",
                )}
                title={`${t.segments} segment${t.segments === 1 ? "" : "s"} across the workspace`}
              >
                {t.name}
                <span className="proto-atelier-ctx-chip-count">{t.segments}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ── Related ─────────────────────────────────────── */}
      {snap.related.length > 0 && (
        <section className="proto-atelier-ctx-section">
          <div className="proto-atelier-ctx-section-title">
            Related from your library
          </div>
          {snap.related.map((d) => (
            <button
              key={d.id}
              type="button"
              className="proto-atelier-ctx-card"
              onClick={() => {
                const md = (d.metadata && typeof d.metadata === "object"
                  ? d.metadata : {}) as Record<string, unknown>;
                const path = String(md.raw_path || md.path || "");
                if (String(md.smartnote_type) === "wiki_topic" && path) {
                  onSelect(`source:${path}` as ChannelId);
                } else {
                  onSelect("note");
                }
              }}
            >
              <div className="proto-atelier-ctx-card-title">{d.name}</div>
              <div className="proto-atelier-ctx-card-meta">
                <span>{describeDocKind(d)}</span>
                <span>·</span>
                <span>{(d.byte_size / 1024).toFixed(1)} KB</span>
                <span>·</span>
                <span>{relative(d.ingested_at || d.created_at)}</span>
              </div>
            </button>
          ))}
        </section>
      )}

      {/* ── Pending memories ────────────────────────────── */}
      {snap.proposals.length > 0 && (
        <section className="proto-atelier-ctx-section">
          <div className="proto-atelier-ctx-section-title">
            Pending memories <span className="proto-atelier-ctx-section-count">· {snap.proposals.length}</span>
          </div>
          {snap.proposals.slice(0, 3).map((p) => {
            const isExpanded = expanded === p.id;
            return (
              <article
                key={p.id}
                className={cn(
                  "proto-atelier-ctx-memory",
                  isExpanded && "proto-atelier-ctx-memory-open",
                )}
              >
                <button
                  type="button"
                  className="proto-atelier-ctx-memory-head"
                  onClick={() => setExpanded(isExpanded ? null : p.id)}
                  aria-expanded={isExpanded}
                >
                  <div className="proto-atelier-ctx-card-title">
                    {firstLine(p.content) || "(untitled memory)"}
                  </div>
                  <div className="proto-atelier-ctx-card-meta">
                    <span>{p.author_agent || "agent"}</span>
                    <span>·</span>
                    <span>{p.kind}</span>
                    <span>·</span>
                    <span>conf {p.confidence.toFixed(2)}</span>
                  </div>
                </button>
                <div className="proto-atelier-ctx-memory-detail">
                  <div className="proto-atelier-ctx-memory-detail-inner">
                    {p.content && p.content !== firstLine(p.content) && (
                      <div className="proto-atelier-ctx-memory-row">
                        <strong>full</strong>
                        <span>{p.content}</span>
                      </div>
                    )}
                    {p.proposal_reason && (
                      <div className="proto-atelier-ctx-memory-row">
                        <strong>reason</strong>
                        <span>{p.proposal_reason}</span>
                      </div>
                    )}
                    <div className="proto-atelier-ctx-memory-row">
                      <strong>scope</strong>
                      <span>{p.scope}</span>
                    </div>
                    <div className="proto-atelier-ctx-memory-actions">
                      <button
                        type="button"
                        className="proto-atelier-ctx-btn proto-atelier-ctx-btn-primary"
                        onClick={(e) => { e.stopPropagation(); onSelect("cloud-sync"); }}
                      >
                        Review →
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
          {snap.proposals.length > 3 && (
            <button
              type="button"
              className="proto-atelier-ctx-link"
              onClick={() => onSelect("cloud-sync")}
            >
              See {snap.proposals.length - 3} more in Memories →
            </button>
          )}
        </section>
      )}

      {/* ── Last enrichment ─────────────────────────────── */}
      {snap.lastEnrich && (
        <section className="proto-atelier-ctx-section">
          <div className="proto-atelier-ctx-section-title">Last enrichment</div>
          <div className="proto-atelier-ctx-fact">
            <Sparkles size={11} strokeWidth={2} className="proto-atelier-ctx-fact-icon" />
            <div>
              <strong>{describeEnrichOutcome(snap.lastEnrich)}</strong>
              <div className="proto-atelier-ctx-fact-meta">
                {[
                  snap.lastEnrich.executor && `via ${snap.lastEnrich.executor}`,
                  describeEnrichTokens(snap.lastEnrich),
                  snap.lastEnrich.finished_at && relative(snap.lastEnrich.finished_at),
                ].filter(Boolean).join(" · ")}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function describeKind(ch: ChannelId): string {
  if (ch === "note") return "the open note";
  if (ch === "special-knowledge") return "the wiki home";
  if (ch === "source-list") return "the wiki sources index";
  if (ch.startsWith("source:")) return ch.slice("source:".length).split("/").pop() || "this source";
  return "this page";
}

function describeDocKind(d: cloudApi.CloudDocument): string {
  const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
  const snt = String(md.smartnote_type || "");
  if (snt === "wiki_topic") return "wiki";
  if (snt === "note") return "note";
  return d.kind || "doc";
}

function describeEnrichOutcome(j: cloudApi.EnrichJob): string {
  const segments = (j.result && typeof j.result === "object" && "segments" in j.result
    && Array.isArray((j.result as { segments?: unknown[] }).segments)
    ? ((j.result as { segments: unknown[] }).segments.length)
    : 0);
  if (j.document_name) {
    return segments > 0
      ? `${segments} segments classified for ${j.document_name}`
      : `${j.document_name} re-enriched`;
  }
  return segments > 0
    ? `${segments} segments classified`
    : "Enrichment complete";
}

function describeEnrichTokens(j: cloudApi.EnrichJob): string | null {
  const t = j.progress?.tokens?.total ?? 0;
  if (t > 0) return `${t.toLocaleString()} tokens`;
  return null;
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i >= 0 ? s.slice(0, i).trim() : s.trim();
}

function relative(iso: string): string {
  if (!iso) return "";
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
