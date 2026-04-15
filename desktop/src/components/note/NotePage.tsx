import { useState, useEffect, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Database, Tag, FolderOpen } from "lucide-react";
import { NoteEditor } from "../editor/NoteEditor";
import { NoteSegments } from "./NoteSegments";
import { IngestDialog } from "./IngestDialog";
import { cn } from "@/lib/cn";
import { pickRawFile, saveRawPathForHotkey, writeFile } from "@/lib/electron";
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
  const [scrollTarget, setScrollTarget] = useState<{ start: number; end: number } | null>(null);
  const [showTags, setShowTags] = useState(() => localStorage.getItem("smartnote-show-tags") !== "false");

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
      await writeFile(rawPath, content);
    } catch {}
  }, [rawPath]);

  if (!rawPath) {
    return (
      <div className="proto-editor-empty">
        <div className="proto-editor-empty-inner">
          <FolderOpen size={28} className="proto-editor-empty-icon" />
          <h2 className="proto-editor-empty-title">Open a Note</h2>
          <p className="proto-editor-empty-desc">
            Select a raw note file (.md, .txt) as your knowledge source.
          </p>
          <button type="button" onClick={handlePickFile} className="proto-btn proto-btn-primary">
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
            onClick={() => { const next = !showTags; setShowTags(next); localStorage.setItem("smartnote-show-tags", String(next)); }}
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
            <FolderOpen size={14} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Tags strip + Editor */}
      <div className="proto-note-body">
        <AnimatePresence initial={false}>
          {showTags && (
            <motion.div
              className="proto-note-tags-strip"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1, overflow: "visible" }}
              exit={{ height: 0, opacity: 0, overflow: "hidden" }}
              transition={{ duration: 0.15, ease: [0.25, 1, 0.5, 1] }}
              style={{ overflow: "hidden" }}
            >
              <NoteSegments refreshKey={ingestResult?.message} tags={tags} onScrollToLine={(start, end) => setScrollTarget({ start, end })} onTagsChanged={onTagsChanged} />
            </motion.div>
          )}
        </AnimatePresence>
        <div className="proto-note-editor-area">
          <NoteEditor filePath={rawPath} onSave={handleSave} onDirty={setDirty} scrollToRange={scrollTarget} />
        </div>
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
