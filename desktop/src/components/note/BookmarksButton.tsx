import { useState, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bookmark, BookmarkCheck, X, ArrowUpRight, Trash2 } from "lucide-react";
import type * as api from "@/lib/api";
import { cn } from "@/lib/cn";

type Props = {
  bookmarks: api.NoteLineMeta[];
  onJumpToLine: (line: number) => void;
  onRemove: (lineHash: string) => void;
};

/**
 * Bookmarks button — sits next to the pack badge. Count badge shows how
 * many bookmarks exist in the current file. Expand to list + jump.
 *
 * Users create bookmarks via Cmd+B in the editor (handled in NotePage).
 * This component only surfaces and dismisses them.
 */
export function BookmarksButton({ bookmarks, onJumpToLine, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    function onPointer(e: PointerEvent) {
      const wrap = wrapRef.current;
      if (wrap && !wrap.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  // Always render the button so users discover the bookmark feature even
  // before creating any. The panel explains ⌘B as the create affordance.
  return (
    <div ref={wrapRef} className={cn("proto-bookmarks-wrap", open && "proto-bookmarks-wrap-open")}>
      <AnimatePresence>
        {open && (
          <motion.div
            key="bookmarks-panel"
            className="proto-bookmarks-panel"
            role="dialog"
            aria-label="Bookmarks"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
          >
            <div className="proto-bookmarks-head">
              <span className="proto-bookmarks-title">
                <BookmarkCheck size={13} strokeWidth={2} />
                <span>Bookmarks</span>
                <span className="proto-section-label-count">{bookmarks.length}</span>
              </span>
              <button
                type="button"
                className="proto-pack-panel-close"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>

            <p className="proto-bookmarks-why">
              Bookmarks anchor to line content via hash, so they survive line
              number shifts. <kbd className="proto-kbd">⌘B</kbd> on any line
              to toggle.
            </p>

            {bookmarks.length === 0 ? (
              <p className="proto-dashboard-empty">No bookmarks yet.</p>
            ) : (
              <ul className="proto-bookmarks-list">
                {bookmarks.map((b) => (
                  <li key={b.line_hash} className="proto-bookmarks-item">
                    <button
                      type="button"
                      className="proto-bookmarks-jump"
                      onClick={() => { onJumpToLine(b.line_no_last); setOpen(false); }}
                      title={`L${b.line_no_last} · ${b.line_preview || ""}`}
                    >
                      <span className="proto-bookmarks-line-no">L{b.line_no_last}</span>
                      <span className="proto-bookmarks-preview">
                        {/* Label first (user-given name, the whole point
                            of naming a bookmark); line preview only
                            shows on hover via the title above. */}
                        {b.bookmark || b.line_preview || <em>(blank)</em>}
                      </span>
                      <ArrowUpRight size={11} strokeWidth={2} className="proto-bookmarks-jump-icon" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="proto-bookmarks-remove"
                      onClick={() => onRemove(b.line_hash)}
                      aria-label="Remove bookmark"
                      title="Remove this bookmark"
                    >
                      <Trash2 size={10} strokeWidth={2} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <button
        type="button"
        className={cn("proto-bookmarks-badge", bookmarks.length > 0 && "proto-bookmarks-badge-active")}
        onClick={() => setOpen((v) => !v)}
        aria-label={`${bookmarks.length} bookmark${bookmarks.length === 1 ? "" : "s"}`}
        aria-expanded={open}
      >
        <Bookmark size={14} strokeWidth={2} />
        {bookmarks.length > 0 && (
          <span className="proto-bookmarks-badge-count">{bookmarks.length}</span>
        )}
      </button>
    </div>
  );
}
