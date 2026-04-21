/**
 * SmartNote Cloud — TypeScript client.
 *
 * Parity with the Python SDK: API key → JWT exchange with auto-renewal,
 * typed resources for memories / preferences / documents / retrieve /
 * usage, structured errors.
 *
 * Uses the global `fetch` that's native in Node ≥18 and all modern
 * browsers, so no HTTP dependency is required.
 */

import { SmartNoteAuthError, SmartNoteError } from "./errors.js";
import type {
  Document,
  Memory,
  MemoryAddInput,
  MemoryPatchInput,
  Preference,
  RetrieveRequest,
  RetrieveResult,
  Usage,
} from "./types.js";

export interface SmartNoteOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;            // for testing + environments without global fetch
  refreshMarginSec?: number;
}

interface TokenExchangeResponse {
  jwt: string;
  expires_at: number;
  scopes: string[];
  workspace_id: string;
}

export class SmartNote {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly refreshMargin: number;

  private jwt: string | null = null;
  private jwtExp = 0;

  readonly memories: MemoriesResource;
  readonly preferences: PreferencesResource;
  readonly documents: DocumentsResource;
  readonly usage: UsageResource;

  constructor(opts: SmartNoteOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "http://localhost:58000").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.refreshMargin = opts.refreshMarginSec ?? 30;
    this.memories = new MemoriesResource(this);
    this.preferences = new PreferencesResource(this);
    this.documents = new DocumentsResource(this);
    this.usage = new UsageResource(this);
  }

  /** Top-level retrieve — more ergonomic than a sub-resource. */
  async retrieve(req: RetrieveRequest): Promise<{ results: RetrieveResult[]; query_embedded: boolean }> {
    return this.request("POST", "/v1/retrieve", { json: req });
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { json?: unknown; query?: Record<string, unknown> } = {},
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const token = await this.ensureToken();
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        ...(opts.json !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
    });
    // If the JWT expired in the window between ensureToken() and the
    // request landing, retry once with a freshly-minted token.
    if (res.status === 401 && this.jwt) {
      this.jwt = null;
      this.jwtExp = 0;
      const retryToken = await this.ensureToken();
      const retry = await this.fetchImpl(url, {
        method,
        headers: {
          "Authorization": `Bearer ${retryToken}`,
          ...(opts.json !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
      });
      return this.handleResponse<T>(retry);
    }
    return this.handleResponse<T>(res);
  }

  private async ensureToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now + this.refreshMargin < this.jwtExp) {
      return this.jwt;
    }
    const res = await this.fetchImpl(`${this.baseUrl}/v1/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey }),
    });
    if (res.status === 401) {
      throw new SmartNoteAuthError("api key rejected", { status: 401, body: await safeJson(res) });
    }
    if (!res.ok) {
      throw new SmartNoteError(`token exchange failed (${res.status})`, {
        status: res.status, body: await safeJson(res),
      });
    }
    const data = (await res.json()) as TokenExchangeResponse;
    this.jwt = data.jwt;
    this.jwtExp = data.expires_at;
    return this.jwt;
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    if (res.status === 401) {
      throw new SmartNoteAuthError("unauthorized", { status: 401, body: await safeJson(res) });
    }
    if (res.status === 403) {
      throw new SmartNoteAuthError("forbidden (scope)", { status: 403, body: await safeJson(res) });
    }
    if (!res.ok) {
      const body = await safeJson(res);
      throw new SmartNoteError(`request failed (${res.status})`, { status: res.status, body });
    }
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try { return await res.text(); } catch { return undefined; }
  }
}

// ── Resources ──────────────────────────────────────────────

class MemoriesResource {
  constructor(private readonly client: SmartNote) {}

  add(input: MemoryAddInput): Promise<Memory> {
    return this.client.request<Memory>("POST", "/v1/memories", { json: input });
  }

  async list(opts: { kind?: string; scope?: string; limit?: number; offset?: number } = {}): Promise<Memory[]> {
    const body = await this.client.request<{ memories: Memory[] }>("GET", "/v1/memories", {
      query: opts as Record<string, unknown>,
    });
    return body.memories;
  }

  get(id: string): Promise<Memory> {
    return this.client.request<Memory>("GET", `/v1/memories/${id}`);
  }

  patch(id: string, updates: MemoryPatchInput): Promise<Memory> {
    return this.client.request<Memory>("PATCH", `/v1/memories/${id}`, { json: updates });
  }

  async delete(id: string): Promise<void> {
    await this.client.request("DELETE", `/v1/memories/${id}`);
  }
}

class PreferencesResource {
  constructor(private readonly client: SmartNote) {}

  async all(): Promise<Record<string, Preference>> {
    const body = await this.client.request<{ preferences: Record<string, Preference> }>(
      "GET", "/v1/preferences",
    );
    return body.preferences;
  }

  get(key: string): Promise<Preference> {
    return this.client.request<Preference>("GET", `/v1/preferences/${encodeURIComponent(key)}`);
  }

  set(key: string, value: unknown, description?: string): Promise<Preference> {
    return this.client.request<Preference>(
      "PUT", `/v1/preferences/${encodeURIComponent(key)}`,
      { json: { value, description } },
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.request("DELETE", `/v1/preferences/${encodeURIComponent(key)}`);
  }
}

class DocumentsResource {
  constructor(private readonly client: SmartNote) {}

  add(name: string, content: string, opts: { kind?: string; metadata?: Record<string, unknown> } = {}): Promise<Document> {
    return this.client.request<Document>("POST", "/v1/documents", {
      json: { name, content, kind: opts.kind ?? "text", metadata: opts.metadata ?? null },
    });
  }

  ingest(id: string): Promise<{ ok: boolean; chunks: number }> {
    return this.client.request("POST", `/v1/documents/${id}/ingest`);
  }

  async list(): Promise<Document[]> {
    const body = await this.client.request<{ documents: Document[] }>("GET", "/v1/documents");
    return body.documents;
  }

  get(id: string): Promise<Document & { content: string; metadata: Record<string, unknown> }> {
    return this.client.request("GET", `/v1/documents/${id}`);
  }
}

class UsageResource {
  constructor(private readonly client: SmartNote) {}

  current(): Promise<Usage> {
    return this.client.request<Usage>("GET", "/v1/usage");
  }
}
