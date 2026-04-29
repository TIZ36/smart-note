import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, Loader2, Clock } from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { cn } from "@/lib/cn";

/* RAGProcessingPanel — live job feed shown after the user triggers
 * Embedding / Enrich / Tag pass / Graph rebuild on the RAG surface.
 *
 * Auto-shows when there are running jobs or recently-finished jobs
 * (within 30s of completion). Hides itself when everything is quiet
 * for a while so the panel doesn't permanently dominate the surface.
 */

const POLL_MS = 2_500;
const SHOW_DONE_FOR_MS = 60_000;
const PHASES: { key: string; label: string }[] = [
  { key: "queued",    label: "Queued" },
  { key: "embedding", label: "Embed" },
  { key: "classify",  label: "Classify" },
  { key: "enrich",    label: "Enrich" },
  { key: "store",     label: "Store" },
];

export function RAGProcessingPanel() {
  const [jobs, setJobs] = useState<cloudApi.EnrichJob[]>([]);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) setJobs([]);
          return;
        }
        const all = await cloudApi.listEnrichJobs();
        if (!alive) return;
        const cutoff = Date.now() - SHOW_DONE_FOR_MS;
        const visible = all.filter((j) => {
          if (j.status === "queued" || j.status === "running" || j.status === "dispatched") return true;
          if (!j.finished_at) return true;
          return new Date(j.finished_at).getTime() > cutoff;
        }).slice(0, 8);
        setJobs(visible);
      } catch {
        /* silent — panel is decorative, never error-flash */
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (jobs.length === 0) return null;

  const running = jobs.filter((j) => j.status === "running" || j.status === "queued" || j.status === "dispatched").length;
  const done    = jobs.filter((j) => j.status === "done").length;
  const failed  = jobs.filter((j) => j.status === "failed" || j.status === "error").length;

  return (
    <div className="proto-atelier-rag-progress">
      <div className="proto-atelier-rag-progress-head">
        <span className="proto-atelier-rag-progress-title">Processing</span>
        <span className="proto-atelier-rag-progress-stats">
          {running > 0 && <span className="proto-atelier-rag-progress-stat proto-atelier-rag-progress-stat-running">{running} running</span>}
          {done    > 0 && <span className="proto-atelier-rag-progress-stat proto-atelier-rag-progress-stat-done">{done} done</span>}
          {failed  > 0 && <span className="proto-atelier-rag-progress-stat proto-atelier-rag-progress-stat-failed">{failed} failed</span>}
        </span>
      </div>
      <div className="proto-atelier-rag-progress-list">
        {jobs.map((j) => <JobRow key={j.id} j={j} />)}
      </div>
    </div>
  );
}

function JobRow({ j }: { j: cloudApi.EnrichJob }) {
  const isRunning = j.status === "running" || j.status === "dispatched";
  const isQueued  = j.status === "queued";
  const isDone    = j.status === "done";
  const isFailed  = j.status === "failed" || j.status === "error";

  const phaseLabel = j.progress?.phase || (isRunning ? "running" : j.status);
  const classify = j.progress?.classify;
  const tokens = j.progress?.tokens?.total ?? 0;

  // Try to derive a coarse % across the pipeline. Uses classify
  // sub-progress when present (most informative), else maps phase
  // names to checkpoint percentages.
  const pct = (() => {
    if (isDone) return 100;
    if (isFailed) return 100; // bar full but red-tinted
    if (isQueued) return 0;
    if (classify && classify.total > 0) {
      // Classify is the main long-running phase (~70% of total time).
      const local = (classify.done / classify.total) * 70;
      return Math.round(20 + local);
    }
    const phaseIdx = PHASES.findIndex((p) => p.key === phaseLabel);
    if (phaseIdx >= 0) return Math.round((phaseIdx / (PHASES.length - 1)) * 90);
    return 30;
  })();

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
          <span className="proto-atelier-rag-progress-row-name">
            {j.document_name || j.document_id.slice(0, 8)}
          </span>
          <span className="proto-atelier-rag-progress-row-phase">
            {isDone   ? "complete"
              : isQueued ? "queued"
              : isFailed ? (j.error || "failed")
              : phaseLabel}
            {classify && classify.total > 0 && (
              <> · {classify.done}/{classify.total}</>
            )}
            {tokens > 0 && <> · {tokens.toLocaleString()} tok</>}
            {j.executor && <> · {j.executor}</>}
          </span>
        </div>
        <div className="proto-atelier-rag-progress-bar">
          <span
            className="proto-atelier-rag-progress-bar-fill"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
