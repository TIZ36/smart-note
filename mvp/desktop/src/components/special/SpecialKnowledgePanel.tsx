import { useState, useEffect } from "react";
import { BookPlus, FolderOpen, File, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { specialIngestAsync, pickFolder, pickRawFile } from "@/lib/electron";
import * as api from "@/lib/api";
import type { IngestStep } from "@/App";

type Props = {
  ingestBusy: boolean;
  ingestSteps: IngestStep[];
  ingestResult: { message: string; type: "success" | "error" } | null;
};

export function SpecialKnowledgePanel({ ingestBusy, ingestSteps, ingestResult }: Props) {
  const [path, setPath] = useState("");
  const [topicName, setTopicName] = useState("");
  const [topics, setTopics] = useState<api.SpecialKnowledgeTopic[]>([]);

  useEffect(() => { loadTopics(); }, [ingestResult]);

  function loadTopics() {
    api.fetchSpecialKnowledge().then((d) => setTopics(d.topics)).catch(() => {});
  }

  async function handlePickFolder() {
    const p = await pickFolder();
    if (p) { setPath(p); if (!topicName) setTopicName(p.split("/").pop() || ""); }
  }

  async function handlePickFile() {
    const p = await pickRawFile();
    if (p) { setPath(p); if (!topicName) setTopicName(p.split("/").pop()?.replace(/\.\w+$/, "") || ""); }
  }

  async function handleIngest() {
    if (!path || ingestBusy) return;
    await specialIngestAsync(path, topicName || undefined);
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto">
        <div className="proto-page-content" style={{ maxWidth: 560 }}>
          <h1 className="proto-page-title">Special Knowledge</h1>

          {topics.length === 0 && !path && (
            <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 24, lineHeight: 1.6 }}>
              No special knowledge imported yet. Import a folder or file of reference materials (papers, docs, code) to enrich AI answers.
            </p>
          )}

          {/* Import section */}
          <div className="proto-form-section">
            <div className="proto-form-field">
              <label className="proto-form-label">Source (file or folder)</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input type="text" value={path} onChange={(e) => setPath(e.target.value)} placeholder="Select file or folder..." className="proto-form-input proto-form-input-mono" style={{ flex: 1, minWidth: 0 }} />
                <button type="button" onClick={handlePickFolder} className="proto-btn proto-btn-secondary" style={{ flexShrink: 0 }}>
                  <FolderOpen size={13} /> Folder
                </button>
                <button type="button" onClick={handlePickFile} className="proto-btn proto-btn-secondary" style={{ flexShrink: 0 }}>
                  <File size={13} /> File
                </button>
              </div>
            </div>
            <div className="proto-form-field">
              <label className="proto-form-label">Topic name</label>
              <input type="text" value={topicName} onChange={(e) => setTopicName(e.target.value)} placeholder="e.g. Attention Is All You Need" className="proto-form-input" />
              <p className="proto-form-hint">Use @topic_name in search to include this knowledge.</p>
            </div>
          </div>

          <div style={{ marginBottom: 24 }}>
            <button type="button" onClick={handleIngest} disabled={ingestBusy || !path} className="proto-btn proto-btn-primary disabled:opacity-30" style={{ width: "100%", justifyContent: "center" }}>
              {ingestBusy ? <Loader2 size={14} className="animate-spin" /> : <BookPlus size={14} />}
              Import as Special Knowledge
            </button>
          </div>

          {/* Pipeline */}
          {ingestSteps.length > 0 && (
            <div className="proto-pipeline" style={{ marginBottom: 24 }}>
              <div className="proto-pipeline-header" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span>Pipeline</span>
                {ingestBusy && <Loader2 size={12} className="animate-spin text-[var(--color-accent)] ml-auto" />}
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
                    <span style={{ fontSize: 13 }}>{step.label}</span>
                    {step.detail && <p className="proto-step-detail">{step.detail}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Result */}
          {ingestResult && (
            <div style={{ padding: "8px 12px", borderRadius: "var(--radius-proto)", border: "1px solid var(--color-border)", fontSize: 13, marginBottom: 24 }} className={ingestResult.type === "success" ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}>
              {ingestResult.type === "success" ? "\u2713" : "\u2717"} {ingestResult.message}
            </div>
          )}

          {/* Imported topics */}
          {topics.length > 0 && (
            <div>
              <h3 style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-muted)", marginBottom: 8 }}>Imported Topics</h3>
              <p className="proto-form-hint" style={{ marginBottom: 12 }}>Use <code style={{ fontSize: 12, padding: "1px 4px", background: "var(--color-bg-elevated)", borderRadius: 3 }}>@topic_name</code> in search to include.</p>
              {topics.map((t) => (
                <div key={t.id} className="proto-version-item">
                  <div className={cn("proto-tag-dot", "proto-tag-dot-purple")} />
                  <div className="flex-1 min-w-0">
                    <div className="proto-version-id">{t.topic}</div>
                    <div className="proto-version-meta">{t.summary}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
