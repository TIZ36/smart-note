import { useEffect, useRef, useState } from "react";
import { EditorView, lineNumbers, drawSelection, Decoration, type DecorationSet } from "@codemirror/view";
import { EditorState, StateField, StateEffect } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import { FileText } from "lucide-react";
import { readFileFull } from "@/lib/electron";

type Props = {
  filePath: string;
};

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
    caretColor: "transparent",
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
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 3%, transparent)",
  },
  ".cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--color-accent) 12%, transparent) !important",
  },
  ".cm-cursor": {
    display: "none",
  },
  ".cm-scroller": {
    overflow: "auto",
  },
});

export function WikiSourceViewer({ filePath }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!containerRef.current) return;

    setLoading(true);
    readFileFull(filePath).then((result) => {
      const content = result.output || "";

      if (viewRef.current) {
        viewRef.current.destroy();
      }

      const state = EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          drawSelection(),
          highlightSelectionMatches(),
          markdown(),
          keymap.of(searchKeymap),
          editorTheme,
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
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
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [filePath]);

  const fileName = filePath.split("/").pop() || filePath;

  return (
    <div className="proto-note-page">
      <div className="proto-note-header">
        <div className="proto-note-header-left">
          <FileText size={14} className="text-[var(--color-text-muted)]" />
          <span className="proto-note-header-name">{fileName}</span>
          <span className="proto-wiki-source-badge">read-only</span>
        </div>
      </div>
      <div className="proto-note-body">
        <div className="proto-note-editor-area">
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
        </div>
      </div>
    </div>
  );
}
