import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Shuffle, Check, Loader2, AlertTriangle } from "lucide-react";
import * as api from "@/lib/api";

type Props = {
  rawPath: string;
  notePath: string;
  open: boolean;
  onClose: () => void;
  onApproved: () => void;
};

/**
 * Reorganize by tag — show the user a before/after diff of the raw file
 * grouped into per-tag sections, then commit on approval (snapshot + write
 * + full reset ingest). Destructive, irreversible except via snapshot.
 *
 * Design principles honored:
 *   - P0-1 raw.md is truth → we snapshot first, then rewrite
 *   - P0-2 reversible → the snapshot restores if the user regrets it
 *   - P0-5 capture speed doesn't apply (this is an intentional rewrite)
 *   - P1-5 explainable → diff preview, warning when line accounting disagrees
 */
export function ReorganizeDialog({ rawPath, notePath, open, onClose, onApproved }: Props) {
  const [preview, setPreview] = useState<api.ReorganizePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setPreview(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.previewReorganize(rawPath)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, rawPath]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function handleApprove() {
    if (!preview || approving) return;
    setApproving(true);
    setError(null);
    try {
      await api.approveReorganize(rawPath, preview.candidate, notePath);
      onApproved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setApproving(false);
    }
  }

  // Inline split-view diff — each tag section + original side-by-side.
  // Lightweight: we don't try to compute a true LCS diff; we show the raw
  // "before" vs "after" so the user can read both. Consistent with other
  // preview dialogs in the app (rewrite candidates) — text + scroll.

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="proto-reorg-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
          onMouseDown={(e) => { if (e.target === e.currentTarget && !approving) onClose(); }}
        >
          <motion.div
            className="proto-reorg-dialog"
            role="dialog"
            aria-label="Reorganize note by tag"
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
          >
            <header className="proto-reorg-header">
              <div className="proto-reorg-title">
                <Shuffle size={14} strokeWidth={2} />
                <span>Reorganize by tag</span>
              </div>
              <button
                type="button"
                className="proto-reorg-close"
                onClick={onClose}
                disabled={approving}
                aria-label="Close"
              >
                <X size={13} strokeWidth={2} />
              </button>
            </header>

            <div className="proto-reorg-why">
              <p>
                Rewrites <code className="proto-code">{rawPath.split("/").pop()}</code> so
                content is grouped under per-tag sections
                (<code className="proto-code">## work</code>, <code className="proto-code">## learn</code>, …).
                Original line content is preserved — only order changes.
              </p>
              <p className="proto-reorg-why-note">
                <strong>This is destructive.</strong> On approval the app
                takes a snapshot (restorable from Versions), overwrites
                your raw file, and runs a full re-ingest. All current
                chunks / tag segments are regenerated.
              </p>
            </div>

            {loading && (
              <div className="proto-reorg-loading">
                <Loader2 size={14} className="animate-spin" />
                <span>Building candidate…</span>
              </div>
            )}

            {error && (
              <div className="proto-reorg-error">
                <AlertTriangle size={13} />
                <span>{error}</span>
              </div>
            )}

            {preview && (
              <>
                <Summary preview={preview} />
                {preview.warning && (
                  <div className="proto-reorg-warning">
                    <AlertTriangle size={13} />
                    <span>{preview.warning}</span>
                  </div>
                )}
                <DiffPane before={preview.before} after={preview.candidate} />
              </>
            )}

            <footer className="proto-reorg-footer">
              <button
                type="button"
                className="proto-btn proto-btn-ghost"
                onClick={onClose}
                disabled={approving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="proto-btn proto-btn-primary"
                onClick={handleApprove}
                disabled={!preview || approving || loading}
                title="Snapshot, overwrite raw.md, then run a full re-ingest"
              >
                {approving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2} />}
                <span>{approving ? "Rebuilding…" : "Approve & rebuild"}</span>
              </button>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Summary({ preview }: { preview: api.ReorganizePreview }) {
  return (
    <div className="proto-reorg-summary">
      <div className="proto-reorg-summary-row">
        <span className="proto-reorg-summary-label">Lines</span>
        <span className="proto-reorg-summary-value">
          {preview.line_count_before} → {preview.line_count_after}
        </span>
      </div>
      <div className="proto-reorg-summary-row">
        <span className="proto-reorg-summary-label">Tags</span>
        <span className="proto-reorg-summary-value">
          {preview.tags_used.length > 0
            ? preview.tags_used.join(" · ")
            : <em>none</em>}
        </span>
      </div>
      {preview.unclassified_lines > 0 && (
        <div className="proto-reorg-summary-row">
          <span className="proto-reorg-summary-label">Unclassified</span>
          <span className="proto-reorg-summary-value">
            {preview.unclassified_lines} lines → <code className="proto-code">## unclassified</code>
          </span>
        </div>
      )}
    </div>
  );
}

function DiffPane({ before, after }: { before: string; after: string }) {
  // Two scrollable columns side by side. Prefixing each line with its
  // number matches the editor's gutter so the user can orient.
  const beforeLines = useMemo(() => before.split("\n"), [before]);
  const afterLines = useMemo(() => after.split("\n"), [after]);

  return (
    <div className="proto-reorg-diff">
      <div className="proto-reorg-pane">
        <div className="proto-reorg-pane-head">Before</div>
        <pre className="proto-reorg-pane-body">
          {beforeLines.map((l, i) => (
            <div key={i} className="proto-reorg-line">
              <span className="proto-reorg-line-no">{i + 1}</span>
              <span className="proto-reorg-line-text">{l || "\u00A0"}</span>
            </div>
          ))}
        </pre>
      </div>
      <div className="proto-reorg-pane">
        <div className="proto-reorg-pane-head">After</div>
        <pre className="proto-reorg-pane-body">
          {afterLines.map((l, i) => {
            const isHeading = l.startsWith("## ");
            return (
              <div key={i} className={`proto-reorg-line ${isHeading ? "proto-reorg-line-heading" : ""}`}>
                <span className="proto-reorg-line-no">{i + 1}</span>
                <span className="proto-reorg-line-text">{l || "\u00A0"}</span>
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}
