import { useEffect } from "react";
import { X } from "lucide-react";

/* Cloud center modal (D3) — replaces v2's full-page CloudConsolePage.
 *
 * Per the v3 prototype, the modal stays lightweight: it shows
 * inventory + devices + plan, four quick actions (Upload note → wiki,
 * Trigger enrich, Run AI tag pass, Run today's digest), an auto-enrich
 * toggle, and the workspace's MCP endpoint with a copy button.
 *
 * Stub for Phase 1 — the body lands in Phase 2. The shell + scrim +
 * close affordances are wired now so the rail click actually opens
 * something coherent.
 */

type Props = {
  open: boolean;
  onClose: () => void;
};

export function CloudModal({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="proto-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        className="proto-modal"
        role="dialog"
        aria-label="Workspace"
        aria-modal="true"
      >
        <div className="proto-modal-bar">
          <div className="proto-modal-title">Workspace</div>
          <div className="proto-modal-meta">live · Phase 2 will wire content</div>
          <button
            type="button"
            className="proto-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="proto-modal-body">
          <div className="proto-modal-section">
            <div className="proto-modal-section-title">Coming in Phase 2</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
              Inventory · devices · plan · 4 quick actions (Upload note → wiki ·
              Trigger enrich · Run AI tag pass · Run today's digest) ·
              auto-enrich toggle · MCP endpoint copy.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
