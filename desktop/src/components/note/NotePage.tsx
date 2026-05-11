import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  FolderOpen, Shuffle, ArrowDownToLine, Save, CloudUpload,
  Plus, Minus, FileEdit, Sparkles, Search, Tags,
} from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { NoteEditor, type LineMeta } from "../editor/NoteEditor";
import { BookmarksButton } from "./BookmarksButton";
import { IngestDialog } from "./IngestDialog";
import { ReorganizeDialog } from "./ReorganizeDialog";
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
  const [dirty, setDirty] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<{ start: number; end: number } | null>(null);
  const [recentDone, setRecentDone] = useState(false);

  // Bookmarks — purely client-side now (the original cloud-backed
  // implementation went away with the local Python gateway). Each
  // bookmark anchors to a line_hash so adding/removing lines elsewhere
  // in the file doesn't break the jump target. Persisted per-file in
  // localStorage; rehydrated on file load by re-hashing every line.
  type LocalBookmark = {
    line_hash: string;
    label: string;
    line_no_last: number;
    line_preview: string;
  };
  const [bookmarks, setBookmarks] = useState<LocalBookmark[]>([]);
  // `loaded` gates the persist effect — without it, the initial empty
  // [] would race the async load and wipe localStorage + clobber any
  // unsynced cloud value (the user's reported "重启丢失" bug). Tracked
  // per rawPath: it flips false→true once we've hydrated, and resets
  // on path change so we re-load cleanly.
  const [bookmarksLoaded, setBookmarksLoaded] = useState(false);
  // Cloud doc id for the current rawPath, looked up once on load.
  // Bookmarks are stored in that doc's metadata.bookmarks so they
  // sync across devices. null means we couldn't find a cloud doc
  // (note hasn't been synced yet) — localStorage is the fallback.
  const [bookmarksCloudDocId, setBookmarksCloudDocId] = useState<string | null>(null);
  // Cache the cloud doc's full metadata so the bookmark-save PATCH
  // can preserve sibling keys (local_path, smartnote_type, etc.).
  // Cloud's PATCH replaces metadata wholesale, not merges.
  const bookmarksCloudMetaRef = useRef<Record<string, unknown>>({});
  const bookmarksKey = rawPath ? `smartnote-bookmarks:${rawPath}` : "";

  // Re-anchor + load: every time the file changes:
  //   1. Reset state (mark unloaded so persist doesn't fire)
  //   2. Pull cloud doc + its metadata.bookmarks (source of truth)
  //   3. Fall back to localStorage if no cloud doc / cloud fetch fails
  //   4. Re-hash every line of the on-disk content and remap each
  //      stored bookmark to its current line_no (so L42 stays
  //      accurate after the user inserts paragraphs above)
  //   5. Commit + mark loaded
  useEffect(() => {
    if (!rawPath || !bookmarksKey) {
      setBookmarks([]);
      setBookmarksLoaded(false);
      setBookmarksCloudDocId(null);
      return;
    }
    let cancelled = false;
    setBookmarksLoaded(false);
    (async () => {
      // Cloud lookup — find a note doc whose metadata.local_path
      // matches this rawPath. handleSyncToKp uses the same predicate.
      let cloudDocId: string | null = null;
      let cloudBookmarks: LocalBookmark[] | null = null;
      try {
        const list = await cloudApi.listDocuments({ smartnote_type: "note" });
        const match = list.documents.find((d) => {
          const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
          return md.local_path === rawPath;
        });
        if (match) {
          cloudDocId = match.id;
          const md = (match.metadata && typeof match.metadata === "object" ? match.metadata : {}) as Record<string, unknown>;
          bookmarksCloudMetaRef.current = md;
          const raw = md.bookmarks;
          if (Array.isArray(raw)) {
            cloudBookmarks = raw.filter((x: unknown) => x && typeof (x as { line_hash?: unknown }).line_hash === "string") as LocalBookmark[];
          }
        }
      } catch {
        /* offline / no auth — fall back to localStorage */
      }

      // Local-storage fallback for unsynced notes.
      let stored: LocalBookmark[] = [];
      if (cloudBookmarks !== null) {
        stored = cloudBookmarks;
      } else {
        try {
          const raw = localStorage.getItem(bookmarksKey);
          const arr = raw ? JSON.parse(raw) : [];
          if (Array.isArray(arr)) stored = arr;
        } catch { stored = []; }
      }

      // Re-anchor against current file content.
      const r = await readFileFull(rawPath).catch(() => null);
      const content = (r && r.ok && typeof r.output === "string") ? r.output : "";
      const lines = content.split("\n");
      const hashToLine = new Map<string, { line_no: number; text: string }>();
      for (let i = 0; i < lines.length; i++) {
        const h = await api.lineHash(lines[i]);
        if (!hashToLine.has(h)) hashToLine.set(h, { line_no: i + 1, text: lines[i] });
      }
      const rebuilt: LocalBookmark[] = stored.map((b) => {
        const hit = hashToLine.get(b.line_hash);
        return hit
          ? { ...b, line_no_last: hit.line_no, line_preview: hit.text.trim().slice(0, 80) }
          : b; // orphaned — keep stale line_no_last so the user can still rename/remove
      });

      if (!cancelled) {
        setBookmarksCloudDocId(cloudDocId);
        setBookmarks(rebuilt);
        setBookmarksLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [rawPath, bookmarksKey, buildVersion]);

  // Persist on every bookmarks change. Two destinations:
  //   - localStorage (immediate, always)
  //   - cloud doc.metadata.bookmarks (debounced, fire-and-forget)
  // `bookmarksLoaded` gates this — without it, the initial render's
  // empty [] would write before we'd loaded anything, wiping the
  // saved values.
  useEffect(() => {
    if (!bookmarksLoaded || !bookmarksKey) return;
    try {
      if (bookmarks.length === 0) localStorage.removeItem(bookmarksKey);
      else localStorage.setItem(bookmarksKey, JSON.stringify(bookmarks));
    } catch { /* ignore */ }
    // Same-tab StorageEvent isn't fired by localStorage writes — only
    // OTHER tabs see those. NoteWorkspace's file-tree badge listener
    // needs an in-tab nudge to recount, so we dispatch this on every
    // bookmark change.
    try { window.dispatchEvent(new CustomEvent("smartnote:bookmarks-changed")); } catch { /* silent */ }

    if (!bookmarksCloudDocId) return;
    // Debounce cloud patch by 600ms — every keystroke in the rename
    // dialog re-fires this, so we don't want a PATCH per char.
    const handle = window.setTimeout(() => {
      // Strip line_no_last / line_preview before persisting to cloud;
      // those are derived from the live document each load, not
      // canonical. Keep line_hash + label as the durable shape.
      const payload = bookmarks.map((b) => ({
        line_hash: b.line_hash,
        label: b.label,
      }));
      // Cloud PATCH replaces metadata wholesale, so merge our
      // bookmarks into the cached snapshot of the doc's metadata.
      const merged = { ...bookmarksCloudMetaRef.current, bookmarks: payload };
      bookmarksCloudMetaRef.current = merged;
      cloudApi.patchDocument(bookmarksCloudDocId, { metadata: merged })
        .catch(() => { /* offline — localStorage already saved */ });
    }, 600);
    return () => window.clearTimeout(handle);
  }, [bookmarks, bookmarksKey, bookmarksLoaded, bookmarksCloudDocId]);

  // Per-line meta passed to the editor: maps current line_no →
  // bookmark label so the left gutter shows the marker + tooltip.
  const lineMeta = useMemo<LineMeta>(() => {
    const m: LineMeta = new Map();
    for (const b of bookmarks) {
      if (b.line_no_last > 0) m.set(b.line_no_last, { bookmark: b.label });
    }
    return m;
  }, [bookmarks]);

  // ⌘B toggle UX — instead of window.prompt (which is blocking and
  // unreliable in Electron, and was crashing the render when called
  // from inside a setState updater), open a proper inline dialog.
  // The dialog owns label state; submit → mutate `bookmarks`.
  type BookmarkDlg = {
    mode: "create" | "rename";
    hash: string;
    lineNo: number;
    preview: string;
    initialLabel: string;
  };
  const [bookmarkDlg, setBookmarkDlg] = useState<BookmarkDlg | null>(null);
  const [bookmarkLabelInput, setBookmarkLabelInput] = useState("");
  // Ref tracking the latest bookmarks so callbacks can read the
  // current value without depending on it (avoids stale closures
  // AND avoids the React anti-pattern of calling setBookmarks from
  // inside another setter — which was running twice in Strict Mode
  // and producing duplicate entries on every Add.).
  const bookmarksRef = useRef(bookmarks);
  bookmarksRef.current = bookmarks;

  const handleToggleBookmark = useCallback(async (lineNo: number, lineText: string) => {
    const hash = await api.lineHash(lineText);
    const preview = lineText.trim().slice(0, 80);
    const existing = bookmarksRef.current.find((b) => b.line_hash === hash);
    const dlg: BookmarkDlg = existing
      ? { mode: "rename", hash, lineNo, preview, initialLabel: existing.label }
      : { mode: "create", hash, lineNo, preview, initialLabel: preview || `Line ${lineNo}` };
    setBookmarkLabelInput(dlg.initialLabel);
    setBookmarkDlg(dlg);
  }, []);

  const submitBookmarkDlg = useCallback(() => {
    const dlg = bookmarkDlg;
    if (!dlg) return;
    const label = bookmarkLabelInput.trim();
    setBookmarks((prev) => {
      if (dlg.mode === "rename") {
        if (!label) return prev.filter((b) => b.line_hash !== dlg.hash);
        return prev.map((b) =>
          b.line_hash === dlg.hash
            ? { ...b, label, line_no_last: dlg.lineNo, line_preview: dlg.preview }
            : b,
        );
      }
      // create — guard against duplicate insertion (Strict Mode runs
      // updaters twice; without this check we'd push a second entry).
      if (!label) return prev;
      if (prev.some((b) => b.line_hash === dlg.hash)) return prev;
      return [...prev, {
        line_hash: dlg.hash,
        label,
        line_no_last: dlg.lineNo,
        line_preview: dlg.preview,
      }];
    });
    setBookmarkDlg(null);
  }, [bookmarkDlg, bookmarkLabelInput]);

  const cancelBookmarkDlg = useCallback(() => setBookmarkDlg(null), []);

  const removeBookmarkFromDlg = useCallback(() => {
    const dlg = bookmarkDlg;
    if (!dlg) return;
    setBookmarks((prev) => prev.filter((b) => b.line_hash !== dlg.hash));
    setBookmarkDlg(null);
  }, [bookmarkDlg]);

  const handleJumpToBookmark = useCallback((line: number) => {
    setScrollTarget({ start: line, end: line });
  }, []);

  const handleRemoveBookmark = useCallback((hash: string) => {
    setBookmarks((prev) => prev.filter((b) => b.line_hash !== hash));
  }, []);

  // No-op stand-in: callers (save/apply/discard handlers, ReorganizeDialog
  // onApproved) used to trigger a gateway refresh of line meta + pack
  // queue. The gateway is gone; keeping the callback shape avoids
  // touching every caller site.
  const refreshNoteState = useCallback(async () => {}, []);

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
  }, [activeKind, activeUserId, activeTagName, rawPath, tagSegments]);

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

  /* External-edit detection / md5 baseline lived on the legacy
     gateway. Removed alongside the bookmarks + pack queue. */

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

  /* Sync this local note to cloud as a CloudDocument so it appears
   * on the Library surface for embedding / enrich processing.
   *
   * Upsert by `metadata.local_path`:
   *   - First sync of a path → POST /v1/documents (create)
   *   - Subsequent syncs of the same path → PATCH content of the
   *     existing doc (cloud clears ingested_at + schedules re-ingest).
   *
   * Earlier behaviour stamped each sync with `__YYYY-MM-DD_HHMMSS`
   * which:
   *   1. Created N copies of the same note in the workspace
   *   2. Forked retrieval (search returned the wrong / stale version)
   *   3. Made vec / embedding scoring noisy because old un-embedded
   *      duplicates competed with the freshly-embedded current doc
   * The "version snapshot" feature was theoretical — nothing read
   * the suffix. Drop it; one local note → one cloud document.
   *
   * Reads the FULL file from disk — NOT from .cm-content innerText,
   * which only holds the rendered viewport (CodeMirror virtualizes
   * large files — a 6000-line note would upload as ~30 visible lines).
   */
  async function handleSyncToKp() {
    if (!rawPath) return;
    setSyncState("syncing");
    try {
      // Save first if dirty so the on-disk content reflects the
      // user's latest edits — Sync = "build a snapshot of what's
      // saved", as the user put it.
      if (dirty) {
        handleSaveClick();
        await new Promise((r) => setTimeout(r, 250));
      }
      const result = await readFileFull(rawPath);
      const content = result.output || "";
      const filename = rawPath.split("/").pop() || "note.md";
      const nowIso = new Date().toISOString();
      const baseMeta: Record<string, unknown> = {
        smartnote_type: "note",
        local_path: rawPath,
        original_name: filename,
        synced_at: nowIso,
        line_count: content.split("\n").length,
        byte_size: new Blob([content]).size,
      };

      // Look up existing doc with the same local_path so re-syncs
      // update content in place.
      let existingId: string | null = null;
      try {
        const list = await cloudApi.listDocuments({ smartnote_type: "note" });
        const match = list.documents.find((d) => {
          const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
          return md.local_path === rawPath;
        });
        if (match) existingId = match.id;
      } catch {
        // List failure isn't fatal — fall through to create.
      }

      if (existingId) {
        // Re-sync · update content + bump synced_at. Cloud clears
        // ingested_at + queues re-ingest so chunks/embeddings refresh.
        await cloudApi.patchDocument(existingId, {
          name: filename,
          content,
          metadata: baseMeta,
        });
      } else {
        await cloudApi.createDocument({
          name: filename,
          content,
          kind: "markdown",
          metadata: baseMeta,
        });
      }
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
    return <NoteLanding onSample={handleTrySample} onPickFile={handlePickFile} />;
  }

  return (
    <div className="proto-note-v3">
      {/* v3 breadcrumb bar — Notes / filename + actions */}
      <div className="proto-note-v3-bar">
        <span className="proto-note-v3-crumbs">
          <span>Notes /</span>
          <strong>{rawPath.split("/").pop()}</strong>
          {dirty && <span className="proto-note-v3-crumbs-dirty" title="Unsaved changes" />}
        </span>

        <div className="proto-note-v3-actions">
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
        // View CRUD lived on the legacy gateway — disabled until
        // reimplemented on cloud. Strip still renders auto-views
        // (AI-classified tag segments) so it isn't empty.
        onNewView={undefined}
        onEditView={undefined}
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
            lineMeta={lineMeta}
            memberLines={memberLineSet}
            dimMode={activeView?.display.dim_mode || "opacity"}
            dimLevel={activeView?.display.dim_level || "medium"}
            onSelectionChange={setEditorSelection}
            onToggleBookmark={handleToggleBookmark}
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
              {/* Bookmarks · ⌘B on any line to add (prompt for label).
                  Adapter shape — fill the NoteLineMeta fields the
                  component reads; the rest are placeholders. */}
              <BookmarksButton
                bookmarks={bookmarks.map((b) => ({
                  line_hash: b.line_hash,
                  line_no_last: b.line_no_last,
                  line_preview: b.line_preview,
                  bookmark: b.label,
                  ts: null,
                  highlight_color: "",
                  highlight_note: "",
                  updated_at: "",
                }))}
                onJumpToLine={handleJumpToBookmark}
                onRemove={handleRemoveBookmark}
              />
              <button
                type="button"
                className="proto-bookmarks-badge"
                onClick={() => setScrollTarget({ start: 1_000_000_000, end: 1_000_000_000 })}
                title="Jump to the latest (bottom) of the note"
                aria-label="Jump to bottom"
              >
                <ArrowDownToLine size={14} strokeWidth={2} />
              </button>
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
        bookmarks={bookmarks.map((b) => ({
          line_no: b.line_no_last,
          label: b.label,
          preview: b.line_preview,
        }))}
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

      {bookmarkDlg && (
        <div
          className="proto-newnote-backdrop"
          onClick={cancelBookmarkDlg}
        >
          <div
            className="proto-newnote-card proto-bookmark-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="proto-newnote-title">
              {bookmarkDlg.mode === "rename" ? "Rename bookmark" : "New bookmark"}
            </h3>
            <div className="proto-bookmark-dialog-meta">
              <span className="proto-bookmark-dialog-line">L{bookmarkDlg.lineNo}</span>
              <span className="proto-bookmark-dialog-preview" title={bookmarkDlg.preview}>
                {bookmarkDlg.preview || <em>(blank line)</em>}
              </span>
            </div>
            <label className="proto-newnote-label">
              <span>Name</span>
              <input
                className="proto-newnote-input"
                type="text"
                value={bookmarkLabelInput}
                onChange={(e) => setBookmarkLabelInput(e.target.value)}
                placeholder="What is this section about?"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitBookmarkDlg();
                  else if (e.key === "Escape") cancelBookmarkDlg();
                }}
              />
            </label>
            <div className="proto-newnote-actions">
              {bookmarkDlg.mode === "rename" && (
                <button
                  type="button"
                  className="proto-newnote-btn proto-bookmark-dialog-remove"
                  onClick={removeBookmarkFromDlg}
                >
                  Remove
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button type="button" className="proto-newnote-btn" onClick={cancelBookmarkDlg}>
                Cancel
              </button>
              <button
                type="button"
                className="proto-newnote-btn proto-newnote-btn-primary"
                onClick={submitBookmarkDlg}
              >
                {bookmarkDlg.mode === "rename" ? "Save" : "Add"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* Insert a second-level timestamp before the file extension so every
 * upload creates a uniquely-named snapshot in the cloud workspace.
 * Users can later see "note__2026-04-29_173045.md" alongside
 * "note__2026-04-30_091200.md" and choose which to keep. */
/* NoteLanding · zero-file empty state for the Note pane.
 *
 * Mirrors LibraryLanding's structure (hero · "How it works" · feature
 * cards · subtle close) so the desktop's two main creation surfaces
 * read consistently. The four cards explain Note-specific concepts:
 *   1. Plain markdown raw file is sacred — never rewritten
 *   2. AI side file (note.md) holds enrichments — additive, reversible
 *   3. Spotlight (⌘K) crosses the workspace
 *   4. Sync to Library upgrades retrieval / cross-device / MCP access
 */
function NoteLanding({ onSample, onPickFile }: { onSample: () => void; onPickFile: () => void }) {
  return (
    <div className="proto-note-landing">
      <div className="proto-note-landing-hero">
        <div className="proto-note-landing-icon" aria-hidden="true">
          <FileEdit size={22} strokeWidth={1.5} />
        </div>
        <h2 className="proto-note-landing-title">Open a markdown file to start</h2>
        <p className="proto-note-landing-sub">
          You write plain markdown. SmartNote enriches in a side file
          (<code>note.md</code>) — your raw text is never rewritten and
          every AI annotation is reversible.
        </p>
        <div className="proto-note-landing-cta">
          <button
            type="button"
            onClick={onSample}
            className="proto-note-v3-btn proto-note-v3-btn-primary"
          >
            Try with sample
          </button>
          <button
            type="button"
            onClick={onPickFile}
            className="proto-note-v3-btn"
          >
            <FolderOpen size={12} strokeWidth={2} /> Open your own file
          </button>
        </div>
      </div>

      <div className="proto-note-landing-section">
        <h3>How it works</h3>
        <p>
          Two files per note: the <code>raw</code> markdown you control,
          and a sibling <code>note.md</code> SmartNote writes into. Saving
          the raw file is the only thing that ever touches your bytes.
        </p>
      </div>

      <div className="proto-note-landing-stages">
        <NoteLandingCard
          icon={<FileEdit size={14} strokeWidth={1.7} />}
          tone="raw"
          name="You write"
          mark="RAW · NEVER REWRITTEN"
          desc="Plain markdown in your file. Hotkey-paste from the system clipboard appends a timestamped block. Save with ⌘S."
        />
        <NoteLandingCard
          icon={<Sparkles size={14} strokeWidth={1.7} />}
          tone="ai"
          name="AI enriches in note.md"
          mark="ADDITIVE · REVERSIBLE"
          desc="A separate sidecar file holds AI-generated tags, summaries, and outlines. Delete it any time — the raw stays clean."
        />
        <NoteLandingCard
          icon={<Tags size={14} strokeWidth={1.7} />}
          tone="tags"
          name="Custom tags"
          mark="USER-DEFINED"
          desc="Define tags with descriptions in workspace settings. Note tag-classify (LLM) suggests line ranges to label; you Accept or Dismiss."
        />
        <NoteLandingCard
          icon={<Search size={14} strokeWidth={1.7} />}
          tone="search"
          name="Spotlight ⌘K"
          mark="ACROSS NOTES"
          desc="Hit ⌘K anywhere in SmartNote to jump to any line by content, tag, or smart-view name."
        />
        <NoteLandingCard
          icon={<CloudUpload size={14} strokeWidth={1.7} />}
          tone="cloud"
          name="Sync to Library"
          mark="OPTIONAL · CLOUD"
          desc="Push a note to SmartNote Cloud and the Library kicks off chunk_embed → chunk_enrich → topology so other devices and MCP agents can retrieve it."
        />
      </div>
    </div>
  );
}

function NoteLandingCard({
  icon, name, tone, mark, desc,
}: {
  icon: React.ReactNode;
  name: string;
  tone: "raw" | "ai" | "tags" | "search" | "cloud";
  mark: string;
  desc: string;
}) {
  return (
    <div className={`proto-note-landing-stage proto-note-landing-stage-${tone}`}>
      <span className="proto-note-landing-stage-icon">{icon}</span>
      <div className="proto-note-landing-stage-body">
        <div className="proto-note-landing-stage-head">
          <span className="proto-note-landing-stage-name">{name}</span>
          <span className={`proto-note-landing-stage-mark mark-${tone}`}>{mark}</span>
        </div>
        <p className="proto-note-landing-stage-desc">{desc}</p>
      </div>
    </div>
  );
}

function stampFilename(name: string): string {
  const d = new Date();
  const p = (n: number) => n.toString().padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const slash = name.lastIndexOf("/");
  const dot = name.lastIndexOf(".");
  if (dot > slash && dot > 0) {
    return `${name.slice(0, dot)}__${stamp}${name.slice(dot)}`;
  }
  return `${name}__${stamp}`;
}
