import { useCallback, useEffect, useState } from "react";
import { Save, Loader2, Check } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  listEnrichJobs, type EnrichJob,
  fetchEnrichProvider, saveEnrichProvider, deleteEnrichProvider,
  type EnrichProviderConfig,
} from "@/lib/cloud-api";

const STATUSES = ["all", "queued", "running", "done", "failed"] as const;
type StatusFilter = (typeof STATUSES)[number];

export function EnrichTab() {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [jobs, setJobs] = useState<EnrichJob[]>([]);
  const [err, setErr] = useState("");

  const refresh = useCallback(async () => {
    try { setJobs(await listEnrichJobs(filter === "all" ? undefined : filter)); setErr(""); }
    catch (e) { setErr(String(e)); }
  }, [filter]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  const tally = (st: string) => jobs.filter((j) => j.status === st).length;

  return (
    <div className="proto-cc-content">
      <ProviderSection />

      <div className="proto-form-divider" />

      <section className="proto-form-section">
        <div className="proto-cc-section-head">
          <h2 className="proto-form-section-title">Enrich jobs</h2>
          <div style={{ display: "flex", gap: 2 }}>
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setFilter(s)}
                className={cn("proto-cc-tab", filter === s && "proto-cc-tab-active")}
                style={{ height: 26, padding: "0 10px", fontSize: 12 }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="proto-cc-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 16 }}>
          {(["queued", "running", "done", "failed"] as const).map((st) => (
            <div key={st} className="proto-cc-card">
              <div className="proto-cc-card-label">{st}</div>
              <div className="proto-cc-card-value">{tally(st)}</div>
            </div>
          ))}
        </div>

        {err && <div className="proto-cc-error">{err}</div>}

        {jobs.length === 0 ? (
          <div className="proto-cc-empty">No jobs.</div>
        ) : (
          <table className="proto-cc-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Executor</th>
                <th>Created</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="proto-cc-cell-mono">{j.id.slice(0, 8)}</td>
                  <td>
                    <span className={cn("proto-cc-status-badge", `proto-cc-status-badge-${j.status}`)}>
                      {j.status}
                    </span>
                  </td>
                  <td className="proto-cc-cell-muted">{j.executor || "—"}</td>
                  <td className="proto-cc-cell-muted">{new Date(j.created_at).toLocaleString()}</td>
                  <td className="proto-cc-cell-muted">
                    {j.finished_at ? new Date(j.finished_at).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/* ── Provider config card ──────────────────────────────────────────
   Workspace-level LLM credentials for the cloud_pool executor.
   When set, full_ingest(enrich_with_ai=True) and the dispatcher's
   cloud_pool path use it for concurrent server-side classification. */

function ProviderSection() {
  const [cfg, setCfg] = useState<EnrichProviderConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-4o-mini");
  const [maxConcurrency, setMaxConcurrency] = useState(64);
  const [maxTokens, setMaxTokens] = useState(4000);
  const [timeoutSec, setTimeoutSec] = useState(60);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState("");

  const refresh = useCallback(async () => {
    try {
      const c = await fetchEnrichProvider();
      setCfg(c);
      setBaseUrl(c.base_url);
      setModel(c.model);
      setMaxConcurrency(c.max_concurrency);
      setMaxTokens(c.max_tokens);
      setTimeoutSec(c.timeout_sec);
    } catch (e) { setErr(String(e)); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onSave = async () => {
    setSaving(true); setErr("");
    try {
      const c = await saveEnrichProvider({
        api_key: apiKey || null,  // null → keep existing
        base_url: baseUrl,
        model,
        max_concurrency: maxConcurrency,
        max_tokens: maxTokens,
        timeout_sec: timeoutSec,
      });
      setCfg(c);
      setApiKey("");
      setSavedAt(Date.now());
    } catch (e) { setErr(String(e)); }
    finally { setSaving(false); }
  };

  const onClear = async () => {
    if (!confirm("Delete the saved API key? cloud_pool path will stop firing.")) return;
    setSaving(true); setErr("");
    try {
      await deleteEnrichProvider();
      await refresh();
      setApiKey("");
      setSavedAt(Date.now());
    } catch (e) { setErr(String(e)); }
    finally { setSaving(false); }
  };

  return (
    <section className="proto-form-section">
      <div className="proto-cc-section-head">
        <h2 className="proto-form-section-title">LLM provider (cloud-side)</h2>
        {cfg?.has_api_key
          ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--color-success)" }}>
              <Check size={12} /> configured
            </span>
          : <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>not set</span>}
      </div>

      <p className="proto-form-hint" style={{ marginTop: 0 }}>
        Stored encrypted-at-rest in your cloud workspace. Used by the{" "}
        <code style={{ background: "var(--color-bg-elevated)", padding: "1px 5px", borderRadius: 3 }}>cloud_pool</code>{" "}
        executor to make concurrent classification calls. The key never leaves the cloud — desktop only writes, never reads.
      </p>

      <div className="proto-form-field">
        <label className="proto-form-label">API key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={cfg?.has_api_key ? "(unchanged) — enter new key to rotate" : "sk-..."}
          className="proto-form-input proto-form-input-mono"
        />
      </div>

      <div className="proto-form-row" style={{ gap: 8 }}>
        <div style={{ flex: 2 }}>
          <label className="proto-form-label">Base URL</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
            className="proto-form-input proto-form-input-mono" />
        </div>
        <div style={{ flex: 1 }}>
          <label className="proto-form-label">Model</label>
          <input value={model} onChange={(e) => setModel(e.target.value)}
            className="proto-form-input proto-form-input-mono" />
        </div>
      </div>

      <div className="proto-form-row" style={{ gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label className="proto-form-label">Max concurrency (1-512)</label>
          <input type="number" min={1} max={512}
            value={maxConcurrency} onChange={(e) => setMaxConcurrency(Number(e.target.value))}
            className="proto-form-input proto-form-input-mono" />
        </div>
        <div style={{ flex: 1 }}>
          <label className="proto-form-label">Max tokens</label>
          <input type="number" value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))}
            className="proto-form-input proto-form-input-mono" />
        </div>
        <div style={{ flex: 1 }}>
          <label className="proto-form-label">Timeout (sec)</label>
          <input type="number" value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))}
            className="proto-form-input proto-form-input-mono" />
        </div>
      </div>

      {err && <div className="proto-cc-error" style={{ marginTop: 8 }}>{err}</div>}

      <div className="proto-form-row" style={{ marginTop: 12, gap: 8 }}>
        <button className="proto-btn proto-btn-primary" disabled={saving} onClick={onSave}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save
        </button>
        {cfg?.has_api_key && (
          <button className="proto-btn proto-btn-secondary" disabled={saving} onClick={onClear}>
            Clear API key
          </button>
        )}
        {savedAt && (
          <span style={{ fontSize: 12, color: "var(--color-success)", alignSelf: "center" }}>
            saved
          </span>
        )}
      </div>

      <p className="proto-form-hint" style={{ marginTop: 8 }}>
        Tested concurrencies: OpenAI tier-1 ~16, Deepseek 256-500. Pick a number your provider's RPM allows.
      </p>
    </section>
  );
}
