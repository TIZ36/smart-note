import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/* Stage detail "name plate" modal — shared between Wiki and Notes panes.
 *
 * Translates the v3.6 prototype (prototypes/library-merged.html
 * `openStageModal`) into a real React component. Compact 420px
 * placard with status-tinted accent stripe, live tick on running.
 *
 * Data shape mirrors what cloud broadcasts on WS:
 *   {stage, status, run_id, document_id, workspace_id, schema_version,
 *    at, data: {model, cost_usd, input_tokens, output_tokens,
 *              segments_count, duration_ms, executor, mode, ...}}
 *
 * The "Open in logs" button deep-links to the log panel:
 *   <LOG_PANEL_URL>/?run=<run_id>
 */

export type StageStatus = "queued" | "running" | "done" | "failed" | "partial" | "skipped" | "pending";

export type StageInfo = {
  /** Display name in the placard title. */
  name: string;
  /** Cloud stage identifier — chunk_embed | ai_enrich | wiki_abstract | note_classify | graph */
  cloudStage: string;
  /** Cloud event identifier — chunk_embed_done | enrich_done | etc. */
  cloudEvent: string;
  status: StageStatus;
  /** Single-letter stamp, e.g. P/C/E/T/I or first letter of stage. */
  stamp?: string;
  /** Where executor ran. e.g. cloud_pool / inline / mcp_pull / ws_relay */
  executor?: string | null;
  /** Source-side of the call: parser / model name / table — context column. */
  source?: string | null;
  /** Plain-English description shown right under the title. */
  purpose?: string;
  /** Numbered AI workflow steps (only for LLM stages). */
  aiSteps?: string[];
  /** LLM cost summary; if present and non-null, shown as cost card. */
  cost?: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    input_rate?: string;
    output_rate?: string;
    cost_usd: number;
  } | null;
  /** Self-hosted compute summary (e.g. Embed). Mutually exclusive with cost. */
  compute?: {
    label: string;
    detail: string;
    node?: string;
  } | null;
  /** Failure detail. */
  err?: string | null;
  /** Progress current/total. */
  progressCurrent?: number;
  progressTotal?: number;
  /** Duration in ms when status === done. */
  durationMs?: number | null;
  /** Cloud event payload; rendered as JSON disclose. */
  payload?: unknown;
  /** Stable IDs for the placard's KV grid. */
  runId?: string | null;
  documentId?: string | null;
  workspaceId?: string | null;
  schemaVersion?: number;
  at?: string | null;
  /** When status === running, this lets the modal compute live elapsed. */
  runStartedAt?: number | null;
  /** Cloud-derived: artefact exists but inputs changed since the last run.
   *  When true, the modal shows a "Why stale?" section so the user
   *  understands why the row is gold-tinted instead of green. */
  stale?: boolean;
};

/* Cloud association · maps a cloudStage value to the canonical
 * endpoint, request body shape, and the DB tables the run writes.
 * Source: docs/library-client-integration.md §2.1 + §10.3 + cloud
 * processing.py. Used by the Stage Detail modal so the user (and
 * eng) can see exactly what hitting "Re-run" sends. */
const CLOUD_ASSOC: Record<string, {
  scope: "per-document" | "workspace";
  body: string;
  tables: string;
  llm: "yes" | "no" | "no — deterministic";
  notes?: string;
}> = {
  chunk_embed:    { scope: "per-document", body: `{"kind":"chunk_embed","force":false}`,    tables: "chunks · chunk_embeddings", llm: "no" },
  chunk_enrich:   { scope: "per-document", body: `{"kind":"chunk_enrich","force":false,"options":{"provider_pref":["cloud_pool","ws_relay","mcp_pull"]}}`, tables: "tag_segments · entities · entity_links", llm: "yes" },
  graph_topology: { scope: "per-document", body: `{"kind":"graph_topology","force":false}`, tables: "document_links WHERE source_document_id = this", llm: "no — deterministic", notes: "No auto-rerun: client triggers explicitly when stale (doc §6.1)." },
  wiki_abstract:  { scope: "per-document", body: `{"kind":"wiki_abstract","force":false}`,  tables: "wiki_chapters · wiki_chapters.summary", llm: "yes" },
  note_classify:  { scope: "per-document", body: `{"kind":"note_classify","force":false}`,  tables: "note_tag_suggestions", llm: "yes", notes: "Requires ≥1 workspace user tag (412 if none)." },
  // Legacy aliases — older StageInfo callers may still pass these.
  ai_enrich:      { scope: "per-document", body: `{"kind":"chunk_enrich","force":false}`,   tables: "tag_segments · entities · entity_links", llm: "yes" },
  graph:          { scope: "per-document", body: `{"kind":"graph_topology","force":false}`, tables: "document_links", llm: "no — deterministic" },
};

