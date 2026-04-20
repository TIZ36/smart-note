import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { createSmartTable, deleteSmartTable, fetchSmartTables, type SmartTableSummary } from "@/lib/api";

const SMART_TABLES_CHANGED_EVENT = "smart-tables-changed";

type Props = {
  onOpenTable: (name: string) => void;
};

export function SmartTablesHome({ onOpenTable }: Props) {
  const [tables, setTables] = useState<SmartTableSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newTableName, setNewTableName] = useState("");
  const [pendingDeleteTable, setPendingDeleteTable] = useState<string | null>(null);
  const [busyTable, setBusyTable] = useState<string | null>(null);

  const loadTables = useCallback(async () => {
    try {
      const data = await fetchSmartTables();
      setTables(data.tables);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  async function handleCreate() {
    const name = newTableName.trim();
    if (!name) return;
    try {
      setError(null);
      const data = await createSmartTable(name);
      setNewTableName("");
      window.dispatchEvent(new Event(SMART_TABLES_CHANGED_EVENT));
      onOpenTable(data.table.name);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDelete(tableName: string) {
    if (pendingDeleteTable !== tableName) {
      setPendingDeleteTable(tableName);
      return;
    }
    try {
      setError(null);
      setBusyTable(tableName);
      await deleteSmartTable(tableName);
      setTables((current) => current.filter((table) => table.name !== tableName));
      setPendingDeleteTable(null);
      window.dispatchEvent(new Event(SMART_TABLES_CHANGED_EVENT));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyTable(null);
    }
  }

  return (
    <div className="proto-smart-table-page">
      <header className="proto-smart-table-header">
        <div>
          <h1 className="proto-dashboard-title">Smart Tables</h1>
          <p className="proto-smart-table-subtitle">Structured data alongside notes. Start with a table, then add sheets and typed columns.</p>
        </div>
        <div className="proto-smart-table-toolbar-group">
          <input
            className="proto-smart-table-toolbar-input"
            placeholder="New table name"
            value={newTableName}
            onChange={(e) => setNewTableName(e.target.value)}
          />
          <button type="button" className="proto-smart-table-action" onClick={handleCreate}>
            <Plus size={13} /> New table
          </button>
        </div>
      </header>
      {error && <div className="proto-dashboard-error">{error}</div>}
      {tables.length === 0 ? (
        <div className="proto-dashboard-empty">No smart tables yet. Create one to begin.</div>
      ) : (
        <div className="proto-dashboard-list">
          {tables.map((table) => (
            <div key={table.id} className="proto-dashboard-list-row proto-dashboard-list-row-with-actions">
              <button
                type="button"
                className="proto-dashboard-list-open"
                onClick={() => onOpenTable(table.name)}
              >
                <span className="proto-dashboard-list-primary">{table.name}</span>
                <span className="proto-dashboard-list-trailing">{table.sheet_count} sheets · {table.row_count} rows</span>
              </button>
              <button
                type="button"
                className="proto-smart-table-icon-button"
                onClick={() => void handleDelete(table.name)}
                aria-label={pendingDeleteTable === table.name ? `Confirm delete ${table.name}` : `Delete ${table.name}`}
                title={pendingDeleteTable === table.name ? `Confirm delete ${table.name}` : `Delete ${table.name}`}
                disabled={busyTable === table.name}
              >
                {pendingDeleteTable === table.name ? "Confirm" : <Trash2 size={13} />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
