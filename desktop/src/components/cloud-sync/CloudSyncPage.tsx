import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2, AlertTriangle, Loader2, Save, Upload, Download, RefreshCw,
  X, CloudOff, FileText, BookOpen, Table, Sparkles, Copy, Ban, Layers,
  Play, Power, Hammer,
} from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";
import * as api from "@/lib/api";
import type { AppSettings } from "@/lib/types";
import {
  readSettings, writeSettings,
  fetchCloudStackStatus, startCloudStack, stopCloudStack,
  STACK_IPC_UNAVAILABLE, type CloudStackService,
} from "@/lib/electron";
import { CloudIconAnimated } from "./CloudIconAnimated";
import { AgentInstallerCard } from "./AgentInstallerCard";
import { DraftInbox } from "./DraftInbox";
import {
  useCloudSyncUpload, startUpload, cancelUpload, progressOf,
  type UploadPhase,
} from "./upload-state";
import { claimDevice } from "@/lib/cloud-api";

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

  // Cloud stack lifecycle (docker compose) — separate from the API
  // reachability test. `stackServices` tells us what containers exist
  // and whether they're up; when all are down/missing we surface a
  // one-click "Start stack" banner instead of a useless test-fail.
  const [stackServices, setStackServices] = useState<CloudStackService[] | null>(null);
  const [stackBusy, setStackBusy] = useState<"start" | "stop" | "rebuild" | null>(null);
  const [stackError, setStackError] = useState("");
  // When the running Electron main process predates the stack IPC, we
  // want to hide stack controls entirely (not error-spam the page).
  const [stackIpcUnavailable, setStackIpcUnavailable] = useState(false);

  // ── Load / refresh ─────────────────────────────────────────

  const refreshStack = useCallback(async () => {
    try {
      const r = await fetchCloudStackStatus();
      if (!r.ok && r.error === STACK_IPC_UNAVAILABLE) {
        // Main-process predates the handlers. Hide stack controls
        // rather than spamming the page with a technical error.
        setStackIpcUnavailable(true);
        setStackServices(null);
        return;
      }
      setStackIpcUnavailable(false);
      setStackServices(r.ok ? r.services : []);
      setStackError(r.ok ? "" : (r.error || ""));
    } catch (e) {
      setStackServices([]);
      setStackError(String(e));
    }
  }, []);

  const refresh = useCallback(async () => {
    void refreshStack();
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

  async function handleStackStart(rebuild = false) {
    if (stackBusy) return;
    setStackBusy(rebuild ? "rebuild" : "start");
    setStackError("");
    try {
      const r = await startCloudStack({ rebuild });
      if (!r.ok) setStackError(r.error || "start failed");
      // Poll for health so the banner dismisses automatically once
      // the API responds, without the user clicking Refresh.
      const started = Date.now();
      while (Date.now() - started < 120_000) {
        await new Promise((res) => setTimeout(res, 1500));
        try {
          const tr = await api.testCloudSync({ url, api_key: apiKey });
          if (tr.ok) break;
        } catch { /* keep polling */ }
      }
      await refreshStack();
      await refresh();
    } finally {
      setStackBusy(null);
    }
  }

  async function handleStackStop() {
    if (stackBusy) return;
    setStackBusy("stop");
    setStackError("");
    try {
      const r = await stopCloudStack();
      if (!r.ok) setStackError(r.error || "stop failed");
      await refreshStack();
    } finally {
      setStackBusy(null);
    }
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

  // Force-pull: blow away local with cloud. Shows a preview first so
  // the user can see exactly what will be overwritten before they
  // commit. Conflicting (locally-modified) items are flagged.
  const [forcePreview, setForcePreview] = useState<api.SyncPullPreview | null>(null);
  const [forceLoading, setForceLoading] = useState(false);
  const [forceConfirming, setForceConfirming] = useState(false);

  async function openForcePullDialog() {
    setForceLoading(true);
    setPullError("");
    try {
      setForcePreview(await api.fetchSyncPullPreview());
    } catch (e) {
      setPullError(String(e));
    } finally {
      setForceLoading(false);
    }
  }

  async function confirmForcePull() {
    setForceConfirming(true);
    setPullError("");
    try {
      await api.triggerSyncPull({ force: true });
      setForcePreview(null);
      await refresh();
    } catch (e) {
      setPullError(String(e));
    } finally {
      setForceConfirming(false);
    }
  }

  // Cloud dedupe: collapse duplicate cloud docs (same kind + same
  // identifying field) into one. Recovery from older sync code that
  // POSTed a fresh doc when sync_state was missing.
  const [dedupeBusy, setDedupeBusy] = useState(false);
  const [dedupeResult, setDedupeResult] = useState<api.DedupeSummary | null>(null);
  async function runDedupe() {
    if (dedupeBusy) return;
    setDedupeBusy(true);
    setPullError("");
    try {
      setDedupeResult(await api.dedupeCloudDocs());
      await refresh();
    } catch (e) {
      setPullError(String(e));
    } finally {
      setDedupeBusy(false);
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

          {/* Stack-down banner — only when IPC is available + we've
              actually seen the services list. */}
          {!stackIpcUnavailable && stackServices !== null && (() => {
            const runningCount = stackServices.filter((s) => s.state === "running").length;
            const total = stackServices.length;
            const allDown = total === 0 || runningCount === 0;
            const partial = runningCount > 0 && runningCount < total;
            if (!allDown && !partial) return null;
            return (
              <div className={cn(
                "proto-cloud-stack-banner",
                allDown ? "proto-cloud-stack-banner-down" : "proto-cloud-stack-banner-partial",
              )}>
                <div className="proto-cloud-stack-banner-body">
                  <Power size={14} />
                  <div>
                    <div className="proto-cloud-stack-banner-title">
                      {allDown
                        ? (total === 0 ? "Cloud stack not running" : "Cloud stack is stopped")
                        : `Cloud stack only partially up (${runningCount}/${total})`}
                    </div>
                    <div className="proto-cloud-stack-banner-desc">
                      {total === 0
                        ? "No containers found. First launch will build the images (~2 min for the embedding model)."
                        : "Docker containers exist but aren't running. Click Start to bring them back up."}
                    </div>
                  </div>
                </div>
                <div className="proto-cloud-stack-banner-actions">
                  <button
                    type="button"
                    className="proto-btn proto-btn-primary"
                    onClick={() => handleStackStart(false)}
                    disabled={!!stackBusy}
                  >
                    {stackBusy === "start" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                    {stackBusy === "start" ? "Starting…" : "Start stack"}
                  </button>
                  {total > 0 && (
                    <button
                      type="button"
                      className="proto-btn"
                      onClick={() => handleStackStart(true)}
                      disabled={!!stackBusy}
                      title="Rebuild images from source. Slow — only use after dependency changes."
                    >
                      {stackBusy === "rebuild" ? <Loader2 size={14} className="animate-spin" /> : <Hammer size={14} />}
                      Rebuild
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
          {stackError && !stackIpcUnavailable && (
            <div className="proto-cloud-sync-note proto-cloud-sync-note-error">
              <AlertTriangle size={12} /> {stackError}
            </div>
          )}
          {stackIpcUnavailable && (
            <div className="proto-cloud-sync-note proto-cloud-sync-note-warning" style={{ marginBottom: 12 }}>
              <AlertTriangle size={12} />
              Stack controls unavailable — quit and relaunch the desktop app to
              enable the Start / Stop buttons. (Sync itself keeps working.)
            </div>
          )}

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
            {!stackIpcUnavailable && stackServices && stackServices.length > 0 && (
              <div className="proto-cloud-stack-strip">
                <span className="proto-cloud-stack-strip-title">Stack:</span>
                {stackServices.map((s) => (
                  <span
                    key={s.service}
                    className={cn(
                      "proto-cloud-stack-chip",
                      s.state === "running" && "proto-cloud-stack-chip-running",
                      s.state === "exited" && "proto-cloud-stack-chip-down",
                    )}
                    title={s.status}
                  >
                    <span className="proto-cloud-stack-chip-dot" />
                    {s.service}
                  </span>
                ))}
                {stackServices.some((s) => s.state === "running") && (
                  <button
                    type="button"
                    className="proto-cloud-stack-strip-action"
                    onClick={handleStackStop}
                    disabled={!!stackBusy}
                    title="Stop the containers. Data + volumes preserved; Start brings them back instantly."
                  >
                    {stackBusy === "stop" ? <Loader2 size={11} className="animate-spin" /> : <Power size={11} />}
                    Stop
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Pair-with-code card — for users joining an existing workspace.
              The new device has no key yet; an existing device issues a
              6-digit code (Cloud Console → Devices → Pair new device),
              this form trades it for a fresh key bound to this device. */}
          <PairWithCodeCard
            currentUrl={url}
            onPaired={async ({ baseUrl, apiKey }) => {
              const merged: AppSettings = {
                ...(settings as AppSettings),
                cloud_sync_enabled: true,
                cloud_sync_url: baseUrl,
                cloud_sync_api_key: apiKey,
              };
              await writeSettings(merged);
              setSettings(merged);
              setPersisted({ url: baseUrl, key: apiKey, enabled: true });
            }}
          />

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

          {/* One-click MCP installer — most users bounce at "edit this
              JSON file" step. Placing this right after Connection so
              the aha happens within seconds of saving credentials. */}
          {hasConfig && <AgentInstallerCard url={url} apiKey={apiKey} />}

          {/* Draft inbox — pending proposals from agents. */}
          {hasConfig && <DraftInbox hasConfig={hasConfig} />}

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
                    className="proto-btn"
                    onClick={openForcePullDialog}
                    disabled={pulling || forceLoading || forceConfirming}
                    title="Pull every cloud doc and overwrite local. Use for disaster recovery."
                  >
                    {forceLoading ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
                    Force pull from cloud
                  </button>
                  <button
                    type="button"
                    className="proto-btn"
                    onClick={runDedupe}
                    disabled={pulling || forceLoading || dedupeBusy}
                    title="Find duplicate cloud documents and keep only the newest of each."
                  >
                    {dedupeBusy ? <Loader2 size={14} className="animate-spin" /> : <Layers size={14} />}
                    Dedupe cloud
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
              {dedupeResult && (
                <div className="proto-cloud-sync-note">
                  <CheckCircle2 size={12} />
                  Dedupe: {Object.entries(dedupeResult)
                    .map(([k, v]) => `${k} ${v.kept}↑${v.deleted}↓`)
                    .join(" · ")}
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

      {forcePreview && (
        <ForcePullDialog
          preview={forcePreview}
          onConfirm={confirmForcePull}
          onCancel={() => setForcePreview(null)}
          confirming={forceConfirming}
        />
      )}
    </div>
  );
}

function ForcePullDialog({ preview, onConfirm, onCancel, confirming }: {
  preview: api.SyncPullPreview;
  onConfirm: () => void;
  onCancel: () => void;
  confirming: boolean;
}) {
  const c = preview.counts;
  const willOverwrite = (c["would-overwrite-clean"] || 0) + (c["would-overwrite-conflict"] || 0);
  const conflicts = c["would-overwrite-conflict"] || 0;
  const newItems = c["new"] || 0;
  const inSync = c["in-sync"] || 0;
  const totalAffected = willOverwrite + newItems;

  // Top-N preview: prioritize conflicts, then clean overwrites, then new.
  const priority = (a: api.SyncPullPreviewRow["action"]) => ({
    "would-overwrite-conflict": 0,
    "would-overwrite-clean": 1,
    "new": 2,
    "skip": 3, "in-sync": 4, "error": 5,
  }[a] ?? 9);
  const sorted = [...preview.rows]
    .filter(r => r.action !== "in-sync")
    .sort((a, b) => priority(a.action) - priority(b.action));
  const sample = sorted.slice(0, 30);

  return (
    <div className="proto-force-pull-overlay">
      <div className="proto-force-pull-dialog">
        <header className="proto-force-pull-header">
          <AlertTriangle size={18} />
          <h2>Force pull from cloud</h2>
          <button type="button" className="proto-force-pull-close" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="proto-force-pull-summary">
          <SummaryStat n={totalAffected} label="will change" tone="warn" />
          <SummaryStat n={newItems} label="new (no local)" tone="ok" />
          <SummaryStat n={c["would-overwrite-clean"] || 0} label="clean overwrite" tone="ok" />
          <SummaryStat n={conflicts} label="conflicts (local diverged)" tone="err" />
          <SummaryStat n={inSync} label="already in sync" tone="muted" />
        </div>

        {conflicts > 0 && (
          <div className="proto-force-pull-warn">
            <AlertTriangle size={12} />
            {conflicts} item{conflicts === 1 ? "" : "s"} have local edits that differ from cloud.
            Their current local content will be saved to <code>sync_conflicts</code> before overwrite.
          </div>
        )}

        <div className="proto-force-pull-list">
          {sample.length === 0 ? (
            <div className="proto-force-pull-empty">Nothing to pull — everything is already in sync.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Action</th><th>Kind</th><th>Item</th><th>Size</th></tr>
              </thead>
              <tbody>
                {sample.map((r, i) => (
                  <tr key={(r.cloud_doc_id || r.local_id || i) + "/" + r.action}>
                    <td><ActionChip action={r.action} /></td>
                    <td className="proto-force-pull-kind">{r.kind || "—"}</td>
                    <td className="proto-force-pull-name">{r.name || r.local_id || "(unnamed)"}</td>
                    <td className="proto-force-pull-size">
                      {r.action === "would-overwrite-conflict" || r.action === "would-overwrite-clean"
                        ? `${formatBytes(r.local_size)} → ${formatBytes(r.remote_size)}`
                        : r.action === "new"
                          ? formatBytes(r.remote_size)
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {sorted.length > sample.length && (
            <div className="proto-force-pull-truncated">
              + {sorted.length - sample.length} more not shown
            </div>
          )}
        </div>

        <footer className="proto-force-pull-footer">
          <button className="proto-btn" onClick={onCancel} disabled={confirming}>
            Cancel
          </button>
          <button
            className="proto-btn proto-btn-primary"
            onClick={onConfirm}
            disabled={confirming || totalAffected === 0}
            data-tone="danger"
          >
            {confirming
              ? <><Loader2 size={14} className="animate-spin" /> Overwriting…</>
              : totalAffected === 0
                ? "Nothing to do"
                : `Overwrite ${totalAffected} local item${totalAffected === 1 ? "" : "s"}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

function SummaryStat({ n, label, tone }: { n: number; label: string; tone: "ok" | "warn" | "err" | "muted" }) {
  return (
    <div className={"proto-force-pull-stat proto-force-pull-stat-" + tone}>
      <div className="proto-force-pull-stat-n">{n}</div>
      <div className="proto-force-pull-stat-label">{label}</div>
    </div>
  );
}

function ActionChip({ action }: { action: api.SyncPullPreviewRow["action"] }) {
  const map: Record<api.SyncPullPreviewRow["action"], { label: string; tone: string }> = {
    "new":                       { label: "new",        tone: "ok" },
    "would-overwrite-clean":     { label: "overwrite",  tone: "warn" },
    "would-overwrite-conflict":  { label: "conflict",   tone: "err" },
    "in-sync":                   { label: "in sync",    tone: "muted" },
    "skip":                      { label: "skip",       tone: "muted" },
    "error":                     { label: "error",      tone: "err" },
  };
  const { label, tone } = map[action];
  return <span className={"proto-force-pull-chip proto-force-pull-chip-" + tone}>{label}</span>;
}

function formatBytes(n?: number): string {
  if (n === undefined || n === null) return "—";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// ── sub-components ──────────────────────────────────────────────

function PairWithCodeCard({
  currentUrl,
  onPaired,
}: {
  currentUrl: string;
  onPaired: (r: { baseUrl: string; apiKey: string }) => void | Promise<void>;
}) {
  // Defaults: reuse the URL the user already typed in the credentials
  // card if any, otherwise the dev port. Saves a paste step.
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState(currentUrl || "http://localhost:58000");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // Pre-populate the device name with something recognizable. We ask
  // the main process indirectly via window.navigator since we want to
  // avoid yet another IPC just for hostname.
  useEffect(() => {
    if (!name) {
      const guess = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
        || navigator.platform
        || "this device";
      setName(guess);
    }
  }, [name]);

  // Keep the URL field in sync with the credentials card when the user
  // hasn't manually edited the pair URL — small UX nicety.
  useEffect(() => {
    if (currentUrl) setBaseUrl(currentUrl);
  }, [currentUrl]);

  async function submit() {
    setErr(null); setOkMsg(null); setBusy(true);
    try {
      const cleanCode = code.replace(/\s/g, "");
      if (!/^\d{6}$/.test(cleanCode)) {
        throw new Error("Pairing code must be 6 digits");
      }
      const platform = navigator.platform || "unknown";
      const r = await claimDevice(baseUrl, cleanCode, name || "this device", platform);
      setOkMsg(`Paired as "${r.device.name}". Credentials saved.`);
      setCode("");
      await onPaired({ baseUrl, apiKey: r.api_key });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="proto-cloud-sync-card">
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
        onClick={() => setOpen((v) => !v)}
      >
        <h2 className="proto-cloud-sync-card-title" style={{ margin: 0 }}>
          Pair to an existing workspace
        </h2>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {open ? "Hide" : "I have a code"}
        </span>
      </div>
      {!open && (
        <div className="proto-form-hint" style={{ marginTop: 6 }}>
          Already running SmartNote Cloud on another device? Get a 6-digit
          code from there (Cloud Console → Devices → Pair new device) and
          paste it here — no API key needed.
        </div>
      )}
      {open && (
        <>
          <div className="proto-form-field">
            <label className="proto-form-label">Cloud API URL</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:58000"
              className="proto-form-input"
              disabled={busy}
            />
          </div>
          <div className="proto-form-field">
            <label className="proto-form-label">Pairing code</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
              maxLength={7}
              className="proto-form-input"
              style={{ letterSpacing: "0.3em", fontFamily: "var(--font-mono, monospace)" }}
              disabled={busy}
              autoFocus
            />
          </div>
          <div className="proto-form-field">
            <label className="proto-form-label">This device's name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="MacBook Pro"
              className="proto-form-input"
              disabled={busy}
            />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !code.trim() || !baseUrl.trim()}
              className={cn("proto-btn", "proto-btn-primary")}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {busy ? "Pairing…" : "Pair this device"}
            </button>
            {okMsg && (
              <span className="proto-settings-status proto-settings-status-success">✓ {okMsg}</span>
            )}
            {err && (
              <span className="proto-settings-status proto-settings-status-error">✗ {err}</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

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
