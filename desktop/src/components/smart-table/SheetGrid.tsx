import { useState } from "react";
import { Trash2, History as HistoryIcon, Pencil } from "lucide-react";
import type { SmartCellHistoryItem, SmartColumn, SmartRow, SmartSheetPayload } from "@/lib/api";
import { deleteSmartRow, fetchSmartCellHistory, fetchSmartSheet, updateSmartCell, uploadSmartTableImage } from "@/lib/api";
import { TextCell } from "./cells/TextCell";
import { LinkCell } from "./cells/LinkCell";
import { ImageCell } from "./cells/ImageCell";
import { SmartCellEditorDialog } from "./SmartCellEditorDialog";

type Props = {
  tableName: string;
  payload: SmartSheetPayload;
  onUpdated: (payload: SmartSheetPayload) => void;
};

function CellView({ column, value }: { column: SmartColumn; value: Record<string, unknown> | undefined }) {
  if (column.type === "link") return <LinkCell value={value} />;
  if (column.type === "image") return <ImageCell value={value} />;
  return <TextCell value={value} />;
}

export function SheetGrid({ tableName, payload, onUpdated }: Props) {
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [history, setHistory] = useState<SmartCellHistoryItem[]>([]);
  const [confirmDeleteRowId, setConfirmDeleteRowId] = useState<number | null>(null);
  // Editor dialog target — identifies which cell is being edited. Keeping
  // row/column references (not just ids) gives the dialog enough context
  // to render type-specific UI without another lookup pass.
  const [editorTarget, setEditorTarget] = useState<{ row: SmartRow; column: SmartColumn } | null>(null);

  const sheetName = payload.sheet.name;
  const gridTemplateColumns = ["48px", "64px", ...payload.columns.map(() => "240px")].join(" ");

  async function persistCell(row: SmartRow, column: SmartColumn, nextValue: Record<string, unknown>) {
    const key = `${row.id}:${column.id}`;
    setSavingKey(key);
    setError(null);
    try {
      const updated = await updateSmartCell(tableName, sheetName, row.id, column.name, nextValue);
      onUpdated(updated);
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setSavingKey((cur) => (cur === key ? null : cur));
    }
  }

  async function handleHistory(row: SmartRow, column: SmartColumn) {
    const key = `${row.id}:${column.id}`;
    if (historyKey === key) {
      setHistoryKey(null);
      setHistory([]);
      return;
    }
    setError(null);
    try {
      const data = await fetchSmartCellHistory(tableName, sheetName, row.id, column.name);
      setHistoryKey(key);
      setHistory(data.history);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleImageUploadInDialog(file: File) {
    if (!editorTarget) return;
    const { row, column } = editorTarget;
    const key = `${row.id}:${column.id}`;
    setSavingKey(key);
    setError(null);
    try {
      const uploaded = await uploadSmartTableImage(file);
      const updated = await updateSmartCell(tableName, sheetName, row.id, column.name, {
        url: `http://127.0.0.1:8787${uploaded.image.url}`,
        path: uploaded.image.relative_path,
        value: uploaded.image.filename,
      });
      onUpdated(updated);
      setEditorTarget(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingKey((cur) => (cur === key ? null : cur));
    }
  }

  async function handleDeleteRow(row: SmartRow) {
    if (confirmDeleteRowId !== row.id) {
      setConfirmDeleteRowId(row.id);
      return;
    }
    setError(null);
    try {
      await deleteSmartRow(tableName, sheetName, row.id);
      setConfirmDeleteRowId(null);
      onUpdated(await fetchSmartSheet(tableName, sheetName));
    } catch (e) {
      setError(String(e));
    }
  }

  function formatAuditValue(value: SmartCellHistoryItem["new_value"]) {
    if (!value) return "empty";
    if (typeof value.value === "string" && value.value) return value.value;
    if (typeof value.label === "string" && value.label) return value.label;
    if (typeof value.url === "string" && value.url) return value.url;
    return JSON.stringify(value);
  }

  const editorCell = editorTarget
    ? editorTarget.row.cells[String(editorTarget.column.id)]
    : undefined;
  const editorSavingKey = editorTarget
    ? `${editorTarget.row.id}:${editorTarget.column.id}`
    : null;

  return (
    <div className="proto-smart-table-grid-wrap">
      {error && <div className="proto-dashboard-error">{error}</div>}
      <div className="proto-smart-table-grid">
        <div className="proto-smart-table-grid-head" style={{ gridTemplateColumns }}>
          <div className="proto-smart-table-grid-cell proto-smart-table-grid-cell-head proto-smart-table-row-delete-head" />
          <div className="proto-smart-table-grid-cell proto-smart-table-grid-cell-head proto-smart-table-rownum">#</div>
          {payload.columns.map((column) => (
            <div key={column.id} className="proto-smart-table-grid-cell proto-smart-table-grid-cell-head">
              <span className="proto-smart-table-colname">{column.name}</span>
              <span className="proto-smart-table-coltype">{column.type}</span>
            </div>
          ))}
        </div>
        {payload.rows.map((row) => (
          <div key={row.id} className="proto-smart-table-grid-row" style={{ gridTemplateColumns }}>
            <div className="proto-smart-table-grid-cell proto-smart-table-row-delete">
              <button
                type="button"
                className={[
                  "proto-smart-table-row-delete-button",
                  confirmDeleteRowId === row.id && "proto-smart-table-row-delete-button-confirm",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => void handleDeleteRow(row)}
                aria-label={confirmDeleteRowId === row.id ? `Confirm delete row ${row.ord + 1}` : `Delete row ${row.ord + 1}`}
                title={confirmDeleteRowId === row.id ? "Confirm delete" : "Delete row"}
              >
                <Trash2 size={13} />
              </button>
            </div>
            <div className="proto-smart-table-grid-cell proto-smart-table-rownum">{row.ord + 1}</div>
            {payload.columns.map((column) => {
              const cellKey = String(column.id);
              const value = row.cells[cellKey];
              const saving = savingKey === `${row.id}:${column.id}`;
              const expandedHistory = historyKey === `${row.id}:${column.id}`;
              return (
                <div
                  key={column.id}
                  className="proto-smart-table-grid-cell proto-smart-table-grid-editable proto-smart-table-cell-clickable"
                  role="button"
                  tabIndex={0}
                  // Clicking the cell body opens the editor. Row Delete + the
                  // History action button stop propagation below so they
                  // don't accidentally trigger an edit.
                  onClick={() => setEditorTarget({ row, column })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setEditorTarget({ row, column });
                    }
                  }}
                  title="Click to edit"
                >
                  <div className="proto-smart-table-cell-shell">
                    <CellView column={column} value={value} />
                    <div className="proto-smart-table-cell-actions">
                      <button
                        type="button"
                        className="proto-smart-table-history-toggle"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditorTarget({ row, column });
                        }}
                        aria-label="Edit cell"
                        title="Edit cell"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        type="button"
                        className="proto-smart-table-history-toggle"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleHistory(row, column);
                        }}
                        aria-label={expandedHistory ? "Hide history" : "Show history"}
                        title={expandedHistory ? "Hide history" : "Show history"}
                      >
                        <HistoryIcon size={11} />
                      </button>
                    </div>
                  </div>
                  {expandedHistory && (
                    <div
                      className="proto-smart-table-history-list"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {history.length === 0 && <span className="proto-smart-table-history-empty">No changes yet</span>}
                      {history.map((item) => (
                        <div key={item.id} className="proto-smart-table-history-item">
                          <span className="proto-smart-table-history-meta">{item.source} · {item.changed_at}</span>
                          <code>{formatAuditValue(item.new_value)}</code>
                        </div>
                      ))}
                    </div>
                  )}
                  {saving && <span className="proto-smart-table-saving">saving</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <SmartCellEditorDialog
        open={editorTarget !== null}
        row={editorTarget?.row ?? null}
        column={editorTarget?.column ?? null}
        initialValue={editorCell}
        saving={savingKey !== null && savingKey === editorSavingKey}
        onClose={() => setEditorTarget(null)}
        onSave={async (next) => {
          if (!editorTarget) return;
          await persistCell(editorTarget.row, editorTarget.column, next);
        }}
        onImageUpload={handleImageUploadInDialog}
      />
    </div>
  );
}
