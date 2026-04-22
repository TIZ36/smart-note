import { useCallback, useEffect, useState } from "react";
import {
  Inbox, Check, X, Loader2, RefreshCw, AlertTriangle, ChevronDown, ChevronRight,
  Sparkles, User, BookOpen, Clock, Link2, Edit3,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/cn";
import * as api from "@/lib/api";

/* Draft Inbox — reviews pending memory proposals coming from any agent
   (Claude Code / Cursor / your own scripts) that called propose_memory.

   Per-item actions:
     ✓ Accept   — promote to active (optionally with an edit / supersede)
     × Reject   — archive with optional reason
     ⇅ Merge    — accept + supersedes=<similar_id> when the proposal
                   was flagged as near-duplicate of an existing memory

   Non-goals: this doesn't show archived / rejected history. The
   server keeps those for future heuristics; a "Review rejects"
   tab is a v2 idea.
*/

type Props = {
  hasConfig: boolean;
  onCountChange?: (n: number) => void;
};

export function DraftInbox({ hasConfig, onCountChange }: Props) {
  const [proposals, setProposals] = useState<api.CloudProposal[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Record<string, string>>({}); // id → edited content
  const [busy, setBusy] = useState<Record<string, "accept" | "reject" | "merge" | null>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!hasConfig) { setProposals(null); return; }
    setLoading(true);
    setError("");
    try {
      const r = await api.fetchCloudProposals({ limit: 100 });
      setProposals(r.proposals);
      setTotal(r.total);
      onCountChange?.(r.total);
    } catch (e) {
      setError(String(e));
      setProposals([]);
    } finally {
      setLoading(false);
    }
  }, [hasConfig, onCountChange]);

  useEffect(() => { void refresh(); }, [refresh]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleAccept(p: api.CloudProposal, supersedesId?: string) {
    setBusy((b) => ({ ...b, [p.id]: supersedesId ? "merge" : "accept" }));
    try {
      const patch: Parameters<typeof api.acceptCloudProposal>[1] = {};
      if (editing[p.id] !== undefined && editing[p.id] !== p.content) {
        patch.content = editing[p.id];
      }
      if (supersedesId) patch.supersedes = supersedesId;
      await api.acceptCloudProposal(p.id, patch);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy((b) => ({ ...b, [p.id]: null }));
    }
  }

  async function handleReject(p: api.CloudProposal) {
    setBusy((b) => ({ ...b, [p.id]: "reject" }));
    try {
      await api.rejectCloudProposal(p.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy((b) => ({ ...b, [p.id]: null }));
    }
  }

  async function handleBatchAccept() {
    if (selected.size === 0) return;
    setLoading(true);
    try {
      await api.batchAcceptCloudProposals([...selected]);
      setSelected(new Set());
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  if (!hasConfig) return null;
  if (proposals === null) {
    return (
      <section className="proto-cloud-sync-card">
        <h2 className="proto-cloud-sync-card-title">
          <Inbox size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Draft Inbox
        </h2>
        <p className="proto-form-hint">Loading…</p>
      </section>
    );
  }

  return (
    <section className="proto-cloud-sync-card">
      <div className="proto-draft-inbox-header">
        <h2 className="proto-cloud-sync-card-title" style={{ margin: 0 }}>
          <Inbox size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Draft Inbox
          {total > 0 && <span className="proto-draft-inbox-count">{total}</span>}
        </h2>
        <div style={{ display: "flex", gap: 6 }}>
          {selected.size > 0 && (
            <button
              type="button"
              className="proto-btn proto-btn-primary"
              onClick={handleBatchAccept}
              disabled={loading}
            >
              <Check size={13} /> Accept {selected.size} selected
            </button>
          )}
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="proto-btn"
            aria-label="Refresh"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        </div>
      </div>

      <p className="proto-form-hint" style={{ marginBottom: 12 }}>
        Candidate memories submitted by agents (via <code className="proto-cloud-sync-code">propose_memory</code>).
        Review, edit, accept or reject. Rejects are archived — not lost — so
        future heuristics can learn from them.
      </p>

      {error && (
        <div className="proto-cloud-sync-note proto-cloud-sync-note-error">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {proposals.length === 0 ? (
        <div className="proto-draft-inbox-empty">
          Nothing pending. Agents will surface candidates here as they propose them.
        </div>
      ) : (
        <div className="proto-draft-inbox-list">
          <AnimatePresence initial={false}>
            {proposals.map((p) => {
              const isExpanded = expanded.has(p.id);
              const isSelected = selected.has(p.id);
              const isBusy = Boolean(busy[p.id]);
              const similar = p.similar_existing ?? [];
              const currentText = editing[p.id] ?? p.content;
              return (
                <motion.div
                  key={p.id}
                  className={cn(
                    "proto-draft-inbox-item",
                    isSelected && "proto-draft-inbox-item-selected",
                  )}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <div className="proto-draft-inbox-item-head">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(p.id)}
                      className="proto-draft-inbox-checkbox"
                      aria-label="Select for batch action"
                    />
                    <button
                      type="button"
                      className="proto-draft-inbox-expand"
                      onClick={() => toggleExpand(p.id)}
                      aria-label={isExpanded ? "Collapse" : "Expand"}
                    >
                      {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <KindPill kind={p.kind} />
                    <span className="proto-draft-inbox-agent">
                      <User size={10} /> {p.author_agent}
                    </span>
                    <span className="proto-draft-inbox-conf">
                      conf <strong>{p.confidence.toFixed(2)}</strong>
                    </span>
                    <span className="proto-draft-inbox-time">
                      <Clock size={10} /> {timeAgo(p.created_at)}
                    </span>
                    {similar.length > 0 && (
                      <span className="proto-draft-inbox-similar" title="Near-duplicate of existing memory">
                        <Link2 size={10} /> {similar.length} similar
                      </span>
                    )}
                  </div>

                  <div className="proto-draft-inbox-content">
                    {isExpanded ? (
                      <textarea
                        className="proto-draft-inbox-textarea"
                        value={currentText}
                        onChange={(e) => setEditing((m) => ({ ...m, [p.id]: e.target.value }))}
                        rows={Math.min(6, Math.max(2, currentText.split("\n").length))}
                      />
                    ) : (
                      <div className="proto-draft-inbox-preview">{p.content}</div>
                    )}
                    {p.proposal_reason && (
                      <div className="proto-draft-inbox-reason">
                        <Sparkles size={10} /> <em>{p.proposal_reason}</em>
                      </div>
                    )}
                    {isExpanded && p.tags.length > 0 && (
                      <div className="proto-draft-inbox-tags">
                        {p.tags.map((t) => <span key={t} className="proto-draft-inbox-tag">#{t}</span>)}
                      </div>
                    )}
                  </div>

                  {isExpanded && similar.length > 0 && (
                    <div className="proto-draft-inbox-similar-list">
                      <div className="proto-draft-inbox-similar-head">
                        <BookOpen size={11} /> Near-duplicate of existing:
                      </div>
                      {similar.map((s) => (
                        <div key={s.id} className="proto-draft-inbox-similar-row">
                          <span className="proto-draft-inbox-similar-sim">{s.similarity.toFixed(2)}</span>
                          <span className="proto-draft-inbox-similar-content">
                            [{s.kind}] {s.content}
                          </span>
                          <button
                            type="button"
                            className="proto-btn proto-draft-inbox-merge-btn"
                            onClick={() => handleAccept(p, s.id)}
                            disabled={isBusy}
                            title="Accept this proposal as an update that supersedes the existing memory"
                          >
                            {busy[p.id] === "merge"
                              ? <Loader2 size={11} className="animate-spin" />
                              : <Link2 size={11} />}
                            Merge
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="proto-draft-inbox-actions">
                    {isExpanded && (
                      <span className="proto-draft-inbox-edit-hint">
                        <Edit3 size={10} /> edited inline — changes apply on Accept
                      </span>
                    )}
                    <button
                      type="button"
                      className="proto-btn proto-draft-inbox-accept"
                      onClick={() => handleAccept(p)}
                      disabled={isBusy}
                    >
                      {busy[p.id] === "accept"
                        ? <Loader2 size={12} className="animate-spin" />
                        : <Check size={12} />}
                      Accept
                    </button>
                    <button
                      type="button"
                      className="proto-btn proto-draft-inbox-reject"
                      onClick={() => handleReject(p)}
                      disabled={isBusy}
                    >
                      {busy[p.id] === "reject"
                        ? <Loader2 size={12} className="animate-spin" />
                        : <X size={12} />}
                      Reject
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}

function KindPill({ kind }: { kind: string }) {
  const colors: Record<string, string> = {
    fact: "proto-draft-pill-fact",
    preference: "proto-draft-pill-preference",
    procedure: "proto-draft-pill-procedure",
    episode: "proto-draft-pill-episode",
    document_ref: "proto-draft-pill-doc",
  };
  return (
    <span className={cn("proto-draft-pill", colors[kind] || "proto-draft-pill-fact")}>
      {kind}
    </span>
  );
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
