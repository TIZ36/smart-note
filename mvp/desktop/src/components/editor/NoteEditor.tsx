import { useEffect, useRef, useState, useCallback } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { readFileFull } from "@/lib/electron";

type Props = {
  filePath: string;
  onSave: (content: string) => void;
  onDirty?: (dirty: boolean) => void;
};

/** Dark theme matching IntelliNote's design tokens */
const editorTheme = EditorView.theme({
  "&": {
    fontSize: "13px",
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
    height: "100%",
    backgroundColor: "var(--color-bg-primary)",
    color: "var(--color-text-primary)",
  },
  ".cm-content": {
    padding: "16px 0",
    caretColor: "var(--color-accent)",
    lineHeight: "1.6",
  },
  ".cm-line": {
    padding: "0 24px",
  },
  ".cm-gutters": {
    backgroundColor: "var(--color-bg-primary)",
    color: "var(--color-text-muted)",
    border: "none",
    paddingRight: "8px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--color-text-secondary)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 4%, transparent)",
  },
  ".cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 15%, transparent) !important",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--color-accent)",
    borderLeftWidth: "1.5px",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklab, var(--color-warning) 20%, transparent)",
  },
  ".cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 20%, transparent) !important",
  },
  ".cm-scroller": {
    overflow: "auto",
  },
});

export function NoteEditor({ filePath, onSave, onDirty }: Props) {
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
          EditorView.lineWrapping,
        ],
      });

      viewRef.current = new EditorView({
        state,
        parent: containerRef.current!,
      });

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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {loading && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--color-text-muted)", fontSize: 13 }}>
            Loading...
          </div>
        )}
        <div ref={containerRef} style={{ position: "absolute", inset: 0, display: loading ? "none" : "block" }} />
      </div>
    </div>
  );
}
