import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FileText, BookOpen, Sparkles, MessageSquare, Inbox, Search,
  Clock, FileEdit, ArrowRight, X, SlidersHorizontal,
} from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import * as electron from "@/lib/electron";
import type { ChannelId } from "@/lib/types";
import { cn } from "@/lib/cn";

// Tunable retrieval defaults — persisted in localStorage so the
// user's preference survives reloads. Min score is applied
// client-side; topk goes to the cloud query directly.
type RetrievalSettings = {
  topk: number;
  minScore: number;
};
// Tunables: topk default raised from 8 → 24 after a real-world miss
// where the user asked "what's my deepseek apikey?" and retrieval
// brought back 8 chunks of MCP protocol docs (which lexically match
// "api/key" lots of times) while the actual `- DeepSeek: \`sk-...\``
// line ranked ~12. Bigger top-k → relevant chunks reliably make it
// into the AI synth's 12-block window. Cost is negligible (one DB
// query returning a handful of extra rows).
const DEFAULT_RETRIEVAL: RetrievalSettings = { topk: 24, minScore: 0 };
const RETRIEVAL_KEY = "smartnote-stream-retrieval";

function loadRetrieval(): RetrievalSettings {
  try {
    const raw = localStorage.getItem(RETRIEVAL_KEY);
    if (!raw) return DEFAULT_RETRIEVAL;
    const parsed = JSON.parse(raw);
    // Migrate any stored topk < 16 up to the new default — the old
    // 8 was clearly too narrow once the knowledge base has more
    // than a few docs; users who tuned it down can re-lower it via
    // the retrieval settings popover.
    const rawTopk = parsed.topk ?? DEFAULT_RETRIEVAL.topk;
    return {
      topk: Math.max(1, Math.min(50, rawTopk < 16 ? DEFAULT_RETRIEVAL.topk : rawTopk)),
      minScore: Math.max(0, Math.min(1, parsed.minScore ?? DEFAULT_RETRIEVAL.minScore)),
    };
  } catch {
    return DEFAULT_RETRIEVAL;
  }
}

function saveRetrieval(s: RetrievalSettings) {
  try { localStorage.setItem(RETRIEVAL_KEY, JSON.stringify(s)); } catch { /* silent */ }
}

// 6 retrieval paths in canonical display order. Always rendered so
// the user can see which dimensions hit and which were 0 (often
// because the chunks haven't been enriched yet — kw and tag_meta
// only populate after AI enrichment).
const PATH_KEYS = ["vec", "fts", "ngram", "sub", "kw", "tag_meta"] as const;
const PATH_LABELS: Record<string, string> = {
  fts: "fts",
  vec: "vec",
  ngram: "ngram",
  sub: "sub",
  kw: "kw",
  tag_meta: "tag",
};
const PATH_HELP: Record<string, string> = {
  fts:      "Postgres FTS token match — needs raw text",
  vec:      "Cosine similarity on chunk embedding — needs embed",
  ngram:    "Char-bigram overlap — needs raw text (typo-tolerant)",
  sub:      "Substring LIKE match — needs raw text",
  kw:       "Keyword overlap on chunk.keywords — needs Enrich",
  tag_meta: "Tag-segment dimension match — needs Enrich",
};

/* StreamHome — v3 home surface.
 *
 * Three things merged here:
 *   1) Real ask input (type + Enter → inline composed answer + chunks).
 *   2) Filter-chip row to scope the feed to one kind.
 *   3) Time-grouped feed split by KIND within each day:
 *        Today
 *          ❓ Questions      (search history)
 *          ⬆ Uploads         (notes / wiki ingested)
 *          🧠 Memories        (proposals — drafts AI proposed)
 *          ⚡ Enrich           (re-enrichment runs)
 *        Yesterday
 *          …
 *
 * Kinds get distinct icons + sub-headers so the eye can scan the
 * column without reading every title. Per the user note: "区分问题
 * / 上传行为 / 总结知识 / enrich行为", not stuffed in one stream.
 */

type Kind = "question" | "upload" | "memory" | "enrich";

type Props = {
  onSelect: (channel: ChannelId) => void;
  onOpenPalette?: () => void;
};

type Filter = "all" | Kind;

type FeedEvent = {
  id: string;
  kind: Kind;
  title: ReactNode;
  snippet: ReactNode;
  at: string;
  metric?: string;
  tags: { label: string; accent?: boolean }[];
  onClick: () => void;
  iconAccent?: boolean;
};

type SynthState =
  | { status: "idle" }
  | { status: "loading" }
  // Streaming — chunks are accumulating. reasoning lights up during
  // the chain-of-thought phase (DeepSeek-Reasoner / o1 / Qwen-thinking);
  // text is the visible answer that follows.
  | { status: "streaming"; reasoning: string; text: string; cancel: () => void }
  | { status: "ready"; reasoning: string; text: string; total_tokens: number; finish_reason: string }
  | { status: "unavailable"; err: string }
  | { status: "error"; err: string };

