import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, AlertTriangle, Loader2, Clock, X } from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { cn } from "@/lib/cn";
import type { RunStatus, RunKind } from "./RAGPage";

/* RAGProcessingPanel — live job feed.
 *
 * Two data sources merged:
 *   1. clientRuns — real-time per-doc state for ops dispatched from
 *      THIS session (Embedding / Enrich / Tag / Graph). Updates
 *      instantly as each per-doc await resolves.
 *   2. cloud listEnrichJobs — catches enrich jobs triggered elsewhere
 *      (MCP, scheduled tasks). Polled every 2.5s.
 *
 * Hides itself when both sources are empty + nothing recent.
 */

const POLL_MS = 2_500;
const SHOW_DONE_FOR_MS = 60_000;

type Row = {
  id: string;
  name: string;
  kind: RunKind | "enrich-bg";
  status: "queued" | "running" | "done" | "failed";
  finishedAt?: number;
  detail: string;
  pct: number;
};

type Props = {
  clientRuns: Map<string, RunStatus>;
  onClearDone: () => void;
};

export function RAGProcessingPanel({ clientRuns, onClearDone }: Props) {
  const [cloudJobs, setCloudJobs] = useState<cloudApi.EnrichJob[]>([]);

  // Cloud poll for background enrich jobs
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) setCloudJobs([]);
          return;
        }
        const all = await cloudApi.listEnrichJobs();
        if (!alive) return;
        const cutoff = Date.now() - SHOW_DONE_FOR_MS;
        setCloudJobs(all.filter((j) => {
          if (j.status === "queued" || j.status === "running" || j.status === "dispatched") return true;
          if (!j.finished_at) return true;
          return new Date(j.finished_at).getTime() > cutoff;
        }));
      } catch {
        /* silent */
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    // Client-side runs (instant, real-time)
    for (const [docId, r] of clientRuns) {
      result.push({
        id: `client:${docId}`,
        name: r.name,
        kind: r.kind,
        status: r.status,
        finishedAt: r.finishedAt,
        detail: clientDetail(r),
        pct: clientPct(r),
      });
    }
    // Cloud enrich jobs (background, MCP-triggered)
    for (const j of cloudJobs) {
      result.push({
        id: `cloud:${j.id}`,
        name: j.document_name || j.document_id.slice(0, 8),
        kind: "enrich-bg",
        status: cloudJobStatus(j),
        finishedAt: j.finished_at ? new Date(j.finished_at).getTime() : undefined,
        detail: cloudDetail(j),
        pct: cloudPct(j),
      });
    }
    // Sort: running first, then queued, then by recency for done/failed
    return result.sort((a, b) => {
      const order = { running: 0, queued: 1, failed: 2, done: 3 } as const;
      const ao = order[a.status]; const bo = order[b.status];
      if (ao !== bo) return ao - bo;
      return (b.finishedAt ?? Date.now()) - (a.finishedAt ?? Date.now());
    });
  }, [clientRuns, cloudJobs]);

  if (rows.length === 0) return null;

  const running = rows.filter((r) => r.status === "running" || r.status === "queued").length;
  const done    = rows.filter((r) => r.status === "done").length;
  const failed  = rows.filter((r) => r.status === "failed").length;
  const allDone = running === 0 && (done > 0 || failed > 0);

  return (
    <div className="proto-atelier-rag-progress">
      <div className="proto-atelier-rag-progress-head">
        <span className="proto-atelier-rag-progress-title">Processing</span>
        <span className="proto-atelier-rag-progress-stats">
          {running > 0 && <span className="proto-atelier-rag-progress-stat proto-atelier-rag-progress-stat-running">{running} running</span>}
          {done    > 0 && <span className="proto-atelier-rag-progress-stat proto-atelier-rag-progress-stat-done">{done} done</span>}
          {failed  > 0 && <span className="proto-atelier-rag-progress-stat proto-atelier-rag-progress-stat-failed">{failed} failed</span>}
        </span>
        {allDone && (
          <button
            type="button"
            onClick={onClearDone}
            className="proto-atelier-rag-progress-clear"
            title="Hide completed rows"
            aria-label="Clear completed"
          >
            <X size={11} />
          </button>
        )}
      </div>
      <div className="proto-atelier-rag-progress-list">
        {rows.slice(0, 30).map((r) => <RowEl key={r.id} r={r} />)}
        {rows.length > 30 && (
          <div className="proto-atelier-rag-progress-more">
            …{rows.length - 30} more
          </div>
        )}
      </div>
    </div>
  );
}

