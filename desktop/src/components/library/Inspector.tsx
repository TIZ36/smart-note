/* Library Inspector · 320px right column (per
 * prototypes/library-redesign-b.html §inspector + integration doc).
 *
 * Renders a context-aware detail panel that swaps based on:
 *   - bulk mode (≥1 checked in tree)        → bulk plan
 *   - active KN tab                         → tab-specific detail
 *   - active doc + tab-selected item        → item-level focus
 *
 * Eight templates mirror the prototype exactly:
 *   pipeline · chunks · segments · tags · chapters · graph · bulk · raw
 *
 * No external state — derives everything from props (DocumentKn,
 * BulkRuns, selected doc) so the component is pure-render. Future
 * inspector-side selection (which chunk to inspect, which segment)
 * can plug in as additional props without changing this layout.
 */
import { useMemo } from "react";
import { cn } from "@/lib/cn";
import * as cloudApi from "@/lib/cloud-api";
import type { BulkRuns } from "./useBulkRuns";

type KnTab =
  | "pipeline"
  | "chunks"
  | "segments"
  | "tags"
  | "chapters"
  | "graph"
  | "raw";

type ViewMode = "raw" | "kn";

type Props = {
  /** Active doc — null when nothing selected (workspace empty state). */
  doc: cloudApi.CloudDocument | null;
  knData: cloudApi.DocumentKn | null;
  /** Current top-level KN tab the user is on (drives template). */
  knTab: KnTab;
  /** Raw vs KN view — when raw, override to the raw template. */
  viewMode: ViewMode;
  /** Bulk-mode toggle: when true, inspector shows the bulk plan
   *  regardless of knTab (multi-select beats single-doc detail). */
  bulkMode: boolean;
  /** Number of currently-checked tree rows when in bulk mode. */
  bulkCount: number;
  /** Detected kind of the bulk selection ("notes" | "wiki" | "doc"). */
  bulkKind: "notes" | "wiki" | "doc" | null;
  bulk: BulkRuns;
  /** Action: when user clicks Jump in segment/tag/chapter inspector. */
  onJumpToLine?: (start: number, end: number) => void;
  /** Action: accept a tag suggestion from inside the inspector. */
  onAcceptSuggestion?: (tag: string) => void;
  onDismissSuggestion?: (tag: string) => void;
};

export function Inspector(props: Props) {
  const { doc, knData, knTab, viewMode, bulkMode, bulkCount, bulkKind, bulk, onJumpToLine, onAcceptSuggestion, onDismissSuggestion } = props;

  if (!doc) return <InspectorEmpty />;
  if (bulkMode) return <InspectorBulk count={bulkCount} kind={bulkKind} bulk={bulk} doc={doc} />;
  if (viewMode === "raw") return <InspectorRaw doc={doc} />;

  switch (knTab) {
    case "pipeline":  return <InspectorPipeline doc={doc} knData={knData} bulk={bulk} />;
    case "chunks":    return <InspectorChunks knData={knData} />;
    case "segments":  return <InspectorSegments knData={knData} onJumpToLine={onJumpToLine} />;
    case "tags":      return <InspectorTags
                                doc={doc}
                                knData={knData}
                                onJumpToLine={onJumpToLine}
                                onAccept={onAcceptSuggestion}
                                onDismiss={onDismissSuggestion}
                              />;
    case "chapters":  return <InspectorChapters knData={knData} onJumpToLine={onJumpToLine} />;
    case "graph":     return <InspectorGraph knData={knData} />;
    case "raw":       return <InspectorRaw doc={doc} />;
    default:          return <InspectorEmpty />;
  }
}

/* ───────── Empty state · no doc / empty workspace ───────── */
function InspectorEmpty() {
  return (
    <aside className="proto-library-inspector">
      <div className="proto-library-inspector-head">
        <div>
          <div className="title">Inspector</div>
          <div className="sub">context · per tab</div>
        </div>
      </div>
      <div className="proto-library-inspector-body">
        <p>
          When you open a document, this panel reflects the active tab —
          run state for Pipeline, vector neighbours for Chunks, accept/dismiss
          for Tag suggestions, and so on.
        </p>
        <h4>Tabs and what they show</h4>
        <ul>
          <li><b>Pipeline</b> — current run · concurrency · tokens · live logs</li>
          <li><b>Chunks</b> — selected chunk's vector + cross-doc neighbours</li>
          <li><b>Segments</b> — segment tag, entities, jump-to-line</li>
          <li><b>Tag suggestions</b> — user tag detail + Accept / Dismiss</li>
          <li><b>Chapters</b> — wiki chapter summary + keywords</li>
          <li><b>Graph</b> — document-link evidence + LLM explain (optional)</li>
        </ul>
      </div>
    </aside>
  );
}

