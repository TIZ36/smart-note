import { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Layers, Loader2, X, Check, Trash2, FolderSync, FilePlus,
  ChevronRight, ArrowUpRight,
} from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";

type Props = {
  rawPath: string;
  pendingCount: number;
  onChanged: () => void;
  onJumpToLine: (line: number) => void;
};

/**
 * Pack badge — bottom-right of the note editor. The badge shows the
 * unsaved-work backlog ("N packs pending"); expanding reveals each pack
 * with its per-line diff so the user can jump to, apply, or discard.
 */
export function PackBadge({ rawPath, pendingCount, onChanged, onJumpToLine }: Props) {
  const [open, setOpen] = useState(false);
  const [packs, setPacks] = useState<api.IngestPack[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedPackId, setExpandedPackId] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.fetchPacks(rawPath, "pending");
      setPacks(r.packs);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [rawPath]);

  useEffect(() => {
    if (open) load();
  }, [open, load, pendingCount]);

  // ESC closes the panel; click outside closes too — standard popover.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onPointer(e: PointerEvent) {
      const wrap = wrapRef.current;
      if (wrap && !wrap.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    // pointerdown fires before click — dismisses before a nested button handler
    // would re-trigger open. Added passively; never blocks scroll.
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  async function handleDiscard(id: number) {
    setBusyId(id);
    try {
      await api.discardPack(id);
      onChanged();
      setPacks((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function handleApplyAll() {
    setBusyId("all");
    setError(null);
    try {
      await api.applyAllPacks(rawPath);
      onChanged();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  if (pendingCount === 0 && !open) return null;

  return (
    <div ref={wrapRef} className={cn("proto-pack-badge-wrap", open && "proto-pack-badge-wrap-open")}>
      <AnimatePresence>
        {open && (
          <motion.div
            key="pack-panel"
            className="proto-pack-panel"
            role="dialog"
            aria-label="Pending ingest packs"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
          >
            <div className="proto-pack-panel-head">
              <span className="proto-pack-panel-title">
                <Layers size={13} strokeWidth={2} />
                <span>Pending packs</span>
                <span className="proto-section-label-count" aria-live="polite">{pendingCount}</span>
              </span>
              <button
                type="button"
                className="proto-pack-panel-close"
                onClick={() => setOpen(false)}
                aria-label="Close panel"
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>

            <p className="proto-pack-panel-why">
              Each save (and each externally-edited reload) queues one pack.
              Remove any you don't want indexed, then Apply the rest as a
              single re-ingest.
            </p>

            {error && <p className="proto-dashboard-error">{error}</p>}

            <div className="proto-pack-panel-body">
              {loading && packs.length === 0 && (
                <div className="proto-pack-panel-loading">
                  <Loader2 size={12} className="animate-spin" />
                  <span>Loading…</span>
                </div>
              )}

              {!loading && packs.length === 0 && (
                <p className="proto-dashboard-empty">All caught up.</p>
              )}

              {packs.length > 0 && (
                <ul className="proto-pack-list">
                  {packs.map((p) => (
                    <PackItem
                      key={p.id}
                      pack={p}
                      expanded={expandedPackId === p.id}
                      onToggle={() => setExpandedPackId((id) => (id === p.id ? null : p.id))}
                      busy={busyId}
                      onDiscard={() => handleDiscard(p.id)}
                      onJumpToLine={onJumpToLine}
                    />
                  ))}
                </ul>
              )}
            </div>

            {packs.length >= 1 && (
              <div className="proto-pack-panel-footer">
                <button
                  type="button"
                  className="proto-btn proto-btn-primary"
                  disabled={busyId !== null}
                  onClick={handleApplyAll}
                  title="Re-ingest the file so search catches up with every pack kept above"
                >
                  {busyId === "all" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  <span>
                    Apply {packs.length} {packs.length === 1 ? "pack" : "packs"}
                  </span>
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <button
        type="button"
        className={cn("proto-pack-badge", pendingCount > 0 && "proto-pack-badge-active")}
        onClick={() => setOpen((v) => !v)}
        aria-label={`${pendingCount} pending ingest pack${pendingCount === 1 ? "" : "s"} — click to review`}
        aria-expanded={open}
      >
        <Layers size={14} strokeWidth={2} />
        <span className="proto-pack-badge-count">{pendingCount}</span>
      </button>
    </div>
  );
}

// ── One pack row ────────────────────────────────────────────────

function PackItem({
  pack,
  expanded,
  onToggle,
  busy,
  onDiscard,
  onJumpToLine,
}: {
  pack: api.IngestPack;
  expanded: boolean;
  onToggle: () => void;
  busy: number | "all" | null;
  onDiscard: () => void;
  onJumpToLine: (line: number) => void;
}) {
  const kindIcon = pack.kind === "external"
    ? <FolderSync size={11} strokeWidth={2} />
    : <FilePlus size={11} strokeWidth={2} />;
  const kindLabel = pack.kind === "external" ? "External change" : "You edited";
  const hasChanges = pack.changes && pack.changes.length > 0;

  return (
    <li className={cn("proto-pack-item", expanded && "proto-pack-item-expanded")}>
      <button
        type="button"
        className="proto-pack-item-head"
        onClick={onToggle}
        aria-expanded={expanded}
        disabled={!hasChanges}
      >
        <motion.span
          className="proto-pack-item-chev"
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.14, ease: [0.25, 1, 0.5, 1] }}
          aria-hidden
        >
          {hasChanges && <ChevronRight size={12} strokeWidth={2} />}
        </motion.span>
        <span className="proto-pack-item-kind">
          {kindIcon}
          <span>{kindLabel}</span>
        </span>
        <span className="proto-pack-item-stats" aria-label={`${pack.lines_added} added, ${pack.lines_removed} removed`}>
          {pack.lines_added > 0 && <span className="proto-pack-item-added">+{pack.lines_added}</span>}
          {pack.lines_removed > 0 && <span className="proto-pack-item-removed">−{pack.lines_removed}</span>}
        </span>
        <span className="proto-pack-item-time" title={formatAbsolute(pack.created_at)}>
          {formatRelative(pack.created_at)}
        </span>
      </button>

      {pack.note && (
        <p className="proto-pack-item-note" title={pack.note}>
          {pack.note}
        </p>
      )}

      <AnimatePresence initial={false}>
        {expanded && hasChanges && (
          <motion.ul
            key="changes"
            className="proto-pack-changes"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
            style={{ overflow: "hidden" }}
          >
            {pack.changes.slice(0, 8).map((c, i) => (
              <ChangeRow key={i} change={c} onJump={() => onJumpToLine(c.line)} />
            ))}
            {pack.changes.length > 8 && (
              <li className="proto-pack-change-more">
                + {pack.changes.length - 8} more
              </li>
            )}
          </motion.ul>
        )}
      </AnimatePresence>

      <div className="proto-pack-item-actions">
        <button
          type="button"
          className="proto-btn proto-btn-ghost proto-btn-xs"
          disabled={busy !== null}
          onClick={onDiscard}
          title="Drop this change from the queue. The file content is untouched — only the pending-ingest entry is removed."
        >
          {busy === pack.id ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} strokeWidth={2} />}
          <span>Remove</span>
        </button>
      </div>
    </li>
  );
}

// ── One change row — whole row click-to-jump ────────────────────

function ChangeRow({ change, onJump }: { change: api.PackChange; onJump: () => void }) {
  const isRange = change.range[1] >= change.range[0] && change.range[1] !== change.range[0];
  const rangeLabel = isRange ? `L${change.range[0]}–${change.range[1]}` : `L${change.line}`;
  const opGlyph =
    change.op === "insert" ? "+" :
    change.op === "delete" ? "−" :
    "~";
  const opLabel =
    change.op === "insert" ? "added" :
    change.op === "delete" ? "removed" :
    "changed";
  const sign = change.chars > 0 ? "+" : "";
  const preview = change.preview || (change.op === "delete" ? "(removed)" : "");
  const fullPreviewTitle = `${opLabel} at ${rangeLabel}\n${preview}`;

  const ref = useRef<HTMLButtonElement>(null);
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onJump();
    }
  }

  return (
    <li className={cn("proto-pack-change-row", `proto-pack-change-row--${change.op}`)}>
      <button
        ref={ref}
        type="button"
        className="proto-pack-change-body"
        onClick={onJump}
        onKeyDown={onKey}
        title={fullPreviewTitle}
      >
        <span className={`proto-pack-change-op proto-pack-change-op--${change.op}`} aria-label={opLabel}>
          {opGlyph}
        </span>
        <span className="proto-pack-change-line">{rangeLabel}</span>
        <span className="proto-pack-change-chars" title={`+${change.chars_added} / −${change.chars_removed} chars`}>
          {sign}{change.chars} chars
        </span>
        <span className="proto-pack-change-preview">
          {preview}
        </span>
        <ArrowUpRight size={11} strokeWidth={2} className="proto-pack-change-jump-icon" aria-hidden />
      </button>
    </li>
  );
}

function parseUtc(iso: string): Date | null {
  try {
    const d = new Date(iso.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function formatRelative(iso: string): string {
  const d = parseUtc(iso);
  if (!d) return iso;
  const now = new Date();
  const diff = Math.max(0, now.getTime() - d.getTime());
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  // Yesterday (if the day number differs by exactly 1)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thatDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((today.getTime() - thatDay.getTime()) / 86_400_000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (dayDiff === 1) return `yesterday ${hh}:${mm}`;
  if (dayDiff < 7) {
    const wk = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
    return `${wk} ${hh}:${mm}`;
  }
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${mo} ${d.getDate()} ${hh}:${mm}`;
}

function formatAbsolute(iso: string): string {
  const d = parseUtc(iso);
  if (!d) return iso;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${dd} ${hh}:${mm}:${ss}`;
}
