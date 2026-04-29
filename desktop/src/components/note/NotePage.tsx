import { useState, useEffect, useCallback, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  FolderOpen, Shuffle, ArrowDownToLine, Save, CloudUpload,
  Plus, Minus,
} from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { NoteEditor, type LineMeta } from "../editor/NoteEditor";
import { IngestDialog } from "./IngestDialog";
import { PackBadge } from "./PackBadge";
import { ReorganizeDialog } from "./ReorganizeDialog";
import { BookmarksButton } from "./BookmarksButton";
import { QuickSearch } from "./QuickSearch";
import { NoteViewDialog } from "./NoteViewDialog";
import { type SidebarViewItem } from "./NoteViewSidebar";
import { NoteViewStrip } from "./NoteViewStrip";
import { cn } from "@/lib/cn";
import { pickRawFile, saveRawPathForHotkey, installSampleNote, readFileFull } from "@/lib/electron";
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

/* Build a short, human-readable label for an AI segment entry in the
   sidebar. Prefers topic_name (most specific), falls back to the first
   line of summary, then to a bare line count. The sidebar already renders
   line_start in its own column, so we don't repeat it here. */
function buildAutoViewLabel(seg: api.NoteSegment): string {
  const span = seg.line_end - seg.line_start + 1;
  const spanSuffix = span > 1 ? `  · ${span}L` : "";
  const topic = (seg.topic_name || "").trim();
  if (topic) return `${topic}${spanSuffix}`;
  const summary = (seg.summary || "").split("\n")[0].trim();
  if (summary) return `${summary.slice(0, 80)}${spanSuffix}`;
  return `(segment${spanSuffix})`;
}

