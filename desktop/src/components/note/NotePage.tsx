import { useState, useEffect, useCallback, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Database, Tag, FolderOpen, Shuffle, ArrowDownToLine } from "lucide-react";
import { NoteEditor, type LineMeta } from "../editor/NoteEditor";
import { NoteSegments } from "./NoteSegments";
import { IngestDialog } from "./IngestDialog";
import { PackBadge } from "./PackBadge";
import { ReorganizeDialog } from "./ReorganizeDialog";
import { BookmarksButton } from "./BookmarksButton";
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
  buildVersion?: number;
  tags: { name: string; color?: string; desc?: string; segments: number }[];
  onTagsChanged?: () => void;
};

export function NotePage({ rawPath, notePath, onSetRawPath, onSetNotePath, onIngestComplete, ingestBusy, ingestSteps, ingestResult, buildVersion, tags, onTagsChanged }: Props) {
  const [showIngest, setShowIngest] = useState(false);
  const [showReorganize, setShowReorganize] = useState(false);
  const [activeBuild, setActiveBuild] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<{ start: number; end: number } | null>(null);
  const [showTags, setShowTags] = useState(() => localStorage.getItem("smartnote-show-tags") !== "false");
  const [recentDone, setRecentDone] = useState(false);
  const [lineMetaRows, setLineMetaRows] = useState<api.NoteLineMeta[]>([]);
  const [pendingPacks, setPendingPacks] = useState<number>(0);
  const [packsSinceFull, setPacksSinceFull] = useState<number>(0);
  const [packsRefreshKey, setPacksRefreshKey] = useState(0);

  // Build the line-number → meta map the editor reads. Deriving (not storing)
  // keeps the mapping in sync with whichever meta list arrived most recently.
  const lineMeta = useMemo<LineMeta>(() => {
    const m: LineMeta = new Map();
    for (const row of lineMetaRows) {
      if (row.line_no_last > 0) {
        m.set(row.line_no_last, {
          ts: row.ts,
          bookmark: row.bookmark || undefined,
          highlight: row.highlight_color || undefined,
        });
      }
    }
    return m;
  }, [lineMetaRows]);

  const bookmarks = useMemo(
    () => lineMetaRows.filter((r) => r.bookmark && r.line_no_last > 0),
    [lineMetaRows]
  );

  // Fetch line meta + pending pack count for the current file. Called on
  // mount, after save, and after apply/discard.
  const refreshNoteState = useCallback(async () => {
    if (!rawPath) return;
    try {
      const [meta, packs, stats] = await Promise.all([
        api.fetchNoteLineMeta(rawPath),
        api.fetchPacks(rawPath, "pending"),
        api.fetchPackStats(rawPath).catch(() => null),
      ]);
      setLineMetaRows(meta.lines);
      setPendingPacks(packs.pending_count);
      setPacksSinceFull(stats ? stats.applied_since_full : 0);
    } catch {
      /* offline / gateway down — silent */
    }
  }, [rawPath]);

  // Toggle: if line is already bookmarked (hash match), clear; else set.
  // We send the line content + number so the backend can upsert a row for
  // files that haven't been saved through /note/save yet.
  const handleToggleBookmark = useCallback(async (lineNo: number, lineText: string) => {
    if (!rawPath) return;
    const trimmed = lineText.trim();
    if (!trimmed) return;  // skip blank lines — they have no identity
    try {
      const hash = await api.lineHash(lineText);
      const existing = lineMetaRows.find((r) => r.line_hash === hash);
      const isBookmarked = Boolean(existing?.bookmark);
      await api.setLineMark(rawPath, hash, {
        bookmark: isBookmarked ? "" : trimmed.slice(0, 80),
        line_preview: trimmed,
        line_no: lineNo,
      });
      refreshNoteState();
    } catch (e) {
      console.warn("bookmark toggle failed:", e);
    }
  }, [rawPath, lineMetaRows, refreshNoteState]);

  const handleRemoveBookmark = useCallback(async (hash: string) => {
    if (!rawPath) return;
    try {
      await api.setLineMark(rawPath, hash, { bookmark: "" });
      refreshNoteState();
    } catch { /* silent */ }
  }, [rawPath, refreshNoteState]);

  useEffect(() => { refreshNoteState(); }, [refreshNoteState, packsRefreshKey]);

  // External-edit detection: poll /note/load every 20s. If the file was
  // changed outside SmartNote, the backend creates an 'external' pack which
  // the badge will then surface.
  useEffect(() => {
    if (!rawPath) return;
    // Initial load: ensures baseline md5 is recorded for this session.
    api.loadNote(rawPath).then(() => refreshNoteState()).catch(() => {});
    const id = setInterval(() => {
      api.loadNote(rawPath).then((r) => {
        if (r.external_pack_created) {
          setPacksRefreshKey((k) => k + 1);
        }
      }).catch(() => {});
    }, 20_000);
    return () => clearInterval(id);
  }, [rawPath, refreshNoteState]);

  useEffect(() => {
    api.fetchBuilds().then((d) => {
      const active = d.builds.find((b) => b.is_active);
      if (active) setActiveBuild(active.id);
    }).catch(() => {});
  }, [ingestResult]);

  // Keep the completion/error badge visible briefly after finishing.
  useEffect(() => {
    if (ingestBusy) { setRecentDone(false); return; }
    if (!ingestResult) return;
    setRecentDone(true);
    const t = setTimeout(() => setRecentDone(false), 4000);
    return () => clearTimeout(t);
  }, [ingestBusy, ingestResult]);

  const activeStep = ingestSteps.find((s) => s.status === "active");
  const showProgressPill = ingestBusy || recentDone;
  const progressLabel = ingestBusy
    ? (activeStep ? activeStep.label : "Starting ingest…")
    : (ingestResult?.type === "error" ? "Ingest failed" : "Ingest complete");
  const progressCount = ingestBusy && activeStep && activeStep.total > 0
    ? `${activeStep.current}/${activeStep.total}`
    : "";

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
    // Route through the gateway so the backend creates a pending ingest
    // pack + stamps per-line ts. The backend also writes the file — we no
    // longer go through Electron's writeFile here.
    try {
      await api.saveNote(rawPath, content);
      refreshNoteState();
    } catch {
      /* silent — dirty flag stays true if the backend is unreachable */
    }
  }, [rawPath, refreshNoteState]);

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
          {packsSinceFull > 0 && (
            <button
              type="button"
              onClick={() => setShowIngest(true)}
              className="proto-note-header-progress proto-note-header-progress-warning"
              title={`${packsSinceFull} pack${packsSinceFull === 1 ? "" : "s"} applied since last full ingest — AI classification is stale. Click to run a full rebuild.`}
            >
              <span className="proto-note-header-progress-dot" />
              <span>{packsSinceFull} since full</span>
            </button>
          )}
          <AnimatePresence>
            {showProgressPill && (
              <motion.button
                key="ingest-progress-pill"
                type="button"
                onClick={() => setShowIngest(true)}
                initial={{ opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
                className={cn(
                  "proto-note-header-progress",
                  ingestBusy && "proto-note-header-progress-active",
                  !ingestBusy && ingestResult?.type === "success" && "proto-note-header-progress-done",
                  !ingestBusy && ingestResult?.type === "error" && "proto-note-header-progress-error",
                )}
                title="Ingest pipeline — click for details"
              >
                <span className="proto-note-header-progress-dot" />
                <span>{progressLabel}</span>
                {progressCount && <span className="proto-note-header-progress-count">{progressCount}</span>}
              </motion.button>
            )}
          </AnimatePresence>
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
            onClick={() => setShowReorganize(true)}
            className="proto-note-header-icon-btn"
            title="Reorganize note by tag — destructive rewrite with snapshot"
          >
            <Shuffle size={14} strokeWidth={2} />
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
              <NoteSegments refreshKey={`${ingestResult?.message ?? ""}|${buildVersion ?? 0}`} tags={tags} onScrollToLine={(start, end) => setScrollTarget({ start, end })} onTagsChanged={onTagsChanged} />
            </motion.div>
          )}
        </AnimatePresence>
        <div className="proto-note-editor-area">
          <NoteEditor
            filePath={rawPath}
            onSave={handleSave}
            onDirty={setDirty}
            scrollToRange={scrollTarget}
            lineMeta={lineMeta}
            onToggleBookmark={handleToggleBookmark}
          />
          {rawPath && (
            <div className="proto-note-floating-stack">
              <button
                type="button"
                className="proto-bookmarks-badge"
                onClick={() => setScrollTarget({ start: 1_000_000_000, end: 1_000_000_000 })}
                title="Jump to the latest (bottom) of the note"
                aria-label="Jump to bottom"
              >
                <ArrowDownToLine size={14} strokeWidth={2} />
              </button>
              <BookmarksButton
                bookmarks={bookmarks}
                onJumpToLine={(line) => setScrollTarget({ start: line, end: line })}
                onRemove={handleRemoveBookmark}
              />
              <PackBadge
                rawPath={rawPath}
                pendingCount={pendingPacks}
                onChanged={() => setPacksRefreshKey((k) => k + 1)}
                onJumpToLine={(line) => setScrollTarget({ start: line, end: line })}
              />
            </div>
          )}
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

      <ReorganizeDialog
        rawPath={rawPath}
        notePath={notePath}
        open={showReorganize}
        onClose={() => setShowReorganize(false)}
        onApproved={() => {
          refreshNoteState();
          onIngestComplete();
        }}
      />
    </div>
  );
}
