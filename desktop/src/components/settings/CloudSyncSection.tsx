import { useEffect, useState, useCallback } from "react";
import { Loader2, Cloud, CloudOff, RefreshCw, Upload, Download, CheckCircle2, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import * as api from "@/lib/api";
import type { AppSettings } from "@/lib/types";
import { cn } from "@/lib/cn";

/* Settings section for SmartNote Cloud bidirectional sync.
   Three things happen here:
     - URL + API key input (form fields — writes go through the parent
       SettingsPanel save button, not here, so it's consistent with the
       other persistently-stored settings)
     - "Test connection" button — probes the cloud with the current URL
       and key; shows workspace id on success
     - Status panel + manual Sync Now / Push / Pull buttons */

type Props = {
  settings: AppSettings;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
};

type TestResult = { ok: boolean; workspace?: { workspace_id?: string; memory_count?: number }; error?: string } | null;

export function CloudSyncSection({ settings, update }: Props) {
  const [status, setStatus] = useState<api.CloudSyncStatus | null>(null);
  const [testResult, setTestResult] = useState<TestResult>(null);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState<"full" | "push" | "pull" | null>(null);
  const [syncError, setSyncError] = useState("");

  const enabled = settings.cloud_sync_enabled !== false;
  const url = settings.cloud_sync_url || "";
  const key = settings.cloud_sync_api_key || "";

  const refreshStatus = useCallback(async () => {
    try { setStatus(await api.fetchCloudSyncStatus()); }
    catch { setStatus(null); }
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  async function handleTest() {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testCloudSync();
      setTestResult(r as TestResult);
    } catch (e) {
      setTestResult({ ok: false, error: String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function handleSync(kind: "full" | "push" | "pull") {
    if (syncing) return;
    setSyncing(kind);
    setSyncError("");
    try {
      if (kind === "full") await api.triggerSyncFull();
      else if (kind === "push") await api.triggerSyncPush();
      else await api.triggerSyncPull();
      await refreshStatus();
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setSyncing(null);
    }
  }

  const hasConfig = Boolean(url && key);

  return (
    <section className="proto-form-section">
      <h2 className="proto-form-section-title">
        <Cloud size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
        SmartNote Cloud Sync
      </h2>
      <p className="proto-form-hint" style={{ marginBottom: 12 }}>
        Bidirectional sync of notes, wiki topics, and smart tables to a
        SmartNote Cloud workspace. Other agents (Cursor, Claude Code) using
        the same API key see the same content.
      </p>

      <div className="proto-toggle-row">
        <div>
          <div className="proto-toggle-label">Enable cloud sync</div>
          <div className="proto-toggle-desc">
            {hasConfig
              ? "Local changes push to the cloud; remote changes pull down."
              : "Enter URL + API key below to enable."}
          </div>
        </div>
        <button
          type="button"
          aria-pressed={enabled}
          onClick={() => update("cloud_sync_enabled", !enabled)}
          className={cn("proto-toggle-switch", enabled && "proto-toggle-switch-on")}
        >
          <span className="proto-toggle-knob" />
        </button>
      </div>

      <AnimatePresence>
        {enabled && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: "hidden" }}
          >
            <div className="proto-form-field mt-4">
              <label className="proto-form-label">Cloud API URL</label>
              <input
                type="text"
                value={url}
                onChange={(e) => update("cloud_sync_url", e.target.value)}
                placeholder="http://localhost:58000"
                className="proto-form-input"
              />
              <p className="proto-form-hint">
                Point at your SmartNote Cloud deployment. The local dev stack
                listens on <code style={codeStyle}>http://localhost:58000</code>.
              </p>
            </div>

            <div className="proto-form-field">
              <label className="proto-form-label">API Key</label>
              <input
                type="password"
                value={key}
                onChange={(e) => update("cloud_sync_api_key", e.target.value)}
                placeholder="sn_live_..."
                className="proto-form-input"
              />
              <p className="proto-form-hint">
                Mint one with <code style={codeStyle}>./cloud/scripts/issue_key.sh</code>.
              </p>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || !hasConfig}
                className="proto-btn"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {testing ? "Testing…" : "Test connection"}
              </button>
              {testResult && (
                <span
                  className={cn(
                    "proto-settings-status",
                    testResult.ok ? "proto-settings-status-success" : "proto-settings-status-error",
                  )}
                >
                  {testResult.ok
                    ? `✓ connected (${testResult.workspace?.memory_count ?? 0} memories)`
                    : `✗ ${testResult.error || "connection failed"}`}
                </span>
              )}
            </div>

            {/* Status panel + manual sync buttons */}
            {status && status.configured && (
              <div className="proto-cloud-sync-status">
                <div className="proto-cloud-sync-counts">
                  {status.entities.length === 0 ? (
                    <div className="proto-form-hint">No synced entities yet.</div>
                  ) : (
                    status.entities.map((e) => (
                      <div key={e.local_kind} className="proto-cloud-sync-row">
                        <span className="proto-cloud-sync-kind">{e.local_kind}</span>
                        <span className="proto-cloud-sync-count">{e.count}</span>
                        <span className="proto-cloud-sync-time">
                          {e.last_push || e.last_pull
                            ? `last synced ${timeAgo(e.last_pull || e.last_push || "")}`
                            : "not yet synced"}
                        </span>
                      </div>
                    ))
                  )}
                  {status.conflicts > 0 && (
                    <div className="proto-cloud-sync-conflicts">
                      <AlertTriangle size={12} /> {status.conflicts} conflict{status.conflicts === 1 ? "" : "s"} logged
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => handleSync("full")}
                    disabled={Boolean(syncing) || !hasConfig}
                    className="proto-btn proto-btn-primary"
                  >
                    {syncing === "full" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    {syncing === "full" ? "Syncing…" : "Sync now"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSync("push")}
                    disabled={Boolean(syncing) || !hasConfig}
                    className="proto-btn"
                    title="Push local changes only"
                  >
                    {syncing === "push" ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                    Push
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSync("pull")}
                    disabled={Boolean(syncing) || !hasConfig}
                    className="proto-btn"
                    title="Pull remote changes only"
                  >
                    {syncing === "pull" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    Pull
                  </button>
                </div>
                {syncError && (
                  <div className="proto-settings-status proto-settings-status-error" style={{ marginTop: 6 }}>
                    {syncError}
                  </div>
                )}
              </div>
            )}

            {status && !status.configured && hasConfig && (
              <p className="proto-form-hint" style={{ marginTop: 12 }}>
                <CloudOff size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                Save settings first, then Sync buttons will activate.
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

const codeStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "1px 4px",
  background: "var(--color-bg-elevated)",
  borderRadius: 3,
};

/** Crude relative time — "5m ago" / "2h ago" / "yesterday". */
function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
