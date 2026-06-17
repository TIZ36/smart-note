export type RunStatus = "done" | "running" | "failed";

export type Run = {
  id: string;
  stage: string;
  status: RunStatus;
  doc: string;          // file name (resolved from document_id when possible)
  docId: string | null; // raw document UUID
  startedAt: string | null;
  time: string;         // HH:MM display
  timeFull: string;     // full timestamp for tooltip
  duration: string;
  cost: string;
  bucket: "Today" | "Yesterday" | "Earlier";
  log: string;
  error?: string;
};

export type DocKind = "document" | "wiki" | "pdf";

export type DocItem = {
  id: string;
  name: string;
  kind: DocKind;
  chunks: number;
  size: string;
  updated: string;
  status: RunStatus;
  preview: string;
};

export type Note = {
  id: string;
  title: string;
  updated: string;
  tag: "starred" | "";
  snippet: string;
  body: string;
};

export type Citation = {
  n: number;
  title: string;
  meta: string;
  score: string;
};

export type AskResult = {
  answer: string;
  citations: Citation[];
  model: string;
  latencyMs: number;
  cost: string;
};
