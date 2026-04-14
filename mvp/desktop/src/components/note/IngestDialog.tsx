import { useState, useEffect } from "react";
import { Loader2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { ingestRawAsync } from "@/lib/electron";
import * as api from "@/lib/api";
import type { IngestStep } from "@/App";

type Props = {
  rawPath: string;
  notePath: string;
  ingestBusy: boolean;
  ingestSteps: IngestStep[];
  ingestResult: { message: string; type: "success" | "error" } | null;
  onClose: () => void;
  onIngestComplete: () => void;
};

export function IngestDialog({ rawPath, notePath, ingestBusy, ingestSteps, ingestResult, onClose, onIngestComplete }: Props) {
  const [builds, setBuilds] = useState<api.BuildInfo[]>([]);
  const [buildBusy, setBuildBusy] = useState<string | null>(null);

  useEffect(() => { loadBuilds(); }, [ingestResult]);

  function loadBuilds() {
    api.fetchBuilds().then((d) => setBuilds(d.builds || [])).catch(() => {});
  }

  async function handleIngest(reset: boolean) {
    if (!rawPath || !notePath || ingestBusy) return;
    try { await ingestRawAsync(rawPath, notePath, reset); } catch {}
  }

  async function handleActivate(id: string) {
    if (buildBusy) return;
    setBuildBusy(id);
    try { await api.activateBuild(id); onIngestComplete(); loadBuilds(); } catch {}
    setBuildBusy(null);
  }

  async function handleDelete(id: string) {
    if (buildBusy) return;
    setBuildBusy(id);
    try { await api.deleteBuild(id); loadBuilds(); onIngestComplete(); } catch {}
    setBuildBusy(null);
  }

  return (
    <div className="proto-dialog-overlay" onClick={onClose}>
      <div className="proto-dialog" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
        <div className="proto-dialog-header">
          <span>Ingest & Builds</span>
          <button type="button" onClick={onClose} className="proto-dialog-close"><X size={14} /></button>
        </div>

        <div className="proto-dialog-body">
          {/* Actions */}
          <div className="proto-btn-group" style={{ marginBottom: 20 }}>
            <button type="button" onClick={() => handleIngest(false)} disabled={ingestBusy || !rawPath} className="proto-btn proto-btn-primary disabled:opacity-30" style={{ flex: 1, justifyContent: "center" }}>
              {ingestBusy ? <Loader2 size={14} className="animate-spin" /> : null}
              Ingest (incremental)
            </button>
            <button type="button" onClick={() => handleIngest(true)} disabled={ingestBusy || !rawPath} className="proto-btn proto-btn-secondary disabled:opacity-30" style={{ flex: 1, justifyContent: "center" }}>
              Rebuild all
            </button>
          </div>

          {/* Pipeline */}
          {ingestSteps.length > 0 && (
            <div className="proto-pipeline" style={{ marginBottom: 20 }}>
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
                <div key={step.key} className={cn("proto-pipeline-step", step.status === "done" && "proto-pipeline-step-done", step.status === "pending" && "proto-pipeline-step-pending", step.status === "active" && "proto-pipeline-step-active")}>
                  <div className="proto-pipeline-step-icon">
                    {step.status === "done" && "\u2713"}
                    {step.status === "active" && "\u25CF"}
                    {step.status === "pending" && "\u25CB"}
                    {step.status === "error" && "\u2717"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className={cn("text-[13px]", step.status === "active" ? "text-[var(--color-text-primary)]" : step.status === "done" ? "text-[var(--color-text-secondary)]" : "text-[var(--color-text-muted)] opacity-40")}>
                      {step.label}
                    </span>
                    {step.status === "active" && step.total > 0 && (
                      <span style={{ fontSize: 11, color: "var(--color-accent)", marginLeft: 8 }}>{step.current}/{step.total}</span>
                    )}
                    {step.detail && <p className="proto-step-detail" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{step.detail}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Result */}
          {ingestResult && (
            <div style={{ padding: "8px 12px", borderRadius: "var(--radius-proto)", border: "1px solid var(--color-border)", fontSize: 13, marginBottom: 20 }} className={ingestResult.type === "success" ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}>
              {ingestResult.type === "success" ? "\u2713" : "\u2717"} {ingestResult.message}
            </div>
          )}

          {/* Builds */}
          {builds.length > 0 && (
            <div>
              <h3 style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-muted)", marginBottom: 8 }}>Builds</h3>
              {builds.map((b) => (
                <div key={b.id} className="proto-version-item">
                  <div className={cn("proto-version-dot", !b.is_active && "proto-version-dot-old")} />
                  <div className="flex-1 min-w-0">
                    <div className="proto-version-id">{b.id}</div>
                    <div className="proto-version-meta">
                      {b.chunk_count} chunks · {b.segment_count} seg
                      {b.estimated_cost_cny > 0 && <span style={{ color: "var(--color-warning)" }}> · ¥{b.estimated_cost_cny.toFixed(2)}</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {b.is_active ? (
                      <span className="proto-version-current">active</span>
                    ) : (
                      <button type="button" onClick={() => handleActivate(b.id)} disabled={buildBusy !== null} className="proto-version-action">Activate</button>
                    )}
                    <button type="button" onClick={() => handleDelete(b.id)} disabled={buildBusy !== null} className="proto-version-action-danger">Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
