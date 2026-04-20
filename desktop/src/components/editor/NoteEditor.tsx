import { useEffect, useRef, useState, useCallback } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, Decoration, WidgetType, gutter, GutterMarker, type DecorationSet } from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSetBuilder, RangeSet } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { readFileFull } from "@/lib/electron";

type LineRange = { start: number; end: number };

/** Per-line metadata rendered to the right of each line. Keyed by 1-based line number. */
export type LineMeta = Map<number, { ts?: string | null; bookmark?: string; highlight?: string }>;

type Props = {
  filePath: string;
  onSave: (content: string) => void;
  onDirty?: (dirty: boolean) => void;
  scrollToRange?: LineRange | null;
  lineMeta?: LineMeta;
  /** Cmd+B toggles a bookmark on the active line. Parent handles storage. */
  onToggleBookmark?: (lineNo: number, lineText: string) => void;
};

/* Right-aligned inline widget that surfaces per-line metadata — ts label
   plus an optional highlight color dot. Bookmarks live in a dedicated
   left gutter (see `bookmarkGutter` below) rather than here, so the star
   doesn't compete with the timestamp for the same sliver of space. */
class LineMetaWidget extends WidgetType {
  constructor(readonly label: string, readonly highlight?: string) { super(); }
  eq(other: LineMetaWidget) {
    return other.label === this.label && other.highlight === this.highlight;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-line-meta";
    if (this.highlight) {
      const h = document.createElement("span");
      h.className = "cm-line-meta-highlight";
      h.style.background = this.highlight;
      wrap.appendChild(h);
    }
    if (this.label) {
      const ts = document.createElement("span");
      ts.className = "cm-line-meta-ts";
      ts.textContent = this.label;
      wrap.appendChild(ts);
    }
    return wrap;
  }
  ignoreEvent() { return true; }
}

/* Bookmark marker in the left gutter — IDE "breakpoint column" convention.
   Uses the lucide Bookmark glyph (filled) at medium size. Hover reveals
   the bookmark label via tooltip. Never editable — click-to-jump lives
   in the floating panel. */
const BOOKMARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>' +
  "</svg>";

class BookmarkGutterMarker extends GutterMarker {
  constructor(readonly label: string) { super(); }
  eq(other: GutterMarker): boolean {
    return other instanceof BookmarkGutterMarker && other.label === this.label;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-bookmark-marker";
    el.innerHTML = BOOKMARK_SVG;
    el.title = this.label || "Bookmarked";
    el.setAttribute("aria-label", `Bookmarked: ${this.label || "(no label)"}`);
    return el;
  }
}

/* Invisible spacer — reserves the gutter column width even when no
   bookmarks exist, so line numbers don't jiggle left/right as the user
   toggles bookmarks. Sized identically to the real marker. */
class BookmarkSpacerMarker extends GutterMarker {
  eq(other: GutterMarker): boolean { return other instanceof BookmarkSpacerMarker; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-bookmark-spacer";
    return el;
  }
}

const setLineMetaEffect = StateEffect.define<LineMeta | null>();

/* StateField derived from the same setLineMetaEffect the right-side widget
   consumes — single source of truth, two presentations (right widget for
   ts/highlight, left gutter for bookmark). */
const bookmarkLinesField = StateField.define<Map<number, string>>({
  create: () => new Map(),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setLineMetaEffect)) {
        if (!e.value) return new Map();
        const m = new Map<number, string>();
        for (const [lineNo, meta] of e.value) {
          if (meta.bookmark) m.set(lineNo, meta.bookmark);
        }
        return m;
      }
    }
    return value;
  },
});

