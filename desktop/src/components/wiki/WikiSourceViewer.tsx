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
  /** Optional line range to highlight + scroll to on mount.
   *  Wired by the stream search "open chunk" flow so the user
   *  lands on the most-relevant span, not the file top. */
  lineStart?: number;
  lineEnd?: number;
};

// Highlight effect / state field — paints a range of lines with a
// soft accent backdrop + left border so the chunk that the user
// clicked through to stands out without competing with body text.
const setHighlightRange = StateEffect.define<{ start: number; end: number } | null>();

const highlightField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHighlightRange)) {
        if (e.value === null) {
          deco = Decoration.none;
        } else {
          const { start, end } = e.value;
          const doc = tr.state.doc;
          const total = doc.lines;
          const fromLine = doc.line(Math.max(1, Math.min(start, total)));
          const toLine   = doc.line(Math.max(1, Math.min(end, total)));
          deco = Decoration.set([
            Decoration.mark({ class: "proto-source-highlight" })
              .range(fromLine.from, toLine.to),
          ]);
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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

export function WikiSourceViewer({ filePath, lineStart, lineEnd }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [loading, setLoading] = useState(true);
  const [docName, setDocName] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    setLoading(true);
    // Two source paths: cloud document (UUID v4) or local filesystem.
    // Cloud docs come from Library Docs's "View raw" button which
    // routes via channel `source:<doc-uuid>`. Local file paths come
    // from the legacy WikiSources picker.
    const isCloudId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filePath);
    const fetcher: Promise<{ content: string; name?: string }> = isCloudId
      ? import("@/lib/cloud-api").then((m) => m.getDocument(filePath)).then((d) => ({ content: d.content, name: d.name }))
      : readFileFull(filePath).then((result) => ({ content: result.output || "" }));

    fetcher.then(({ content, name }) => {
      if (name) setDocName(name);
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
          highlightField,
        ],
      });

      viewRef.current = new EditorView({
        state,
        parent: containerRef.current!,
      });

      // If a line range was passed, dispatch the highlight + scroll
      // it into view. Done in a follow-up dispatch so the editor
      // measurement is settled (line metrics need to be ready).
      if (lineStart && lineEnd && lineStart > 0) {
        const view = viewRef.current;
        requestAnimationFrame(() => {
          if (!view || view !== viewRef.current) return;
          const total = view.state.doc.lines;
          const a = Math.max(1, Math.min(lineStart, total));
          const b = Math.max(a, Math.min(lineEnd, total));
          const targetLine = view.state.doc.line(a);
          view.dispatch({
            effects: [
              setHighlightRange.of({ start: a, end: b }),
              EditorView.scrollIntoView(targetLine.from, { y: "center" }),
            ],
          });
        });
      }

      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // Intentionally omit lineStart/lineEnd from deps — content
    // re-fetch is expensive. A separate effect dispatches the
    // highlight when only the range changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // Keep highlight in sync when only the line range prop changes
  // (e.g., user clicks a different chunk in Stream answer for the
  // same doc — content is already loaded, just re-target).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!lineStart || !lineEnd) {
      view.dispatch({ effects: setHighlightRange.of(null) });
      return;
    }
    const total = view.state.doc.lines;
    const a = Math.max(1, Math.min(lineStart, total));
    const b = Math.max(a, Math.min(lineEnd, total));
    const targetLine = view.state.doc.line(a);
    view.dispatch({
      effects: [
        setHighlightRange.of({ start: a, end: b }),
        EditorView.scrollIntoView(targetLine.from, { y: "center" }),
      ],
    });
  }, [lineStart, lineEnd]);

  const fileName = docName || filePath.split("/").pop() || filePath;

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
