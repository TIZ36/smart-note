/* Direct-to-cloud HTTP client. Phase 2.5+ — used by Cloud Console.
 *
 * Distinct from `lib/api.ts`, which proxies through the local server.
 * The console talks to the cloud directly so quotas, devices, jobs etc.
 * reflect cloud state without a local relay (the local server still
 * exists for file watching / sync; both clients coexist).
 *
 * JWT cache: we exchange the user's API key for a JWT once and reuse
 * it. On 401 we drop and retry once. Refresh is 60s before expiry.
 */
import { readSettings } from "./electron";

let _jwtCache: { jwt: string; expiresAt: number; key: string } | null = null;

async function getCreds(): Promise<{ baseUrl: string; key: string }> {
  const s = await readSettings();
  const baseUrl = (s.cloud_sync_url || "").replace(/\/+$/, "");
  const key = s.cloud_sync_api_key || "";
  if (!baseUrl || !key) throw new Error("Cloud not configured (Sync tab → set URL + API key)");
  return { baseUrl, key };
}

async function getJwt(): Promise<{ baseUrl: string; jwt: string }> {
  const { baseUrl, key } = await getCreds();
  const now = Math.floor(Date.now() / 1000);
  if (_jwtCache && _jwtCache.key === key && _jwtCache.expiresAt - 60 > now) {
    return { baseUrl, jwt: _jwtCache.jwt };
  }
  const r = await fetch(`${baseUrl}/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key }),
  });
  if (!r.ok) throw new Error(`auth token: ${r.status}`);
  const d = await r.json() as { jwt: string; expires_at: number };
  _jwtCache = { jwt: d.jwt, expiresAt: d.expires_at, key };
  return { baseUrl, jwt: d.jwt };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { baseUrl, jwt } = await getJwt();
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  let r = await fetch(`${baseUrl}${path}`, init);
  if (r.status === 401) {
    _jwtCache = null;
    const refreshed = await getJwt();
    (init.headers as Record<string, string>).Authorization = `Bearer ${refreshed.jwt}`;
    r = await fetch(`${baseUrl}${path}`, init);
  }
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.status === 204 ? undefined as T : await r.json() as T;
}

// ── Types (mirror server pydantic shapes) ──────────────────────────

export type ConsoleOverview = {
  workspace_id: string;
  counts: {
    memories: number; documents: number; devices: number;
    enrich_queued: number; enrich_done: number;
    proposals_pending: number; wiki_nodes: number;
  };
  executors: { mcp_pull: boolean; ws_relay: boolean; cloud_pool: boolean };
  primary_device_online: boolean;
  activity: { kind: string; id: string; summary: string; at: string }[];
};

export type Device = {
  id: string; name: string; platform: string;
  is_primary: boolean; online: boolean;
  last_seen_at: string | null; created_at: string;
};

export type EnrichJob = {
  id: string; document_id: string; status: string;
  executor: string | null; attempts: number;
  result: Record<string, unknown> | null; error: string | null;
  created_at: string; dispatched_at: string | null; finished_at: string | null;
};

// ── Endpoints ──────────────────────────────────────────────────────

export const fetchOverview = () => call<ConsoleOverview>("GET", "/v1/console/overview");

export const listDevices = () => call<Device[]>("GET", "/v1/devices");
export const pairDevice = () =>
  call<{ pairing_code: string; expires_at: string; device_id: string }>("POST", "/v1/devices/pair", {});
export const promoteDevice = (id: string) => call<Device>("POST", `/v1/devices/${id}/promote`, {});
export const unpairDevice = (id: string) => call<{ deleted: number }>("DELETE", `/v1/devices/${id}`);

export const listEnrichJobs = (status?: string) =>
  call<EnrichJob[]>("GET", `/v1/enrich/jobs${status ? `?status_filter=${status}` : ""}`);
export const runEnrich = (documentId: string) =>
  call<EnrichJob>("POST", "/v1/enrich/run", { document_id: documentId });