export function NotePage({ rawPath, notePath, onSetRawPath, onSetNotePath, onIngestComplete, ingestBusy, ingestSteps, ingestResult, buildVersion, tags, onTagsChanged }: Props) {
  const [showIngest, setShowIngest] = useState(false);
  const [showReorganize, setShowReorganize] = useState(false);
  const [showQuickSearch, setShowQuickSearch] = useState(false);
  // v3: views + AI tags live inline as a chip strip below the
  // breadcrumb (no foldable sidebar). One coherent surface.
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "ok" | "err">("idle");

  // ── View state ──
  // `views` is the list of persisted custom lenses for the current file.
  // `activeViewId === null` means the default (unfiltered) view is active.
  // `viewLines` is the resolved member set for the active view: line numbers
  // (1-based) that belong to it, plus a parallel hash map for "add/remove
  // selected lines" actions.
  const [views, setViews] = useState<api.NoteView[]>([]);
  // activeKey encodes both kinds of views so one state covers both tabs:
  //   null         → Default (unfiltered source)
  //   "user:<id>"  → user-created view (CRUD-able)
  //   "tag:<name>" → AI-derived auto-view (from tag_segments, read-only)
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [viewLines, setViewLines] = useState<api.ViewResolvedLine[]>([]);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [viewDialogInitial, setViewDialogInitial] = useState<api.NoteView | null>(null);
  const [editorSelection, setEditorSelection] = useState<{ lines: number[]; texts: string[] }>({ lines: [], texts: [] });
  // All AI-classified segments (flat list); used to derive auto-views and
  // their member line numbers. Loaded once and refreshed when ingestResult
  // changes (same cadence as the old tag strip).
  const [tagSegments, setTagSegments] = useState<api.NoteSegment[]>([]);
  const [activeBuild, setActiveBuild] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<{ start: number; end: number } | null>(null);
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

  // ── Views: load list whenever the file changes ──
  const refreshViews = useCallback(async () => {
    if (!rawPath) { setViews([]); return; }
    try {
      const { views } = await api.fetchViews(rawPath);
      setViews(views);
    } catch {
      setViews([]);
    }
  }, [rawPath]);

  // Load AI-classified segments — powers the auto-views in the sidebar
  // (formerly the tag strip). Refreshes on the same cadence as tags/builds.
  useEffect(() => {
    api.fetchAllTagSegments()
      .then((d) => setTagSegments(d.segments))
      .catch(() => setTagSegments([]));
  }, [ingestResult, buildVersion]);

  useEffect(() => {
    setActiveKey(null);
    setViewLines([]);
    refreshViews();
  }, [rawPath, refreshViews]);

  // Decode the active key into its kind + identifier once, so downstream
  // memos don't each re-parse the string.
  const activeKind: "default" | "user" | "auto" =
    activeKey === null ? "default"
      : activeKey.startsWith("user:") ? "user"
      : "auto";
  const activeUserId = activeKind === "user" ? Number(activeKey!.slice(5)) : null;
  const activeTagName = activeKind === "auto" ? activeKey!.slice(4) : null;

  const activeView = useMemo(
    () => (activeUserId != null ? views.find((v) => v.id === activeUserId) || null : null),
    [views, activeUserId],
  );

  // Resolve user-view members on the backend; auto-views derive members
  // directly from tag_segments (no hashing needed — AI already gave line
  // ranges for the active build).
  useEffect(() => {
    if (!rawPath) { setViewLines([]); return; }
    if (activeKind === "default") { setViewLines([]); return; }
    if (activeKind === "user" && activeUserId != null) {
      let cancelled = false;
      api.resolveView(activeUserId, rawPath).then((r) => {
        if (!cancelled) setViewLines(r.lines);
      }).catch(() => { if (!cancelled) setViewLines([]); });
      return () => { cancelled = true; };
    }
    if (activeKind === "auto" && activeTagName) {
      // Sidebar member list: one entry per segment (not per line) so the
      // user sees the distinct topic_name / summary the AI attached to each
      // range. Clicking jumps to the segment's first line. The editor's
      // dim set is expanded to every line separately below.
      const segs = tagSegments.filter(
        (s) => s.tag === activeTagName && s.source_file === rawPath
      );
      const rows: api.ViewResolvedLine[] = segs
        .slice()
        .sort((a, b) => a.line_start - b.line_start)
        .map((seg) => ({
          line_no: seg.line_start,
          line_hash: `tag:${activeTagName}:${seg.id}`,
          text: buildAutoViewLabel(seg),
          source: "ai" as const,
        }));
      setViewLines(rows);
    }
  }, [activeKind, activeUserId, activeTagName, rawPath, lineMetaRows, tagSegments]);

  // Lines that should NOT be dimmed. For user views this is just the
  // resolved member lines. For auto views we expand each segment's
  // [line_start, line_end] so the whole range stays bright, even though
  // the sidebar only shows one entry per segment.
  const memberLineSet = useMemo<Set<number> | null>(() => {
    if (activeKind === "default") return null;
    if (activeKind === "auto" && activeTagName) {
      const set = new Set<number>();
      for (const seg of tagSegments) {
        if (seg.tag !== activeTagName || seg.source_file !== rawPath) continue;
        for (let n = seg.line_start; n <= seg.line_end; n++) set.add(n);
      }
      return set;
    }
    return new Set(viewLines.map((l) => l.line_no));
  }, [activeKind, activeTagName, viewLines, tagSegments, rawPath]);

  const memberHashSet = useMemo<Set<string>>(
    () => new Set(viewLines.map((l) => l.line_hash)),
    [viewLines],
  );

  // Build the sidebar's unified item list: AI auto-views (one per tag that
  // has ≥1 segment in the current file) + user views. Auto-views appear
  // only when they have members in this file — empty tags are hidden.
  const sidebarItems = useMemo<SidebarViewItem[]>(() => {
    const items: SidebarViewItem[] = [];
    // Count segment lines per tag for the current file — drives the count
    // badge. Tags without any current segments still show (they're taxonomy
    // buckets waiting for the next enrich pass), just with a 0.
    const tagCounts = new Map<string, { lines: number; summary?: string }>();
    for (const seg of tagSegments) {
      if (seg.source_file !== rawPath) continue;
      const cur = tagCounts.get(seg.tag) || { lines: 0, summary: undefined };
      cur.lines += Math.max(0, seg.line_end - seg.line_start + 1);
      if (!cur.summary && seg.summary) cur.summary = seg.summary;
      tagCounts.set(seg.tag, cur);
    }
    // Use the tag-table ordering as canonical, then append any tags that
    // only exist as segments (shouldn't happen normally but defensive).
    const orderedNames = [
      ...tags.map((t) => t.name),
      ...Array.from(tagCounts.keys()).filter((n) => !tags.some((t) => t.name === n)),
    ];
    for (const name of orderedNames) {
      const meta = tagCounts.get(name);
      const tagInfo = tags.find((t) => t.name === name);
      items.push({
        kind: "tag",
        key: `tag:${name}`,
        tag: name,
        color: tagInfo?.color,
        summary: meta?.summary,
        memberCount: meta?.lines ?? 0,
      });
    }
    for (const v of views) {
      items.push({ kind: "user", key: `user:${v.id}`, view: v });
    }
    return items;
  }, [views, tags, tagSegments, rawPath]);

  // Enrich-tag CRUD — routes to the existing /tags API. onTagsChanged is
  // how the parent (App) refreshes the tags list prop we receive.
  const handleAddTag = useCallback(async (name: string, desc: string) => {
    try { await api.addTag(name, desc); onTagsChanged?.(); }
    catch (e) { console.warn("add tag failed:", e); }
  }, [onTagsChanged]);

  const handleDeleteTag = useCallback(async (name: string) => {
    try {
      await api.deleteTag(name);
      if (activeKey === `tag:${name}`) setActiveKey(null);
      onTagsChanged?.();
    } catch (e) { console.warn("delete tag failed:", e); }
  }, [activeKey, onTagsChanged]);

  // Create or update a view. `runPopulate` kicks off a backend populate
  // pass right after the CRUD call so the user sees results immediately.
  const handleViewSubmit = useCallback(async (data: {
    name: string;
    rule: api.ViewRule;
    display: api.ViewDisplay;
    runPopulate: boolean;
  }) => {
    if (!rawPath) return;
    try {
      let view: api.NoteView;
      if (viewDialogInitial) {
        const { view: v } = await api.updateView(viewDialogInitial.id, {
          name: data.name, rule: data.rule, display: data.display,
        });
        view = v;
      } else {
        const { view: v } = await api.createView(rawPath, data.name, data.rule, data.display);
        view = v;
      }
      if (data.runPopulate) {
        await api.populateView(view.id, { rule: data.rule, replace: true });
      }
      setViewDialogOpen(false);
      setViewDialogInitial(null);
      setActiveKey(`user:${view.id}`);
      await refreshViews();
    } catch (e) {
      console.warn("view submit failed:", e);
    }
  }, [rawPath, viewDialogInitial, refreshViews]);

  const handleDeleteView = useCallback(async (v: api.NoteView) => {
    try {
      await api.deleteView(v.id);
      if (activeKey === `user:${v.id}`) setActiveKey(null);
      await refreshViews();
    } catch (e) { console.warn("delete view failed:", e); }
  }, [activeKey, refreshViews]);

  const handleRepopulate = useCallback(async (v: api.NoteView) => {
    try {
      await api.populateView(v.id, { replace: true });
      await refreshViews();
      if (activeKey === `user:${v.id}`) {
        const r = await api.resolveView(v.id, rawPath);
        setViewLines(r.lines);
      }
    } catch (e) { console.warn("repopulate failed:", e); }
  }, [activeKey, rawPath, refreshViews]);

  // Add / remove the editor's currently-selected lines to/from the active
  // view. Uses the same line_hash convention as bookmarks so edits that
  // move lines around still keep membership intact.
  const handleAddSelectionToView = useCallback(async () => {
    if (!activeView || editorSelection.lines.length === 0) return;
    const add = await Promise.all(
      editorSelection.texts.map(async (t, i) => ({
        line_hash: await api.lineHash(t),
        line_preview: t.trim().slice(0, 200),
        line_no: editorSelection.lines[i],
      }))
    );
    try {
      await api.setViewMembers(activeView.id, { add });
      if (rawPath) {
        const r = await api.resolveView(activeView.id, rawPath);
        setViewLines(r.lines);
      }
      refreshViews();
    } catch (e) { console.warn("add selection failed:", e); }
  }, [activeView, editorSelection, rawPath, refreshViews]);

  const handleRemoveSelectionFromView = useCallback(async () => {
    if (!activeView || editorSelection.lines.length === 0) return;
    const ops = await Promise.all(
      editorSelection.texts.map(async (t) => ({
        line_hash: await api.lineHash(t),
        line_preview: t.trim().slice(0, 200),
      }))
    );
    try {
      // Use `exclude` (not `remove`): this marks the rows as user-excluded
      // so a future populate pass doesn't re-add them. Pure delete would let
      // rule/ai hits resurrect them on the next re-populate.
      await api.setViewMembers(activeView.id, { exclude: ops });
      if (rawPath) {
        const r = await api.resolveView(activeView.id, rawPath);
        setViewLines(r.lines);
      }
      refreshViews();
    } catch (e) { console.warn("remove selection failed:", e); }
  }, [activeView, editorSelection, rawPath, refreshViews]);

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

  // Shift+Shift (double-tap within 400ms) opens the unified quick-search palette.
  // We only count "bare" Shift presses — any modifier combo (Shift+Cmd, Shift+letter)
  // resets the timer so normal shortcuts aren't hijacked.
  useEffect(() => {
    if (!rawPath) return;
    let lastShiftAt = 0;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Shift") { lastShiftAt = 0; return; }
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) { lastShiftAt = 0; return; }
      const now = performance.now();
      if (now - lastShiftAt < 400) {
        lastShiftAt = 0;
        setShowQuickSearch((v) => !v);
      } else {
        lastShiftAt = now;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rawPath]);

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

  async function handleTrySample() {
    // Copies the curated sample file to the user's Documents dir and
    // opens it — skips the "pick a file" friction that kills 80% of
    // first-run flows. Sample is safe to edit / delete; re-running
    // this CTA won't overwrite a user-edited copy.
    const r = await installSampleNote();
    if (r.ok && r.path) {
      onSetRawPath(r.path);
      saveRawPathForHotkey(r.path).catch(() => {});
      const dir = r.path.replace(/\/[^/]+$/, "");
      onSetNotePath(`${dir}/note.md`);
    }
  }

  // Note is read/write only — embedding + enrich live on the RAG
  // surface (rail icon → Network glyph). Saved files become candidate
  // sources there, where the user picks them and triggers AI capabilities
  // explicitly. This keeps the editor focused on writing.

  // Global ⌘B re-routes to the editor's bookmark keymap even when
  // focus has drifted (clicked a chip in the view strip, hit a
  // header button, etc). CodeMirror's Mod-b binding only fires when
  // the editor itself owns focus; this re-fires the keystroke at
  // .cm-content so the user's bookmark muscle memory always works
  // anywhere on the Note surface.
  useEffect(() => {
    if (!rawPath) return;
    function onKey(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod || e.key.toLowerCase() !== "b") return;
      const cm = document.querySelector<HTMLElement>(".cm-content");
      if (!cm) return;
      // If editor already has focus, let CodeMirror handle natively.
      if (cm.contains(document.activeElement)) return;
      e.preventDefault();
      cm.focus();
      cm.dispatchEvent(new KeyboardEvent("keydown", {
        key: "b",
        code: "KeyB",
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        bubbles: true,
        cancelable: true,
      }));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rawPath]);

  // Sync this local note to cloud as a CloudDocument so it appears
  // on the KP (RAG) surface for embedding / enrich processing.
  // Reads the FULL file from disk — NOT from .cm-content innerText,
  // which only contains the virtually-rendered viewport (CodeMirror
  // virtualizes large files — a 6000-line note would upload as
  // ~30 visible lines if we scraped the DOM).
  async function handleSyncToKp() {
    if (!rawPath) return;
    setSyncState("syncing");
    try {
      // Save first if dirty so the on-disk content reflects the
      // user's latest edits — Sync = "build a snapshot of what's
      // saved", as the user put it.
      if (dirty) {
        handleSaveClick();
        // Tiny grace so CodeMirror's auto-save round-trip lands
        // before we re-read the file.
        await new Promise((r) => setTimeout(r, 250));
      }
      const result = await readFileFull(rawPath);
      const content = result.output || "";
      const filename = rawPath.split("/").pop() || "note.md";
      await cloudApi.createDocument({
        name: filename,
        content,
        kind: "markdown",
        metadata: {
          smartnote_type: "note",
          local_path: rawPath,
          synced_at: new Date().toISOString(),
          line_count: content.split("\n").length,
          byte_size: new Blob([content]).size,
        },
      });
      setSyncState("ok");
      setTimeout(() => setSyncState("idle"), 1800);
    } catch (e) {
      setSyncState("err");
      window.alert(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => setSyncState("idle"), 2400);
    }
  }

  // Trigger the editor's native ⌘S save by synthesizing a keydown.
  // CodeMirror's keymap picks it up so save flows through the same
  // path as user-typed ⌘S (handleSave callback below).
  function handleSaveClick() {
    const cm = document.querySelector<HTMLElement>(".cm-content");
    if (!cm) return;
    cm.focus();
    cm.dispatchEvent(new KeyboardEvent("keydown", {
      key: "s",
      code: "KeyS",
      metaKey: true,
      ctrlKey: false,
      bubbles: true,
      cancelable: true,
    }));
  }

  if (!rawPath) {
    return (
      <div className="proto-note-v3-empty">
        <div className="proto-note-v3-empty-inner">
          <span className="proto-note-v3-empty-eyebrow">Note</span>
          <h2 className="proto-note-v3-empty-title">Open a markdown file to start.</h2>
          <p className="proto-note-v3-empty-desc">
            Raw content is never rewritten — all AI enrichment is additive and reversible.
          </p>
          <div className="proto-note-v3-empty-actions">
            <button
              type="button"
              onClick={handleTrySample}
              className="proto-note-v3-btn proto-note-v3-btn-primary"
            >
              Try with sample
            </button>
            <button
              type="button"
              onClick={handlePickFile}
              className="proto-note-v3-btn"
            >
              <FolderOpen size={12} strokeWidth={2} /> Use your own file
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="proto-note-v3">
      {/* v3 breadcrumb bar — Notes / filename + actions */}
      <div className="proto-note-v3-bar">
        <span className="proto-note-v3-crumbs">
          <span>Notes /</span>
          <strong>{rawPath.split("/").pop()}</strong>
          {dirty && <span className="proto-note-v3-crumbs-dirty" title="Unsaved changes" />}
          {activeBuild && (
            <span className="proto-note-v3-build">v{activeBuild}</span>
          )}
        </span>

        <div className="proto-note-v3-actions">
          {packsSinceFull > 0 && (
            <button
              type="button"
              onClick={() => setShowIngest(true)}
              className="proto-note-v3-pill proto-note-v3-pill-warning"
              title={`${packsSinceFull} pack${packsSinceFull === 1 ? "" : "s"} applied since last full ingest — classification stale.`}
            >
              <span className="proto-note-v3-pill-dot" />
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
                  "proto-note-v3-pill",
                  ingestBusy && "proto-note-v3-pill-active",
                  !ingestBusy && ingestResult?.type === "success" && "proto-note-v3-pill-done",
                  !ingestBusy && ingestResult?.type === "error" && "proto-note-v3-pill-error",
                )}
                title="Ingest pipeline — click for details"
              >
                <span className="proto-note-v3-pill-dot" />
                <span>{progressLabel}</span>
                {progressCount && <span style={{ opacity: 0.7 }}>{progressCount}</span>}
              </motion.button>
            )}
          </AnimatePresence>

          <button
            type="button"
            onClick={handleSyncToKp}
            className="proto-note-v3-btn"
            disabled={syncState === "syncing"}
            title="Push this note to SmartNote Cloud so it appears in KP (RAG) for embedding / enrich processing"
          >
            <CloudUpload size={12} strokeWidth={2} />
            {syncState === "syncing" ? "Syncing…"
              : syncState === "ok"   ? "Synced ✓"
              : syncState === "err"  ? "Sync failed"
              : "Sync to KP"}
          </button>
          <button
            type="button"
            onClick={handleSaveClick}
            className="proto-note-v3-btn proto-note-v3-btn-primary"
            disabled={!dirty}
            title={dirty ? "Save · ⌘S" : "Already saved"}
          >
            <Save size={12} strokeWidth={2} /> Save
          </button>

          {/* Secondary icon-button row */}
          <button
            type="button"
            onClick={() => setShowReorganize(true)}
            className="proto-note-v3-btn proto-note-v3-btn-icon"
            title="Reorganize note by tag (destructive — snapshots first)"
          >
            <Shuffle size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={handlePickFile}
            className="proto-note-v3-btn proto-note-v3-btn-icon"
            title="Change file"
          >
            <FolderOpen size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* View + AI-tag strip — always visible, no fold */}
      <NoteViewStrip
        items={sidebarItems}
        activeKey={activeKey}
        onChange={(k) => setActiveKey(k)}
        onNewView={() => { setViewDialogInitial(null); setViewDialogOpen(true); }}
        onEditView={(v) => { setViewDialogInitial(v); setViewDialogOpen(true); }}
        onRepopulateView={handleRepopulate}
        onDeleteView={handleDeleteView}
      />

      {/* Body shell — full-width centered editor canvas */}
      <div className="proto-note-v3-shell">
        <div className="proto-note-v3-canvas">
        <div className="proto-note-v3-canvas-inner">
          <NoteEditor
            filePath={rawPath}
            onSave={handleSave}
            onDirty={setDirty}
            scrollToRange={scrollTarget}
            lineMeta={activeView && activeView.display.show_ts === false ? undefined : lineMeta}
            onToggleBookmark={handleToggleBookmark}
            memberLines={memberLineSet}
            dimMode={activeView?.display.dim_mode || "opacity"}
            dimLevel={activeView?.display.dim_level || "medium"}
            onSelectionChange={setEditorSelection}
          />
          {rawPath && (
            <div className="proto-note-v3-floating-stack">
              {/* Add/remove selection → only meaningful for user views.
                  Auto-views are read-only (AI classification owns them). */}
              {activeView && activeKind === "user" && editorSelection.lines.length > 0 && (
                <div className="proto-view-selection-actions">
                  {(() => {
                    const selHashes = editorSelection.lines; // proxy — we don't have hashes here
                    const anyNotMember = editorSelection.lines.some((n) => !memberLineSet?.has(n));
                    const anyMember = editorSelection.lines.some((n) => memberLineSet?.has(n));
                    void selHashes; void memberHashSet;
                    return (
                      <>
                        {anyNotMember && (
                          <button
                            type="button"
                            className="proto-bookmarks-badge"
                            onClick={handleAddSelectionToView}
                            title={`Add ${editorSelection.lines.length} line(s) to "${activeView.name}"`}
                            aria-label="Add to view"
                          >
                            <Plus size={14} strokeWidth={2} />
                          </button>
                        )}
                        {anyMember && (
                          <button
                            type="button"
                            className="proto-bookmarks-badge"
                            onClick={handleRemoveSelectionFromView}
                            title={`Remove ${editorSelection.lines.length} line(s) from "${activeView.name}"`}
                            aria-label="Remove from view"
                          >
                            <Minus size={14} strokeWidth={2} />
                          </button>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}
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

      <QuickSearch
        rawPath={rawPath}
        open={showQuickSearch}
        onClose={() => setShowQuickSearch(false)}
        onJumpToLine={(line) => setScrollTarget({ start: line, end: line })}
      />

      <NoteViewDialog
        open={viewDialogOpen}
        initial={viewDialogInitial}
        onClose={() => { setViewDialogOpen(false); setViewDialogInitial(null); }}
        onSubmit={handleViewSubmit}
      />

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