const bookmarkGutterExt = gutter({
  class: "cm-gutter-bookmark",
  markers(view) {
    const map = view.state.field(bookmarkLinesField);
    if (map.size === 0) return RangeSet.empty;
    const builder = new RangeSetBuilder<GutterMarker>();
    const totalLines = view.state.doc.lines;
    const sorted = Array.from(map.entries()).sort(([a], [b]) => a - b);
    for (const [lineNo, label] of sorted) {
      if (lineNo < 1 || lineNo > totalLines) continue;
      const line = view.state.doc.line(lineNo);
      builder.add(line.from, line.from, new BookmarkGutterMarker(label));
    }
    return builder.finish();
  },
  initialSpacer: () => new BookmarkSpacerMarker(),
});
const lineMetaField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    let meta: LineMeta | null | undefined;
    for (const e of tr.effects) {
      if (e.is(setLineMetaEffect)) meta = e.value;
    }
    if (meta === undefined) {
      // Not updated this tx; only re-map on doc change to keep widgets aligned.
      return tr.docChanged ? deco.map(tr.changes) : deco;
    }
    if (!meta || meta.size === 0) return Decoration.none;
    const decos = [];
    const totalLines = tr.state.doc.lines;
    for (const [lineNo, m] of meta) {
      if (lineNo < 1 || lineNo > totalLines) continue;
      const line = tr.state.doc.line(lineNo);
      const label = formatLineTs(m.ts);
      // Bookmarks render in the left gutter — the right-side widget only
      // carries ts + optional highlight dot so it stays narrow.
      if (!label && !m.highlight) continue;
      decos.push(
        Decoration.widget({
          widget: new LineMetaWidget(label, m.highlight),
          side: 1,
        }).range(line.to)
      );
    }
    return Decoration.set(decos, true);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function formatLineTs(ts?: string | null): string {
  if (!ts) return "";
  try {
    const d = new Date(ts.replace(" ", "T") + "Z");
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    if (sameDay) return `${hh}:${mm}:${ss}`;
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mo}-${dd} ${hh}:${mm}:${ss}`;
  } catch {
    return "";
  }
}

/* Highlight effect for scroll-to-range (multiple lines) */
const setHighlightRange = StateEffect.define<LineRange | null>();
const highlightRangeField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setHighlightRange)) {
        if (e.value === null) return Decoration.none;
        const { start, end } = e.value;
        const maxLine = tr.state.doc.lines;
        const from = Math.min(start, maxLine);
        const to = Math.min(end, maxLine);
        const decos = [];
        // First line gets the top-border class
        const firstLine = tr.state.doc.line(from);
        decos.push(Decoration.line({ class: "cm-highlight-range cm-highlight-range-first" }).range(firstLine.from));
        // Middle lines
        for (let i = from + 1; i < to; i++) {
          const line = tr.state.doc.line(i);
          decos.push(Decoration.line({ class: "cm-highlight-range" }).range(line.from));
        }
        // Last line gets the bottom-border class
        if (to > from) {
          const lastLine = tr.state.doc.line(to);
          decos.push(Decoration.line({ class: "cm-highlight-range cm-highlight-range-last" }).range(lastLine.from));
        }
        return Decoration.set(decos);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Dark theme matching SmartNote's design tokens */
const editorTheme = EditorView.theme({
  "&": {
    fontSize: "14px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif",
    height: "100%",
    backgroundColor: "var(--color-bg-primary)",
    color: "var(--color-text-primary)",
  },
  ".cm-content": {
    padding: "24px 0 48px",
    caretColor: "var(--color-accent)",
    lineHeight: "1.7",
  },
  ".cm-line": {
    padding: "0 32px",
  },
  ".cm-gutters": {
    backgroundColor: "var(--color-bg-primary)",
    color: "var(--color-text-muted)",
    border: "none",
    paddingRight: "12px",
    fontSize: "12px",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--color-text-secondary)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 3%, transparent)",
  },
  ".cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 12%, transparent) !important",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--color-accent)",
    borderLeftWidth: "1.5px",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklab, var(--color-warning) 20%, transparent)",
  },
  ".cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 18%, transparent) !important",
  },
  ".cm-scroller": {
    overflow: "auto",
  },
  ".cm-highlight-range": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 6%, transparent)",
    borderLeft: "2px solid var(--color-accent)",
  },
  ".cm-highlight-range-first": {
    borderTop: "1px solid color-mix(in oklab, var(--color-accent) 25%, transparent)",
  },
  ".cm-highlight-range-last": {
    borderBottom: "1px solid color-mix(in oklab, var(--color-accent) 25%, transparent)",
  },
});

export function NoteEditor({ filePath, onSave, onDirty, scrollToRange, lineMeta, onToggleBookmark }: Props) {
  const onToggleBookmarkRef = useRef(onToggleBookmark);
  onToggleBookmarkRef.current = onToggleBookmark;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const lastSavedRef = useRef("");
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSave = useCallback(() => {
    if (!viewRef.current) return;
    const content = viewRef.current.state.doc.toString();
    onSave(content);
    lastSavedRef.current = content;
    setDirty(false);
    onDirty?.(false);
  }, [onSave, onDirty]);

  // Auto-save after 2s of no edits
  const scheduleAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      if (viewRef.current) {
        const content = viewRef.current.state.doc.toString();
        if (content !== lastSavedRef.current) {
          handleSave();
        }
      }
    }, 2000);
  }, [handleSave]);

  useEffect(() => {
    if (!containerRef.current) return;

    setLoading(true);
    // Full raw file for the Note editor only; search/tag side panels use gateway line windows.
    readFileFull(filePath).then((result) => {
      const content = result.output || "";
      lastSavedRef.current = content;

      if (viewRef.current) {
        viewRef.current.destroy();
      }

      const saveKeymap = keymap.of([
        { key: "Mod-s", run: () => { handleSave(); return true; } },
        // Cmd+B (or Ctrl+B) toggles a bookmark on the line under the cursor.
        // Parent owns the storage logic; we just surface "line at cursor".
        {
          key: "Mod-b",
          run: (view) => {
            const cb = onToggleBookmarkRef.current;
            if (!cb) return false;
            const pos = view.state.selection.main.head;
            const line = view.state.doc.lineAt(pos);
            cb(line.number, line.text);
            return true;
          },
        },
        {
          key: "Mod-l",
          run: (view) => {
            const currentLine = view.state.doc.lineAt(view.state.selection.main.head).number;
            const raw = window.prompt("Go to line", String(currentLine));
            if (raw === null) return true;
            const nextLine = Number.parseInt(raw.trim(), 10);
            if (Number.isNaN(nextLine)) return true;
            const targetLine = Math.max(1, Math.min(nextLine, view.state.doc.lines));
            const line = view.state.doc.line(targetLine);
            view.dispatch({
              selection: { anchor: line.from },
              effects: [
                setHighlightRange.of({ start: targetLine, end: targetLine }),
                EditorView.scrollIntoView(line.from, { y: "center" }),
              ],
            });
            return true;
          },
        },
      ]);

      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newContent = update.state.doc.toString();
          const isDirty = newContent !== lastSavedRef.current;
          setDirty(isDirty);
          onDirty?.(isDirty);
          if (isDirty) scheduleAutoSave();
        }
      });

      const state = EditorState.create({
        doc: content,
        extensions: [
          // Order matters for gutter placement: bookmark column lives to
          // the LEFT of line numbers, mirroring IDE breakpoint gutters.
          bookmarkLinesField,
          bookmarkGutterExt,
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          highlightSelectionMatches(),
          history(),
          markdown(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          saveKeymap,
          updateListener,
          editorTheme,
          highlightRangeField,
          lineMetaField,
          EditorView.lineWrapping,
        ],
      });

      viewRef.current = new EditorView({
        state,
        parent: containerRef.current!,
      });

      // Auto-scroll to bottom — newest content is at the end
      const lastLine = state.doc.lines;
      if (lastLine > 1) {
        const line = state.doc.line(lastLine);
        viewRef.current.dispatch({
          effects: EditorView.scrollIntoView(line.from, { y: "end" }),
        });
      }

      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });

    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [filePath]); // Re-create editor when file changes

  // Auto-refresh: poll file every 5s to pick up external writes
  useEffect(() => {
    const id = setInterval(() => {
      const view = viewRef.current;
      if (!view) return;
      // Skip refresh if user has unsaved local edits
      const current = view.state.doc.toString();
      if (current !== lastSavedRef.current) return;

      readFileFull(filePath).then((result) => {
        const disk = result.output || "";
        if (disk === current) return; // no change
        lastSavedRef.current = disk;

        // Check if user is scrolled near the bottom before updating
        const scroller = view.scrollDOM;
        const wasAtBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;

        view.dispatch({
          changes: { from: 0, to: current.length, insert: disk },
        });

        // If was at bottom, stay at bottom to follow new content
        if (wasAtBottom) {
          const lastLine = view.state.doc.line(view.state.doc.lines);
          view.dispatch({
            effects: EditorView.scrollIntoView(lastLine.from, { y: "end" }),
          });
        }
      }).catch(() => {});
    }, 5000);

    return () => clearInterval(id);
  }, [filePath]);

  // Push line meta into the editor whenever the prop changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setLineMetaEffect.of(lineMeta ?? null) });
  }, [lineMeta]);

  // Scroll to a line range when requested
  useEffect(() => {
    if (!scrollToRange || !viewRef.current) return;
    const view = viewRef.current;
    const startLine = Math.min(scrollToRange.start, view.state.doc.lines);
    const line = view.state.doc.line(startLine);
    view.dispatch({
      effects: [
        setHighlightRange.of(scrollToRange),
        EditorView.scrollIntoView(line.from, { y: "center" }),
      ],
    });
    // Clear highlight after 4s
    const timer = setTimeout(() => {
      if (viewRef.current) {
        viewRef.current.dispatch({ effects: setHighlightRange.of(null) });
      }
    }, 4000);
    return () => clearTimeout(timer);
  }, [scrollToRange]);

  return (
    <div className="proto-editor-container">
      <div className="proto-editor-pane">
        {loading && (
          <div className="proto-editor-loading">
            <div className="proto-editor-loading-lines">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="proto-editor-loading-line animate-shimmer" style={{ width: `${60 + (i * 7) % 30}%`, animationDelay: `${i * 80}ms` }} />
              ))}
            </div>
          </div>
        )}
        <div ref={containerRef} className="proto-editor-cm" style={{ display: loading ? "none" : "block" }} />
      </div>
    </div>
  );
}
