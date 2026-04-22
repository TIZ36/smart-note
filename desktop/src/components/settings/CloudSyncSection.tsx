import { useEffect, useState, useCallback } from "react";
import {
  Loader2, Cloud, CloudOff, RefreshCw, Upload, Download,
  CheckCircle2, AlertTriangle, Copy, X, FileText, Table, BookOpen, Sparkles, Save,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import * as api from "@/lib/api";
import type { AppSettings } from "@/lib/types";
import { cn } from "@/lib/cn";

/* Friendly cloud-sync onboarding.
   Three distinct states, rendered in-place:
     1. Empty — no URL / no API key → numbered guide explaining what to do
     2. Configured, never synced → preview ("N files, X MB") + big confirm CTA
     3. Synced at least once → existing status panel + Sync Now buttons */

type Props = {
  settings: AppSettings;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
};

type TestResult = { ok: boolean; workspace?: { workspace_id?: string; memory_count?: number }; error?: string } | null;

export function CloudSyncSection({ settings, update }: Props) {
  const [status, setStatus] = useState<api.CloudSyncStatus | null>(null);
  const [preview, setPreview] = useState<api.CloudSyncPreview | null>(null);
  const [testResult, setTestResult] = useState<TestResult>(null);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState<"full" | "push" | "pull" | null>(null);
  const [syncError, setSyncError] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [savingCreds, setSavingCreds] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const enabled = settings.cloud_sync_enabled !== false;
  const url = settings.cloud_sync_url || "";
  const key = settings.cloud_sync_api_key || "";
  const hasConfig = Boolean(url && key);

  // Track whether the form has unsaved changes vs the last backend
  // snapshot. The backend stores settings separately from the React
  // state in the parent, so we keep our own "last persisted" to
  // detect drift without doing a round-trip per keystroke.
  const [persisted, setPersisted] = useState({ url, key, enabled });
  const dirty = persisted.url !== url || persisted.key !== key || persisted.enabled !== enabled;

  const refreshStatus = useCallback(async () => {
    try { setStatus(await api.fetchCloudSyncStatus()); }
    catch { setStatus(null); }
  }, []);

  const refreshPreview = useCallback(async () => {
    try { setPreview(await api.fetchCloudSyncPreview()); }
    catch { setPreview(null); }
  }, []);

  useEffect(() => {
    refreshStatus();
    refreshPreview();
  }, [refreshStatus, refreshPreview]);

  async function handleTest() {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      // Pass current form values — users expect "Test connection" to
      // verify what they just typed, not whatever was last persisted.
      setTestResult(await api.testCloudSync({ url, api_key: key }) as TestResult);
    } catch (e) {
      setTestResult({ ok: false, error: String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function handleSaveCredentials() {
    if (savingCreds) return;
    setSavingCreds(true);
    try {
      await api.saveCloudSyncSettings({
        cloud_sync_enabled: enabled,
        cloud_sync_url: url,
        cloud_sync_api_key: key,
      });
      setPersisted({ url, key, enabled });
      setSavedAt(Date.now());
      // Refresh preview/status immediately so the UI reflects the new
      // backend state without the user needing to re-interact.
      refreshStatus();
      refreshPreview();
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setSavingCreds(false);
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
      await refreshPreview();
      setReviewOpen(false);
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setSyncing(null);
    }
  }

  // Three rendering branches.
  const firstRun = hasConfig && status?.entities?.length === 0;
  const hasSyncHistory = hasConfig && (status?.entities?.length ?? 0) > 0;

  return (
    <section className="proto-form-section">
      <h2 className="proto-form-section-title">
        <Cloud size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
        SmartNote Cloud Sync
      </h2>
      <p className="proto-form-hint" style={{ marginBottom: 12 }}>
        Sync your notes, wiki topics, and smart tables to a SmartNote Cloud
        workspace. Once connected, any agent with your API key (Cursor,
        Claude Code, another device) reads the same content.
      </p>

      <div className="proto-toggle-row">
        <div>
          <div className="proto-toggle-label">Enable cloud sync</div>
          <div className="proto-toggle-desc">
            {!hasConfig ? "Follow the steps below to connect." :
              hasSyncHistory ? "Actively syncing." : "Ready for first upload."}
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

      <AnimatePresence initial={false}>
        {enabled && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: "hidden" }}
          >
            {/* STATE 1: empty — numbered guide */}
            {!hasConfig && <EmptyGuide url={url} keyVal={key} update={update} />}

            {/* Credentials form (always visible when enabled) */}
            <div className="proto-cloud-sync-form">
              <div className="proto-form-field">
                <label className="proto-form-label">Cloud API URL</label>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => update("cloud_sync_url", e.target.value)}
                  placeholder="http://localhost:58000"
                  className="proto-form-input"
                />
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
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testing || !hasConfig}
                  className="proto-btn"
                >
                  {testing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  {testing ? "Testing…" : "Test connection"}
                </button>
                <button
                  type="button"
                  onClick={handleSaveCredentials}
                  disabled={savingCreds || !dirty}
                  className={cn("proto-btn", dirty && "proto-btn-primary")}
                  title={dirty ? "Persist credentials to the local backend" : "Nothing to save"}
                >
                  {savingCreds ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {savingCreds ? "Saving…" : dirty ? "Save credentials" : "Saved"}
                </button>
                {savedAt && Date.now() - savedAt < 4000 && !dirty && (
                  <span className="proto-settings-status proto-settings-status-success">
                    ✓ credentials saved
                  </span>
                )}
                {testResult && (
                  <span className={cn(
                    "proto-settings-status",
                    testResult.ok ? "proto-settings-status-success" : "proto-settings-status-error",
                  )}>
                    {testResult.ok
                      ? `✓ connected · workspace has ${testResult.workspace?.memory_count ?? 0} memories`
                      : `✗ ${testResult.error || "connection failed"}`}
                  </span>
                )}
              </div>
              {dirty && hasConfig && (
                <div className="proto-form-hint" style={{ marginTop: 6, color: "var(--color-warning, #d48b00)" }}>
                  <AlertTriangle size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                  Unsaved credentials — Sync / Preview use the persisted values until you click Save.
                </div>
              )}
            </div>

            {/* STATE 2: configured but never synced — preview + big CTA */}
            {firstRun && preview && (
              <FirstRunPanel
                preview={preview}
                onReview={() => setReviewOpen(true)}
                onUpload={() => handleSync("push")}
                uploading={syncing === "push" || syncing === "full"}
                error={syncError}
              />
            )}

            {/* STATE 3: already syncing — compact status + actions */}
            {hasSyncHistory && status && (
              <ActiveSyncPanel
                status={status}
                preview={preview}
                syncing={syncing}
                syncError={syncError}
                onSync={handleSync}
                onReview={() => setReviewOpen(true)}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Review modal — what exactly will be uploaded? */}
      <AnimatePresence>
        {reviewOpen && preview && (
          <ReviewModal
            preview={preview}
            onClose={() => setReviewOpen(false)}
            onConfirm={() => handleSync("push")}
            uploading={syncing === "push" || syncing === "full"}
          />
        )}
      </AnimatePresence>
    </section>
  );
}


// ── State 1: empty-state numbered guide ─────────────────────────

function EmptyGuide({ url, keyVal, update }: {
  url: string; keyVal: string;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  function copy(cmd: string, label: string) {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <div className="proto-cloud-sync-guide">
      <div className="proto-cloud-sync-guide-intro">
        <Sparkles size={13} />
        <span>Three steps to connect. Runs entirely on your own machine by default.</span>
      </div>

      <Step num={1} title="Start the cloud stack">
        <p>Bring up Postgres + embedding + API on your machine.</p>
        <CopyRow
          cmd="./cloud/scripts/quickstart.sh"
          label="quickstart"
          copied={copied}
          onCopy={copy}
        />
        <p className="proto-cloud-sync-hint-small">
          First run takes ~2 min (downloads embedding model). Subsequent starts are seconds.
        </p>
      </Step>

      <Step num={2} title="Mint an API key">
        <CopyRow
          cmd="./cloud/scripts/issue_key.sh my-laptop"
          label="issue-key"
          copied={copied}
          onCopy={copy}
        />
        <p className="proto-cloud-sync-hint-small">
          Prints one <code className="proto-cloud-sync-code">sn_live_…</code>{" "}
          secret. Save it — it's shown only once.
        </p>
      </Step>

      <Step num={3} title="Paste URL + key below">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {!url && (
            <button
              type="button"
              className="proto-btn proto-cloud-sync-preset-btn"
              onClick={() => update("cloud_sync_url", "http://localhost:58000")}
            >
              Use local default (58000)
            </button>
          )}
          {!keyVal && (
            <span className="proto-cloud-sync-hint-small" style={{ alignSelf: "center" }}>
              Paste your <code className="proto-cloud-sync-code">sn_live_…</code> into the API Key field.
            </span>
          )}
        </div>
      </Step>

      <div className="proto-cloud-sync-privacy">
        <CloudOff size={11} />
        <span>
          Content only leaves your machine once you click <strong>Upload</strong> —
          nothing auto-syncs before the first manual upload.
        </span>
      </div>
    </div>
  );
}

function Step({ num, title, children }: { num: number; title: string; children: React.ReactNode }) {
  return (
    <div className="proto-cloud-sync-step">
      <div className="proto-cloud-sync-step-num">{num}</div>
      <div className="proto-cloud-sync-step-body">
        <div className="proto-cloud-sync-step-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

function CopyRow({ cmd, label, copied, onCopy }: {
  cmd: string; label: string; copied: string | null;
  onCopy: (cmd: string, label: string) => void;
}) {
  return (
    <div className="proto-cloud-sync-copyrow">
      <code className="proto-cloud-sync-cmd">{cmd}</code>
      <button
        type="button"
        className="proto-cloud-sync-copy-btn"
        onClick={() => onCopy(cmd, label)}
        title="Copy"
        aria-label="Copy"
      >
        {copied === label ? <CheckCircle2 size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}


// ── State 2: first-run preview ──────────────────────────────────

function FirstRunPanel({ preview, onReview, onUpload, uploading, error }: {
  preview: api.CloudSyncPreview;
  onReview: () => void;
  onUpload: () => void;
  uploading: boolean;
  error: string;
}) {
  const nothingToUpload = preview.total_items === 0;
  return (
    <div className="proto-cloud-sync-firstrun">
      <div className="proto-cloud-sync-firstrun-head">
        <div className="proto-cloud-sync-firstrun-title">Ready to upload</div>
        <div className="proto-cloud-sync-firstrun-desc">
          {nothingToUpload
            ? "No notes, wiki docs, or smart tables found locally to sync."
            : "This is your first sync. Everything listed below will be uploaded to your cloud workspace."}
        </div>
      </div>

      {!nothingToUpload && (
        <>
          <div className="proto-cloud-sync-kind-chips">
            {Object.entries(preview.kinds).map(([kind, info]) => (
              info.count > 0 && (
                <div key={kind} className="proto-cloud-sync-kind-chip">
                  <KindIcon kind={kind} />
                  <span className="proto-cloud-sync-kind-label">{kindLabel(kind)}</span>
                  <span className="proto-cloud-sync-kind-count">{info.count}</span>
                </div>
              )
            ))}
          </div>

          <div className="proto-cloud-sync-firstrun-actions">
            <button
              type="button"
              className="proto-btn proto-btn-primary"
              onClick={onUpload}
              disabled={uploading}
            >
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              {uploading ? "Uploading…" : `Upload ${preview.total_items} item${preview.total_items === 1 ? "" : "s"} · ${fmtBytes(preview.total_bytes)}`}
            </button>
            <button type="button" className="proto-btn" onClick={onReview} disabled={uploading}>
              Review list
            </button>
          </div>
          {error && (
            <div className="proto-settings-status proto-settings-status-error">{error}</div>
          )}
        </>
      )}
    </div>
  );
}


// ── State 3: active sync panel ──────────────────────────────────

function ActiveSyncPanel({ status, preview, syncing, syncError, onSync, onReview }: {
  status: api.CloudSyncStatus;
  preview: api.CloudSyncPreview | null;
  syncing: "full" | "push" | "pull" | null;
  syncError: string;
  onSync: (k: "full" | "push" | "pull") => void;
  onReview: () => void;
}) {
  const pendingChanges = preview ? preview.total_new + preview.total_changed : 0;

  return (
    <div className="proto-cloud-sync-active">
      <div className="proto-cloud-sync-kind-rows">
        {status.entities.map((e) => (
          <div key={e.local_kind} className="proto-cloud-sync-kind-row">
            <KindIcon kind={e.local_kind} />
            <span className="proto-cloud-sync-kind-label">{kindLabel(e.local_kind)}</span>
            <span className="proto-cloud-sync-kind-count">{e.count}</span>
            <span className="proto-cloud-sync-kind-time">
              {e.last_push || e.last_pull
                ? `synced ${timeAgo(e.last_pull || e.last_push || "")}`
                : "pending"}
            </span>
          </div>
        ))}
      </div>

      {pendingChanges > 0 && (
        <div className="proto-cloud-sync-pending">
          <AlertTriangle size={11} />
          {pendingChanges} local change{pendingChanges === 1 ? "" : "s"} not yet uploaded
          <button type="button" className="proto-cloud-sync-pending-link" onClick={onReview}>
            review
          </button>
        </div>
      )}

      {status.conflicts > 0 && (
        <div className="proto-cloud-sync-conflicts">
          <AlertTriangle size={12} /> {status.conflicts} conflict{status.conflicts === 1 ? "" : "s"} logged — inspect via /sync/conflicts
        </div>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => onSync("full")}
          disabled={Boolean(syncing)}
          className="proto-btn proto-btn-primary"
        >
          {syncing === "full" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {syncing === "full" ? "Syncing…" : "Sync now"}
        </button>
        <button
          type="button"
          onClick={() => onSync("push")}
          disabled={Boolean(syncing)}
          className="proto-btn"
          title="Push local changes only"
        >
          {syncing === "push" ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          Push
        </button>
        <button
          type="button"
          onClick={() => onSync("pull")}
          disabled={Boolean(syncing)}
          className="proto-btn"
          title="Pull remote changes only"
        >
          {syncing === "pull" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Pull
        </button>
      </div>

      {syncError && (
        <div className="proto-settings-status proto-settings-status-error">{syncError}</div>
      )}
    </div>
  );
}


// ── Review modal ────────────────────────────────────────────────

function ReviewModal({ preview, onClose, onConfirm, uploading }: {
  preview: api.CloudSyncPreview;
  onClose: () => void;
  onConfirm: () => void;
  uploading: boolean;
}) {
  return (
    <motion.div
      className="proto-dialog-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !uploading) onClose(); }}
    >
      <motion.div
        className="proto-dialog proto-cloud-sync-review"
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.12 }}
      >
        <div className="proto-dialog-header">
          <span>Review upload</span>
          <button type="button" className="proto-dialog-close" onClick={onClose} disabled={uploading}>
            <X size={14} />
          </button>
        </div>
        <div className="proto-dialog-body">
          <div className="proto-cloud-sync-review-summary">
            <strong>{preview.total_items}</strong> items ·{" "}
            <strong>{fmtBytes(preview.total_bytes)}</strong> ·{" "}
            <span className="proto-cloud-sync-review-breakdown">
              {preview.total_new} new, {preview.total_changed} changed,{" "}
              {preview.total_items - preview.total_new - preview.total_changed} unchanged (will skip)
            </span>
          </div>
          {Object.entries(preview.kinds).map(([kind, info]) => (
            info.count > 0 && (
              <div key={kind} className="proto-cloud-sync-review-kind">
                <div className="proto-cloud-sync-review-kind-head">
                  <KindIcon kind={kind} />
                  <strong>{kindLabel(kind)}</strong>
                  <span>{info.count} items · {fmtBytes(info.total_bytes)}</span>
                </div>
                <div className="proto-cloud-sync-review-items">
                  {info.items.map((it) => (
                    <div key={it.local_id} className={cn(
                      "proto-cloud-sync-review-item",
                      `proto-cloud-sync-review-item-${it.status}`,
                    )}>
                      <span className="proto-cloud-sync-review-item-status">{it.status}</span>
                      <span className="proto-cloud-sync-review-item-name">{it.name}</span>
                      <span className="proto-cloud-sync-review-item-size">{fmtBytes(it.size)}</span>
                    </div>
                  ))}
                  {info.truncated && (
                    <div className="proto-cloud-sync-review-item-more">… and {info.count - info.items.length} more</div>
                  )}
                </div>
              </div>
            )
          ))}
        </div>
        <div className="proto-cloud-sync-review-footer">
          <button type="button" className="proto-btn" onClick={onClose} disabled={uploading}>
            Cancel
          </button>
          <button
            type="button"
            className="proto-btn proto-btn-primary"
            onClick={onConfirm}
            disabled={uploading || preview.total_items === 0}
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {uploading ? "Uploading…" : `Upload`}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}


// ── helpers ─────────────────────────────────────────────────────

function KindIcon({ kind }: { kind: string }) {
  if (kind === "smart_table") return <Table size={12} />;
  if (kind === "wiki_topic") return <BookOpen size={12} />;
  return <FileText size={12} />;
}

function kindLabel(kind: string): string {
  if (kind === "smart_table") return "Smart tables";
  if (kind === "wiki_topic") return "Wiki topics";
  if (kind === "note") return "Notes";
  return kind;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
