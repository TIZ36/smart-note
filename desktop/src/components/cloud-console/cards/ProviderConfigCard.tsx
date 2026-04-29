import { useCallback, useEffect, useState } from "react";
import { Save, Loader2, Check } from "lucide-react";
import {
  fetchEnrichProvider, saveEnrichProvider, deleteEnrichProvider,
  type EnrichProviderConfig,
} from "@/lib/cloud-api";

/* Provider config — workspace-level LLM credentials for the cloud_pool
   executor. Lives under Subscription now (it's how the user activates
   the cloud-side concurrent classifier path). */

export function ProviderConfigCard() {
  const [cfg, setCfg] = useState<EnrichProviderConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-4o-mini");
  const [maxConcurrency, setMaxConcurrency] = useState(64);
  const [maxTokens, setMaxTokens] = useState(4000);
  const [timeoutSec, setTimeoutSec] = useState(60);
  const [autoEnrich, setAutoEnrich] = useState(false);
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
      setAutoEnrich(c.auto_enrich_on_ingest);
    } catch (e) { setErr(String(e)); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onSave = async () => {
    setSaving(true); setErr("");
    try {
      const c = await saveEnrichProvider({
        api_key: apiKey || null,
        base_url: baseUrl,
        model,
        max_concurrency: maxConcurrency,
        max_tokens: maxTokens,
        timeout_sec: timeoutSec,
        auto_enrich_on_ingest: autoEnrich,
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
    <section className="proto-cloud-sync-card">
      <div className="proto-cc-section-head">
        <h2 className="proto-cloud-sync-card-title" style={{ margin: 0 }}>LLM provider</h2>
        {cfg?.has_api_key
          ? <span className="proto-provider-status proto-provider-status--ok"><Check size={12} /> configured</span>
          : <span className="proto-provider-status">not set</span>}
      </div>

      <p className="proto-form-hint" style={{ marginTop: 4 }}>
        Stored encrypted-at-rest in your cloud workspace. Powers the
        <code className="proto-code"> cloud_pool </code>
        executor — concurrent server-side classification. The key never
        leaves the cloud; desktop only writes, never reads.
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
          <label className="proto-form-label">Max concurrency</label>
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

      <div className="proto-form-field" style={{ marginTop: 12 }}>
        <label className="proto-checkbox-label">
          <input
            type="checkbox"
            checked={autoEnrich}
            onChange={(e) => setAutoEnrich(e.target.checked)}
          />
          <span><strong>Auto-enrich on ingest</strong></span>
        </label>
        <p className="proto-form-hint" style={{ marginTop: 4 }}>
          When on, every sync push (and bulk ingest) automatically fires
          LLM tag classification after chunking. Off by default — saves
          tokens when you only want chunks + embeddings.
        </p>
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
          <span className="proto-provider-status proto-provider-status--ok" style={{ alignSelf: "center" }}>
            saved
          </span>
        )}
      </div>

      <p className="proto-form-hint" style={{ marginTop: 8 }}>
        Tested concurrencies: OpenAI tier-1 ≈16, Deepseek 256-500. Pick a number your provider's RPM allows.
      </p>
    </section>
  );
}