export type StageDetailModalProps = {
  open: boolean;
  stage: StageInfo | null;
  /** Optional URL of the log panel; "Open in logs" deep-links there. */
  logPanelUrl?: string;
  onClose: () => void;
  /** When the stage is in retry-able / runnable status, footer offers them. */
  onRetry?: () => void;
  onRun?: () => void;
  onRerun?: () => void;
  /** Default-open the JSON disclose (used by the "logs" affordance on
   *  failure rows). */
  initialJsonOpen?: boolean;
};

function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + "s";
  return Math.floor(s) + "s";
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1) return "$" + n.toFixed(2);
  if (n >= 0.01) return "$" + n.toFixed(3);
  return "$" + n.toFixed(4);
}

function shortIso(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.length > 20 ? iso.slice(0, 19) + "Z" : iso;
}

function shortId(s: string | null | undefined, head = 18): string {
  if (!s) return "—";
  return s.length > head ? s.slice(0, head) + "…" : s;
}

function syntaxJson(obj: unknown): string {
  const json = JSON.stringify(obj, null, 2);
  return json
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"([^"]+)":/g, '<span class="k">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span class="s">"$1"</span>')
    .replace(/: (-?\d+\.?\d*)/g, ': <span class="n">$1</span>')
    .replace(/: (true|false|null)/g, ': <span class="b">$1</span>');
}

/** Per-step running/done/pending derivation from the overall stage
 * status + progress%. Same algorithm as the prototype. */
function aiStepStatus(idx: number, total: number, stage: StageInfo): "done" | "running" | "pending" | "failed" {
  if (stage.status === "done") return "done";
  if (stage.status === "failed") return idx <= 1 ? "done" : (idx === 2 ? "failed" : "pending");
  if (stage.status === "running") {
    const cur = stage.progressCurrent ?? 0;
    const tot = Math.max(1, stage.progressTotal ?? 1);
    const stepIdx = Math.floor((cur / tot) * total);
    if (idx < stepIdx) return "done";
    if (idx === stepIdx) return "running";
    return "pending";
  }
  return "pending";
}

