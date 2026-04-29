import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  FileText, BookOpen, Sparkles, MessageSquare, Inbox, Search,
  Clock, FileEdit,
} from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import type { ChannelId } from "@/lib/types";
import { cn } from "@/lib/cn";

/* StreamHome — A-direction landing.
 *
 * Aligned to docs/design-mocks/a-stream.html. The page is a quiet
 * vertical river of activity, not a card grid. Rows separate with a
 * 1px top border (no boxes, no shadows). The accent earns its place
 * through the active filter chip, the agent-read icon tint, and the
 * `tag-accent` for primary type chips — nothing else.
 *
 * Topbar carries the single "ask, search, jot" entry — clicking it
 * opens the ⌘K palette. Ambient (devices / sync / live enrich) lives
 * in BottomBar; we don't duplicate it here.
 */

type Props = {
  onSelect: (channel: ChannelId) => void;
  onOpenPalette?: () => void;
};

type Filter = "all" | "doc" | "wiki" | "memory" | "enrich";

type FeedEvent = {
  id: string;
  filter: Exclude<Filter, "all">;
  title: string;
  snippet: ReactNode;
  at: string;
  metric?: string;
  tags: { label: string; accent?: boolean }[];
  onClick: () => void;
  iconAccent?: boolean;
};

const POLL_MS = 15_000;

export function StreamHome({ onSelect, onOpenPalette }: Props) {
  const [events, setEvents] = useState<FeedEvent[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [err, setErr] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const ok = await cloudApi.isCloudConfigured();
        if (!alive) return;
        setConfigured(ok);
        if (!ok) { setEvents([]); return; }

        const [jobs, docs, proposalsRes] = await Promise.all([
          cloudApi.listEnrichJobs().catch(() => [] as cloudApi.EnrichJob[]),
          cloudApi.listDocuments().catch(() => ({ documents: [] as cloudApi.CloudDocument[] })),
          cloudApi.listProposals(30).catch(() => ({ proposals: [] as cloudApi.Proposal[], total: 0 })),
        ]);

        const merged: FeedEvent[] = [];

        for (const j of jobs.slice(0, 30)) {
          const at = j.finished_at || j.dispatched_at || j.created_at;
          const tokens = j.progress?.tokens?.total ?? 0;
          const lines = j.progress?.classify?.total;
          merged.push({
            id: `enrich:${j.id}`,
            filter: "enrich",
            title: j.document_name
              ? `Re-enriched ${j.document_name}`
              : "Re-enriched a document",
            snippet: enrichSnippet(j),
            at,
            metric: j.status === "done" && tokens > 0
              ? `${tokens.toLocaleString()} tokens`
              : j.status === "done" && lines
                ? `${lines} lines`
                : undefined,
            tags: [
              ...(j.smartnote_type ? [{ label: j.smartnote_type === "wiki_topic" ? "wiki" : j.smartnote_type, accent: true }] : []),
              ...(j.executor ? [{ label: j.executor }] : []),
            ],
            onClick: () => onSelect("cloud-sync"),
            iconAccent: true,
          });
        }

        for (const d of docs.documents.slice(0, 30)) {
          const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
          const snt = String(md.smartnote_type || "");
          const isWiki = snt === "wiki_topic";
          const path = String(md.raw_path || md.path || "");
          merged.push({
            id: `doc:${d.id}`,
            filter: isWiki ? "wiki" : "doc",
            title: isWiki ? `Wiki topic · ${d.name}` : `Note synced — ${d.name}`,
            snippet: docSnippet(d, isWiki),
            at: d.ingested_at || d.created_at,
            metric: d.byte_size ? `${(d.byte_size / 1024).toFixed(1)} KB` : undefined,
            tags: [
              { label: isWiki ? "wiki" : "note", accent: true },
            ],
            onClick: () => {
              if (isWiki && path) onSelect(`source:${path}` as ChannelId);
              else if (isWiki) onSelect("special-knowledge");
              else onSelect("note");
            },
          });
        }

        for (const p of proposalsRes.proposals.slice(0, 30)) {
          merged.push({
            id: `proposal:${p.id}`,
            filter: "memory",
            title: `${p.author_agent || "An agent"} proposed a memory — review (1)`,
            snippet: <em>{`"${p.content.slice(0, 220)}${p.content.length > 220 ? "…" : ""}"`}</em>,
            at: p.created_at,
            metric: `confidence ${(p.confidence ?? 0).toFixed(2)}`,
            tags: [
              { label: "draft" },
              { label: p.kind },
            ],
            onClick: () => onSelect("cloud-sync"),
          });
        }

        merged.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
        if (alive) { setEvents(merged); setErr(""); }
      } catch (e) {
        if (alive) setErr(String(e));
      }
    }
    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [onSelect]);

  const counts = useMemo(() => {
    const c = { all: 0, doc: 0, wiki: 0, memory: 0, enrich: 0 };
    if (!events) return c;
    c.all = events.length;
    for (const e of events) c[e.filter]++;
    return c;
  }, [events]);

  const visible = useMemo(() => {
    if (!events) return null;
    if (filter === "all") return events;
    return events.filter((e) => e.filter === filter);
  }, [events, filter]);

  return (
    <div className="proto-atelier-stream">
      <header className="proto-atelier-stream-topbar">
        <button
          type="button"
          className="proto-atelier-stream-ask"
          onClick={onOpenPalette}
          aria-label="Open command palette"
        >
          <Search size={14} strokeWidth={2} className="proto-atelier-stream-ask-icon" />
          <span>Ask, search, or jot down a memory…</span>
          <kbd className="proto-atelier-stream-ask-kbd">⌘K</kbd>
        </button>
      </header>

      <div className="proto-atelier-stream-chips" role="tablist">
        <Chip active={filter === "all"}    count={counts.all}    onClick={() => setFilter("all")}>Everything</Chip>
        <Chip active={filter === "doc"}    count={counts.doc}    onClick={() => setFilter("doc")}>Notes</Chip>
        <Chip active={filter === "wiki"}   count={counts.wiki}   onClick={() => setFilter("wiki")}>Wiki</Chip>
        <Chip active={filter === "memory"} count={counts.memory} onClick={() => setFilter("memory")}>Memories</Chip>
        <Chip active={filter === "enrich"} count={counts.enrich} onClick={() => setFilter("enrich")}>Agent activity</Chip>
      </div>

      <div className="proto-atelier-stream-feed">
        {configured === false ? (
          <EmptyConfigured onSelect={onSelect} />
        ) : err ? (
          <div className="proto-atelier-stream-empty">
            <strong>Couldn't load activity.</strong>
            <span className="proto-atelier-stream-empty-meta">{err}</span>
          </div>
        ) : visible === null ? (
          <div className="proto-atelier-stream-empty">Loading recent activity…</div>
        ) : visible.length === 0 ? (
          <EmptyFeed filter={filter} />
        ) : (
          renderGrouped(visible)
        )}
      </div>
    </div>
  );
}

