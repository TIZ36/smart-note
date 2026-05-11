import { useEffect, useMemo, useRef, useState } from "react";
import { Search, CornerDownLeft, Hash, Bookmark } from "lucide-react";
import { readFileFull } from "@/lib/electron";

export type QuickSearchBookmark = { line_no: number; label: string; preview: string };

type Props = {
  rawPath: string;
  open: boolean;
  onClose: () => void;
  onJumpToLine: (line: number) => void;
  /** Current file's bookmarks. Used by the `:b` mode to list them. */
  bookmarks?: QuickSearchBookmark[];
};

type Hit = { line: number; text: string; label?: string };

const MAX_HITS = 200;

export function QuickSearch({ rawPath, open, onClose, onJumpToLine, bookmarks = [] }: Props) {
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load file content each time the palette opens so results stay fresh.
  useEffect(() => {
    if (!open || !rawPath) return;
    setQuery("");
    setCursor(0);
    readFileFull(rawPath)
      .then((r) => setLines((r.output || "").split("\n")))
      .catch(() => setLines([]));
    // Focus after mount
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, rawPath]);

  // Line-jump mode: ":123" or pure digits.
  const jumpLine = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    const m = q.match(/^:?(\d+)$/);
    if (!m) return null;
    const n = Number.parseInt(m[1], 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.min(n, Math.max(1, lines.length));
  }, [query, lines.length]);

  // Bookmark-list mode: `:b` (alone) shows every bookmark; `:b foo`
  // filters bookmarks by label / preview substring.
  const bookmarkFilter = useMemo<string | null>(() => {
    const q = query.trim();
    const m = q.match(/^:b(?:\s+(.*))?$/i);
    if (!m) return null;
    return (m[1] || "").trim().toLowerCase();
  }, [query]);

  const bookmarkHits = useMemo<Hit[]>(() => {
    if (bookmarkFilter === null) return [];
    const needle = bookmarkFilter;
    const out: Hit[] = [];
    for (const b of bookmarks) {
      const hay = `${b.label} ${b.preview}`.toLowerCase();
      if (!needle || hay.includes(needle)) {
        out.push({ line: b.line_no, text: b.preview, label: b.label });
      }
    }
    // Sort by line number ascending so the list reads top-to-bottom
    // like the note itself.
    out.sort((a, b) => a.line - b.line);
    return out;
  }, [bookmarks, bookmarkFilter]);

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim();
    if (!q || jumpLine !== null || bookmarkFilter !== null) return [];
    const needle = q.toLowerCase();
    const out: Hit[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        out.push({ line: i + 1, text: lines[i] });
        if (out.length >= MAX_HITS) break;
      }
    }
    return out;
  }, [query, lines, jumpLine, bookmarkFilter]);

  useEffect(() => { setCursor(0); }, [query]);

  // Keep active item visible.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  const activeHits = bookmarkFilter !== null ? bookmarkHits : hits;
  const total = jumpLine !== null ? 1 : activeHits.length;

  const commit = () => {
    if (jumpLine !== null) {
      onJumpToLine(jumpLine);
      onClose();
      return;
    }
    const hit = activeHits[cursor];
    if (hit) {
      onJumpToLine(hit.line);
      onClose();
    }
  };

  return (
    <div
      className="proto-quicksearch-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="proto-quicksearch" role="dialog" aria-label="Quick search">
        <div className="proto-quicksearch-input-row">
          <Search size={15} className="proto-quicksearch-icon" strokeWidth={2} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search content, or type :123 to jump to line"
            className="proto-quicksearch-input"
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
              if (e.key === "Enter") { e.preventDefault(); commit(); return; }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(total - 1, c + 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
                return;
              }
            }}
          />
          <span className="proto-quicksearch-hint">
            {jumpLine !== null
              ? "Line"
              : bookmarkFilter !== null
                ? `${bookmarkHits.length} bookmark${bookmarkHits.length === 1 ? "" : "s"}`
                : `${hits.length}${hits.length >= MAX_HITS ? "+" : ""}`}
          </span>
        </div>
        <div ref={listRef} className="proto-quicksearch-list">
          {jumpLine !== null && (
            <button
              type="button"
              data-idx={0}
              className="proto-quicksearch-item proto-quicksearch-item-active"
              onClick={commit}
            >
              <Hash size={13} className="proto-quicksearch-item-icon" strokeWidth={2} />
              <span className="proto-quicksearch-item-label">Go to line {jumpLine}</span>
              <CornerDownLeft size={12} className="proto-quicksearch-item-enter" strokeWidth={2} />
            </button>
          )}
          {jumpLine === null && bookmarkFilter === null && hits.length === 0 && query.trim() !== "" && (
            <div className="proto-quicksearch-empty">No matches</div>
          )}
          {jumpLine === null && bookmarkFilter !== null && bookmarkHits.length === 0 && (
            <div className="proto-quicksearch-empty">
              {bookmarks.length === 0
                ? "No bookmarks yet · press ⌘B on a line to add one"
                : `No bookmarks matching "${bookmarkFilter}"`}
            </div>
          )}
          {jumpLine === null && bookmarkFilter !== null && bookmarkHits.map((h, i) => (
            <button
              key={`bm-${h.line}-${i}`}
              type="button"
              data-idx={i}
              className={
                "proto-quicksearch-item proto-quicksearch-item-bookmark" +
                (i === cursor ? " proto-quicksearch-item-active" : "")
              }
              onMouseEnter={() => setCursor(i)}
              onClick={commit}
            >
              <Bookmark size={12} className="proto-quicksearch-item-icon" strokeWidth={2} />
              <span className="proto-quicksearch-item-line">{h.line}</span>
              <span className="proto-quicksearch-item-text">
                <strong>{h.label}</strong>
                {h.text && (
                  <span className="proto-quicksearch-item-sub"> · {h.text}</span>
                )}
              </span>
            </button>
          ))}
          {jumpLine === null && bookmarkFilter === null && hits.map((h, i) => (
            <button
              key={`${h.line}-${i}`}
              type="button"
              data-idx={i}
              className={
                "proto-quicksearch-item" +
                (i === cursor ? " proto-quicksearch-item-active" : "")
              }
              onMouseEnter={() => setCursor(i)}
              onClick={commit}
            >
              <span className="proto-quicksearch-item-line">{h.line}</span>
              <span className="proto-quicksearch-item-text">
                {renderHighlight(h.text, query.trim())}
              </span>
            </button>
          ))}
          {jumpLine === null && bookmarkFilter === null && hits.length === 0 && query.trim() === "" && (
            <div className="proto-quicksearch-empty">
              Type to search · <code>:N</code> jump to line · <code>:b</code> list bookmarks
            </div>
          )}
        </div>
        <div className="proto-quicksearch-footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> jump</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function renderHighlight(text: string, needle: string) {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let idx = lower.indexOf(n);
  // Trim very long lines around the first match so the preview stays readable.
  let shown = text;
  let offset = 0;
  if (idx > 80) {
    const start = Math.max(0, idx - 40);
    shown = "…" + text.slice(start);
    offset = start - 1;
    idx = idx - offset;
  }
  if (shown.length > 240) shown = shown.slice(0, 240) + "…";
  const shownLower = shown.toLowerCase();
  let cursor = 0;
  idx = shownLower.indexOf(n);
  while (idx !== -1) {
    if (idx > cursor) parts.push(shown.slice(cursor, idx));
    parts.push(<mark key={i++} className="proto-quicksearch-mark">{shown.slice(idx, idx + n.length)}</mark>);
    cursor = idx + n.length;
    idx = shownLower.indexOf(n, cursor);
  }
  if (cursor < shown.length) parts.push(shown.slice(cursor));
  return parts;
}