function RowEl({ r }: { r: Row }) {
  const isRunning = r.status === "running";
  const isQueued  = r.status === "queued";
  const isDone    = r.status === "done";
  const isFailed  = r.status === "failed";

  return (
    <div className={cn(
      "proto-atelier-rag-progress-row",
      isFailed && "proto-atelier-rag-progress-row-failed",
      isDone   && "proto-atelier-rag-progress-row-done",
    )}>
      <span className="proto-atelier-rag-progress-row-icon">
        {isRunning && <Loader2 size={13} strokeWidth={1.8} className="animate-spin" />}
        {isQueued  && <Clock    size={13} strokeWidth={1.8} />}
        {isDone    && <CheckCircle2 size={13} strokeWidth={1.8} />}
        {isFailed  && <AlertTriangle size={13} strokeWidth={1.8} />}
      </span>
      <div className="proto-atelier-rag-progress-row-body">
        <div className="proto-atelier-rag-progress-row-line">
          <span className="proto-atelier-rag-progress-row-kind">{kindLabel(r.kind)}</span>
          <span className="proto-atelier-rag-progress-row-name">{r.name}</span>
          <span className="proto-atelier-rag-progress-row-phase">{r.detail}</span>
        </div>
        <div className="proto-atelier-rag-progress-bar">
          <span
            className="proto-atelier-rag-progress-bar-fill"
            style={{ width: `${r.pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────

function kindLabel(k: RunKind | "enrich-bg"): string {
  switch (k) {
    case "embed":     return "EMBED";
    case "enrich":    return "ENRICH";
    case "tag":       return "TAG";
    case "graph":     return "GRAPH";
    case "enrich-bg": return "ENRICH·BG";
  }
}

function clientPct(r: RunStatus): number {
  if (r.status === "queued") return 0;
  if (r.status === "running") {
    const elapsed = Date.now() - r.startedAt;
    // Faux progress for indeterminate work — approaches but never
    // reaches 90% so user sees motion. Final 10% snaps when done.
    return Math.min(85, Math.round(elapsed / 600));
  }
  return 100;
}

function clientDetail(r: RunStatus): string {
  if (r.status === "queued")   return "queued";
  if (r.status === "failed")   return r.error || "failed";
  if (r.status === "done") {
    const ms = (r.finishedAt ?? Date.now()) - r.startedAt;
    return `complete · ${formatMs(ms)}`;
  }
  // running
  const ms = Date.now() - r.startedAt;
  return `running · ${formatMs(ms)}`;
}

function cloudJobStatus(j: cloudApi.EnrichJob): Row["status"] {
  if (j.status === "queued")     return "queued";
  if (j.status === "running")    return "running";
  if (j.status === "dispatched") return "running";
  if (j.status === "done")       return "done";
  return "failed";
}

function cloudPct(j: cloudApi.EnrichJob): number {
  if (j.status === "done") return 100;
  if (j.status === "failed" || j.status === "error") return 100;
  if (j.status === "queued") return 0;
  const c = j.progress?.classify;
  if (c && c.total > 0) return Math.min(95, Math.round((c.done / c.total) * 95));
  return 30;
}

function cloudDetail(j: cloudApi.EnrichJob): string {
  if (j.status === "done")    return "complete";
  if (j.status === "failed" || j.status === "error") return j.error || "failed";
  if (j.status === "queued")  return "queued";
  const c = j.progress?.classify;
  if (c && c.total > 0) return `classify · ${c.done}/${c.total}`;
  return j.progress?.phase || j.status;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
