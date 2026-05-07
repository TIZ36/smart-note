/* In-app Logs channel — reads pipeline_events via local-db IPC.
 *
 * Companion to the cloud's standalone log-panel service: same data
 * model, same wire shape, but runs entirely inside the desktop app
 * against SQLite. Only meaningful in local mode — cloud mode users
 * still have the standalone web panel at port 8090.
 */

import { isLocalMode } from "./mode";

type Desktop = { invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> };
function dt(): Desktop {
  const d = (window as unknown as { desktop?: Desktop }).desktop;
  if (!d) throw new Error("desktop bridge unavailable");
  return d;
}

export type LogEvent = {
  id: number;
  at: string | null;
  workspace_id: string;
  run_id: string | null;
  document_id: string | null;
  stage: string | null;
  event: string;
  status: string | null;
  message: string | null;
  error: string | null;
  schema_version: number;
  data: Record<string, unknown>;
};

export type LogRecentRun = {
  run_id: string;
  workspace_id: string;
  document_id: string | null;
  stage: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  event_count: number;
  status: string;
};

export type LogStats = {
  events_total: number;
  events_24h: number;
  runs_total: number;
  runs_24h: number;
  errors_24h: number;
  workspaces_24h: number;
  cost_24h_usd: number;
};

export type LogRunChain = {
  run_id: string;
  workspace_id: string;
  document_id: string | null;
  stage: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  status: string | null;
  cost_usd: number | null;
  model: string | null;
  events: LogEvent[];
};

export function isLogsChannelAvailable(): boolean {
  // Local mode hosts pipeline_events itself; cloud mode shows the
  // user the standalone web panel instead. Renderer side just hides
  // the rail icon when this is false.
  return isLocalMode();
}

export const recentRuns = (limit = 50) =>
  dt().invoke<{ runs: LogRecentRun[]; count: number }>("local:logsRecentRuns", limit);

export const runChain = (run_id: string) =>
  dt().invoke<LogRunChain>("local:logsRunChain", run_id);

export const search = (opts: {
  stage?: string;
  status?: string;
  document_id?: string;
  q?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: number;
}) =>
  dt().invoke<{ events: LogEvent[]; next_cursor: number | null; count: number }>(
    "local:logsSearch", opts,
  );

export const stats = () => dt().invoke<LogStats>("local:logsStats");
