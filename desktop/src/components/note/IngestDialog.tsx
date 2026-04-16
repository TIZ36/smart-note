import { useState, useEffect } from "react";
import { Loader2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { ingestRawAsync } from "@/lib/electron";
import * as api from "@/lib/api";
import type { IngestStep } from "@/App";
import { PipelineStep } from "../shared/PipelineStep";
import { BuildAttributionBadge } from "../shared/BuildAttributionBadge";

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

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

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
            <button type="button" onClick={() => handleIngest(false)} disabled={ingestBusy || !rawPath} className="proto-btn proto-btn-primary" style={{ flex: 1, justifyContent: "center" }}>
              {ingestBusy ? <Loader2 size={14} className="animate-spin" /> : null}
              Ingest (incremental)
            </button>
            <button type="button" onClick={() => handleIngest(true)} disabled={ingestBusy || !rawPath} className="proto-btn proto-btn-secondary" style={{ flex: 1, justifyContent: "center" }}>
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
                <PipelineStep key={step.key} step={step} />
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
              <h3 className="proto-section-label">Builds</h3>
              {builds.map((b) => (
                <div key={b.id} className="proto-version-item">
                  <div className={cn("proto-version-dot", !b.is_active && "proto-version-dot-old")} />
                  <div className="flex-1 min-w-0">
                    <div className="proto-version-id">
                      {b.id}
                      <BuildAttributionBadge enrichStatus={b.enrich_status} completedBy={b.completed_by} awaitingForSeconds={b.awaiting_for_seconds} />
                    </div>
                    <div className="proto-version-meta">
                      {b.chunk_count} chunks · {b.segment_count} seg
                      {b.estimated_cost_cny > 0 && <span className="proto-version-cost"> · ¥{b.estimated_cost_cny.toFixed(2)}</span>}
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
