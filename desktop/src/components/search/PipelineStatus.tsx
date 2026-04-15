import { cn } from "../../lib/cn";

export type StageStatus = "idle" | "running" | "done" | "error";

type Props = {
  recall: { status: StageStatus; count?: number; ms?: number };
  rerank: { status: StageStatus; count?: number; ms?: number };
  answer: { status: StageStatus; ms?: number };
  isAdaptive?: boolean;
  kbVersion?: string;
};

function formatStage(label: string, status: StageStatus, detail?: string) {
  if (status === "done") return `\u2713 ${label} ${detail || ""}`;
  if (status === "running") return `\u25CF ${label}...`;
  if (status === "error") return `\u2717 ${label}`;
  return label;
}

export function PipelineStatus({ recall, rerank, answer, isAdaptive, kbVersion }: Props) {
  return (
    <div className="proto-pipeline-inline">
      <span
        className={cn(recall.status === "done" && "proto-pipeline-inline-done")}
      >
        {formatStage("Recall", recall.status, recall.status === "done" ? `${recall.count} · ${recall.ms}ms` : undefined)}
      </span>
      <span className="opacity-20">/</span>
      <span
        className={cn(rerank.status === "done" && "proto-pipeline-inline-done")}
      >
        {formatStage("Rerank", rerank.status, rerank.status === "done" ? `${rerank.count} · ${rerank.ms}ms` : undefined)}
      </span>
      <span className="opacity-20">/</span>
      <span
        className={cn(answer.status === "done" && "proto-pipeline-inline-done")}
      >
        {formatStage("Answer", answer.status, answer.status === "done" ? `${answer.ms}ms` : undefined)}
      </span>
      {kbVersion && (
        <span className="text-[10px] text-[var(--color-text-muted)] ml-2">{kbVersion}</span>
      )}
      {isAdaptive && <span className="text-[var(--color-text-muted)] ml-1">adaptive</span>}
    </div>
  );
}