type AnswerState = {
  status: "loading" | "ready" | "error";
  query: string;
  hits: cloudApi.ChunkSearchHit[];
  err?: string;
  /** LLM-synthesized answer composed on top of the retrieval results
   *  using the user's local chat provider. Lazy — populated after
   *  retrieval lands; absent when the user hasn't run a query yet. */
  synth?: SynthState;
};

const POLL_MS = 15_000;

export function StreamHome({ onSelect, onOpenPalette }: Props) {
  const [events, setEvents] = useState<FeedEvent[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [err, setErr] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);

  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<AnswerState | null>(null);
  const [retrieval, setRetrieval] = useState<RetrievalSettings>(loadRetrieval);
  const [retrievalOpen, setRetrievalOpen] = useState(false);
  // Doc id → source kind map. Populated from listDocuments load below.
  // Lets the inline answer split chunks by Notes vs Wiki vs Doc so
  // user-authored notes (narrow scope, less authoritative) read
  // separately from imported wiki references (broad, authoritative).
  const [docKinds, setDocKinds] = useState<Map<string, "note" | "wiki" | "doc">>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);

  function updateRetrieval(patch: Partial<RetrievalSettings>) {
    setRetrieval((prev) => {
      const next = { ...prev, ...patch };
      saveRetrieval(next);
      return next;
    });
  }

  // ── Load events from cloud (jobs / docs / proposals / search history) ──
  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const ok = await cloudApi.isCloudConfigured();
        if (!alive) return;
        setConfigured(ok);
        if (!ok) { setEvents([]); return; }

        const [jobs, docs, proposalsRes, history] = await Promise.all([
          cloudApi.listEnrichJobs().catch(() => [] as cloudApi.EnrichJob[]),
          cloudApi.listDocuments().catch(() => ({ documents: [] as cloudApi.CloudDocument[] })),
          cloudApi.listProposals(30).catch(() => ({ proposals: [] as cloudApi.Proposal[], total: 0 })),
          cloudApi.fetchSearchHistory(30).catch(() => [] as cloudApi.CloudSearchHistoryItem[]),
        ]);

        // Build the doc-id → kind lookup so the inline-answer renderer
        // can group hits by source. Same kind heuristic as RAGPage:
        // smartnote_type=wiki_topic → wiki, =note → note, else doc.
        const km = new Map<string, "note" | "wiki" | "doc">();
        for (const d of docs.documents) {
          const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
          const snt = String(md.smartnote_type || "");
          km.set(d.id, snt === "wiki_topic" ? "wiki" : snt === "note" ? "note" : "doc");
        }
        if (alive) setDocKinds(km);

        const merged: FeedEvent[] = [];

        // Enrich runs ─────────────────────────────────────────────
        for (const j of jobs.slice(0, 30)) {
          const at = j.finished_at || j.dispatched_at || j.created_at;
          const tokens = j.progress?.tokens?.total ?? 0;
          const lines = j.progress?.classify?.total;
          const isMcp = j.executor === "mcp" || j.executor?.startsWith("mcp");
          merged.push({
            id: `enrich:${j.id}`,
            kind: "enrich",
            title: (
              <>
                <span className="proto-atelier-stream-actor">
                  {isMcp ? "Agent" : "Cloud pool"}
                </span>{" "}
                {j.document_name
                  ? <>re-enriched <em>{j.document_name}</em></>
                  : <>re-enriched a document</>}
              </>
            ),
            snippet: enrichSnippet(j),
            at,
            metric: j.status === "done" && tokens > 0
              ? `${tokens.toLocaleString()} tokens`
              : j.status === "done" && lines
                ? `${lines} lines`
                : undefined,
            tags: [
              ...(j.smartnote_type ? [{ label: j.smartnote_type === "wiki_topic" ? "wiki" : j.smartnote_type }] : []),
              ...(j.executor ? [{ label: j.executor }] : []),
              ...(isMcp ? [{ label: "agent-triggered", accent: true }] : []),
            ],
            onClick: () => onSelect("library:memories"),
            iconAccent: isMcp,
          });
        }

        // Uploads (docs ingested by you) ──────────────────────────
        for (const d of docs.documents.slice(0, 30)) {
          const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
          const snt = String(md.smartnote_type || "");
          const isWiki = snt === "wiki_topic";
          const at = d.ingested_at || d.updated_at || d.created_at;
          merged.push({
            id: `doc:${d.id}`,
            kind: "upload",
            title: (
              <>
                <span className="proto-atelier-stream-actor proto-atelier-stream-actor-you">You</span>{" "}
                {isWiki ? "synced wiki topic" : "ingested note"}{" "}
                <em>{d.name}</em>
              </>
            ),
            snippet: docSnippet(d, isWiki),
            at,
            metric: d.byte_size ? `${(d.byte_size / 1024).toFixed(1)} KB` : undefined,
            tags: [
              { label: isWiki ? "wiki" : "note", accent: isWiki },
            ],
            onClick: () => {
              if (isWiki) onSelect(`source:${d.id}` as ChannelId);
              else onSelect("note");
            },
          });
        }

        // Memory proposals (knowledge synthesis) ──────────────────
        for (const p of proposalsRes.proposals.slice(0, 20)) {
          const isDigest = p.author_agent === "digest";
          merged.push({
            id: `mem:${p.id}`,
            kind: "memory",
            title: (
              <>
                <span className="proto-atelier-stream-actor">
                  {isDigest ? "Daily digest" : (p.author_agent || "Agent")}
                </span>{" "}
                proposed a memory
                {p.confidence != null && (
                  <span className="proto-atelier-stream-row-confidence">
                    {" "}· {p.confidence.toFixed(2)}
                  </span>
                )}
              </>
            ),
            snippet: <em>"{truncate(p.content, 200)}"</em>,
            at: p.created_at,
            tags: [
              { label: p.kind || "fact" },
              ...(isDigest ? [{ label: "digest", accent: true }] : []),
              ...(p.scope ? [{ label: p.scope }] : []),
            ],
            onClick: () => onSelect("library:memories"),
            iconAccent: true,
          });
        }

        // Questions (search history) ──────────────────────────────
        for (const h of history.slice(0, 30)) {
          merged.push({
            id: `q:${h.id}`,
            kind: "question",
            title: (
              <>
                <span className="proto-atelier-stream-actor proto-atelier-stream-actor-you">You</span>{" "}
                asked: <em>"{truncate(h.query_text, 80)}"</em>
              </>
            ),
            snippet: (
              <>
                {h.result_count} chunk{h.result_count === 1 ? "" : "s"} returned
                {h.tag_filter && <> · scoped to <code>{h.tag_filter}</code></>}
              </>
            ),
            at: h.created_at,
            tags: [
              { label: "search" },
              ...(h.tag_filter ? [{ label: h.tag_filter }] : []),
            ],
            onClick: () => {
              setQuery(h.query_text);
              setTimeout(() => runSearch(h.query_text), 0);
            },
          });
        }

        merged.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
        if (alive) setEvents(merged);
        if (alive) setErr("");
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    }

    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelect]);

  // Filter the merged event list by the active chip.
  const visible = useMemo(() => {
    if (!events) return null;
    if (filter === "all") return events;
    return events.filter((e) => e.kind === filter);
  }, [events, filter]);

  // Counts for chip badges (always over the unfiltered set).
  const counts = useMemo(() => {
    const c: Record<Kind, number> & { all: number } = {
      all: 0, question: 0, upload: 0, memory: 0, enrich: 0,
    };
    if (!events) return c;
    c.all = events.length;
    for (const e of events) c[e.kind]++;
    return c;
  }, [events]);

  // ── Inline answer (B1) ───────────────────────────────────────────
  async function runSearch(text: string) {
    const q = text.trim();
    if (!q) return;
    setAnswer({ status: "loading", query: q, hits: [] });
    try {
      if (!(await cloudApi.isCloudConfigured())) {
        setAnswer({ status: "error", query: q, hits: [], err: "Cloud not configured. Open the Cloud panel to add URL + API key." });
        return;
      }
      const res = await cloudApi.searchChunks(q, { topk: retrieval.topk });
      const filtered = retrieval.minScore > 0
        ? res.results.filter((h) => h.score >= retrieval.minScore)
        : res.results;
      // Show retrieval immediately, then auto-fire AI synthesis on
      // top of it. Earlier this was opt-in via "Compose answer", but
      // users (correctly) read the panel as "ask my knowledge base"
      // and the manual button felt like the AI was ignoring their
      // notes. Auto-synthesize whenever we have hits — Compose
      // button below is still there for manual re-runs after edits
      // to settings / retrieval scope.
      setAnswer({ status: "ready", query: q, hits: filtered, synth: { status: "idle" } });
      if (filtered.length > 0) {
        // setTimeout 0 — let React commit the "ready" state before
        // synth flips us to "streaming", so users see the chunk list
        // appear (instant) followed by the answer streaming in
        // (a few hundred ms later) instead of the empty-then-everything
        // jump.
        setTimeout(() => synthesizeAnswer(q, filtered), 0);
      }
    } catch (e) {
      setAnswer({
        status: "error",
        query: q,
        hits: [],
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Streaming RAG answer. Sends top-N chunks as numbered citations,
  // then renders reasoning_content (when present — DeepSeek-Reasoner
  // / o1 / Qwen-thinking) and content as separate streams. Inspired
  // by chaya-engine's openai_llm.go dual-stream pattern.
  function synthesizeAnswer(q: string, hits: cloudApi.ChunkSearchHit[]) {
    if (hits.length === 0) {
      setAnswer((a) => a && { ...a, synth: { status: "idle" } });
      return;
    }
    // Bumped from 8×700 to 12×2000 — short snippets were the main
    // reason the model kept saying "context doesn't contain the
    // answer" even when retrieval clearly had it (the relevant
    // sentence sat past char 700 in a chunk). At ~24k chars of
    // context we comfortably fit inside any 32k+ context window.
    const ctxBlocks = hits.slice(0, 12).map((h, i) => (
      `[${i + 1}] ${h.document_name}${h.line_start > 0 ? ` (L${h.line_start}–${h.line_end})` : ""}\n${h.text.slice(0, 2000)}`
    )).join("\n\n");
    const system = (
      "You are SmartNote's answer composer. The user has retrieved relevant " +
      "excerpts from their personal notes. Prefer answering from the numbered " +
      "context excerpts and cite each claim with [N] markers; if a passage is " +
      "only partially relevant, synthesize across excerpts before falling back. " +
      "Only state that the notes don't contain the answer when you've genuinely " +
      "looked and none of the excerpts speak to the question. Match the user's " +
      "language. Be concise — 1 to 4 short paragraphs."
    );
    const user = `Question: ${q}\n\nContext:\n${ctxBlocks}`;
    // Diagnostic — flat string so the values are visible in DevTools
    // without expanding an object. If chunks=0 or ctx_chars=0 then
    // retrieval was empty; if those are non-zero but the LLM says
    // "no answer", the model is being too conservative.
    // eslint-disable-next-line no-console
    console.log(
      `[ai-synth] chunks=${hits.length} ctx_chars=${ctxBlocks.length} query="${q}"`,
    );
    // eslint-disable-next-line no-console
    console.log("[ai-synth] first-200-chars-of-context:", ctxBlocks.slice(0, 200));

    let reasoning = "";
    let text = "";
    const cancel = electron.aiChatStream({ system, user, temperature: 0.2 }, (chunk) => {
      if (chunk.type === "reasoning") {
        reasoning += chunk.text;
        setAnswer((a) => a && { ...a, synth: { status: "streaming", reasoning, text, cancel } });
      } else if (chunk.type === "content") {
        text += chunk.text;
        setAnswer((a) => a && { ...a, synth: { status: "streaming", reasoning, text, cancel } });
      } else if (chunk.type === "done") {
        if (!text.trim() && !reasoning.trim()) {
          const why = chunk.finish_reason
            ? `provider returned no text (finish_reason: ${chunk.finish_reason})`
            : "provider returned no text";
          setAnswer((a) => a && { ...a, synth: { status: "error", err: why } });
          return;
        }
        setAnswer((a) => a && {
          ...a,
          synth: {
            status: "ready",
            reasoning,
            text: text.trim() || reasoning,  // fallback: show reasoning if no content
            total_tokens: chunk.total_tokens || 0,
            finish_reason: chunk.finish_reason || "",
          },
        });
      } else if (chunk.type === "error") {
        const msg = chunk.err || "stream error";
        const notConfigured = /local provider not configured/i.test(msg);
        setAnswer((a) => a && {
          ...a,
          synth: { status: notConfigured ? "unavailable" : "error", err: msg },
        });
      }
    });
    // Initial state — opens the streaming block immediately so the
    // user sees the request was accepted, even before first chunk.
    setAnswer((a) => a && { ...a, synth: { status: "streaming", reasoning: "", text: "", cancel } });
  }

  function clearAnswer() {
    setAnswer(null);
    setQuery("");
    inputRef.current?.focus();
  }

  // Group events by day → kind for rendering. Returns ordered list:
  // [{ dayLabel, kinds: [{ kind, items }] }]
  const grouped = useMemo(() => {
    if (!visible) return [];
    type KindBlock = { kind: Kind; items: FeedEvent[] };
    type DayBlock = { day: string; kinds: KindBlock[] };
    const days = new Map<string, Map<Kind, FeedEvent[]>>();
    for (const e of visible) {
      const day = dayLabel(e.at);
      let kinds = days.get(day);
      if (!kinds) { kinds = new Map(); days.set(day, kinds); }
      const list = kinds.get(e.kind) || [];
      list.push(e);
      kinds.set(e.kind, list);
    }
    const order: Kind[] = ["question", "upload", "memory", "enrich"];
    const result: DayBlock[] = [];
    for (const [day, kindMap] of days) {
      const blocks: KindBlock[] = order
        .filter((k) => kindMap.has(k))
        .map((k) => ({ kind: k, items: kindMap.get(k)! }));
      result.push({ day, kinds: blocks });
    }
    return result;
  }, [visible]);

  return (
    <div className="proto-atelier-stream">
      {/* Real input ask bar */}
      <header className="proto-atelier-stream-topbar">
        <form
          className="proto-atelier-stream-ask"
          onSubmit={(e) => { e.preventDefault(); runSearch(query); }}
        >
          <Search size={14} strokeWidth={2} className="proto-atelier-stream-ask-icon" />
          <input
            ref={inputRef}
            type="text"
            className="proto-atelier-stream-ask-input"
            placeholder="Ask, search, or jot down a memory…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setQuery(""); inputRef.current?.blur(); }
            }}
            aria-label="Ask SmartNote anything"
          />
          {query && (
            <button
              type="button"
              className="proto-atelier-stream-ask-clear"
              aria-label="Clear"
              onClick={() => { setQuery(""); setAnswer(null); inputRef.current?.focus(); }}
            >
              <X size={12} />
            </button>
          )}
          <button
            type="button"
            className={cn(
              "proto-atelier-stream-ask-settings",
              retrievalOpen && "proto-atelier-stream-ask-settings-open",
            )}
            onClick={() => setRetrievalOpen((v) => !v)}
            title={`Retrieval — top ${retrieval.topk}${retrieval.minScore > 0 ? `, ≥ ${retrieval.minScore.toFixed(2)}` : ""}`}
            aria-pressed={retrievalOpen}
          >
            <SlidersHorizontal size={12} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="proto-atelier-stream-ask-kbd"
            onClick={onOpenPalette}
            title="Open command palette"
          >
            ⌘K
          </button>
        </form>
        {retrievalOpen && (
          <RetrievalSettingsPopover
            settings={retrieval}
            onChange={updateRetrieval}
            onClose={() => setRetrievalOpen(false)}
          />
        )}
      </header>

      {/* Inline composed answer (B1) */}
      {answer && (
        <InlineAnswer
          state={answer}
          docKinds={docKinds}
          onClose={clearAnswer}
          onCompose={() => synthesizeAnswer(answer.query, answer.hits)}
          onChunkClick={(hit) => {
            // Carry line range so the source viewer can scroll +
            // highlight that span. Channel format documented in
            // App.tsx's source: route.
            const range = (hit.line_start && hit.line_end && hit.line_start > 0)
              ? `#L${hit.line_start}-${hit.line_end}`
              : "";
            onSelect(`source:${hit.document_id}${range}` as ChannelId);
          }}
        />
      )}

      {/* Filter chips */}
      <div className="proto-atelier-stream-chips" role="tablist" aria-label="Filter feed by kind">
        <Chip active={filter === "all"}      count={counts.all}      onClick={() => setFilter("all")}>Everything</Chip>
        <Chip active={filter === "question"} count={counts.question} onClick={() => setFilter("question")}>Questions</Chip>
        <Chip active={filter === "upload"}   count={counts.upload}   onClick={() => setFilter("upload")}>Uploads</Chip>
        <Chip active={filter === "memory"}   count={counts.memory}   onClick={() => setFilter("memory")}>Memories</Chip>
        <Chip active={filter === "enrich"}   count={counts.enrich}   onClick={() => setFilter("enrich")}>Enrich</Chip>
      </div>

      {/* Feed */}
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
          grouped.map((day) => (
            <section key={day.day} className="proto-atelier-stream-group">
              <div className="proto-atelier-stream-day">{day.day}</div>
              {day.kinds.map((kb) => (
                <div key={kb.kind} className="proto-atelier-stream-kind-block">
                  <div className={cn(
                    "proto-atelier-stream-kind-head",
                    `proto-atelier-stream-kind-head-${kb.kind}`,
                  )}>
                    <KindIcon kind={kb.kind} />
                    <span>{kindLabel(kb.kind)}</span>
                    <span className="proto-atelier-stream-kind-count">{kb.items.length}</span>
                  </div>
                  {kb.items.map((e) => (
                    <article
                      key={e.id}
                      className="proto-atelier-stream-row"
                      data-kind={e.kind}
                      onClick={e.onClick}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); e.onClick(); } }}
                    >
                      <span className={cn(
                        "proto-atelier-stream-row-icon",
                        `proto-atelier-stream-row-icon-${e.kind}`,
                        e.iconAccent && "proto-atelier-stream-row-icon-accent",
                      )}>
                        <KindIcon kind={e.kind} />
                      </span>
                      <div className="proto-atelier-stream-row-body">
                        <div className="proto-atelier-stream-row-title">{e.title}</div>
                        <div className="proto-atelier-stream-row-snippet">{e.snippet}</div>
                        <div className="proto-atelier-stream-row-meta">
                          {e.metric && (
                            <>
                              <span className="proto-atelier-stream-row-metric">
                                <strong>{e.metric}</strong>
                              </span>
                              <span aria-hidden="true">·</span>
                            </>
                          )}
                          {e.tags.map((t, i) => (
                            <span
                              key={i}
                              className={cn(
                                "proto-atelier-stream-tag",
                                t.accent && "proto-atelier-stream-tag-accent",
                              )}
                            >
                              {t.label}
                            </span>
                          ))}
                        </div>
                      </div>
                      <span className="proto-atelier-stream-row-time">{relative(e.at)}</span>
                    </article>
                  ))}
                </div>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────

function RetrievalSettingsPopover({
  settings, onChange, onClose,
}: {
  settings: RetrievalSettings;
  onChange: (patch: Partial<RetrievalSettings>) => void;
  onClose: () => void;
}) {
  return (
    <div className="proto-atelier-stream-retrieval-popover" role="dialog">
      <div className="proto-atelier-stream-retrieval-row">
        <label className="proto-atelier-stream-retrieval-label">
          Recall size
          <span className="proto-atelier-stream-retrieval-value">{settings.topk}</span>
        </label>
        <input
          type="range"
          min={1}
          max={30}
          step={1}
          value={settings.topk}
          onChange={(e) => onChange({ topk: parseInt(e.target.value, 10) })}
          className="proto-atelier-stream-retrieval-slider"
        />
        <div className="proto-atelier-stream-retrieval-hint">
          Top-N chunks to fetch from the cloud's hybrid retrieval.
        </div>
      </div>
      <div className="proto-atelier-stream-retrieval-row">
        <label className="proto-atelier-stream-retrieval-label">
          Min score
          <span className="proto-atelier-stream-retrieval-value">
            {settings.minScore.toFixed(2)}
          </span>
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.minScore}
          onChange={(e) => onChange({ minScore: parseFloat(e.target.value) })}
          className="proto-atelier-stream-retrieval-slider"
        />
        <div className="proto-atelier-stream-retrieval-hint">
          Drop chunks with fused score below this. 0 = keep all.
        </div>
      </div>
      <button
        type="button"
        className="proto-atelier-stream-retrieval-close"
        onClick={onClose}
      >
        Done
      </button>
    </div>
  );
}

function PathScores({ scores }: { scores: Record<string, number> }) {
  // Always render all 6 paths in fixed order. Zero-scoring paths
  // gray out so user sees WHICH paths returned signal vs which
  // are dormant (e.g. kw / tag_meta until enrich runs).
  return (
    <span className="proto-atelier-stream-answer-paths">
      {PATH_KEYS.map((k) => {
        const v = scores[k] ?? 0;
        const inactive = v <= 0;
        return (
          <span
            key={k}
            className={cn(
              "proto-atelier-stream-answer-path",
              inactive && "proto-atelier-stream-answer-path-zero",
            )}
            title={`${PATH_LABELS[k] || k} = ${v.toFixed(2)} · ${PATH_HELP[k] || ""}`}
          >
            <span className="proto-atelier-stream-answer-path-name">
              {PATH_LABELS[k] || k}
            </span>
            <span className="proto-atelier-stream-answer-path-bar">
              <span
                className="proto-atelier-stream-answer-path-bar-fill"
                style={{ width: `${Math.min(100, Math.round(v * 100))}%` }}
              />
            </span>
            <span className="proto-atelier-stream-answer-path-val">
              {v.toFixed(2)}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function InlineAnswer({
  state, docKinds, onClose, onCompose, onChunkClick,
}: {
  state: AnswerState;
  docKinds: Map<string, "note" | "wiki" | "doc">;
  onClose: () => void;
  onCompose: () => void;
  onChunkClick: (hit: cloudApi.ChunkSearchHit) => void;
}) {
  return (
    <section className="proto-atelier-stream-answer" role="region" aria-label="Search results">
      <div className="proto-atelier-stream-answer-head">
        <span className="proto-atelier-stream-answer-dot" />
        <span className="proto-atelier-stream-answer-label">
          {state.status === "loading" && "Searching…"}
          {state.status === "ready" && `${state.hits.length} chunk${state.hits.length === 1 ? "" : "s"} · top score ${(state.hits[0]?.score ?? 0).toFixed(2)}`}
          {state.status === "error" && "Search failed"}
        </span>
        <span className="proto-atelier-stream-answer-q">"{state.query}"</span>
        <button
          type="button"
          onClick={onClose}
          className="proto-atelier-stream-answer-close"
          aria-label="Close result"
        >
          <X size={12} />
        </button>
      </div>
      {state.status === "error" && (
        <div className="proto-atelier-stream-answer-error">{state.err}</div>
      )}
      {state.status === "ready" && state.hits.length === 0 && (
        <div className="proto-atelier-stream-answer-empty">
          No chunks matched. Try a broader phrasing or ingest more sources.
        </div>
      )}
      {/* AI answer composition — opt-in. Default is retrieval only;
          user clicks Compose answer to spend tokens. Citations [N] in
          the composed prose match the chunk numbers below. Reasoning
          (DeepSeek-Reasoner / o1) renders as a collapsible "thinking"
          block above the answer body. */}
      {state.status === "ready" && state.hits.length > 0 && state.synth && (
        <SynthBlock synth={state.synth} hitCount={state.hits.length} onCompose={onCompose} />
      )}
      {state.status === "ready" && state.hits.length > 0 && (() => {
        // Group hits by source kind. Notes (user-authored, narrow but
        // self-curated) read separately from Wiki (broad reference) so
        // the user can weigh evidence appropriately.
        type Kind = "note" | "wiki" | "doc";
        const groups: Record<Kind, cloudApi.ChunkSearchHit[]> = { note: [], wiki: [], doc: [] };
        for (const h of state.hits) {
          const k: Kind = docKinds.get(h.document_id) || "doc";
          groups[k].push(h);
        }
        // Stable display order: notes first (they're scoped + accurate
        // when present), then wiki (broader), then doc (untyped).
        const renderOrder: { kind: Kind; label: string; hint: string }[] = [
          { kind: "note", label: "From your notes",   hint: "self-curated · narrow scope · accurate to context" },
          { kind: "wiki", label: "From wiki",          hint: "imported reference material · broad coverage" },
          { kind: "doc",  label: "From docs",          hint: "uncategorized — re-classify in Library" },
        ];
        // Continuous chunk numbering across groups so the citations in
        // the composed answer ([1] [2] …) match what user sees here.
        let counter = 0;
        return (
          <div className="proto-atelier-stream-answer-chunks">
            {renderOrder.map(({ kind, label, hint }) => {
              const items = groups[kind];
              if (items.length === 0) return null;
              return (
                <div key={kind} className={cn("proto-atelier-stream-answer-section", `proto-atelier-stream-answer-section-${kind}`)}>
                  <div className="proto-atelier-stream-answer-section-head">
                    <span className="proto-atelier-stream-answer-section-label">{label}</span>
                    <span className="proto-atelier-stream-answer-section-count">{items.length}</span>
                    <span className="proto-atelier-stream-answer-section-hint">{hint}</span>
                  </div>
                  {items.map((hit) => {
                    counter++;
                    return (
                      <button
                        key={hit.id}
                        type="button"
                        className="proto-atelier-stream-answer-chunk"
                        onClick={() => onChunkClick(hit)}
                      >
                        <span className="proto-atelier-stream-answer-chunk-num">[{counter}]</span>
                        <span className="proto-atelier-stream-answer-chunk-body">
                          <span className="proto-atelier-stream-answer-chunk-snippet">
                            {truncate(hit.text, 280)}
                          </span>
                          <span className="proto-atelier-stream-answer-chunk-meta">
                            <span>{hit.document_name}</span>
                            {hit.dimension && <span>· {hit.dimension}</span>}
                            {hit.line_start > 0 && (
                              <span title="Line range — click chunk to jump + highlight">
                                · L{hit.line_start}–{hit.line_end}
                              </span>
                            )}
                            <span className="proto-atelier-stream-answer-chunk-score">
                              fused {hit.score.toFixed(2)}
                            </span>
                          </span>
                          {hit.path_scores && Object.keys(hit.path_scores).length > 0 && (
                            <PathScores scores={hit.path_scores} />
                          )}
                        </span>
                        <ArrowRight size={11} />
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })()}
    </section>
  );
}

/* SynthBlock — streaming AI answer surface. Two visual layers:
 *   1. Reasoning ("Thinking") — collapsible, dimmed, mono-ish.
 *      Auto-expanded while streaming so the user sees progress;
 *      auto-collapsed once the final answer arrives.
 *   2. Content — the actual answer prose with [N] citations.
 *
 * The dual-stream pattern matches DeepSeek-Reasoner / o1 / Qwen-
 * thinking which emit reasoning_content first, then content. Chat-
 * only models (deepseek-chat, gpt-4o-mini) skip reasoning entirely
 * and the Thinking block never appears. */
function SynthBlock({
  synth, hitCount, onCompose,
}: {
  synth: SynthState;
  hitCount: number;
  onCompose: () => void;
}) {
  const [thinkingOpen, setThinkingOpen] = useState(true);

  // Once content starts flowing, auto-collapse the thinking pane —
  // the user is past the chain-of-thought and reading the answer.
  useEffect(() => {
    if (synth.status === "streaming" && synth.text.length > 0) {
      setThinkingOpen(false);
    } else if (synth.status === "ready" && synth.text.trim().length > 0) {
      setThinkingOpen(false);
    }
  }, [synth]);

  return (
    <div className="proto-atelier-stream-answer-synth">
      {synth.status === "idle" && (
        <button
          type="button"
          className="proto-atelier-stream-answer-synth-cta"
          onClick={onCompose}
          title="Compose an answer from the chunks above using your chat provider"
        >
          ✨ Compose answer from these {hitCount} chunk{hitCount === 1 ? "" : "s"}
        </button>
      )}
      {synth.status === "loading" && (
        <div className="proto-atelier-stream-answer-synth-pending">
          Composing answer…
        </div>
      )}
      {(synth.status === "streaming" || synth.status === "ready") && (
        <>
          {synth.reasoning && (
            <details
              className="proto-atelier-stream-answer-think"
              open={thinkingOpen}
              onToggle={(e) => setThinkingOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary>
                {synth.status === "streaming" && synth.text.length === 0
                  ? "💭 Thinking…"
                  : "💭 Thinking"}
                <span className="proto-atelier-stream-answer-think-len">
                  {synth.reasoning.length.toLocaleString()} chars
                </span>
              </summary>
              <div className="proto-atelier-stream-answer-think-body">
                {synth.reasoning}
              </div>
            </details>
          )}
          {synth.text && (
            <div className="proto-atelier-stream-answer-synth-body">
              {synth.text}
              {synth.status === "streaming" && (
                <span className="proto-atelier-stream-answer-cursor" aria-hidden>▍</span>
              )}
            </div>
          )}
          {synth.status === "streaming" && !synth.text && !synth.reasoning && (
            <div className="proto-atelier-stream-answer-synth-pending">
              Waiting for first token…
            </div>
          )}
          <div className="proto-atelier-stream-answer-synth-meta">
            {synth.status === "streaming" ? (
              <>
                streaming…
                <button
                  type="button"
                  className="proto-atelier-stream-answer-stop"
                  onClick={() => synth.cancel()}
                >
                  stop
                </button>
              </>
            ) : (
              <>
                via chat provider
                {synth.total_tokens > 0 && ` · ${synth.total_tokens.toLocaleString()} tokens`}
                {synth.finish_reason && synth.finish_reason !== "stop" && ` · ${synth.finish_reason}`}
              </>
            )}
          </div>
        </>
      )}
      {synth.status === "unavailable" && (
        <div className="proto-atelier-stream-answer-synth-unavailable">
          Configure <strong>Settings → Chat provider</strong> to enable AI
          answer composition. Chunks below are still usable.
        </div>
      )}
      {synth.status === "error" && (
        <div className="proto-atelier-stream-answer-synth-error">
          Answer composition failed: {synth.err}
        </div>
      )}
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

function KindIcon({ kind }: { kind: Kind }) {
  if (kind === "question") return <Search size={13} strokeWidth={2} />;
  if (kind === "upload")   return <FileText size={13} strokeWidth={2} />;
  if (kind === "memory")   return <MessageSquare size={13} strokeWidth={2} />;
  if (kind === "enrich")   return <Sparkles size={13} strokeWidth={2} />;
  return null;
}

function kindLabel(kind: Kind): string {
  switch (kind) {
    case "question": return "Questions";
    case "upload":   return "Uploads & ingest";
    case "memory":   return "Memory proposals";
    case "enrich":   return "Enrich runs";
  }
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
          onClick={() => onSelect("settings")}
        >
          Open settings
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
    all:      "Nothing yet. Once agents read your knowledge or you ingest a document, it'll show up here.",
    question: "No searches yet. Type a question above and hit Enter.",
    upload:   "No notes ingested in the recent window. Open the note editor to write or sync one.",
    memory:   "No memory proposals waiting. Cursor and Claude Code surface drafts here as they work.",
    enrich:   "No re-enrichment runs yet. Enrich jobs surface here when classifier or AI re-tag a document.",
  };
  return (
    <div className="proto-atelier-stream-empty">
      <Clock size={16} strokeWidth={1.75} className="proto-atelier-stream-empty-icon" />
      <strong>Quiet for now.</strong>
      <span className="proto-atelier-stream-empty-meta">{lines[filter]}</span>
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
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
      ? `Synced as a wiki topic. ${(d.byte_size / 1024).toFixed(1)} KB linked into the knowledge graph.`
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
  const then = new Date(iso);
  const diff = (Date.now() - then.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
