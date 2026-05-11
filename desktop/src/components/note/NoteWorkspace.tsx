import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, X, FolderOpen, FilePlus } from "lucide-react";
import { NotePage } from "./NotePage";
import { listNoteDir, createNewNote, pickNoteDir, pickRawFile, saveRawPathForHotkey } from "@/lib/electron";
import { cn } from "@/lib/cn";
import type { IngestStep } from "@/App";

/* NoteWorkspace — wraps NotePage with a multi-tab strip + a file
 * tree of siblings in the active note's directory.
 *
 * Architecture: NotePage stays a single-file editor (rawPath prop).
 * The workspace owns the tab list and just feeds the active rawPath
 * down. Switching tabs unmounts/remounts NotePage so CodeMirror
 * loads the new file fresh — autosave on ⌘S keeps content safe.
 * (A future iteration could preserve editor state per tab; that
 * needs a deeper refactor of NotePage's effect graph.)
 *
 * Persistence: open tabs + active tab are stored in localStorage so
 * the workspace recovers on relaunch. */

const TABS_KEY = "smartnote-note-tabs";
const ACTIVE_KEY = "smartnote-note-active";

type Tab = { path: string };

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

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}

export function NoteWorkspace(props: Props) {
  const { rawPath, onSetRawPath } = props;

  // ── Tabs ──────────────────────────────────────────────────────
  // Open tab list, persisted to localStorage. Active tab's path is
  // what we feed to NotePage. Whenever the parent's rawPath changes
  // we ensure it's in the tab list (and active).
  const [tabs, setTabs] = useState<Tab[]>(() => {
    try {
      const raw = localStorage.getItem(TABS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) return arr.filter((t) => typeof t?.path === "string");
    } catch { /* fall through */ }
    return [];
  });
  const [showNewDialog, setShowNewDialog] = useState(false);

  // Keep tabs in sync with the parent-owned rawPath so external opens
  // (Library, ⌘K Spotlight, sample install) feed into the tab list
  // without duplicating logic at every call site.
  useEffect(() => {
    if (!rawPath) return;
    setTabs((prev) => {
      if (prev.some((t) => t.path === rawPath)) return prev;
      return [...prev, { path: rawPath }];
    });
    try { localStorage.setItem(ACTIVE_KEY, rawPath); } catch { /* ignore */ }
  }, [rawPath]);

  useEffect(() => {
    try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch { /* ignore */ }
  }, [tabs]);

  function activate(p: string) {
    if (p === rawPath) return;
    onSetRawPath(p);
    saveRawPathForHotkey(p).catch(() => {});
  }

  function closeTab(p: string) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== p);
      // If we just closed the active tab, jump to a neighbor (or
      // clear rawPath if none left).
      if (p === rawPath) {
        const idx = prev.findIndex((t) => t.path === p);
        const fallback = next[Math.min(idx, next.length - 1)] ?? next[0];
        if (fallback) activate(fallback.path);
        else onSetRawPath("");
      }
      return next;
    });
  }

  // ── File tree ─────────────────────────────────────────────────
  // Lists .md / .txt files in the same directory as the active
  // rawPath. Cheap re-list on rawPath change; users rarely have
  // thousands of notes in a single dir.
  const [treeRoot, setTreeRoot] = useState<string>("");
  const [treeFiles, setTreeFiles] = useState<Array<{ name: string; path: string }>>([]);
  const refreshTree = useCallback(async (dir: string) => {
    if (!dir) { setTreeFiles([]); return; }
    const r = await listNoteDir(dir);
    if (r.ok) { setTreeRoot(r.root || dir); setTreeFiles(r.files || []); }
    else { setTreeFiles([]); }
  }, []);

  useEffect(() => {
    refreshTree(rawPath || treeRoot);
  }, [rawPath, refreshTree]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function handleOpenFile() {
    const p = await pickRawFile();
    if (p) activate(p);
  }

  async function handleSwitchRoot() {
    const dir = await pickNoteDir();
    if (dir) refreshTree(dir);
  }

  // ── New-note dialog state ────────────────────────────────────
  const [newName, setNewName] = useState("");
  const [newDir, setNewDir] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  function openNewDialog() {
    const defaultDir = treeRoot || dirname(rawPath) || "";
    setNewDir(defaultDir);
    setNewName("");
    setCreateErr(null);
    setShowNewDialog(true);
  }
  async function pickNewDir() {
    const d = await pickNoteDir();
    if (d) setNewDir(d);
  }
  async function submitNew() {
    if (!newDir || !newName.trim()) {
      setCreateErr("Both directory and name are required");
      return;
    }
    setCreating(true);
    setCreateErr(null);
    try {
      const r = await createNewNote(newDir, newName);
      if (!r.ok) {
        setCreateErr(r.error || "create failed");
        return;
      }
      setShowNewDialog(false);
      if (r.path) {
        activate(r.path);
        refreshTree(r.path);
      }
    } finally {
      setCreating(false);
    }
  }

  // Bookmark counts per file — peeks at the same localStorage key
  // NotePage writes to (`smartnote-bookmarks:<path>`). Recomputes
  // whenever the tree list or the active rawPath changes, since
  // the user is most likely adding/removing bookmarks on the active
  // file (or just switched to it). Recompute on a custom event so
  // edits in NotePage flip the badge without polling.
  const [bookmarkCounts, setBookmarkCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    function recount() {
      const counts: Record<string, number> = {};
      for (const f of treeFiles) {
        try {
          const raw = localStorage.getItem(`smartnote-bookmarks:${f.path}`);
          if (!raw) continue;
          const arr = JSON.parse(raw);
          if (Array.isArray(arr) && arr.length > 0) counts[f.path] = arr.length;
        } catch { /* ignore */ }
      }
      setBookmarkCounts(counts);
    }
    recount();
    // Listen for cross-tab localStorage writes AND a same-tab custom
    // event NotePage will fire after toggling a bookmark.
    function onStorage(e: StorageEvent) {
      if (e.key && e.key.startsWith("smartnote-bookmarks:")) recount();
    }
    function onLocal() { recount(); }
    window.addEventListener("storage", onStorage);
    window.addEventListener("smartnote:bookmarks-changed", onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("smartnote:bookmarks-changed", onLocal);
    };
  }, [treeFiles, rawPath]);

  const treeShown = useMemo(() => treeFiles, [treeFiles]);

  return (
    <div className="proto-note-workspace">
      {/* Tab strip — always visible, even when no file is open, so
          the "+" affordance is always reachable. */}
      <div className="proto-note-tabs">
        <div className="proto-note-tabs-strip">
          {tabs.map((t) => (
            <button
              key={t.path}
              type="button"
              className={cn(
                "proto-note-tab",
                t.path === rawPath && "proto-note-tab-active",
              )}
              onClick={() => activate(t.path)}
              title={t.path}
            >
              <span className="proto-note-tab-name">{basename(t.path)}</span>
              <span
                role="button"
                tabIndex={0}
                className="proto-note-tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(t.path); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault(); e.stopPropagation(); closeTab(t.path);
                  }
                }}
                aria-label="Close tab"
              >
                <X size={11} />
              </span>
            </button>
          ))}
          <button
            type="button"
            className="proto-note-tab-add"
            onClick={openNewDialog}
            title="Create new note"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      <div className="proto-note-workspace-body">
        {/* File tree — siblings of the current rawPath. Compact list,
            click to open. Header has Open / change-root actions. */}
        <aside className="proto-note-tree">
          <div className="proto-note-tree-head">
            <span className="proto-note-tree-root" title={treeRoot}>
              {treeRoot ? basename(treeRoot) : "no folder"}
            </span>
            <button
              type="button"
              className="proto-note-tree-act"
              onClick={handleSwitchRoot}
              title="Change folder"
            >
              <FolderOpen size={12} />
            </button>
            <button
              type="button"
              className="proto-note-tree-act"
              onClick={handleOpenFile}
              title="Open a file outside this folder"
            >
              <FilePlus size={12} />
            </button>
          </div>
          <div className="proto-note-tree-list">
            {treeShown.length === 0 && (
              <div className="proto-note-tree-empty">No notes here yet.</div>
            )}
            {treeShown.map((f) => {
              const bn = bookmarkCounts[f.path] || 0;
              return (
                <button
                  key={f.path}
                  type="button"
                  className={cn(
                    "proto-note-tree-row",
                    f.path === rawPath && "proto-note-tree-row-active",
                  )}
                  onClick={() => activate(f.path)}
                  title={f.path + (bn > 0 ? ` · ${bn} bookmark${bn === 1 ? "" : "s"}` : "")}
                >
                  <span className="proto-note-tree-row-name">{f.name}</span>
                  {bn > 0 && (
                    <span
                      className="proto-note-tree-row-bm"
                      aria-label={`${bn} bookmark${bn === 1 ? "" : "s"}`}
                    >
                      {bn}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        {/* Active note — NotePage keyed by rawPath so switching tabs
            cleanly remounts the editor with the new file's content. */}
        <div className="proto-note-workspace-canvas">
          <NotePage key={rawPath || "_empty"} {...props} />
        </div>
      </div>

      {showNewDialog && (
        <div className="proto-newnote-backdrop" onClick={() => setShowNewDialog(false)}>
          <div className="proto-newnote-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="proto-newnote-title">New note</h3>
            <label className="proto-newnote-label">
              <span>Filename</span>
              <input
                className="proto-newnote-input"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="my-note.md"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") void submitNew(); }}
              />
            </label>
            <label className="proto-newnote-label">
              <span>Directory</span>
              <div className="proto-newnote-row">
                <input
                  className="proto-newnote-input"
                  type="text"
                  value={newDir}
                  onChange={(e) => setNewDir(e.target.value)}
                  placeholder="/path/to/notes"
                />
                <button type="button" className="proto-newnote-btn" onClick={pickNewDir}>
                  Pick…
                </button>
              </div>
            </label>
            {createErr && <div className="proto-newnote-err">{createErr}</div>}
            <div className="proto-newnote-actions">
              <button type="button" className="proto-newnote-btn" onClick={() => setShowNewDialog(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="proto-newnote-btn proto-newnote-btn-primary"
                onClick={submitNew}
                disabled={creating}
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
