import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, Trash2, RefreshCw, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import * as api from "@/lib/api";

const KIND_OPTIONS = ["rule", "vocab", "alias", "preference", "gotcha"];

/**
 * Meta-memory — the cross-session learnings Claude writes about this
 * knowledge base. Surfacing + editing them here (rather than only in MCP)
 * means the user stays in control: can prune stale rules, add their own,
 * or watch what's being learned in real time.
 */
export function MetaMemoryInspector() {
  const [memories, setMemories] = useState<api.MetaMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newText, setNewText] = useState("");
  const [newKind, setNewKind] = useState("rule");
  const [newScope, setNewScope] = useState("global");
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .fetchMetaMemories()
      .then((d) => {
        setMemories(d.memories);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd() {
    const text = newText.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      await api.addMetaMemory({ text, kind: newKind, scope: newScope });
      setNewText("");
      textareaRef.current?.focus();
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: number) {
    if (deletingId !== null) return;
    setDeletingId(id);
    try {
      await api.deleteMetaMemory(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (e) {
      setError(String(e));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="proto-dashboard">
      <div className="proto-dashboard-header">
        <div>
          <h1 className="proto-dashboard-title">Meta-memory</h1>
          <p className="proto-meta-subtitle">
            What Claude has learned about this knowledge base. Injected into
            new sessions + search query expansion.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="proto-btn proto-btn-secondary"
          aria-label="Refresh memories"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
          <span>Refresh</span>
        </button>
      </div>

      {error && <p className="proto-dashboard-error">{error}</p>}

      <section className="proto-dashboard-section">
        <h2 className="proto-section-label">Add a rule</h2>
        <div className="proto-meta-add">
          <textarea
            ref={textareaRef}
            className="proto-meta-add-textarea"
            placeholder='e.g. "When user says `回传 SQL` they usually mean v2_callback_sub_strategy"'
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
            }}
            rows={2}
          />
          <div className="proto-meta-add-controls">
            <select
              className="proto-meta-add-select"
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
              aria-label="Memory kind"
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input
              className="proto-meta-add-scope"
              value={newScope}
              onChange={(e) => setNewScope(e.target.value)}
              placeholder="scope"
              aria-label="Memory scope"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newText.trim() || adding}
              className="proto-btn proto-btn-primary"
            >
              {adding ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              <span>Save</span>
            </button>
          </div>
          <p className="proto-meta-hint">⌘↵ to save · dedup is automatic on exact-text match</p>
        </div>
      </section>

      <section className="proto-dashboard-section">
        <h2 className="proto-section-label">
          Memories ({memories.length})
        </h2>
        {memories.length === 0 && !loading ? (
          <p className="proto-dashboard-empty">
            No memories yet. Claude adds these via <code>append_meta_memory</code>, or add
            your own above to teach preferences.
          </p>
        ) : (
          <ul className="proto-meta-list">
            {memories.map((m) => (
              <li key={m.id} className="proto-meta-item">
                <div className="proto-meta-item-head">
                  <span className={cn("proto-meta-kind", `proto-meta-kind-${m.kind}`)}>
                    {m.kind}
                  </span>
                  {m.scope !== "global" && (
                    <span className="proto-meta-scope">{m.scope}</span>
                  )}
                  <span className="proto-meta-hits" title={`${m.hit_count} activations`}>
                    ×{m.hit_count}
                  </span>
                  <span className="proto-meta-time">{formatRelative(m.updated_at)}</span>
                  <button
                    type="button"
                    onClick={() => handleDelete(m.id)}
                    disabled={deletingId !== null}
                    className="proto-meta-delete"
                    aria-label={`Forget memory ${m.id}`}
                  >
                    {deletingId === m.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  </button>
                </div>
                <p className="proto-meta-text">{m.text}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso.replace(" ", "T") + "Z");
    const now = Date.now();
    const diff = Math.max(0, now - d.getTime());
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}
