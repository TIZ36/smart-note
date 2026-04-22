import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2, AlertTriangle, Loader2, Save, Upload, Download, RefreshCw,
  X, CloudOff, FileText, BookOpen, Table, Sparkles, Copy, Ban, Layers,
} from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";
import * as api from "@/lib/api";
import type { AppSettings } from "@/lib/types";
import { readSettings, writeSettings } from "@/lib/electron";
import { CloudIconAnimated } from "./CloudIconAnimated";
import {
  useCloudSyncUpload, startUpload, cancelUpload, progressOf,
  type UploadPhase,
} from "./upload-state";

/* Dedicated Cloud Sync page — promoted out of Settings.

   Upload state lives in `./upload-state.ts` as an app-level singleton,
   not inside this component. That's what makes the upload survive
   page navigation: tabbing over to Search mid-upload and coming back
   still shows the right progress, and the nav-icon fill stays live
   via the same subscription. */

type TestResult =
  | { ok: true; memory_count?: number }
  | { ok: false; error: string }
  | null;

export function CloudSyncPage() {
  // Form state + backend snapshot for dirty detection.
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [persisted, setPersisted] = useState<{ url: string; key: string; enabled: boolean }>({
    url: "", key: "", enabled: true,
  });
  const [loading, setLoading] = useState(true);

  const [status, setStatus] = useState<api.CloudSyncStatus | null>(null);
  const [preview, setPreview] = useState<api.CloudSyncPreview | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Upload state is shared app-wide — survives navigating away + back.
  const upload: UploadPhase = useCloudSyncUpload();
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState("");

  // ── Load / refresh ─────────────────────────────────────────

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        api.fetchCloudSyncStatus().catch(() => null),
        api.fetchCloudSyncPreview().catch(() => null),
      ]);
      setStatus(s);
      setPreview(p);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const s = await readSettings();
        setSettings(s);
        setPersisted({
          url: s.cloud_sync_url || "",
          key: s.cloud_sync_api_key || "",
          enabled: s.cloud_sync_enabled !== false,
        });
      } catch {
        setSettings({
          embedding_mode: "local", ai_features_enabled: true,
          provider_base_url: "", provider_api_key: "", provider_chat_model: "",
          embed_base_url: "", embed_api_key: "", provider_embed_model: "",
          ingest_ai_enabled: false, ingest_ai_model: "",
          cloud_sync_enabled: true, cloud_sync_url: "", cloud_sync_api_key: "",
        });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // When an upload finishes elsewhere (or completes while on this page),
  // refresh status + preview so the UI reflects the new state without a
  // manual Refresh click.
  useEffect(() => {
    if (upload.phase === "done" || upload.phase === "canceled" || upload.phase === "error") {
      void refresh();
    }
  }, [upload.phase, refresh]);

  function updateField<K extends keyof AppSettings>(field: K, value: AppSettings[K]) {
    setSettings((p) => (p ? { ...p, [field]: value } : p));
  }

  const url = settings?.cloud_sync_url || "";
  const apiKey = settings?.cloud_sync_api_key || "";
  const enabled = settings?.cloud_sync_enabled !== false;
  const hasConfig = Boolean(url && apiKey);
  const dirty = persisted.url !== url || persisted.key !== apiKey || persisted.enabled !== enabled;

  // ── Actions ────────────────────────────────────────────────

  async function handleTest() {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testCloudSync({ url, api_key: apiKey });
      setTestResult(
        r.ok
          ? { ok: true, memory_count: (r.workspace as { memory_count?: number } | undefined)?.memory_count }
          : { ok: false, error: r.error || "connection failed" },
      );
    } catch (e) {
      setTestResult({ ok: false, error: String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function handleSaveCredentials() {
    if (!settings || saving) return;
    setSaving(true);
    try {
      await writeSettings(settings);
      setPersisted({ url, key: apiKey, enabled });
      setSavedAt(Date.now());
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleUpload() {
    if (!preview) return;
    await startUpload(preview);
    // refresh is triggered by the upload-state effect above when the
    // loop finishes, so no explicit await here.
  }

  async function handlePull() {
    if (pulling) return;
    setPulling(true);
    setPullError("");
    try {
      await api.triggerSyncPull();
      await refresh();
    } catch (e) {
      setPullError(String(e));
    } finally {
      setPulling(false);
    }
  }

  if (loading) {
    return (
      <div className="proto-page-content">
        <div className="proto-settings-loading" />
      </div>
    );
  }

  const pendingCount = preview ? (preview.total_new + preview.total_changed) : 0;
  const uploadProgress = progressOf(upload);

  // Kinds already synced at least once (from status.entities), or
  // pending-first-upload (from preview.kinds). Merge for a complete view.
  const allKinds = new Set<string>([
    ...(status?.entities.map((e) => e.local_kind) || []),
    ...(preview ? Object.keys(preview.kinds) : []),
  ]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto">
        <div className="proto-page-content">
          {/* Page header with live-filled cloud icon */}
          <div className="proto-cloud-sync-page-header">
            <div className="proto-cloud-sync-page-icon-wrap">
              <CloudIconAnimated
                progress={uploadProgress}
                animating={upload.phase === "uploading"}
                size={38}
              />
            </div>
            <div>
              <h1 className="proto-page-title" style={{ margin: 0 }}>Cloud Sync</h1>
              <p className="proto-form-hint" style={{ margin: 0 }}>
                Push your notes, wiki, smart tables, and skills to a SmartNote Cloud workspace.
                Any agent with your API key — Cursor, Claude Code, another device — reads the same content.
              </p>
            </div>
          </div>

          {/* Credentials card */}
          <section className="proto-cloud-sync-card">
            <h2 className="proto-cloud-sync-card-title">Connection</h2>
            <div className="proto-form-field">
              <label className="proto-form-label">Cloud API URL</label>
              <input
                type="text"
                value={url}
                onChange={(e) => updateField("cloud_sync_url", e.target.value)}
                placeholder="http://localhost:58000"
                className="proto-form-input"
                disabled={upload.phase === "uploading"}
              />
            </div>
            <div className="proto-form-field">
              <label className="proto-form-label">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => updateField("cloud_sync_api_key", e.target.value)}
                placeholder="sn_live_..."
                className="proto-form-input"
                disabled={upload.phase === "uploading"}
              />
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || !hasConfig || upload.phase === "uploading"}
                className="proto-btn"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {testing ? "Testing…" : "Test connection"}
              </button>
              <button
                type="button"
                onClick={handleSaveCredentials}
                disabled={saving || !dirty || upload.phase === "uploading"}
                className={cn("proto-btn", dirty && "proto-btn-primary")}
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {saving ? "Saving…" : dirty ? "Save credentials" : "Saved"}
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
                    ? `✓ connected · workspace has ${testResult.memory_count ?? 0} memories`
                    : `✗ ${testResult.error}`}
                </span>
              )}
            </div>
            {dirty && hasConfig && (
              <div className="proto-form-hint" style={{ marginTop: 8, color: "var(--color-warning, #d48b00)" }}>
                <AlertTriangle size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                Unsaved credentials — Upload / Pull use the persisted values until you Save.
              </div>
            )}
          </section>

          {/* Empty-state guide if never configured */}
          {!hasConfig && (
            <section className="proto-cloud-sync-card proto-cloud-sync-guide-card">
              <h2 className="proto-cloud-sync-card-title">
                <Sparkles size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                Three steps to connect
              </h2>
              <GuideStep num={1} title="Start the cloud stack" cmd="./cloud/scripts/quickstart.sh" />
              <GuideStep num={2} title="Mint an API key" cmd="./cloud/scripts/issue_key.sh my-laptop" />
              <GuideStep num={3} title="Paste URL + key above, then Save" cmd="" />
              <div className="proto-cloud-sync-privacy">
                <CloudOff size={11} />
                <span>Nothing leaves your machine until you click <strong>Upload</strong>.</span>
              </div>
            </section>
          )}

          {/* Knowledge model — what syncs vs what doesn't */}
          {hasConfig && (
            <section className="proto-cloud-sync-card">
              <h2 className="proto-cloud-sync-card-title">
                <Layers size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                What syncs
              </h2>
              <p className="proto-form-hint" style={{ marginBottom: 8 }}>
                Only your <strong>source content</strong> uploads. Derived indexes
                (chunks, embeddings, AI tags, search history) rebuild on any
                device that re-ingests — no need to ship them around.
              </p>
              <div className="proto-cloud-sync-kind-grid">
                {allKinds.size === 0 ? (
                  <div className="proto-form-hint">No local content found yet.</div>
                ) : (
                  [...allKinds].map((kind) => (
                    <KindCard
                      key={kind}
                      kind={kind}
                      synced={status?.entities.find((e) => e.local_kind === kind)}
                      pending={preview?.kinds[kind]}
                    />
                  ))
                )}
              </div>
            </section>
          )}

          {/* Upload / Pull card */}
          {hasConfig && (
            <section className="proto-cloud-sync-card">
              <h2 className="proto-cloud-sync-card-title">Upload & Pull</h2>

              {upload.phase === "uploading" && (
                <UploadProgress state={upload} onCancel={cancelUpload} />
              )}

              {upload.phase !== "uploading" && (
                <div className="proto-cloud-sync-actions">
                  <button
                    type="button"
                    className="proto-btn proto-btn-primary"
                    onClick={handleUpload}
                    disabled={!preview || pendingCount === 0 || pulling}
                    title={pendingCount === 0 ? "Nothing to upload" : undefined}
                  >
                    <Upload size={14} />
                    {pendingCount === 0
                      ? "All in sync"
                      : `Upload ${pendingCount} change${pendingCount === 1 ? "" : "s"}`}
                  </button>
                  <button
                    type="button"
                    className="proto-btn"
                    onClick={handlePull}
                    disabled={pulling || upload.phase !== "idle" && upload.phase !== "done" && upload.phase !== "canceled"}
                  >
                    {pulling ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    {pulling ? "Pulling…" : "Pull remote changes"}
                  </button>
                  <button
                    type="button"
                    className="proto-btn proto-cloud-sync-refresh"
                    onClick={refresh}
                    title="Refresh status"
                  >
                    <RefreshCw size={13} />
                  </button>
                </div>
              )}

              {upload.phase === "canceled" && (
                <div className="proto-cloud-sync-note proto-cloud-sync-note-warning">
                  <Ban size={12} />
                  Upload canceled after {upload.completed} / {upload.total}. You can resume any time.
                </div>
              )}
              {upload.phase === "done" && upload.total > 0 && (
                <div className="proto-cloud-sync-note proto-cloud-sync-note-success">
                  <CheckCircle2 size={12} />
                  Uploaded {upload.completed} item{upload.completed === 1 ? "" : "s"}.
                </div>
              )}
              {upload.phase === "error" && (
                <div className="proto-cloud-sync-note proto-cloud-sync-note-error">
                  <AlertTriangle size={12} /> {upload.error}
                </div>
              )}
              {pullError && (
                <div className="proto-cloud-sync-note proto-cloud-sync-note-error">
                  <AlertTriangle size={12} /> {pullError}
                </div>
              )}
              {status && status.conflicts > 0 && (
                <div className="proto-cloud-sync-note proto-cloud-sync-note-warning">
                  <AlertTriangle size={12} /> {status.conflicts} conflict{status.conflicts === 1 ? "" : "s"} logged.
                  Inspect via <code className="proto-cloud-sync-code">curl .../sync/conflicts</code>.
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

// ── sub-components ──────────────────────────────────────────────

function GuideStep({ num, title, cmd }: { num: number; title: string; cmd: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    if (!cmd) return;
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1400);
    });
  }
  return (
    <div className="proto-cloud-sync-step">
      <div className="proto-cloud-sync-step-num">{num}</div>
      <div className="proto-cloud-sync-step-body">
        <div className="proto-cloud-sync-step-title">{title}</div>
        {cmd && (
          <div className="proto-cloud-sync-copyrow">
            <code className="proto-cloud-sync-cmd">{cmd}</code>
            <button type="button" className="proto-cloud-sync-copy-btn" onClick={copy} aria-label="Copy">
              {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function KindCard({ kind, synced, pending }: {
  kind: string;
  synced?: api.CloudSyncStatus["entities"][number];
  pending?: api.CloudSyncPreview["kinds"][string];
}) {
  const label = kindLabel(kind);
  const syncedCount = synced?.count ?? 0;
  const pendingCount = pending ? (pending.new + pending.changed) : 0;
  const totalLocal = pending?.count ?? syncedCount;
  const bytes = pending?.total_bytes ?? 0;
  return (
    <div className="proto-cloud-sync-kind-card">
      <div className="proto-cloud-sync-kind-card-head">
        <KindIcon kind={kind} />
        <span className="proto-cloud-sync-kind-card-label">{label}</span>
      </div>
      <div className="proto-cloud-sync-kind-card-counts">
        <span><strong>{totalLocal}</strong> local</span>
        {bytes > 0 && <span className="proto-cloud-sync-kind-card-bytes">{fmtBytes(bytes)}</span>}
      </div>
      <div className="proto-cloud-sync-kind-card-meta">
        {synced?.last_push ? `synced ${timeAgo(synced.last_push)}` : "not yet synced"}
        {pendingCount > 0 && (
          <span className="proto-cloud-sync-kind-card-pending">
            · {pendingCount} pending
          </span>
        )}
      </div>
    </div>
  );
}

function UploadProgress({ state, onCancel }: {
  state: Extract<UploadPhase, { phase: "uploading" }>;
  onCancel: () => void;
}) {
  const pct = state.total === 0 ? 0 : Math.floor((state.current / state.total) * 100);
  return (
    <div className="proto-cloud-sync-progress">
      <div className="proto-cloud-sync-progress-bar">
        <motion.div
          className="proto-cloud-sync-progress-fill"
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.25 }}
        />
      </div>
      <div className="proto-cloud-sync-progress-row">
        <span className="proto-cloud-sync-progress-count">
          {state.current} / {state.total}  ·  {pct}%
        </span>
        <span className="proto-cloud-sync-progress-name" title={state.currentName}>
          <Loader2 size={11} className="animate-spin" style={{ marginRight: 4 }} />
          {state.currentName}
        </span>
        <button type="button" className="proto-btn proto-cloud-sync-cancel" onClick={onCancel}>
          <X size={13} /> Cancel
        </button>
      </div>
    </div>
  );
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === "smart_table") return <Table size={13} />;
  if (kind === "wiki_topic") return <BookOpen size={13} />;
  if (kind === "skill") return <Sparkles size={13} />;
  return <FileText size={13} />;
}
function kindLabel(kind: string) {
  if (kind === "smart_table") return "Smart tables";
  if (kind === "wiki_topic") return "Wiki topics";
  if (kind === "skill") return "Skills";
  if (kind === "note") return "Notes";
  return kind;
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