/* ───────── Pipeline · run inspector ───────── */
function InspectorPipeline({
  doc, knData, bulk,
}: { doc: cloudApi.CloudDocument; knData: cloudApi.DocumentKn | null; bulk: BulkRuns }) {
  const runs = knData?.processing_runs ?? [];
  const clientRun = bulk.runs.get(doc.id);
  // Prefer the freshest signal: a live client run > the most recent cloud run.
  const cloudRun = runs[0];
  const isLive = clientRun && (clientRun.status === "running" || clientRun.status === "queued");
  const subtitleParts: string[] = [];
  if (clientRun?.runId || cloudRun?.id) subtitleParts.push((clientRun?.runId || cloudRun?.id || "").slice(0, 14));
  if (clientRun?.kind || cloudRun?.kind) subtitleParts.push(String(clientRun?.kind || cloudRun?.kind));
  const status = isLive ? "running" : (cloudRun?.status || "—");
  const badgeClass = status === "running" || status === "queued"
    ? "running"
    : status === "failed" ? "failed"
      : status === "done" ? "done"
        : "warn";

  const result = (cloudRun?.result || {}) as Record<string, unknown>;
  const tokensTotal = typeof result.total_tokens === "number" ? result.total_tokens : null;
  const tokensIn = typeof result.prompt_tokens === "number" ? result.prompt_tokens : null;
  const tokensOut = typeof result.completion_tokens === "number" ? result.completion_tokens : null;

  // Concurrency from live progress; cloud emits classify.{done,total}+
  // batches_in_flight in processing_progress data — read from clientRun
  // when available.
  const progressTotal = clientRun?.progressTotal;
  const progressCurrent = clientRun?.progressCurrent;

  return (
    <aside className="proto-library-inspector">
      <div className="proto-library-inspector-head">
        <div>
          <div className="title">
            Run inspector
            <span className={cn("proto-library-inspector-badge", badgeClass)}>
              {status.toUpperCase()}
            </span>
          </div>
          <div className="sub">{subtitleParts.join(" · ") || "no runs yet"}</div>
        </div>
      </div>
      <div className="proto-library-inspector-body">
        <h4>Stage</h4>
        <dl className="kv">
          <dt>Kind</dt><dd>{String(clientRun?.kind || cloudRun?.kind || "—")}</dd>
          <dt>Executor</dt><dd>{cloudRun?.executor || "—"}</dd>
          <dt>Status</dt><dd>{status}</dd>
          {clientRun?.startedAt && (
            <><dt>Started</dt><dd>{fmtTime(clientRun.startedAt)}</dd></>
          )}
          {clientRun && (
            <><dt>Elapsed</dt><dd>{fmtElapsed(Date.now() - clientRun.startedAt)}</dd></>
          )}
        </dl>

        {(progressTotal != null || tokensTotal != null) && (
          <>
            <h4>Concurrency</h4>
            <dl className="kv">
              {progressTotal != null && (
                <><dt>Progress</dt><dd>{progressCurrent ?? 0} / {progressTotal}</dd></>
              )}
              {clientRun?.message && (
                <><dt>Message</dt><dd>{clientRun.message}</dd></>
              )}
            </dl>
          </>
        )}

        {tokensTotal != null && (
          <>
            <h4>Tokens</h4>
            <dl className="kv">
              {tokensIn != null && (<><dt>Prompt</dt><dd>{tokensIn.toLocaleString()}</dd></>)}
              {tokensOut != null && (<><dt>Completion</dt><dd>{tokensOut.toLocaleString()}</dd></>)}
              <dt>Total</dt><dd>{tokensTotal.toLocaleString()}</dd>
            </dl>
          </>
        )}

        {clientRun?.error && (
          <>
            <h4>Error</h4>
            <p style={{ color: "var(--color-danger)", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
              {clientRun.error}
            </p>
          </>
        )}

        {!clientRun && !cloudRun && (
          <p>No runs yet for this document. Trigger a stage from the Pipeline tab.</p>
        )}
      </div>
    </aside>
  );
}

/* ───────── Chunks · chunk inspector ───────── */
function InspectorChunks({ knData }: { knData: cloudApi.DocumentKn | null }) {
  const c = knData?.chunks?.[0];
  if (!c) {
    return (
      <aside className="proto-library-inspector">
        <div className="proto-library-inspector-empty">
          No chunks yet. Run Embed from the Pipeline tab.
        </div>
      </aside>
    );
  }
  return (
    <aside className="proto-library-inspector">
      <div className="proto-library-inspector-head">
        <div>
          <div className="title">
            Chunk #{1}
            <span className="proto-library-inspector-badge done">INDEXED</span>
          </div>
          <div className="sub">L{c.line_start}–{c.line_end} · {c.dimension}</div>
        </div>
      </div>
      <div className="proto-library-inspector-body">
        <h4>Vector</h4>
        <dl className="kv">
          <dt>Dim</dt><dd>{c.dimension}</dd>
          <dt>Source ref</dt><dd>{c.source_ref || "—"}</dd>
          <dt>Lines</dt><dd>{c.line_start}–{c.line_end}</dd>
        </dl>
        {c.keywords && c.keywords.length > 0 && (
          <>
            <h4>Keywords</h4>
            <p>{c.keywords.join(" · ")}</p>
          </>
        )}
        <h4>Cross-doc</h4>
        <p>
          {(knData?.document_links?.length ?? 0) > 0
            ? `${knData?.document_links?.length} cross-doc relation${(knData?.document_links?.length ?? 0) === 1 ? "" : "s"} from graph_topology.`
            : "No cross-doc links yet — runs after enrich/abstract/classify."}
        </p>
      </div>
    </aside>
  );
}

/* ───────── Segments · chunk_enrich detail ───────── */
function InspectorSegments({
  knData, onJumpToLine,
}: { knData: cloudApi.DocumentKn | null; onJumpToLine?: (s: number, e: number) => void }) {
  const seg = knData?.tag_segments?.[0];
  if (!seg) {
    return (
      <aside className="proto-library-inspector">
        <div className="proto-library-inspector-empty">
          No segments yet. Run Enrich from the Pipeline tab.
        </div>
      </aside>
    );
  }
  const meta = (seg.meta || {}) as Record<string, unknown>;
  const secondary = Array.isArray(meta.secondary_tags) ? (meta.secondary_tags as string[]) : [];
  const keywords = Array.isArray(meta.keywords) ? (meta.keywords as string[]) : [];
  const entities = Array.isArray(meta.entities) ? (meta.entities as string[]) : [];
  const topic = typeof meta.topic_name === "string" ? meta.topic_name : null;
  return (
    <aside className="proto-library-inspector">
      <div className="proto-library-inspector-head">
        <div>
          <div className="title">
            Segment
            <span className="proto-library-inspector-badge done">CLASSIFIED</span>
          </div>
          <div className="sub">L{seg.line_start}–{seg.line_end} · {seg.tag} ({Math.round(seg.confidence * 100)}%)</div>
        </div>
      </div>
      <div className="proto-library-inspector-body">
        <h4>Tag</h4>
        <dl className="kv">
          <dt>Primary</dt><dd>{seg.tag}</dd>
          {secondary.length > 0 && (<><dt>Secondary</dt><dd>{secondary.join(" · ")}</dd></>)}
          <dt>Confidence</dt><dd>{seg.confidence.toFixed(2)}</dd>
          {topic && (<><dt>Topic</dt><dd>{topic}</dd></>)}
        </dl>
        {entities.length > 0 && (
          <>
            <h4>Entities</h4>
            <p>{entities.join(" · ")}</p>
          </>
        )}
        {keywords.length > 0 && (
          <>
            <h4>Keywords</h4>
            <p>{keywords.join(" · ")}</p>
          </>
        )}
        <h4>Action</h4>
        <button
          type="button"
          className="proto-library-btn proto-library-btn-primary"
          onClick={() => onJumpToLine?.(seg.line_start, seg.line_end)}
        >
          ↗ Jump to L{seg.line_start}–{seg.line_end}
        </button>
      </div>
    </aside>
  );
}

/* ───────── Tag suggestions · note_classify detail ───────── */
function InspectorTags({
  doc, knData, onJumpToLine, onAccept, onDismiss,
}: {
  doc: cloudApi.CloudDocument;
  knData: cloudApi.DocumentKn | null;
  onJumpToLine?: (s: number, e: number) => void;
  onAccept?: (tag: string) => void;
  onDismiss?: (tag: string) => void;
}) {
  const sug = (knData?.note_tag_suggestions || []).find((s) => s.status === "pending");
  if (!sug) {
    return (
      <aside className="proto-library-inspector">
        <div className="proto-library-inspector-empty">
          No pending tag suggestions. Run note_classify or wait for new matches.
        </div>
      </aside>
    );
  }
  void doc;
  return (
    <aside className="proto-library-inspector">
      <div className="proto-library-inspector-head">
        <div>
          <div className="title">
            Tag suggestion
            <span className="proto-library-inspector-badge warn">USER TAG</span>
          </div>
          <div className="sub">{sug.tag} · {Math.round(sug.confidence * 100)}% · note_classify</div>
        </div>
      </div>
      <div className="proto-library-inspector-body">
        <h4>User tag</h4>
        <dl className="kv">
          <dt>Tag</dt><dd>{sug.tag}</dd>
          <dt>Confidence</dt><dd>{sug.confidence.toFixed(2)}</dd>
          <dt>Status</dt><dd>{sug.status}</dd>
        </dl>
        {sug.reasoning && (
          <>
            <h4>Why this match</h4>
            <p>{sug.reasoning}</p>
          </>
        )}
        <h4>Action</h4>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button
            type="button"
            className="proto-library-btn proto-library-btn-primary"
            onClick={() => onAccept?.(sug.tag)}
          >
            ✓ Accept
          </button>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="proto-library-btn"
              onClick={() => onDismiss?.(sug.tag)}
              style={{ flex: 1 }}
            >
              ✗ Dismiss
            </button>
            {/* note_tag_suggestions don't carry line ranges yet; show
                Jump only when cloud adds line_start/line_end fields. */}
            {onJumpToLine && (
              <button
                type="button"
                className="proto-library-btn"
                onClick={() => onJumpToLine(1, 1)}
                style={{ flex: 1 }}
                title="Coming when cloud adds line_start/line_end to suggestions"
                disabled
              >
                ↗ Jump
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ───────── Chapters · wiki_abstract detail ───────── */
function InspectorChapters({
  knData, onJumpToLine,
}: { knData: cloudApi.DocumentKn | null; onJumpToLine?: (s: number, e: number) => void }) {
  const ch = knData?.wiki_chapters?.find((c) => c.summarized) || knData?.wiki_chapters?.[0];
  if (!ch) {
    return (
      <aside className="proto-library-inspector">
        <div className="proto-library-inspector-empty">
          No chapters yet. Run Build abstract from the Pipeline tab.
        </div>
      </aside>
    );
  }
  return (
    <aside className="proto-library-inspector">
      <div className="proto-library-inspector-head">
        <div>
          <div className="title">
            Chapter
            <span className={cn("proto-library-inspector-badge", ch.summarized ? "done" : "warn")}>
              {ch.summarized ? "SUMMARIZED" : "PENDING"}
            </span>
          </div>
          <div className="sub">{ch.title || "(untitled)"} · H{ch.level} · L{ch.line_start}–{ch.line_end}</div>
        </div>
      </div>
      <div className="proto-library-inspector-body">
        {ch.summary && (
          <>
            <h4>Summary</h4>
            <p>{ch.summary}</p>
          </>
        )}
        {ch.keywords && ch.keywords.length > 0 && (
          <>
            <h4>Keywords</h4>
            <p>{ch.keywords.join(" · ")}</p>
          </>
        )}
        <h4>Action</h4>
        <button
          type="button"
          className="proto-library-btn proto-library-btn-primary"
          onClick={() => onJumpToLine?.(ch.line_start, ch.line_end)}
        >
          ↗ Jump to chapter
        </button>
      </div>
    </aside>
  );
}

/* ───────── Graph · related document detail ───────── */
function InspectorGraph({ knData }: { knData: cloudApi.DocumentKn | null }) {
  const link = knData?.document_links?.[0];
  if (!link) {
    return (
      <aside className="proto-library-inspector">
        <div className="proto-library-inspector-empty">
          No cross-doc links yet. Run Topology from the Pipeline tab after enrich/abstract.
        </div>
      </aside>
    );
  }
  const evidence = (link.evidence || {}) as Record<string, unknown>;
  const sharedEntities = Array.isArray(evidence.shared_entities) ? (evidence.shared_entities as string[]) : [];
  return (
    <aside className="proto-library-inspector">
      <div className="proto-library-inspector-head">
        <div>
          <div className="title">
            Document link
            <span className="proto-library-inspector-badge warn">{link.relation_type.toUpperCase()}</span>
          </div>
          <div className="sub">{link.target_name} · {link.score.toFixed(2)} · graph_topology</div>
        </div>
      </div>
      <div className="proto-library-inspector-body">
        <h4>Evidence</h4>
        <dl className="kv">
          <dt>Type</dt><dd>{link.relation_type}</dd>
          <dt>Score</dt><dd>{link.score.toFixed(2)}</dd>
          {link.run_id && (<><dt>Run</dt><dd>{link.run_id.slice(0, 8)}</dd></>)}
          <dt>LLM</dt><dd style={{ color: "var(--color-accent)" }}>no — deterministic</dd>
        </dl>
        {sharedEntities.length > 0 && (
          <>
            <h4>Shared entities</h4>
            <p>{sharedEntities.join(" · ")}</p>
          </>
        )}
        <h4>Optional · LLM explanation</h4>
        <p style={{ fontSize: 11 }}>graph_explain stage not run · click to generate (~200 tokens).</p>
        <button type="button" className="proto-library-btn">Explain with LLM</button>

        <h4 style={{ marginTop: 16 }}>Workspace context</h4>
        <p style={{ fontSize: 11 }}>See the workspace section below in the Graph tab for top entities + edges.</p>
      </div>
    </aside>
  );
}

/* ───────── Bulk plan inspector ───────── */
function InspectorBulk({
  count, kind, bulk, doc,
}: {
  count: number;
  kind: "notes" | "wiki" | "doc" | null;
  bulk: BulkRuns;
  doc: cloudApi.CloudDocument | null;
}) {
  void doc;
  // Stage count per kind: notes=4, wiki=3, doc=3 (incl. topology tail).
  const stagesPerDoc = kind === "notes" ? 4 : 3;
  const llmStagesPerDoc = kind === "notes" ? 2 : kind === "wiki" ? 1 : 1;
  const estTokens = useMemo(
    () => llmStagesPerDoc * count * 1500,
    [llmStagesPerDoc, count],
  );
  return (
    <aside className="proto-library-inspector">
      <div className="proto-library-inspector-head">
        <div>
          <div className="title">
            Bulk plan
            <span className="proto-library-inspector-badge running">{count} {kind?.toUpperCase() || ""}</span>
          </div>
          <div className="sub">{count} files · {stagesPerDoc} stages · cloud_pool</div>
        </div>
      </div>
      <div className="proto-library-inspector-body">
        <h4>Cloud dispatch</h4>
        <p>
          Each stage fires <code>POST /v1/processing/{`{id}`}/run</code> with concurrency 4.
          Fast stages (Embed · Topology) run in-process; LLM stages queue to{" "}
          <code>cloud_pool</code> and emit <code>processing_progress</code> events.
        </p>
        <h4>Cost estimate</h4>
        <dl className="kv">
          <dt>Tokens (est)</dt><dd>{estTokens.toLocaleString()}</dd>
          <dt>Calls</dt><dd>{stagesPerDoc * count}</dd>
          <dt>Provider</dt><dd>cloud_pool</dd>
          <dt>Provider ready</dt><dd>{bulk.cloudProviderReady === false ? "no — configure first" : "yes"}</dd>
        </dl>
        <h4>Notes</h4>
        <ul>
          <li>Stages with ✓ are already fresh — skipped unless force.</li>
          <li>Topology auto-runs after the kind-specific stage completes.</li>
          <li>Failed stages don't auto-retry; use the Retry CTA in Recent runs.</li>
        </ul>
      </div>
    </aside>
  );
}

/* ───────── Raw view inspector ───────── */
function InspectorRaw({ doc }: { doc: cloudApi.CloudDocument }) {
  return (
    <aside className="proto-library-inspector">
      <div className="proto-library-inspector-head">
        <div>
          <div className="title">Raw markdown</div>
          <div className="sub">read-only · {Math.round(doc.byte_size / 1024)}k</div>
        </div>
      </div>
      <div className="proto-library-inspector-body">
        <h4>Jump targets</h4>
        <p>Click a Segment / Tag suggestion / Chapter row to scroll here. Last jump highlights for 1.6s.</p>
        <h4>Document</h4>
        <dl className="kv">
          <dt>id</dt><dd>{doc.id.slice(0, 8)}</dd>
          <dt>updated</dt><dd>{doc.updated_at ? fmtTime(new Date(doc.updated_at).getTime()) : "—"}</dd>
        </dl>
      </div>
    </aside>
  );
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
