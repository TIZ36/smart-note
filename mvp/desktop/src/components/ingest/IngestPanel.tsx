import { useState, useEffect } from "react";
import { Play, RefreshCw, ClipboardPaste, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/cn";
import { ingestRawAsync, appendTextToRaw, readClipboard, pickRawFile, pickNoteFile } from "@/lib/electron";
import type { IngestStep } from "@/App";

type Props = {
  rawPath: string;
  notePath: string;
  onSetRawPath: (p: string) => void;
  onSetNotePath: (p: string) => void;
  onIngestComplete: () => void;
  ingestBusy: boolean;
  ingestSteps: IngestStep[];
  ingestResult: { message: string; type: "success" | "error" } | null;
};

type Version = {
  version: string;
  reason: string;
  created_at: string;
  chunk_count: number;
  token_usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  estimated_cost_cny?: number;
  segments?: number;
  tags?: Record<string, number>;
};

function formatElapsed(ms: number): string {
  if (ms >= 60000) return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function IngestPanel({ rawPath, notePath, onSetRawPath, onSetNotePath, onIngestComplete, ingestBusy, ingestSteps, ingestResult }: Props) {
  const [pasteMsg, setPasteMsg] = useState("");
  const [versions, setVersions] = useState<Version[]>([]);
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null);
  const [versionBusy, setVersionBusy] = useState<string | null>(null);

  useEffect(() => { loadVersions(); }, [ingestResult]);

  function loadVersions() {
    fetch("http://127.0.0.1:8787/versions")
      .then((r) => r.json())
      .then((d) => setVersions(d.versions || []))
      .catch(() => setVersions([]));
  }

  async function handleRestore(id: string) {
    if (!notePath || versionBusy) return;
    setVersionBusy(id);
    try {
      await fetch("http://127.0.0.1:8787/versions/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version_id: id, note_path: notePath }) });
      onIngestComplete();
      loadVersions();
    } catch (err) { setPasteMsg(`Restore failed: ${String(err)}`); }
    finally { setVersionBusy(null); }
  }

  async function handleDelete(id: string) {
    if (versionBusy) return;
    setVersionBusy(id);
    try { await fetch(`http://127.0.0.1:8787/versions/${encodeURIComponent(id)}`, { method: "DELETE" }); loadVersions(); }
    catch {}
    setVersionBusy(null);
  }

  async function handlePickRaw() { const p = await pickRawFile(); if (p) onSetRawPath(p); }
  async function handlePickNote() { const p = await pickNoteFile(); if (p) onSetNotePath(p); }
  async function handleIngest(reset: boolean) {
    if (!rawPath || !notePath || ingestBusy) return;
    try { await ingestRawAsync(rawPath, notePath, reset); } catch {}
  }
  async function handlePaste() {
    if (!rawPath || ingestBusy) return;
    try {
      const text = await readClipboard();
      if (!text) { setPasteMsg("Empty clipboard"); return; }
      const res = await appendTextToRaw(rawPath, text);
      setPasteMsg(res.ok ? "Pasted" : res.output);
      setTimeout(() => setPasteMsg(""), 3000);
    } catch (err) { setPasteMsg(`Failed: ${String(err)}`); }
  }

  const hasActivity = ingestSteps.length > 0 || versions.length > 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto">
        <div style={{ display: "flex", gap: 0, minHeight: "100%" }}>

          {/* ── Left column: Configuration & Actions ── */}
          <div style={{ width: 360, flexShrink: 0, padding: "40px 32px", borderRight: "1px solid var(--color-border)" }}>
            <h1 className="proto-page-title">Raw Input</h1>

            <div className="proto-form-section">
              <Field label="Raw file">
                <div className="flex gap-2">
                  <input type="text" value={rawPath} onChange={(e) => onSetRawPath(e.target.value)} placeholder="Choose raw file..." className="proto-form-input proto-form-input-mono flex-1 min-w-0" />
                  <button type="button" onClick={handlePickRaw} className="proto-btn proto-btn-secondary shrink-0">Browse</button>
                </div>
              </Field>
              <Field label="Note output">
                <div className="flex gap-2">
                  <input type="text" value={notePath} onChange={(e) => onSetNotePath(e.target.value)} placeholder="Choose note output..." className="proto-form-input proto-form-input-mono flex-1 min-w-0" />
                  <button type="button" onClick={handlePickNote} className="proto-btn proto-btn-secondary shrink-0">Browse</button>
                </div>
              </Field>
            </div>

            {/* Action buttons — stacked vertically for clarity */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 32 }}>
              <button type="button" onClick={() => handleIngest(false)} disabled={ingestBusy || !rawPath || !notePath} className="proto-btn proto-btn-primary disabled:opacity-30" style={{ justifyContent: "center" }}>
                {ingestBusy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                Ingest new content
              </button>
              <div className="proto-btn-group">
                <button type="button" onClick={() => handleIngest(true)} disabled={ingestBusy || !rawPath || !notePath} className="proto-btn proto-btn-secondary disabled:opacity-30" style={{ flex: 1, justifyContent: "center" }}>
                  <RefreshCw size={14} /> Rebuild all
                </button>
                <button type="button" onClick={handlePaste} disabled={ingestBusy || !rawPath} className="proto-btn proto-btn-secondary disabled:opacity-30" style={{ flex: 1, justifyContent: "center" }}>
                  <ClipboardPaste size={14} /> Paste to raw
                </button>
              </div>
            </div>

            <AnimatePresence>
              {pasteMsg && (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[12px] text-[var(--color-text-muted)]">
                  {pasteMsg}
                </motion.p>
              )}
            </AnimatePresence>

            {/* Result banner */}
            <AnimatePresence>
              {ingestResult && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  style={{ padding: "10px 14px", borderRadius: "var(--radius-proto)", border: "1px solid var(--color-border)", background: "var(--color-bg-surface)", fontSize: 13, lineHeight: 1.5, marginTop: 12 }}
                  className={ingestResult.type === "success" ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}
                >
                  <span style={{ marginRight: 6 }}>{ingestResult.type === "success" ? "\u2713" : "\u2717"}</span>
                  {ingestResult.message}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* ── Right column: Pipeline + Version Timeline ── */}
          <div style={{ flex: 1, minWidth: 0, padding: "40px 32px" }}>
            {!hasActivity && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 8, color: "var(--color-text-muted)" }}>
                <p style={{ fontSize: 13 }}>No activity yet.</p>
                <p style={{ fontSize: 12, opacity: 0.6 }}>Run an ingest to see the pipeline and version history.</p>
              </div>
            )}

            {/* Pipeline */}
            <AnimatePresence>
              {ingestSteps.length > 0 && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <div className="proto-pipeline" style={{ marginBottom: 32 }}>
                    <div className="proto-pipeline-header" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span>Pipeline</span>
                      {ingestBusy && <Loader2 size={12} className="animate-spin text-[var(--color-accent)] ml-auto" />}
                      {!ingestBusy && ingestResult && (
                        <span className={cn("ml-auto text-[11px] font-medium", ingestResult.type === "success" ? "text-[var(--color-success)]" : "text-[var(--color-danger)]")}>
                          {ingestResult.type === "success" ? "Done" : "Failed"}
                        </span>
                      )}
                    </div>
                    {ingestSteps.map((step) => (
                      <div
                        key={step.key}
                        className={cn(
                          "proto-pipeline-step",
                          step.status === "done" && "proto-pipeline-step-done",
                          step.status === "pending" && "proto-pipeline-step-pending",
                          step.status === "active" && "proto-pipeline-step-active"
                        )}
                      >
                        <div className="proto-pipeline-step-icon">
                          {step.status === "done" && "\u2713"}
                          {step.status === "active" && "\u25CF"}
                          {step.status === "pending" && "\u25CB"}
                          {step.status === "error" && "\u2717"}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span className={cn("text-[13px]", step.status === "active" ? "text-[var(--color-text-primary)]" : step.status === "done" ? "text-[var(--color-text-secondary)]" : "text-[var(--color-text-muted)] opacity-40")}>
                              {step.label}
                            </span>
                            {step.status === "active" && step.total > 0 && (
                              <span style={{ fontSize: 11, color: "var(--color-accent)", fontVariantNumeric: "tabular-nums" }}>
                                {step.current}/{step.total}
                              </span>
                            )}
                            {step.elapsedMs > 0 && (step.status === "active" || step.status === "done") && (
                              <span style={{ fontSize: 10, color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums", marginLeft: "auto", opacity: 0.7 }}>
                                {formatElapsed(step.elapsedMs)}
                              </span>
                            )}
                          </div>
                          {step.detail && <p className="proto-step-detail" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{step.detail}</p>}
                          {step.status === "active" && step.total > 0 && (
                            <div className="proto-progress-bar">
                              <div className="proto-progress-fill" style={{ width: `${Math.round((step.current / step.total) * 100)}%`, transition: "width 0.3s" }} />
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Version Timeline */}
            {versions.length > 0 && (
              <div>
                <h2 style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-muted)", marginBottom: 12 }}>
                  Version History
                </h2>
                {versions.map((v, i) => {
                  const isCurrent = i === 0;
                  const isLoading = versionBusy === v.version;
                  const isExpanded = expandedVersion === v.version;
                  const hasCost = v.estimated_cost_cny != null && v.estimated_cost_cny > 0;
                  return (
                    <div key={v.version}>
                      <div className="proto-version-item" style={{ cursor: "pointer" }} onClick={() => setExpandedVersion(isExpanded ? null : v.version)}>
                        <div className={cn("proto-version-dot", !isCurrent && "proto-version-dot-old")} />
                        <div className="flex-1 min-w-0">
                          <div className="proto-version-id">{v.version}</div>
                          <div className="proto-version-meta">
                            {v.reason} · {v.chunk_count} chunks
                            {hasCost && <span style={{ color: "var(--color-warning)" }}> · ¥{v.estimated_cost_cny?.toFixed(2)}</span>}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                          {isCurrent && <span className="proto-version-current">current</span>}
                          {!isCurrent && (
                            <button type="button" onClick={() => handleRestore(v.version)} disabled={versionBusy !== null || ingestBusy} className="proto-version-action">
                              {isLoading ? <Loader2 size={11} className="animate-spin" /> : "Restore"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleDelete(v.version)}
                            disabled={versionBusy !== null || ingestBusy}
                          className="proto-version-action-danger"
                        >
                          Delete
                        </button>
                      </div>
                      </div>
                      {/* Expanded detail */}
                      {isExpanded && (
                        <div style={{ padding: "8px 0 8px 20px", fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
                          {v.token_usage && (
                            <p>Tokens: {v.token_usage.prompt_tokens?.toLocaleString()} prompt + {v.token_usage.completion_tokens?.toLocaleString()} completion = {v.token_usage.total_tokens?.toLocaleString()} total</p>
                          )}
                          {hasCost && <p>Cost: ~¥{v.estimated_cost_cny?.toFixed(2)} (~${v.estimated_cost_cny ? (v.estimated_cost_cny / 7.2).toFixed(4) : "0"} USD)</p>}
                          {v.segments != null && <p>Segments: {v.segments}</p>}
                          {v.tags && Object.keys(v.tags).length > 0 && (
                            <p>Tags: {Object.entries(v.tags).map(([t, c]) => `${t}(${c})`).join(", ")}</p>
                          )}
                          <p>Created: {v.created_at}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="proto-form-field">
      <label className="proto-form-label">{label}</label>
      {children}
    </div>
  );
}
