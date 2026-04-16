import { useState, useEffect } from "react";
import { Play, RefreshCw, ClipboardPaste, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/cn";
import { ingestRawAsync, appendTextToRaw, readClipboard, pickRawFile, pickNoteFile } from "@/lib/electron";
import * as api from "@/lib/api";
import type { IngestStep } from "@/App";
import { PipelineStep } from "../shared/PipelineStep";
import { BuildAttributionBadge } from "../shared/BuildAttributionBadge";

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

export function IngestPanel({ rawPath, notePath, onSetRawPath, onSetNotePath, onIngestComplete, ingestBusy, ingestSteps, ingestResult }: Props) {
  const [pasteMsg, setPasteMsg] = useState("");
  const [builds, setBuilds] = useState<api.BuildInfo[]>([]);
  const [expandedBuild, setExpandedBuild] = useState<string | null>(null);
  const [buildBusy, setBuildBusy] = useState<string | null>(null);

  useEffect(() => { loadBuilds(); }, [ingestResult]);

  function loadBuilds() {
    api.fetchBuilds()
      .then((d) => setBuilds(d.builds || []))
      .catch(() => setBuilds([]));
  }

  async function handleActivate(id: string) {
    if (buildBusy) return;
    setBuildBusy(id);
    try {
      await api.activateBuild(id);
      onIngestComplete();  // Refresh tags in sidebar
      loadBuilds();
    } catch {}
    setBuildBusy(null);
  }

  async function handleDeleteBuild(id: string) {
    if (buildBusy) return;
    setBuildBusy(id);
    try {
      await api.deleteBuild(id);
      loadBuilds();
      onIngestComplete();
    } catch {}
    setBuildBusy(null);
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

  const hasActivity = ingestSteps.length > 0 || builds.length > 0;

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
              <button type="button" onClick={() => handleIngest(false)} disabled={ingestBusy || !rawPath || !notePath} className="proto-btn proto-btn-primary" style={{ justifyContent: "center" }}>
                {ingestBusy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                Ingest new content
              </button>
              <div className="proto-btn-group">
                <button type="button" onClick={() => handleIngest(true)} disabled={ingestBusy || !rawPath || !notePath} className="proto-btn proto-btn-secondary" style={{ flex: 1, justifyContent: "center" }}>
                  <RefreshCw size={14} /> Rebuild all
                </button>
                <button type="button" onClick={handlePaste} disabled={ingestBusy || !rawPath} className="proto-btn proto-btn-secondary" style={{ flex: 1, justifyContent: "center" }}>
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
                      <PipelineStep key={step.key} step={step} showElapsed showProgressBar />
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Builds Timeline */}
            {builds.length > 0 && (
              <div>
                <h2 className="proto-section-label" style={{ marginBottom: 12 }}>Builds</h2>
                {builds.map((b) => {
                  const isLoading = buildBusy === b.id;
                  const isExpanded = expandedBuild === b.id;
                  const hasCost = b.estimated_cost_cny > 0;
                  return (
                    <div key={b.id}>
                      <div className="proto-version-item" style={{ cursor: "pointer" }} onClick={() => setExpandedBuild(isExpanded ? null : b.id)}>
                        <div className={cn("proto-version-dot", !b.is_active && "proto-version-dot-old")} />
                        <div className="flex-1 min-w-0">
                          <div className="proto-version-id">
                            {b.id}
                            <BuildAttributionBadge enrichStatus={b.enrich_status} completedBy={b.completed_by} awaitingForSeconds={b.awaiting_for_seconds} />
                          </div>
                          <div className="proto-version-meta">
                            {b.chunk_count} chunks · {b.segment_count} segments
                            {hasCost && <span className="proto-version-cost"> · ¥{b.estimated_cost_cny.toFixed(2)}</span>}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                          {b.is_active ? (
                            <span className="proto-version-current">active</span>
                          ) : (
                            <button type="button" onClick={() => handleActivate(b.id)} disabled={buildBusy !== null || ingestBusy} className="proto-version-action">
                              {isLoading ? <Loader2 size={11} className="animate-spin" /> : "Activate"}
                            </button>
                          )}
                          <button type="button" onClick={() => handleDeleteBuild(b.id)} disabled={buildBusy !== null || ingestBusy} className="proto-version-action-danger">
                            Delete
                          </button>
                        </div>
                      </div>
                      {isExpanded && (
                        <div style={{ padding: "8px 0 8px 20px", fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
                          {b.token_usage?.total_tokens != null && (
                            <p>Tokens: {b.token_usage.prompt_tokens?.toLocaleString()} prompt + {b.token_usage.completion_tokens?.toLocaleString()} completion = {b.token_usage.total_tokens?.toLocaleString()} total</p>
                          )}
                          {hasCost && <p>Cost: ~¥{b.estimated_cost_cny.toFixed(2)} (~${(b.estimated_cost_cny / 7.2).toFixed(4)} USD)</p>}
                          <p>Segments: {b.segment_count}</p>
                          {Object.keys(b.tags).length > 0 && (
                            <p>Tags: {Object.entries(b.tags).sort(([,a],[,b]) => b - a).map(([t, c]) => `${t}(${c})`).join(", ")}</p>
                          )}
                          <p>Created: {b.created_at}</p>
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