function Chip({ active, count, onClick, children }: {
  active: boolean; count: number; onClick: () => void; children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn("proto-atelier-stream-chip", active && "proto-atelier-stream-chip-active")}
    >
      {children}
      <span className="proto-atelier-stream-chip-count">{count}</span>
    </button>
  );
}

function renderGrouped(events: FeedEvent[]): ReactNode {
  const groups: { label: string; items: FeedEvent[] }[] = [];
  for (const e of events) {
    const label = dayLabel(e.at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(e);
    else groups.push({ label, items: [e] });
  }
  return groups.map((g) => (
    <section key={g.label} className="proto-atelier-stream-group">
      <div className="proto-atelier-stream-day">{g.label}</div>
      {g.items.map((e) => (
        <article
          key={e.id}
          className="proto-atelier-stream-row"
          onClick={e.onClick}
          role="button"
          tabIndex={0}
          onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); e.onClick(); } }}
        >
          <span className={cn("proto-atelier-stream-row-icon", e.iconAccent && "proto-atelier-stream-row-icon-accent")}>
            <KindIcon filter={e.filter} />
          </span>
          <div className="proto-atelier-stream-row-body">
            <div className="proto-atelier-stream-row-title">{e.title}</div>
            <div className="proto-atelier-stream-row-snippet">{e.snippet}</div>
            <div className="proto-atelier-stream-row-meta">
              {e.metric && (<><span className="proto-atelier-stream-row-metric"><strong>{e.metric}</strong></span><span aria-hidden="true">·</span></>)}
              {e.tags.map((t, i) => (
                <span key={i} className={cn("proto-atelier-stream-tag", t.accent && "proto-atelier-stream-tag-accent")}>{t.label}</span>
              ))}
            </div>
          </div>
          <span className="proto-atelier-stream-row-time">{relative(e.at)}</span>
        </article>
      ))}
    </section>
  ));
}