export function StageDetailModal(props: StageDetailModalProps) {
  const { open, stage, logPanelUrl, onClose, onRetry, onRun, onRerun, initialJsonOpen } = props;

  // Live tick state — only used when stage.status === "running".
  const [tickN, setTickN] = useState(0);
  const tickRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open || !stage || stage.status !== "running") {
      if (tickRef.current) { window.clearInterval(tickRef.current); tickRef.current = null; }
      return;
    }
    tickRef.current = window.setInterval(() => setTickN((n) => n + 1), 250);
    return () => {
      if (tickRef.current) { window.clearInterval(tickRef.current); tickRef.current = null; }
    };
  }, [open, stage?.status]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Compute live values during running. Synthesize a moving fakePct
  // when no real progressCurrent ticks come in, so the placard
  // "feels alive" — same approach as the prototype.
  const live = useMemo(() => {
    if (!stage) return null;
    void tickN; // re-eval on every tick
    const isRunning = stage.status === "running";
    const total = stage.progressTotal ?? 0;
    let current = stage.progressCurrent ?? 0;
    let pct = total ? Math.round((current / total) * 100) : 0;
    let elapsedText: string | null = null;

    if (isRunning && stage.runStartedAt) {
      const elapsedMs = Date.now() - stage.runStartedAt;
      elapsedText = fmtElapsed(elapsedMs);
      const expectedMs = 1500 + Math.max(50, total) * 8;
      const fakePct = Math.min(95, Math.round((elapsedMs / expectedMs) * 100));
      // If there's no real progressCurrent flow (still 0), show fake.
      if (current === 0) {
        pct = fakePct;
        current = Math.max(1, Math.round((fakePct / 100) * Math.max(1, total)));
      }
    }
    return { current, total, pct, elapsedText, isRunning };
  }, [stage, tickN]);

  if (!open || !stage || !live) return null;

  const isRunning = stage.status === "running";
  const stamp = (stage.stamp || stage.cloudStage[0] || "·").toUpperCase();

  const purpose = stage.purpose ?? "";
  const aiSteps = stage.aiSteps ?? [];
  const showAi = aiSteps.length > 0;
  const showCost = !!stage.cost && stage.status !== "pending";
  const showCompute = !!stage.compute && !showCost;
  const showErr = stage.status === "failed" && !!stage.err;

  // Cost amount during running scales with progress so the dollar
  // figure "ramps" with token consumption.
  const costScale = isRunning ? Math.max(0.05, live.pct / 100) : 1;
  const liveInputTokens  = stage.cost ? Math.round(stage.cost.input_tokens  * costScale) : 0;
  const liveOutputTokens = stage.cost ? Math.round(stage.cost.output_tokens * costScale) : 0;
  const liveCostUsd      = stage.cost ? stage.cost.cost_usd * costScale : 0;

  const onLogPanel = () => {
    if (!stage.runId) return;
    // In local mode (no separate web panel), open the in-app Logs
    // channel via a window event + sessionStorage hand-off. App.tsx
    // reads sessionStorage when the channel changes to "logs" and
    // passes it as initialRunId.
    if (!logPanelUrl) {
      try {
        sessionStorage.setItem("smartnote.logs.openRunId", stage.runId);
      } catch { /* no-op */ }
      window.dispatchEvent(new CustomEvent("smartnote:open-channel", {
        detail: { channel: "logs" },
      }));
      return;
    }
    const u = `${logPanelUrl.replace(/\/$/, "")}/?run=${encodeURIComponent(stage.runId)}`;
    window.open(u, "_blank", "noopener");
  };

  const copyRunId = async () => {
    if (!stage.runId) return;
    try { await navigator.clipboard.writeText(stage.runId); } catch { /* ignore */ }
  };

  return (
    <div className="proto-stage-modal-scrim" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cn("proto-stage-modal", `s-${stage.status}`)} role="document">

        <header className="proto-stage-head">
          <div className="proto-stage-stamp">{stamp}</div>
          <div className="proto-stage-titles">
            <div className="proto-stage-eyebrow">
              {stage.cloudStage} · {stage.cloudEvent}
            </div>
            <h2 className="proto-stage-title">{stage.name}</h2>
            <div className="proto-stage-subline">
              <span className="proto-stage-pill">
                {isRunning ? "LIVE" : stage.status.toUpperCase()}
              </span>
              {stage.cost?.model && (<span>{stage.cost.model}</span>)}
              {stage.executor && (<span>· {stage.executor}</span>)}
              {isRunning && live.elapsedText && (
                <span className="proto-stage-elapsed">{live.elapsedText}</span>
              )}
            </div>
          </div>
          <button className="proto-stage-close" aria-label="Close" onClick={onClose}>✕</button>
        </header>

        <div className="proto-stage-body">

          {purpose && (<div className="proto-stage-purpose">{purpose}</div>)}

          <div className="proto-stage-prog">
            <div className="proto-stage-prog-readout">
              <span className="num">{live.current}</span>
              <span>of {live.total} {live.total === 1 ? "segment" : "segments"}</span>
              <span className="pct">{live.pct}%</span>
            </div>
            <div className="proto-stage-prog-bar">
              <div className="proto-stage-prog-fill" style={{ width: `${live.pct}%` }} />
            </div>
          </div>

          {showErr && (
            <div className="proto-stage-err">
              <span className="proto-stage-err-label">{stage.cloudEvent}</span>
              {stage.err}
            </div>
          )}

          {showAi && (
            <div className="proto-stage-ai">
              <div className="proto-stage-ai-head">
                <span className="proto-stage-ai-badge">AI</span>
                {stage.cost?.model && <span className="proto-stage-ai-model">{stage.cost.model}</span>}
              </div>
              <div className="proto-stage-ai-list">
                {aiSteps.map((step, i) => {
                  const st = aiStepStatus(i, aiSteps.length, stage);
                  const stateText = st === "done" ? "done"
                                  : st === "running" ? "running"
                                  : st === "failed" ? "failed" : "queued";
                  return (
                    <div key={i} className={cn("proto-stage-ai-step", `s-${st}`)}>
                      <span dangerouslySetInnerHTML={{ __html: step }} />
                      <span className="proto-stage-ai-state">{stateText}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {showCost && stage.cost && (
            <div className="proto-stage-cost">
              <div className="proto-stage-cost-head">
                <span className="lbl">
                  {stage.status === "done" ? "Charged" : isRunning ? "Estimated · live" : "Estimated"}
                </span>
                <span className={cn("amt", stage.status !== "done" && "estimating")}>
                  {fmtUsd(liveCostUsd)}
                </span>
              </div>
              <div className="proto-stage-cost-row-l">Input tokens</div>
              <div className="proto-stage-cost-row-r">
                {liveInputTokens.toLocaleString()} / {stage.cost.input_tokens.toLocaleString()}
                {stage.cost.input_rate && (<span className="proto-stage-cost-rate">{stage.cost.input_rate}</span>)}
              </div>
              <div className="proto-stage-cost-row-l">Output tokens</div>
              <div className="proto-stage-cost-row-r">
                {liveOutputTokens.toLocaleString()} / {stage.cost.output_tokens.toLocaleString()}
                {stage.cost.output_rate && (<span className="proto-stage-cost-rate">{stage.cost.output_rate}</span>)}
              </div>
            </div>
          )}

          {showCompute && stage.compute && (
            <div className="proto-stage-cost">
              <div className="proto-stage-cost-head">
                <span className="lbl">{stage.compute.label}</span>
                <span className="amt" style={{ color: "var(--color-text-secondary)", fontSize: 14 }}>
                  {stage.compute.detail}
                </span>
              </div>
              {stage.compute.node && (<>
                <div className="proto-stage-cost-row-l">Node</div>
                <div className="proto-stage-cost-row-r">{stage.compute.node}</div>
              </>)}
            </div>
          )}

          {/* Cloud association — what the desktop sends + what the
              cloud writes when this stage runs. Source: integration
              doc §2.1 + §10.3. Always rendered so devs can copy the
              endpoint/body straight from the modal. */}
          {(() => {
            const assoc = CLOUD_ASSOC[stage.cloudStage];
            if (!assoc) return null;
            return (
              <dl className="proto-stage-kv">
                <dt>endpoint</dt>
                <dd><code className="proto-stage-code">POST /v1/processing/{"{document_id}"}/run</code></dd>
                <dt>kind</dt>
                <dd><code className="proto-stage-code">{stage.cloudStage}</code></dd>
                <dt>scope</dt>
                <dd>{assoc.scope}</dd>
                <dt>body</dt>
                <dd><code className="proto-stage-code">{assoc.body}</code></dd>
                <dt>tables</dt>
                <dd><code className="proto-stage-code">{assoc.tables}</code></dd>
                <dt>LLM</dt>
                <dd>{assoc.llm}</dd>
                {assoc.notes && (<><dt>note</dt><dd style={{ color: "var(--color-text-muted)" }}>{assoc.notes}</dd></>)}
              </dl>
            );
          })()}

          {stage.stale && (
            <div className="proto-stage-stale-card">
              <div className="proto-stage-stale-head">Why stale?</div>
              <p className="proto-stage-stale-body">
                The artefact exists from a prior successful run, but its inputs (document
                content or an upstream stage's output) changed since. No implicit
                re-run — click <b>Re-run</b> to refresh, or <b>Update {stage.cloudStage.replace(/_/g, " ")}</b>
                from the Pipeline tab. Topology re-runs deterministically and never
                burns tokens; chunk_enrich / wiki_abstract / note_classify will.
              </p>
            </div>
          )}

          <dl className="proto-stage-kv">
            <dt>run_id</dt>
            <dd>
              {shortId(stage.runId)}
              {stage.runId && (
                <button className="copy-btn" onClick={copyRunId} title="Copy run_id">⧉</button>
              )}
            </dd>
            <dt>document</dt>     <dd>{shortId(stage.documentId)}</dd>
            <dt>workspace</dt>    <dd>{shortId(stage.workspaceId)}</dd>
            {stage.executor && (<><dt>executor</dt><dd>{stage.executor}</dd></>)}
            {stage.source && (<><dt>source</dt><dd>{stage.source}</dd></>)}
            <dt>at</dt>           <dd>{shortIso(stage.at)}</dd>
            {stage.durationMs != null && (<><dt>duration</dt><dd>{(stage.durationMs / 1000).toFixed(2)}s</dd></>)}
            {stage.schemaVersion != null && (<><dt>schema</dt><dd>v{stage.schemaVersion}</dd></>)}
          </dl>

          {stage.payload !== undefined && (
            <details className="proto-stage-json" open={initialJsonOpen}>
              <summary>
                <span className="chev">▶</span>
                <span className="lbl">Cloud event payload</span>
                <span className="hint">{stage.cloudEvent}</span>
              </summary>
              <pre dangerouslySetInnerHTML={{ __html: syntaxJson(stage.payload) }} />
            </details>
          )}
        </div>

        <footer className="proto-stage-foot">
          {stage.runId && (
            <button className="proto-stage-btn proto-stage-btn-ghost" onClick={onLogPanel}>
              Open in Logs ↗
            </button>
          )}
          <span className="spacer" />
          {stage.status === "failed" && onRetry && (
            <button className="proto-stage-btn" onClick={onRetry}>Retry stage</button>
          )}
          {stage.status === "pending" && onRun && (
            <button className="proto-stage-btn" onClick={onRun}>Run stage</button>
          )}
          {stage.status === "done" && onRerun && (
            <button className="proto-stage-btn proto-stage-btn-ghost" onClick={onRerun}>Re-run</button>
          )}
          {/* Cancel-run intentionally absent in v3.6 — no backend
              support yet. Button comes back in v3.7 with a real
              POST /v1/processing/runs/{id}/cancel. */}
          <button className="proto-stage-btn proto-stage-btn-primary" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  );
}
