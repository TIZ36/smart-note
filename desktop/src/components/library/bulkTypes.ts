// Bulk pipeline run state shared by the Library Docs bulk-action bar
// and the ProcessingPanel. Lives here (not under rag/) since the RAG
// page was folded into Library — keeping the types co-located with
// the Library surface that owns the workflow.

export type RunKind = "embed" | "enrich" | "tag" | "graph";

export type RunStatus = {
  kind: RunKind;
  status: "queued" | "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: string;
  runId?: string;
  message?: string;
  progressCurrent?: number;
  progressTotal?: number;
  /** Source name captured at enqueue so the panel doesn't need to
   *  re-resolve the doc list every render. */
  name: string;
};
