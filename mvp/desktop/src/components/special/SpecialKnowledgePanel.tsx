import { useState, useEffect } from "react";
import { BookPlus, FolderOpen, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/cn";
import { specialIngestAsync, pickFolder } from "@/lib/electron";
import * as api from "@/lib/api";
import type { IngestStep } from "@/App";

type Props = {
  ingestBusy: boolean;
  ingestSteps: IngestStep[];
  ingestResult: { message: string; type: "success" | "error" } | null;
};

export function SpecialKnowledgePanel({ ingestBusy, ingestSteps, ingestResult }: Props) {
  const [folderPath, setFolderPath] = useState("");
  const [topicName, setTopicName] = useState("");
  const [topics, setTopics] = useState<api.SpecialKnowledgeTopic[]>([]);

  useEffect(() => {
    loadTopics();
  }, [ingestResult]);

  function loadTopics() {
    api.fetchSpecialKnowledge().then((d) => setTopics(d.topics)).catch(() => {});
  }

  async function handlePickFolder() {
    const p = await pickFolder();
    if (p) {
      setFolderPath(p);
      if (!topicName) {
        setTopicName(p.split("/").pop() || "");
      }
    }
  }

  async function handleIngest() {
    if (!folderPath || ingestBusy) return;
    await specialIngestAsync(folderPath, topicName || undefined);
  }

  const inputCls = "proto-form-input proto-form-input-mono flex-1 min-w-0";

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto">
        <div className="proto-page-content" style={{ maxWidth: 560 }}>
          <h1 className="proto-page-title">Special Knowledge</h1>
          <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 24, lineHeight: 1.6 }}>
            Ingest a folder of files (papers, code, docs) as a specialized topic.
            This enriches AI answers when your notes reference external materials.
          </p>

          {/* Folder selection */}
          <div className="proto-form-section">
            <div className="proto-form-field">
              <label className="proto-form-label">Folder</label>
              <div className="flex gap-2">
                <input type="text" value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="Select a folder..." className={inputCls} />
                <button type="button" onClick={handlePickFolder} className="proto-btn proto-btn-secondary shrink-0">
                  <FolderOpen size={14} /> Browse
                </button>
              </div>
            </div>
            <div className="proto-form-field">
              <label className="proto-form-label">Topic name</label>
              <input type="text" value={topicName} onChange={(e) => setTopicName(e.target.value)} placeholder="e.g. Attention Is All You Need" className="proto-form-input" />
              <p className="proto-form-hint">All files in the folder will be indexed under this topic.</p>
            </div>
          </div>

          <div style={{ marginBottom: 32 }}>
            <button type="button" onClick={handleIngest} disabled={ingestBusy || !folderPath} className="proto-btn proto-btn-primary disabled:opacity-30" style={{ width: "100%", justifyContent: "center" }}>
              {ingestBusy ? <Loader2 size={14} className="animate-spin" /> : <BookPlus size={14} />}
              Ingest as Special Knowledge
            </button>
          </div>

          {/* Pipeline progress (shared with IngestPanel via App state) */}
          <AnimatePresence>
            {ingestSteps.length > 0 && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="proto-pipeline" style={{ marginBottom: 24 }}>
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
              </motion.div>
            )}
          </AnimatePresence>

          {/* Existing special knowledge topics */}
          {topics.length > 0 && (
            <div>
              <h2 style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-muted)", marginBottom: 12 }}>
                Imported Topics
              </h2>
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
