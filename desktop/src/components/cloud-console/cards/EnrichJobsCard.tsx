import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, FileText, BookOpen, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  listEnrichJobs, type EnrichJob,
  deleteEnrichJob, bulkDeleteEnrichJobs,
} from "@/lib/cloud-api";

const STATUSES = ["all", "queued", "running", "done", "failed"] as const;
type StatusFilter = (typeof STATUSES)[number];

// Adaptive polling: tight cadence while anything is in flight so the
// progress bar feels live; relax to 5s when the queue is idle to avoid
// hammering the API for nothing. Re-fires on mount + filter change so
// re-entering the page surfaces the freshest state immediately.
const POLL_ACTIVE_MS = 1_200;
const POLL_IDLE_MS = 5_000;

function isLiveStatus(s: string): boolean {
  return s === "queued" || s === "running" || s === "dispatched";
}

/* Enrich jobs list — surfaced inside the Sync tab now that "Enrich"
   isn't its own console section. Each row reads as a sentence:
   "<type icon> source.md · queued — submitted by claude code, 2m ago".
   The user knows what's running, on what, by whom. */

export function EnrichJobsCard() {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [jobs, setJobs] = useState<EnrichJob[]>([]);
  const [err, setErr] = useState("");
  // Don't show "loading…" on every poll — only on the very first
  // fetch after mount or filter change, so the card stays calm once
  // populated and isn't flickering every 1.2s.
  const [firstLoad, setFirstLoad] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await listEnrichJobs(filter === "all" ? undefined : filter);
      setJobs(next);
      setErr("");
    } catch (e) { setErr(String(e)); }
    finally { setFirstLoad(false); }
  }, [filter]);

  // Re-fetch immediately on mount / filter change, then poll on a
  // cadence that tightens while jobs are in flight. The interval
  // recomputes after each tick so it speeds up the moment a new job
  // enters the queue and slows back down once everything is settled.
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  useEffect(() => {
    setFirstLoad(true);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function loop() {
      if (cancelled) return;
      await refresh();
      if (cancelled) return;
      const live = jobsRef.current.some((j) => isLiveStatus(j.status));
      timer = setTimeout(loop, live ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    }
    loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const tally = (st: string) => jobs.filter((j) => j.status === st).length;

  return (
    <section className="proto-cloud-sync-card">
      <h2 className="proto-cloud-sync-card-title">Enrich queue</h2>
      <p className="proto-form-hint" style={{ marginBottom: 12 }}>
        LLM tag classification + entity extraction. Each row shows the
        document being enriched, what kind it is, and which executor is
        handling it.
      </p>

      <div className="proto-cc-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 12 }}>
        {(["queued", "running", "done", "failed"] as const).map((st) => (
          <button
            key={st}
            type="button"
            onClick={() => setFilter(st === filter ? "all" : st)}
            className={cn(
              "proto-cc-card proto-cc-card-button",
              filter === st && "proto-cc-card-active",
            )}
          >
            <div className="proto-cc-card-label">{st}</div>
            <div className="proto-cc-card-value">{tally(st)}</div>
          </button>
        ))}
      </div>

      <div className="proto-cc-section-head" style={{ marginTop: 4, marginBottom: 8 }}>
        <span className="proto-section-label" style={{ margin: 0 }}>
          {filter === "all" ? "All jobs" : `${filter[0].toUpperCase()}${filter.slice(1)}`}
          <span className="proto-section-label-count">{jobs.length}</span>
        </span>
        <button
          type="button"
          className="proto-btn proto-btn-secondary"
          onClick={async () => {
            if (!confirm("Delete every queued job for this workspace?")) return;
            try { await bulkDeleteEnrichJobs("queued"); refresh(); }
            catch (e) { setErr(String(e)); }
          }}
          disabled={tally("queued") === 0}
          title="Drain stuck-queued jobs"
          style={{ fontSize: 11, padding: "4px 8px" }}
        >
          <Trash2 size={11} /> Clear queued
        </button>
      </div>

      {err && <div className="proto-cc-error">{err}</div>}

      {firstLoad && jobs.length === 0 ? (
        <div className="proto-cc-empty">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : jobs.length === 0 ? (
        <div className="proto-cc-empty">
          {filter === "all" ? "No enrich jobs yet." : `No ${filter} jobs.`}
        </div>
      ) : (
        <ul className="proto-enrich-list">
          {jobs.map((j) => (
            <EnrichJobRow key={j.id} job={j} onDelete={async () => {
              try { await deleteEnrichJob(j.id); refresh(); }
              catch (e) { setErr(String(e)); }
            }} />
          ))}
        </ul>
      )}
    </section>
  );
}

function EnrichJobRow({ job, onDelete }: { job: EnrichJob; onDelete: () => void }) {
  const type = job.smartnote_type || "doc";
  const Icon = type === "wiki_topic" ? BookOpen : FileText;
  const typeLabel = type === "wiki_topic" ? "wiki" : type === "note" ? "note" : type;
  const name = job.document_name || `doc ${job.document_id.slice(0, 8)}`;
  const live = isLiveStatus(job.status);
  return (
    <li className={cn("proto-enrich-row", `proto-enrich-row--${job.status}`)}>
      <span className="proto-enrich-row-type" title={typeLabel}>
        <Icon size={12} />
        <span>{typeLabel}</span>
      </span>
      <span className="proto-enrich-row-name" title={name}>{name}</span>
      <StatusPill status={job.status} />
      <span className="proto-enrich-row-by">
        {executorLabel(job.executor, job.status)}
      </span>
      <span className="proto-enrich-row-time">{relativeTime(job.finished_at || job.dispatched_at || job.created_at)}</span>
      <button
        type="button"
        onClick={onDelete}
        className="proto-version-action-danger"
        title="Delete this enrich job"
        aria-label="Delete enrich job"
      >
        <Trash2 size={12} />
      </button>
      {live && <ProgressBar progress={job.progress} status={job.status} />}
    </li>
  );
}

/* Inline progress bar that occupies the row's full width on a second
   line. Reads classify.done/total from the job's progress JSONB and
   falls back to an indeterminate stripe when no counters are available
   yet (queued, or executor that doesn't report counts). */
function ProgressBar({
  progress, status,
}: { progress?: EnrichJob["progress"]; status: string }) {
  const c = progress?.classify;
  const phase = progress?.phase || (status === "queued" ? "queued" : status);
  const phaseLabel = phaseToLabel(phase);
  const tokens = progress?.tokens?.total ?? 0;
  const determinate = c && c.total > 0;
  const pct = determinate ? Math.min(100, Math.round((c!.done / c!.total) * 100)) : 0;

  return (
    <div className="proto-enrich-row-progress">
      <div className="proto-enrich-row-progress-meta">
        <span className="proto-enrich-row-progress-phase">{phaseLabel}</span>
        {determinate ? (
          <span className="proto-enrich-row-progress-counts">
            {c!.done.toLocaleString()} / {c!.total.toLocaleString()} lines · {pct}%
          </span>
        ) : (
          <span className="proto-enrich-row-progress-counts">working…</span>
        )}
        {tokens > 0 && (
          <span className="proto-enrich-row-progress-tokens">
            {tokens.toLocaleString()} tok
          </span>
        )}
      </div>
      <div className={cn(
        "proto-enrich-row-progress-track",
        !determinate && "proto-enrich-row-progress-track--indeterminate",
      )}>
        {determinate && (
          <div
            className="proto-enrich-row-progress-fill"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}

function phaseToLabel(phase: string): string {
  switch (phase) {
    case "queued": return "Queued";
    case "dispatching": return "Dispatching";
    case "classifying": return "Classifying";
    case "done": return "Finalizing";
    case "running": return "Running";
    default: return phase || "Working";
  }
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn("proto-cc-status-badge", `proto-cc-status-badge-${status}`)}>
      {status}
    </span>
  );
}

function executorLabel(executor: string | null | undefined, status: string): string {
  if (!executor) {
    if (status === "queued") return "awaiting executor";
    return "—";
  }
  if (executor === "mcp_pull") return "via AI CLI";
  if (executor === "ws_relay") return "via primary device";
  if (executor === "cloud_pool") return "via cloud LLM";
  return `via ${executor}`;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toLocaleDateString();
}
