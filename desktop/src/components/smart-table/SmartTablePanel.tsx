import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PencilLine,
  Plus,
  RefreshCw,
  Rows3,
  TableProperties,
  Trash2,
  X,
} from "lucide-react";
import * as api from "@/lib/api";
import { SheetTabs } from "./SheetTabs";
import { SheetGrid } from "./SheetGrid";

const SMART_TABLES_CHANGED_EVENT = "smart-tables-changed";

type Props = {
  tableName: string;
  onDeleted: () => void;
};

type ToolbarMode =
  | null
  | "new-sheet"
  | "rename-sheet"
  | "new-column"
  | "rename-column"
  | "delete-column";

export function SmartTablePanel({ tableName, onDeleted }: Props) {
  const [sheets, setSheets] = useState<api.SmartSheetSummary[]>([]);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  const [payload, setPayload] = useState<api.SmartSheetPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [toolbarMode, setToolbarMode] = useState<ToolbarMode>(null);
  const [confirmDeleteTable, setConfirmDeleteTable] = useState(false);
  const [deletingTable, setDeletingTable] = useState(false);

  const [newSheetName, setNewSheetName] = useState("");
  const [renameSheetValue, setRenameSheetValue] = useState("");
  const [newColumnName, setNewColumnName] = useState("");
  const [newColumnType, setNewColumnType] = useState<api.SmartColumn["type"]>("text");
  const [selectedColumnName, setSelectedColumnName] = useState("");
  const [renameColumnValue, setRenameColumnValue] = useState("");
  const [confirmDeleteColumn, setConfirmDeleteColumn] = useState(false);

  function reportError(next: unknown) {
    setError(String(next));
    setActionMessage(null);
  }

  const loadSheets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.fetchSmartSheets(tableName);
      setSheets(data.sheets);
      const nextSheet =
        data.sheets.find((sheet) => sheet.name === activeSheet)?.name ??
        data.sheets[0]?.name ??
        null;
      setActiveSheet(nextSheet);
      setRenameSheetValue(nextSheet ?? "");
    } catch (e) {
      reportError(e);
    } finally {
      setLoading(false);
    }
  }, [tableName, activeSheet]);

  useEffect(() => {
    void loadSheets();
  }, [loadSheets]);

  useEffect(() => {
    if (!activeSheet) {
      setPayload(null);
      return;
    }
    let cancelled = false;
    setError(null);
    api.fetchSmartSheet(tableName, activeSheet)
      .then((next) => {
        if (cancelled) return;
        setPayload(next);
      })
      .catch((e) => {
        if (!cancelled) reportError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [tableName, activeSheet]);

  useEffect(() => {
    if (!payload || payload.columns.length === 0) {
      setSelectedColumnName("");
      setRenameColumnValue("");
      setConfirmDeleteColumn(false);
      return;
    }
    const exists = payload.columns.some((column) => column.name === selectedColumnName);
    if (!exists) {
      const fallback = payload.columns[0]?.name ?? "";
      setSelectedColumnName(fallback);
      setRenameColumnValue(fallback);
      setConfirmDeleteColumn(false);
    }
  }, [payload, selectedColumnName]);

  const stats = useMemo(
    () => ({
      sheetCount: sheets.length,
      rowCount: payload?.rows.length ?? 0,
      columnCount: payload?.columns.length ?? 0,
    }),
    [payload, sheets.length]
  );

  function closeTray() {
    setToolbarMode(null);
    setConfirmDeleteColumn(false);
  }

  function handleToolbarKeyDown(
    event: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
    action: () => Promise<void> | void
  ) {
    if (event.key === "Enter") {
      event.preventDefault();
      void action();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeTray();
    }
  }

  async function handleCreateSheet() {
    const name = newSheetName.trim();
    if (!name) return;
    try {
      await api.createSmartSheet(tableName, name);
      setNewSheetName("");
      await loadSheets();
      setActiveSheet(name);
      setRenameSheetValue(name);
      setActionMessage(`Created sheet ${name}`);
      closeTray();
    } catch (e) {
      reportError(e);
    }
  }

  async function handleRenameSheet() {
    if (!activeSheet) return;
    const nextName = renameSheetValue.trim();
    if (!nextName || nextName === activeSheet) return;
    try {
      await api.renameSmartSheet(tableName, activeSheet, nextName);
      await loadSheets();
      setActiveSheet(nextName);
      setRenameSheetValue(nextName);
      setActionMessage(`Renamed sheet to ${nextName}`);
      closeTray();
    } catch (e) {
      reportError(e);
    }
  }

  async function handleAddColumn() {
    if (!activeSheet) return;
    const columnName = newColumnName.trim();
    if (!columnName) return;
    try {
      await api.addSmartColumn(tableName, activeSheet, columnName, newColumnType);
      setNewColumnName("");
      const next = await api.fetchSmartSheet(tableName, activeSheet);
      setPayload(next);
      setSelectedColumnName(columnName);
      setRenameColumnValue(columnName);
      await loadSheets();
      setActionMessage(`Added ${newColumnType} column ${columnName}`);
      closeTray();
    } catch (e) {
      reportError(e);
    }
  }

  async function handleRenameColumn() {
    if (!activeSheet) return;
    const nextName = renameColumnValue.trim();
    if (!selectedColumnName || !nextName || nextName === selectedColumnName) return;
    try {
      await api.renameSmartColumn(tableName, activeSheet, selectedColumnName, nextName);
      const next = await api.fetchSmartSheet(tableName, activeSheet);
      setPayload(next);
      setSelectedColumnName(nextName);
      setRenameColumnValue(nextName);
      await loadSheets();
      setActionMessage(`Renamed column to ${nextName}`);
      closeTray();
    } catch (e) {
      reportError(e);
    }
  }

  async function handleDeleteColumn() {
    if (!activeSheet || !selectedColumnName) return;
    if (!confirmDeleteColumn) {
      setConfirmDeleteColumn(true);
      return;
    }
    try {
      const deleted = selectedColumnName;
      await api.deleteSmartColumn(tableName, activeSheet, deleted);
      const next = await api.fetchSmartSheet(tableName, activeSheet);
      setPayload(next);
      setSelectedColumnName(next.columns[0]?.name ?? "");
      setRenameColumnValue(next.columns[0]?.name ?? "");
      await loadSheets();
      setActionMessage(`Deleted column ${deleted}`);
      closeTray();
    } catch (e) {
      reportError(e);
    }
  }

  async function handleAddRow() {
    if (!activeSheet) return;
    try {
      await api.addSmartRow(tableName, activeSheet);
      const next = await api.fetchSmartSheet(tableName, activeSheet);
      setPayload(next);
      await loadSheets();
      setActionMessage("Added a new row");
    } catch (e) {
      reportError(e);
    }
  }

  async function handleDeleteTable() {
    if (!confirmDeleteTable) {
      setConfirmDeleteTable(true);
      return;
    }
    try {
      setDeletingTable(true);
      await api.deleteSmartTable(tableName);
      window.dispatchEvent(new Event(SMART_TABLES_CHANGED_EVENT));
      onDeleted();
    } catch (e) {
      reportError(e);
    } finally {
      setDeletingTable(false);
      setConfirmDeleteTable(false);
    }
  }

  function renderTray() {
    if (!toolbarMode) return null;
    if (toolbarMode === "new-sheet") {
      return (
        <div className="proto-smart-table-tray" role="region" aria-label="New sheet">
          <span className="proto-smart-table-tray-label">New sheet</span>
          <input
            className="proto-smart-table-toolbar-input"
            placeholder="Sheet name"
            value={newSheetName}
            onChange={(e) => setNewSheetName(e.target.value)}
            onKeyDown={(e) => handleToolbarKeyDown(e, handleCreateSheet)}
            autoFocus
          />
          <button type="button" className="proto-smart-table-action" onClick={handleCreateSheet}>
            <Plus size={13} /> Add
          </button>
          <button type="button" className="proto-smart-table-icon-button" onClick={closeTray} aria-label="Close sheet tray">
            <X size={13} />
          </button>
        </div>
      );
    }
    if (toolbarMode === "rename-sheet") {
      return (
        <div className="proto-smart-table-tray" role="region" aria-label="Rename sheet">
          <span className="proto-smart-table-tray-label">Rename sheet</span>
          <input
            className="proto-smart-table-toolbar-input"
            placeholder="Sheet name"
            value={renameSheetValue}
            onChange={(e) => setRenameSheetValue(e.target.value)}
            onKeyDown={(e) => handleToolbarKeyDown(e, handleRenameSheet)}
            autoFocus
          />
          <button type="button" className="proto-smart-table-action" onClick={handleRenameSheet} disabled={!activeSheet}>
            <PencilLine size={13} /> Save
          </button>
          <button type="button" className="proto-smart-table-icon-button" onClick={closeTray} aria-label="Close rename sheet tray">
            <X size={13} />
          </button>
        </div>
      );
    }
    if (toolbarMode === "new-column") {
      return (
        <div className="proto-smart-table-tray" role="region" aria-label="New column">
          <span className="proto-smart-table-tray-label">New column</span>
          <input
            className="proto-smart-table-toolbar-input"
            placeholder="Column name"
            value={newColumnName}
            onChange={(e) => setNewColumnName(e.target.value)}
            onKeyDown={(e) => handleToolbarKeyDown(e, handleAddColumn)}
            autoFocus
          />
          <select
            className="proto-smart-table-toolbar-select"
            value={newColumnType}
            onChange={(e) => setNewColumnType(e.target.value as api.SmartColumn["type"])}
            aria-label="New column type"
          >
            <option value="text">text</option>
            <option value="link">link</option>
            <option value="image">image</option>
          </select>
          <button type="button" className="proto-smart-table-action" onClick={handleAddColumn} disabled={!activeSheet}>
            <TableProperties size={13} /> Add
          </button>
          <button type="button" className="proto-smart-table-icon-button" onClick={closeTray} aria-label="Close new column tray">
            <X size={13} />
          </button>
        </div>
      );
    }
    if (toolbarMode === "rename-column") {
      return (
        <div className="proto-smart-table-tray" role="region" aria-label="Rename column">
          <span className="proto-smart-table-tray-label">Rename column</span>
          <select
            className="proto-smart-table-toolbar-select"
            value={selectedColumnName}
            onChange={(e) => {
              setSelectedColumnName(e.target.value);
              setRenameColumnValue(e.target.value);
            }}
            aria-label="Selected column"
          >
            {payload?.columns.map((column) => (
              <option key={column.id} value={column.name}>
                {column.name}
              </option>
            ))}
          </select>
          <input
            className="proto-smart-table-toolbar-input"
            placeholder="New name"
            value={renameColumnValue}
            onChange={(e) => setRenameColumnValue(e.target.value)}
            onKeyDown={(e) => handleToolbarKeyDown(e, handleRenameColumn)}
            autoFocus
          />
          <button type="button" className="proto-smart-table-action" onClick={handleRenameColumn} disabled={!activeSheet || !payload || payload.columns.length === 0}>
            <PencilLine size={13} /> Save
          </button>
          <button type="button" className="proto-smart-table-icon-button" onClick={closeTray} aria-label="Close rename column tray">
            <X size={13} />
          </button>
        </div>
      );
    }
    return (
      <div className="proto-smart-table-tray" role="region" aria-label="Delete column">
        <span className="proto-smart-table-tray-label">Delete column</span>
        <select
          className="proto-smart-table-toolbar-select"
          value={selectedColumnName}
          onChange={(e) => {
            setSelectedColumnName(e.target.value);
            setRenameColumnValue(e.target.value);
            setConfirmDeleteColumn(false);
          }}
          aria-label="Column to delete"
        >
          {payload?.columns.map((column) => (
            <option key={column.id} value={column.name}>
              {column.name}
            </option>
          ))}
        </select>
        <button type="button" className="proto-smart-table-action proto-smart-table-action-danger" onClick={handleDeleteColumn} disabled={!activeSheet || !payload || payload.columns.length === 0}>
          <Trash2 size={13} /> {confirmDeleteColumn ? "Confirm delete" : "Delete"}
        </button>
        <button type="button" className="proto-smart-table-icon-button" onClick={closeTray} aria-label="Close delete column tray">
          <X size={13} />
        </button>
      </div>
    );
  }

  return (
    <div className="proto-smart-table-page">
      <header className="proto-smart-table-header proto-smart-table-header-compact">
        <div className="proto-smart-table-header-copy">
          <span className="proto-smart-table-eyebrow">Smart table</span>
          <div className="proto-smart-table-title-row">
            <h1 className="proto-dashboard-title">{tableName}</h1>
            <div className="proto-smart-table-stats proto-smart-table-stats-inline">
              <span>{stats.sheetCount} sheets</span>
              <span>{stats.columnCount} columns</span>
              <span>{stats.rowCount} rows</span>
              {activeSheet && <span>{activeSheet}</span>}
            </div>
          </div>
        </div>
        <div className="proto-smart-table-actions">
          <button type="button" className="proto-smart-table-action" onClick={() => void loadSheets()}>
            <RefreshCw size={13} /> Refresh
          </button>
          <button
            type="button"
            className="proto-smart-table-action proto-smart-table-action-danger"
            onClick={handleDeleteTable}
            disabled={deletingTable}
          >
            <Trash2 size={13} /> {confirmDeleteTable ? "Confirm delete" : "Delete table"}
          </button>
          <button type="button" className="proto-smart-table-action proto-smart-table-action-strong" onClick={handleAddRow} disabled={!activeSheet}>
            <Rows3 size={13} /> Add row
          </button>
        </div>
      </header>

      {actionMessage && <div className="proto-smart-table-feedback">{actionMessage}</div>}
      {error && <div className="proto-dashboard-error">{error}</div>}

      <SheetTabs sheets={sheets} activeSheet={activeSheet} onSelect={setActiveSheet} />

      <div className="proto-smart-table-controlbar" aria-label="Smart table controls">
        <div className="proto-smart-table-controlgroup">
          <span className="proto-smart-table-controlgroup-label">Sheets</span>
          <button type="button" className="proto-smart-table-chip-button" onClick={() => setToolbarMode("new-sheet")}>New</button>
          <button type="button" className="proto-smart-table-chip-button" onClick={() => setToolbarMode("rename-sheet")} disabled={!activeSheet}>Rename</button>
        </div>
        <div className="proto-smart-table-controlgroup">
          <span className="proto-smart-table-controlgroup-label">Columns</span>
          <button type="button" className="proto-smart-table-chip-button" onClick={() => setToolbarMode("new-column")} disabled={!activeSheet}>Add</button>
          <button type="button" className="proto-smart-table-chip-button" onClick={() => setToolbarMode("rename-column")} disabled={!activeSheet || !payload || payload.columns.length === 0}>Rename</button>
          <button type="button" className="proto-smart-table-chip-button proto-smart-table-chip-button-danger" onClick={() => setToolbarMode("delete-column")} disabled={!activeSheet || !payload || payload.columns.length === 0}>Delete</button>
        </div>
      </div>

      {renderTray()}

      {loading && sheets.length === 0 && (
        <div className="proto-dashboard-empty">Loading smart table…</div>
      )}
      {!loading && sheets.length === 0 && (
        <div className="proto-dashboard-empty">
          No sheets yet. Create one to start structuring shared work.
        </div>
      )}
      {payload && <SheetGrid tableName={tableName} payload={payload} onUpdated={setPayload} />}
    </div>
  );
}
