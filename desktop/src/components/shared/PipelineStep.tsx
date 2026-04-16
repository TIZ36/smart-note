import { cn } from "@/lib/cn";
import type { IngestStep } from "@/App";

const KIND_LABELS: Record<string, string> = {
  note_segments: "note segments",
  wiki_chunks: "wiki chunks",
  wiki_topic: "wiki topic",
  doc_format: "doc formatting",
};

function humanizeKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

function formatElapsed(ms: number): string {
  if (ms >= 60000) return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

type Props = {
  step: IngestStep;
  /** Show elapsed time on the right (active or done). Full pipeline panel uses this. */
  showElapsed?: boolean;
  /** Show a sub-line progress bar when the step is active and has a total. */
  showProgressBar?: boolean;
};

/**
 * Single ingest-pipeline step row. Consolidates the three near-identical
 * renderings that used to live in IngestPanel, IngestDialog, and
 * SpecialKnowledgePanel. Subtle variants (elapsed/progress) are opt-in via
 * props — the default matches dialog/panel usage (label + actor + count).
 */
export function PipelineStep({ step, showElapsed = false, showProgressBar = false }: Props) {
  const labelClass = cn(
    "text-[13px]",
    step.status === "active"
      ? "text-[var(--color-text-primary)]"
      : step.status === "done"
        ? "text-[var(--color-text-secondary)]"
        : "text-[var(--color-text-muted)] opacity-40",
  );

  return (
    <div
      className={cn(
        "proto-pipeline-step",
        step.status === "done" && "proto-pipeline-step-done",
        step.status === "pending" && "proto-pipeline-step-pending",
        step.status === "active" && "proto-pipeline-step-active",
      )}
    >
      <div className="proto-pipeline-step-icon" aria-hidden="true">
        {step.status === "done" && "\u2713"}
        {step.status === "active" && "\u25CF"}
        {step.status === "pending" && "\u25CB"}
        {step.status === "error" && "\u2717"}
      </div>
      <div className="flex-1 min-w-0">
        <div className="proto-pipeline-row">
          <span className={labelClass}>{step.label}</span>
          {step.actor === "mcp:delegate" && (
            <span
              className="proto-pipeline-actor"
              aria-label={`Claude is working on ${step.kind ?? "enrichment"}`}
            >
              by claude{step.kind ? ` · ${humanizeKind(step.kind)}` : ""}
            </span>
          )}
          {step.status === "active" && step.total > 0 && (
            <span className="proto-pipeline-count" aria-label={`Progress: ${step.current} of ${step.total}`}>
              {step.current}/{step.total}
            </span>
          )}
          {showElapsed && step.elapsedMs > 0 && (step.status === "active" || step.status === "done") && (
            <span className="proto-pipeline-elapsed" aria-label={`Elapsed ${formatElapsed(step.elapsedMs)}`}>
              {formatElapsed(step.elapsedMs)}
            </span>
          )}
        </div>
        {step.detail && <p className="proto-step-detail">{step.detail}</p>}
        {showProgressBar && step.status === "active" && step.total > 0 && (
          <div className="proto-progress-bar" role="progressbar" aria-valuenow={step.current} aria-valuemin={0} aria-valuemax={step.total}>
            <div
              className="proto-progress-fill"
              style={{ width: `${Math.round((step.current / step.total) * 100)}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
