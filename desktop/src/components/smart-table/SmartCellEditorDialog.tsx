import { useEffect, useMemo, useRef, useState } from "react";
import { X, Save, Link as LinkIcon, Upload, Loader2, Image as ImageIcon, Pencil, Eye } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import { cn } from "@/lib/cn";
import type { SmartColumn, SmartRow } from "@/lib/api";
import { MarkdownEditor } from "./MarkdownEditor";

/* Full-fidelity cell editor modal.

   Trigger: click anywhere on the cell. Compared to the old inline
   popover (single-line <input>) this gives multi-line text a real
   textarea, link cells two well-labeled fields, and image cells a
   preview + upload pane. Escape or click-outside closes with a
   confirm-if-dirty guard. Ctrl/Cmd+Enter saves.
*/

type NextValue = Record<string, unknown>;

type Props = {
  open: boolean;
  row: SmartRow | null;
  column: SmartColumn | null;
  initialValue: Record<string, unknown> | undefined;
  onClose: () => void;
  onSave: (next: NextValue) => Promise<void> | void;
  onImageUpload?: (file: File) => Promise<void> | void;
  saving?: boolean;
};

export function SmartCellEditorDialog({
  open, row, column, initialValue,
  onClose, onSave, onImageUpload, saving,
}: Props) {
  const type = column?.type ?? "text";

  // Primary text value for 'text' and 'link' label.
  const initialText = typeof initialValue?.value === "string" ? initialValue.value : "";
  const initialUrl =
    typeof initialValue?.url === "string" ? initialValue.url :
    (type === "link" && typeof initialValue?.value === "string") ? initialValue.value : "";
  const initialLabel = typeof initialValue?.label === "string" ? initialValue.label : "";

  const [text, setText] = useState(initialText);
  const [linkUrl, setLinkUrl] = useState(initialUrl);
  const [linkLabel, setLinkLabel] = useState(initialLabel);
  const [localError, setLocalError] = useState("");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  // Stable key so the CodeMirror instance remounts only when the target
  // cell actually changes — not on every re-render.
  const editorKey = `${row?.id ?? "x"}:${column?.id ?? "x"}`;
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset state whenever the dialog opens against a different cell.
  // CodeMirror handles its own focus; we just reset the auxiliary
  // state. `mode` reverts to edit every time so preview isn't sticky.
  useEffect(() => {
    if (!open) return;
    setText(initialText);
    setLinkUrl(initialUrl);
    setLinkLabel(initialLabel);
    setLocalError("");
    setMode("edit");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row?.id, column?.id]);

  const dirty = useMemo(() => {
    if (!open) return false;
    if (type === "text") return text !== initialText;
    if (type === "link") return linkUrl !== initialUrl || linkLabel !== initialLabel;
    return false;
  }, [open, type, text, linkUrl, linkLabel, initialText, initialUrl, initialLabel]);

  function requestClose() {
    if (dirty && !saving) {
      const ok = window.confirm("Discard unsaved changes in this cell?");
      if (!ok) return;
    }
    onClose();
  }

  async function handleSave() {
    if (saving) return;
    try {
      if (type === "text") {
        await onSave({ value: text });
      } else if (type === "link") {
        if (!linkUrl.trim()) {
          setLocalError("URL cannot be empty");
          return;
        }
        await onSave({ url: linkUrl.trim(), label: linkLabel.trim() || linkUrl.trim() });
      }
      onClose();
    } catch (e) {
      setLocalError(String(e));
    }
  }

  if (!open || !row || !column) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="proto-dialog-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}
      >
        <motion.div
          className="proto-dialog proto-smart-cell-dialog"
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={{ duration: 0.12 }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); requestClose(); }
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault(); void handleSave();
            }
          }}
        >
          <div className="proto-dialog-header">
            <div className="proto-smart-cell-dialog-title">
              <span className="proto-smart-cell-dialog-col">{column.name}</span>
              <span className="proto-smart-cell-dialog-meta">
                <span className="proto-smart-table-coltype">{column.type}</span>
                <span>Row {row.ord + 1}</span>
              </span>
            </div>
            <button type="button" className="proto-dialog-close" onClick={requestClose} aria-label="Close">
              <X size={14} />
            </button>
          </div>

          <div className="proto-smart-cell-dialog-body">
            {type === "text" && (
              <div className="proto-smart-cell-md-wrap">
                <div className="proto-smart-cell-md-toolbar">
                  <div className="proto-smart-cell-md-tabs">
                    <button
                      type="button"
                      className={cn("proto-smart-cell-md-tab", mode === "edit" && "proto-smart-cell-md-tab-active")}
                      onClick={() => setMode("edit")}
                    >
                      <Pencil size={11} /> Edit
                    </button>
                    <button
                      type="button"
                      className={cn("proto-smart-cell-md-tab", mode === "preview" && "proto-smart-cell-md-tab-active")}
                      onClick={() => setMode("preview")}
                    >
                      <Eye size={11} /> Preview
                    </button>
                  </div>
                </div>
                {mode === "edit" ? (
                  <MarkdownEditor
                    key={editorKey}
                    initialValue={text}
                    onChange={(v) => setText(v)}
                    autoFocus
                  />
                ) : (
                  <div className="proto-smart-cell-md-preview">
                    {text.trim()
                      ? <ReactMarkdown>{text}</ReactMarkdown>
                      : <span className="proto-smart-table-cell-empty">Empty — nothing to preview.</span>}
                  </div>
                )}
                <p className="proto-smart-cell-md-hint">
                  Supports Markdown — bold, italic, lists, code, headings, links.
                </p>
              </div>
            )}

            {type === "link" && (
              <>
                <label className="proto-smart-cell-field">
                  <span>Label</span>
                  <input
                    className="proto-smart-cell-input"
                    value={linkLabel}
                    onChange={(e) => setLinkLabel(e.target.value)}
                    placeholder="Display text"
                  />
                </label>
                <label className="proto-smart-cell-field">
                  <span><LinkIcon size={11} style={{ verticalAlign: "-1px" }} /> URL</span>
                  <input
                    className="proto-smart-cell-input"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    placeholder="https://…"
                    spellCheck={false}
                  />
                </label>
                {linkUrl && (
                  <a className="proto-smart-cell-link-preview" href={linkUrl} target="_blank" rel="noreferrer">
                    Preview → {linkLabel || linkUrl}
                  </a>
                )}
              </>
            )}

            {type === "image" && (() => {
              const imgSrc =
                typeof initialValue?.url === "string" ? initialValue.url
                : typeof initialValue?.path === "string"
                  ? `http://127.0.0.1:8787/${String(initialValue.path).replace(/^\/+/, "")}`
                  : "";
              return (
              <div className="proto-smart-cell-image-pane">
                {imgSrc && (
                  <img
                    src={imgSrc}
                    alt=""
                    className="proto-smart-cell-image-preview"
                  />
                )}
                <div className="proto-smart-cell-image-actions">
                  <button
                    type="button"
                    className="proto-btn proto-btn-primary"
                    disabled={saving || !onImageUpload}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                    {imgSrc ? "Replace image" : "Upload image"}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f && onImageUpload) {
                        void onImageUpload(f);
                        // Close after successful upload. The parent's
                        // save handler closes via onClose on its side;
                        // we don't close eagerly so errors can surface.
                      }
                    }}
                  />
                  {!imgSrc && (
                    <div className="proto-smart-cell-image-empty">
                      <ImageIcon size={18} />
                      <span>No image yet</span>
                    </div>
                  )}
                </div>
              </div>
              );
            })()}

            {localError && (
              <div className="proto-settings-status proto-settings-status-error" style={{ marginTop: 10 }}>
                {localError}
              </div>
            )}
          </div>

          <div className="proto-smart-cell-dialog-footer">
            <span className="proto-smart-cell-dialog-hint">
              {type === "image"
                ? "Upload replaces the current image immediately."
                : "Esc cancels · ⌘↵ saves"}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="proto-btn"
                onClick={requestClose}
                disabled={!!saving}
              >
                Cancel
              </button>
              {type !== "image" && (
                <button
                  type="button"
                  className="proto-btn proto-btn-primary"
                  onClick={() => void handleSave()}
                  disabled={!!saving || !dirty}
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {saving ? "Saving…" : dirty ? "Save" : "Saved"}
                </button>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
