import { useState, useEffect } from "react";
import { BookOpen, FolderOpen, FileText, Loader2, Plus, X, Trash2, Code, FileSearch, Archive } from "lucide-react";
import { cn } from "@/lib/cn";
import { specialIngestAsync, pickFolder, pickPdf } from "@/lib/electron";
import * as api from "@/lib/api";
import type { WikiCategory } from "@/lib/api";
import type { IngestStep } from "@/App";

const CATEGORY_META: Record<WikiCategory, { label: string; icon: typeof BookOpen }> = {
  research: { label: "Research", icon: FileSearch },
  codebase: { label: "Codebase", icon: Code },
  docs: { label: "Docs", icon: BookOpen },
  reference: { label: "Reference", icon: Archive },
};

type Props = {
  ingestBusy: boolean;
  ingestSteps: IngestStep[];
  ingestResult: { message: string; type: "success" | "error" } | null;
  onTopicsChanged?: (count: number) => void;
};

export function SpecialKnowledgePanel({ ingestBusy, ingestSteps, ingestResult, onTopicsChanged }: Props) {
  const [topics, setTopics] = useState<api.SpecialKnowledgeTopic[]>([]);
  const [showDialog, setShowDialog] = useState(false);

  useEffect(() => { loadTopics(); }, [ingestResult]);

  function loadTopics() {
    api.fetchSpecialKnowledge().then((d) => {
      setTopics(d.topics);
      onTopicsChanged?.(d.topics.length);
    }).catch(() => {});
  }

  async function handleDelete(topic: string) {
    try {
      await api.deleteSpecialKnowledge(topic);
      loadTopics();
    } catch {}
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="proto-view-header">
        <BookOpen size={16} strokeWidth={2} />
        <span>Wiki</span>
        <span className="proto-wiki-header-count">
          {topics.length} {topics.length === 1 ? "topic" : "topics"}
        </span>
        {/* Inline ingest status when dialog is closed */}
        {ingestBusy && !showDialog && (
          <span className="proto-wiki-header-status" onClick={() => setShowDialog(true)}>
            <Loader2 size={12} className="animate-spin" />
            Importing...
          </span>
        )}
        {ingestResult && !ingestBusy && !showDialog && (
          <span className={cn("proto-wiki-header-status", ingestResult.type === "success" ? "proto-wiki-header-status-success" : "proto-wiki-header-status-error")}>
            {ingestResult.type === "success" ? "\u2713" : "\u2717"} {ingestResult.message}
          </span>
        )}
        <div style={{ marginLeft: "auto" }}>
          <button
            type="button"
            onClick={() => setShowDialog(true)}
            className="proto-btn proto-btn-primary"
            style={{ fontSize: 12, padding: "4px 10px" }}
          >
            <Plus size={13} />
            Import
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Topic list grouped by category */}
        {topics.length > 0 ? (
          <div className="proto-wiki-topic-list">
            {(["research", "codebase", "docs", "reference"] as WikiCategory[])
              .filter((cat) => topics.some((t) => (t.category || "reference") === cat))
              .map((cat) => {
                const meta = CATEGORY_META[cat];
                const Icon = meta.icon;
                const catTopics = topics.filter((t) => (t.category || "reference") === cat);
                return (
                  <div key={cat}>
                    <div className="proto-wiki-category-header">
                      <Icon size={13} />
                      <span>{meta.label}</span>
                      <span className="proto-wiki-category-count">{catTopics.length}</span>
                    </div>
                    {catTopics.map((t) => (
                      <div key={t.id} className="proto-wiki-topic-item">
                        <div className="proto-wiki-topic-body">
                          <div className="proto-wiki-topic-name">{t.topic}</div>
                          {t.summary && <div className="proto-wiki-topic-summary">{t.summary}</div>}
                          <div className="proto-wiki-topic-meta">
                            <span>{t.folder}</span>
                            <span>{new Date(t.created_at).toLocaleDateString()}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleDelete(t.topic)}
                          className="proto-wiki-topic-delete"
                          title={`Delete ${t.topic}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })}
          </div>
        ) : (
          <div className="proto-wiki-empty">
            <BookOpen size={32} strokeWidth={1.5} className="proto-wiki-empty-icon" />
            <p className="proto-wiki-empty-title">No wiki topics yet</p>
            <p className="proto-wiki-empty-desc">
              Import reference materials — papers, docs, code — to enrich your AI search answers.
            </p>
            <button type="button" onClick={() => setShowDialog(true)} className="proto-btn proto-btn-secondary" style={{ marginTop: 16 }}>
              <Plus size={14} />
              Import your first topic
            </button>
          </div>
        )}
      </div>

      {/* Import dialog */}
      {showDialog && (
        <WikiImportDialog
          ingestBusy={ingestBusy}
          ingestSteps={ingestSteps}
          ingestResult={ingestResult}
          onClose={() => setShowDialog(false)}
        />
      )}
    </div>
  );
}

/* ── Import Dialog ── */

function WikiImportDialog({ ingestBusy, ingestSteps, ingestResult, onClose }: {
  ingestBusy: boolean;
  ingestSteps: IngestStep[];
  ingestResult: { message: string; type: "success" | "error" } | null;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [topicName, setTopicName] = useState("");

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !ingestBusy) onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, ingestBusy]);

  async function handlePickFolder() {
    const p = await pickFolder();
    if (p) { setPath(p); if (!topicName) setTopicName(p.split("/").pop() || ""); }
  }

  async function handlePickPdf() {
    const p = await pickPdf();
    if (p) { setPath(p); if (!topicName) setTopicName(p.split("/").pop()?.replace(/\.pdf$/i, "") || ""); }
  }

  const isPdf = path.toLowerCase().endsWith(".pdf");

  async function handleIngest() {
    if (!path || ingestBusy) return;
    if (isPdf) {
      await specialIngestAsync({ filePath: path, topicName: topicName || undefined });
    } else {
      await specialIngestAsync({ folderPath: path, topicName: topicName || undefined });
    }
    setPath("");
    setTopicName("");
  }

  const hasProgress = ingestSteps.length > 0 && ingestSteps.some(s => s.status !== "pending");

  return (
    <div className="proto-dialog-overlay" onClick={() => !ingestBusy && onClose()}>
      <div className="proto-dialog" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
        <div className="proto-dialog-header">
          <span>Import to Wiki</span>
          <button type="button" onClick={onClose} className="proto-dialog-close"><X size={14} /></button>
        </div>

        <div className="proto-dialog-body">
          {/* Source selection */}
          <div className="proto-form-field">
            <label className="proto-form-label">Source (file or folder)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="text" value={path} onChange={(e) => setPath(e.target.value)} placeholder="Select file or folder..." className="proto-form-input proto-form-input-mono" style={{ flex: 1, minWidth: 0 }} />
              <button type="button" onClick={handlePickFolder} className="proto-btn proto-btn-secondary" style={{ flexShrink: 0 }}>
                <FolderOpen size={13} /> Folder
              </button>
              <button type="button" onClick={handlePickPdf} className="proto-btn proto-btn-secondary" style={{ flexShrink: 0 }}>
                <FileText size={13} /> PDF
              </button>
            </div>
          </div>

          {/* Topic name + import button */}
          <div className="proto-form-field">
            <label className="proto-form-label">Topic name</label>
            <input type="text" value={topicName} onChange={(e) => setTopicName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleIngest()} placeholder="e.g. Attention Is All You Need" className="proto-form-input" />
            <p className="proto-form-hint">Use <code style={{ fontSize: 12, padding: "1px 4px", background: "var(--color-bg-elevated)", borderRadius: 3 }}>@topic_name</code> in search to focus on this topic.</p>
          </div>

          <button type="button" onClick={handleIngest} disabled={ingestBusy || !path} className="proto-btn proto-btn-primary" style={{ width: "100%", justifyContent: "center", marginBottom: hasProgress || ingestResult ? 20 : 0 }}>
            {ingestBusy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {ingestBusy ? "Importing..." : "Import"}
          </button>

          {/* Pipeline progress */}
          {hasProgress && (
            <div className="proto-pipeline" style={{ marginBottom: ingestResult ? 16 : 0 }}>
              <div className="proto-pipeline-header" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span>Pipeline</span>
                {ingestBusy && <Loader2 size={12} className="animate-spin text-[var(--color-accent)] ml-auto" />}
                {!ingestBusy && ingestResult && (
                  <span className={cn("ml-auto text-[11px] font-medium", ingestResult.type === "success" ? "text-[var(--color-success)]" : "text-[var(--color-danger)]")}>
                    {ingestResult.type === "success" ? "Done" : "Failed"}
                  </span>
                )}
              </div>
              {ingestSteps.map((step) => (
                <div key={step.key} className={cn("proto-pipeline-step", step.status === "done" && "proto-pipeline-step-done", step.status === "pending" && "proto-pipeline-step-pending", step.status === "active" && "proto-pipeline-step-active")}>
                  <div className="proto-pipeline-step-icon">
                    {step.status === "done" && "\u2713"}
                    {step.status === "active" && "\u25CF"}
                    {step.status === "pending" && "\u25CB"}
                    {step.status === "error" && "\u2717"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className={cn("text-[13px]", step.status === "active" ? "text-[var(--color-text-primary)]" : step.status === "done" ? "text-[var(--color-text-secondary)]" : "text-[var(--color-text-muted)] opacity-40")}>
                      {step.label}
                    </span>
                    {step.status === "active" && step.total > 0 && (
                      <span style={{ fontSize: 11, color: "var(--color-accent)", marginLeft: 8 }}>{step.current}/{step.total}</span>
                    )}
                    {step.detail && <p className="proto-step-detail" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{step.detail}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Result */}
          {ingestResult && (
            <div className={cn("proto-wiki-result", ingestResult.type === "success" ? "proto-wiki-result-success" : "proto-wiki-result-error")} style={{ padding: "8px 12px", borderRadius: "var(--radius-proto)", border: "1px solid var(--color-border)", fontSize: 13 }}>
              {ingestResult.type === "success" ? "\u2713" : "\u2717"} {ingestResult.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
