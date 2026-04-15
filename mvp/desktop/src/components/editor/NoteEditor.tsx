import { useEffect, useRef, useState, useCallback } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, Decoration, type DecorationSet } from "@codemirror/view";
import { EditorState, StateField, StateEffect } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { readFileFull } from "@/lib/electron";

type Props = {
  filePath: string;
  onSave: (content: string) => void;
  onDirty?: (dirty: boolean) => void;
  scrollToLine?: number | null;
};

/* Highlight effect for scroll-to-line */
const setHighlightLine = StateEffect.define<number | null>();
const highlightLineField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setHighlightLine)) {
        if (e.value === null) return Decoration.none;
        const line = tr.state.doc.line(Math.min(e.value, tr.state.doc.lines));
        return Decoration.set([
          Decoration.line({ class: "cm-highlight-target" }).range(line.from),
        ]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Dark theme matching IntelliNote's design tokens */
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
    maxWidth: "720px",
    margin: "0 auto",
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
  ".cm-highlight-target": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 10%, transparent)",
  },
});

export function NoteEditor({ filePath, onSave, onDirty, scrollToLine }: Props) {
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

      const saveKeymap = keymap.of([{
        key: "Mod-s",
        run: () => { handleSave(); return true; },
      }]);

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
          highlightLineField,
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

  // Scroll to a specific line when requested
  useEffect(() => {
    if (!scrollToLine || !viewRef.current) return;
    const view = viewRef.current;
    const lineNum = Math.min(scrollToLine, view.state.doc.lines);
    const line = view.state.doc.line(lineNum);
    view.dispatch({
      effects: [setHighlightLine.of(lineNum), EditorView.scrollIntoView(line.from, { y: "center" })],
    });
    // Clear highlight after 3s
    const timer = setTimeout(() => {
      if (viewRef.current) {
        viewRef.current.dispatch({ effects: setHighlightLine.of(null) });
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [scrollToLine]);

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
