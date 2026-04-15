import { useState, useEffect, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Database, Tag, MoreHorizontal } from "lucide-react";
import { NoteEditor } from "../editor/NoteEditor";
import { NoteSegments } from "./NoteSegments";
import { IngestDialog } from "./IngestDialog";
import { cn } from "@/lib/cn";
import { pickRawFile, saveRawPathForHotkey } from "@/lib/electron";
import * as api from "@/lib/api";
import type { IngestStep } from "@/App";

type Props = {
  rawPath: string;
  notePath: string;
  onSetRawPath: (p: string) => void;
  onSetNotePath: (p: string) => void;
  onIngestComplete: () => void;
  ingestBusy: boolean;
  ingestSteps: IngestStep[];
  ingestResult: { message: string; type: "success" | "error" } | null;
  tags: { name: string; color?: string; desc?: string; segments: number }[];
  onTagsChanged?: () => void;
};

export function NotePage({ rawPath, notePath, onSetRawPath, onSetNotePath, onIngestComplete, ingestBusy, ingestSteps, ingestResult, tags, onTagsChanged }: Props) {
  const [showIngest, setShowIngest] = useState(false);
  const [activeBuild, setActiveBuild] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<number | null>(null);
  const [showTags, setShowTags] = useState(() => localStorage.getItem("intellinote-show-tags") !== "false");

  useEffect(() => {
    api.fetchBuilds().then((d) => {
      const active = d.builds.find((b) => b.is_active);
      if (active) setActiveBuild(active.id);
    }).catch(() => {});
  }, [ingestResult]);

  async function handlePickFile() {
    const p = await pickRawFile();
    if (p) {
      onSetRawPath(p);
      saveRawPathForHotkey(p).catch(() => {});
      const dir = p.replace(/\/[^/]+$/, "");
      onSetNotePath(`${dir}/note.md`);
    }
  }

  const handleSave = useCallback(async (content: string) => {
    try {
      if (window.desktop) {
        await window.desktop.invoke("write_file", { path: rawPath, content });
      }
    } catch {}
  }, [rawPath]);

  if (!rawPath) {
    return (
      <div className="proto-editor-empty">
        <div className="proto-editor-empty-inner">
          <h2 className="proto-editor-empty-title">Open a Note</h2>
          <p className="proto-editor-empty-desc">
            Select your raw note file from iCloud Drive or local storage. This will be your primary knowledge source.
          </p>
          <button type="button" onClick={handlePickFile} className="proto-btn proto-btn-primary proto-editor-empty-action">
            Choose file
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="proto-note-page">
      {/* Minimal header — Linear style */}
      <div className="proto-note-header">
        <div className="proto-note-header-left">
          <span className="proto-note-header-name">{rawPath.split("/").pop()}</span>
          {dirty && <span className="proto-note-header-dot" />}
          {activeBuild && (
            <span className="proto-note-header-build">v{activeBuild}</span>
          )}
        </div>
        <div className="proto-note-header-actions">
          <button
            type="button"
            onClick={() => { const next = !showTags; setShowTags(next); localStorage.setItem("intellinote-show-tags", String(next)); }}
            className={cn("proto-note-header-icon-btn", showTags && "proto-note-header-icon-btn-active")}
            title={showTags ? "Hide tags" : "Show tags"}
          >
            <Tag size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => setShowIngest(true)}
            className="proto-note-header-icon-btn"
            title="Ingest"
          >
            <Database size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={handlePickFile}
            className="proto-note-header-icon-btn"
            title="Change file"
          >
            <MoreHorizontal size={14} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Editor + Tags panel */}
      <div className="proto-note-body">
        <div className="proto-note-editor-area">
          <NoteEditor filePath={rawPath} onSave={handleSave} onDirty={setDirty} scrollToLine={scrollTarget} />
        </div>
        <AnimatePresence initial={false}>
          {showTags && (
            <motion.div
              className="proto-note-segments-wrap"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 300, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.15, ease: [0.25, 1, 0.5, 1] }}
            >
              <NoteSegments refreshKey={ingestResult?.message} tags={tags} onScrollToLine={(line) => setScrollTarget(line)} onTagsChanged={onTagsChanged} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {showIngest && (
        <IngestDialog
          rawPath={rawPath}
          notePath={notePath}
          ingestBusy={ingestBusy}
          ingestSteps={ingestSteps}
          ingestResult={ingestResult}
          onClose={() => setShowIngest(false)}
          onIngestComplete={onIngestComplete}
        />
      )}
    </div>
  );
}
