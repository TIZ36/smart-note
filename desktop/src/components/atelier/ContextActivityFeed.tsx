import { useEffect, useState } from "react";
import {
  FileText, BookOpen, Sparkles, MessageSquare,
} from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import type { ChannelId } from "@/lib/types";

/* Activity feed — the A-direction "stream of what's happened" view,
 * surfaced inside the right context panel rather than as a top-level
 * page. Pulls real data from the cloud:
 *   - listEnrichJobs()    → "Cloud · re-enriched X segments"
 *   - listDocuments()     → "Wiki topic added" / "Note synced"
 *   - listProposals()     → "Cursor proposed a memory"
 *
 * Three sources are merged into one reverse-chronological list, then
 * truncated to ~30 items so the panel never overwhelms. Polling at
 * 12s keeps the panel feeling alive without thrashing the API.
 *
 * Empty state is a real teaching surface, not "nothing here": it
 * tells the user what *would* show up here so the placeholder feels
 * like the feature, not a missing one.
 */

type Props = {
  onSelect: (channel: ChannelId) => void;
};

type FeedEvent = {
  id: string;
  kind: "enrich" | "doc" | "proposal";
  title: string;
  snippet: string;
  at: string;        // ISO
  meta?: string;
  // What clicking this row does — usually "go to that doc/note".
  onClick?: () => void;
};

const POLL_MS = 12_000;

export function ContextActivityFeed({ onSelect }: Props) {
  const [events, setEvents] = useState<FeedEvent[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) { setEvents([]); setErr(""); }
          return;
        }
        const [jobs, docs, proposalsRes] = await Promise.all([
          cloudApi.listEnrichJobs().catch(() => [] as cloudApi.EnrichJob[]),
          cloudApi.listDocuments().catch(() => ({ documents: [] as cloudApi.CloudDocument[] })),
          cloudApi.listProposals().catch(() => ({ proposals: [] as cloudApi.Proposal[], total: 0 })),
        ]);
        const proposals = proposalsRes.proposals;

        const merged: FeedEvent[] = [];

        for (const j of jobs) {
          const at = j.finished_at || j.dispatched_at || j.created_at;
          merged.push({
            id: `enrich:${j.id}`,
            kind: "enrich",
            title: j.document_name
              ? `Re-enriched ${j.document_name}`
              : "Re-enriched a document",
            snippet: enrichSnippet(j),
            at,
            meta: enrichMeta(j),
            onClick: j.document_id ? () => onSelect("note") : undefined,
          });
        }

        for (const d of docs.documents.slice(0, 12)) {
          const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
          const snt = String(md.smartnote_type || "");
          merged.push({
            id: `doc:${d.id}`,
            kind: "doc",
            title:
              snt === "wiki_topic" ? `Wiki topic · ${d.name}` :
              snt === "note"        ? `Note · ${d.name}` :
              `Document · ${d.name}`,
            snippet: docSnippet(d),
            at: d.ingested_at || d.created_at,
            meta: snt || "doc",
          });
        }

        for (const p of proposals.slice(0, 12)) {
          merged.push({
            id: `proposal:${p.id}`,
            kind: "proposal",
            title: `Memory proposed by ${p.author_agent || "an agent"}`,
            snippet: p.content.slice(0, 140),
            at: p.created_at,
            meta: `${p.kind} · conf ${(p.confidence ?? 0).toFixed(2)}`,
          });
        }

        merged.sort((a, b) =>
          new Date(b.at).getTime() - new Date(a.at).getTime(),
        );
        if (alive) {
          setEvents(merged.slice(0, 30));
          setErr("");
        }
      } catch (e) {
        if (alive) setErr(String(e));
      }
    }

    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [onSelect]);

  if (events === null) {
    return <div className="proto-atelier-ctx-empty">Loading recent activity…</div>;
  }

  if (err) {
    return (
      <div className="proto-atelier-ctx-empty proto-atelier-ctx-error">
        Couldn't load activity: {err}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="proto-atelier-ctx-empty">
        Once your agents start writing memories, ingesting docs, or
        running enrich jobs, you'll see them appear here in
        reverse-chronological order.
      </div>
    );
  }

  return (
    <ul className="proto-atelier-ctx-feed">
      {events.map((e) => (
        <li
          key={e.id}
          className="proto-atelier-ctx-feed-item"
          onClick={e.onClick}
          style={{ cursor: e.onClick ? "pointer" : "default" }}
        >
          <span className="proto-atelier-ctx-feed-icon">
            <KindIcon kind={e.kind} />
          </span>
          <div className="proto-atelier-ctx-feed-body">
            <div className="proto-atelier-ctx-feed-title">{e.title}</div>
            <div className="proto-atelier-ctx-feed-snippet">{e.snippet}</div>
            <div className="proto-atelier-ctx-feed-meta">
              {e.meta && <span>{e.meta}</span>}
              <span className="proto-atelier-ctx-feed-time">{relative(e.at)}</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function KindIcon({ kind }: { kind: FeedEvent["kind"] }) {
  if (kind === "enrich") return <Sparkles size={12} strokeWidth={2} />;
  if (kind === "proposal") return <MessageSquare size={12} strokeWidth={2} />;
  // doc — show wiki vs note via the title prefix; keep this icon
  // generic. P3 can split with metadata.smartnote_type.
  return <FileText size={12} strokeWidth={2} />;
}

function enrichSnippet(j: cloudApi.EnrichJob): string {
  const phase = j.progress?.phase || j.status;
  if (j.status === "done") {
    const t = j.progress?.tokens?.total ?? 0;
    return t > 0
      ? `Classified ${j.progress?.classify?.total || "—"} lines · ${t.toLocaleString()} tokens`
      : `Classification done.`;
  }
  if (j.status === "failed") return j.error || "Classification failed";
  if (j.progress?.classify) {
    const c = j.progress.classify;
    return `Classifying — ${c.done}/${c.total} lines`;
  }
  return `Status · ${phase}`;
}

function enrichMeta(j: cloudApi.EnrichJob): string {
  const parts: string[] = [];
  if (j.smartnote_type) parts.push(j.smartnote_type === "wiki_topic" ? "wiki" : j.smartnote_type);
  if (j.executor) parts.push(`via ${j.executor}`);
  return parts.join(" · ");
}

function docSnippet(d: cloudApi.CloudDocument): string {
  if (d.byte_size) return `${(d.byte_size / 1024).toFixed(1)} KB`;
  return "No content yet";
}

function relative(iso: string): string {
  if (!iso) return "";
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 0) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

// Re-import BookOpen to silence the "imported but unused" warning;
// kept intentionally for the wiki-topic-specific KindIcon variant
// when P3 lights up smartnote_type detection.
void BookOpen;