function KindIcon({ filter }: { filter: FeedEvent["filter"] }) {
  if (filter === "wiki") return <BookOpen size={14} strokeWidth={2} />;
  if (filter === "memory") return <MessageSquare size={14} strokeWidth={2} />;
  if (filter === "enrich") return <Sparkles size={14} strokeWidth={2} />;
  return <FileText size={14} strokeWidth={2} />;
}

function EmptyConfigured({ onSelect }: { onSelect: (c: ChannelId) => void }) {
  return (
    <div className="proto-atelier-stream-empty proto-atelier-stream-empty-cta">
      <Inbox size={22} strokeWidth={1.5} className="proto-atelier-stream-empty-icon" />
      <strong>SmartNote Cloud isn't connected yet.</strong>
      <span className="proto-atelier-stream-empty-meta">
        Connect cloud to surface agent reads, memory drafts, and re-enrichment runs in your stream.
      </span>
      <div className="proto-atelier-stream-empty-actions">
        <button
          type="button"
          className="proto-atelier-stream-empty-btn proto-atelier-stream-empty-btn-strong"
          onClick={() => onSelect("cloud-sync")}
        >
          Open Cloud Console
        </button>
        <button
          type="button"
          className="proto-atelier-stream-empty-btn"
          onClick={() => onSelect("note")}
        >
          <FileEdit size={12} strokeWidth={2} /> Edit a note
        </button>
      </div>
    </div>
  );
}

function EmptyFeed({ filter }: { filter: Filter }) {
  const lines: Record<Filter, string> = {
    all:    "Nothing yet. Once agents read your knowledge or you ingest a document, it'll show up here.",
    doc:    "No notes ingested in the recent window. Open the note editor to write or sync one.",
    wiki:   "No wiki activity yet. Add a wiki source to start building topics.",
    memory: "No memory proposals waiting. Cursor and Claude Code will surface drafts here as they work.",
    enrich: "No re-enrichment runs yet. Enrich jobs surface here when classifier or AI re-tag a document.",
  };
  return (
    <div className="proto-atelier-stream-empty">
      <Clock size={16} strokeWidth={1.75} className="proto-atelier-stream-empty-icon" />
      <strong>Quiet for now.</strong>
      <span className="proto-atelier-stream-empty-meta">{lines[filter]}</span>
    </div>
  );
}

function enrichSnippet(j: cloudApi.EnrichJob): string {
  if (j.status === "done") {
    const lines = j.progress?.classify?.total;
    return lines
      ? `Classifier reviewed ${lines} lines and updated tags accordingly.`
      : "Classification complete.";
  }
  if (j.status === "failed") return j.error || "Classification failed.";
  if (j.progress?.classify) {
    const c = j.progress.classify;
    return `Classifying — ${c.done}/${c.total} lines.`;
  }
  return `Status · ${j.progress?.phase || j.status}`;
}

function docSnippet(d: cloudApi.CloudDocument, isWiki: boolean): string {
  if (isWiki) {
    return d.byte_size
      ? `Synced as a wiki topic. ${(d.byte_size / 1024).toFixed(1)} KB of source linked into the knowledge graph.`
      : "Synced as a wiki topic.";
  }
  return d.byte_size
    ? `Note ingested from desktop. ${(d.byte_size / 1024).toFixed(1)} KB stored, embeddings generated.`
    : "Note ingested from desktop.";
}

function dayLabel(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(then, now)) return "Today";
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (sameDay(then, yest)) return "Yesterday";
  const diffDays = Math.floor((now.getTime() - then.getTime()) / 86400000);
  if (diffDays < 7) return then.toLocaleDateString(undefined, { weekday: "long" });
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
