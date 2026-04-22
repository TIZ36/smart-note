import { useEffect, useRef } from "react";
import { EditorView, keymap, highlightActiveLine, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";

/* Small markdown-aware editor built on the same CodeMirror stack as
   NoteEditor, scoped for a modal cell editor. No line numbers, no
   gutters — we want it to feel like a textarea that happens to know
   markdown. Syntax highlighting + standard shortcuts come along
   (Cmd+B bold, etc., via defaultKeymap).

   Intentionally uncontrolled: the parent gives us `initialValue`
   once; we expose `onChange` for live state mirroring but the source
   of truth is the CM state. That avoids the cursor-jump problem of
   a fully-controlled CM editor. */

type Props = {
  initialValue: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
};

const editorTheme = EditorView.theme({
  "&": {
    fontSize: "13px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif",
    height: "100%",
    backgroundColor: "var(--color-bg-primary)",
    color: "var(--color-text-primary)",
    borderRadius: "8px",
    border: "1px solid var(--color-border)",
  },
  "&.cm-focused": {
    borderColor: "var(--color-accent)",
    outline: "none",
  },
  ".cm-content": {
    padding: "10px 12px",
    lineHeight: "1.55",
    caretColor: "var(--color-accent)",
  },
  ".cm-line": { padding: 0 },
  ".cm-cursor": {
    borderLeftColor: "var(--color-accent)",
    borderLeftWidth: "1.5px",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 3%, transparent)",
  },
  ".cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 14%, transparent) !important",
  },
  ".cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 20%, transparent) !important",
  },
  ".cm-scroller": { overflow: "auto" },
});

export function MarkdownEditor({ initialValue, onChange, autoFocus = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;
    if (viewRef.current) return;   // don't remount on re-render

    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        markdown(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        editorTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;
    if (autoFocus) {
      setTimeout(() => view.focus(), 30);
    }
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="proto-smart-cell-md-editor" />;
}
