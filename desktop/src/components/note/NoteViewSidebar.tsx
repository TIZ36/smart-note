import { useState } from "react";
import {
  Layers, ChevronLeft, ChevronRight, Sparkles, Filter, User,
  Plus, RotateCw, MoreHorizontal, Pencil, Trash2, Wand2, X, Check,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { NoteView, ViewResolvedLine } from "@/lib/api";

/* Unified sidebar item.
   "tag"  = enrich-tag: the AI classifier's taxonomy bucket. User can add
            / delete tags here; the next AI enrich pass will use this list
            as its classification axes.
   "user" = self-view: user-owned lens backed by note_view. Rules, LLM,
            and manual membership. Fully CRUD (add / delete / rename). */
export type SidebarViewItem =
  | { kind: "user"; view: NoteView; key: string }
  | { kind: "tag"; tag: string; color?: string; summary?: string; memberCount: number; key: string };

type Props = {
  items: SidebarViewItem[];
  activeKey: string | null;                        // null = default view
  onChange: (key: string | null) => void;
  activeMembers: ViewResolvedLine[];               // for the currently-active view
  onJumpToLine: (line: number) => void;
  // Self-view CRUD
  onNewView: () => void;
  onEditView: (view: NoteView) => void;
  onRepopulateView: (view: NoteView) => void;
  onDeleteView: (view: NoteView) => void;
  // Enrich-tag CRUD
  onAddTag: (name: string, desc: string) => Promise<void> | void;
  onDeleteTag: (name: string) => Promise<void> | void;
};

/* Left rail: quick view switcher + member jump-nav. Two sections:
   "AI" = auto-views from tag_segments (read-only, classified at ingest).
   "Mine" = user-created views (editable). Collapsible; state persisted in
   localStorage so the user's width preference survives reloads. */
export function NoteViewSidebar({
  items, activeKey, onChange, activeMembers, onJumpToLine,
  onNewView, onEditView, onRepopulateView, onDeleteView,
  onAddTag, onDeleteTag,
}: Props) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("smartnote-view-sidebar-collapsed") === "true"
  );
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [addTagOpen, setAddTagOpen] = useState(false);
  const [newTagInput, setNewTagInput] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("smartnote-view-sidebar-collapsed", String(next));
      return next;
    });
  };

  const tagItems = items.filter((i): i is Extract<SidebarViewItem, { kind: "tag" }> => i.kind === "tag");
  const userItems = items.filter((i): i is Extract<SidebarViewItem, { kind: "user" }> => i.kind === "user");

  const submitNewTag = async () => {
    const raw = newTagInput.trim();
    if (!raw || tagBusy) return;
    const colonIdx = raw.indexOf(":");
    const name = colonIdx > 0 ? raw.slice(0, colonIdx).trim() : raw;
    const desc = colonIdx > 0 ? raw.slice(colonIdx + 1).trim() : "";
    if (!name) return;
    setTagBusy(true);
    try {
      await onAddTag(name, desc);
      setNewTagInput("");
      setAddTagOpen(false);
    } catch { /* surface is the parent's responsibility */ }
    setTagBusy(false);
  };

  if (collapsed) {
    return (
      <div className="proto-view-sidebar proto-view-sidebar-collapsed">
        <button
          type="button"
          className="proto-view-sidebar-toggle"
          onClick={toggle}
          title="Expand views panel"
          aria-label="Expand views panel"
        >
          <ChevronRight size={14} strokeWidth={2} />
        </button>
        <div className="proto-view-sidebar-mini">
          <MiniBtn
            active={activeKey === null}
            onClick={() => onChange(null)}
            title="Default view"
            char={<Layers size={12} strokeWidth={2} />}
          />
          {items.map((item) => (
            <MiniBtn
              key={item.key}
              active={activeKey === item.key}
              onClick={() => onChange(item.key)}
              title={item.kind === "tag" ? `${item.tag} (enrich-tag)` : item.view.name}
              char={(item.kind === "tag" ? item.tag : item.view.name).charAt(0).toUpperCase() || "V"}
              accent={item.kind === "tag"}
            />
          ))}
        </div>
      </div>
    );
  }

  const activeUserView = userItems.find((i) => i.key === activeKey)?.view || null;

  return (
    <div className="proto-view-sidebar">
      <div className="proto-view-sidebar-header">
        <span className="proto-view-sidebar-title">Views</span>
        <div className="proto-view-sidebar-header-actions">
          <button
            type="button"
            className="proto-view-sidebar-icon-btn"
            onClick={toggle}
            title="Collapse panel"
            aria-label="Collapse panel"
          >
            <ChevronLeft size={12} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="proto-view-sidebar-list">
        <button
          type="button"
          className={cn(
            "proto-view-sidebar-item",
            activeKey === null && "proto-view-sidebar-item-active",
          )}
          onClick={() => onChange(null)}
        >
          <Layers size={12} strokeWidth={2} className="proto-view-sidebar-item-icon" />
          <span className="proto-view-sidebar-item-label">Default</span>
        </button>

        <div className="proto-view-sidebar-subheader">
          <Wand2 size={10} strokeWidth={2} />
          <span>Enrich-tags</span>
          <button
            type="button"
            className="proto-view-sidebar-subheader-btn"
            onClick={() => setAddTagOpen((v) => !v)}
            title="Add enrich-tag — next AI enrich will classify into this bucket"
            aria-label="Add enrich-tag"
          >
            <Plus size={10} strokeWidth={2.5} />
          </button>
        </div>
        {addTagOpen && (
          <div className="proto-view-sidebar-inline-add">
            <input
              type="text"
              value={newTagInput}
              onChange={(e) => setNewTagInput(e.target.value)}
              placeholder="name or name: description"
              autoFocus
              disabled={tagBusy}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); submitNewTag(); }
                if (e.key === "Escape") { e.preventDefault(); setAddTagOpen(false); setNewTagInput(""); }
              }}
            />
            <button
              type="button"
              onClick={submitNewTag}
              disabled={tagBusy || !newTagInput.trim()}
              title="Add"
              aria-label="Add"
            >
              <Check size={11} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => { setAddTagOpen(false); setNewTagInput(""); }}
              title="Cancel"
              aria-label="Cancel"
            >
              <X size={11} strokeWidth={2} />
            </button>
          </div>
        )}
        {tagItems.length === 0 && !addTagOpen && (
          <div className="proto-view-sidebar-sub-empty">
            No tags yet. Add a tag and run AI enrich.
          </div>
        )}
        {tagItems.map((item) => (
          <div key={item.key} className="proto-view-sidebar-item-wrap">
            <button
              type="button"
              className={cn(
                "proto-view-sidebar-item proto-view-sidebar-item-auto",
                activeKey === item.key && "proto-view-sidebar-item-active",
              )}
              onClick={() => onChange(item.key)}
              title={item.summary || item.tag}
            >
              <span
                className="proto-view-sidebar-item-dot"
                style={{ background: colorFromName(item.color || "gray") }}
              />
              <span className="proto-view-sidebar-item-label">{item.tag}</span>
              <span className="proto-view-sidebar-item-count">{item.memberCount}</span>
            </button>
            <button
              type="button"
              className="proto-view-sidebar-item-menu-btn"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(
                  `Delete enrich-tag "${item.tag}"?\n\n` +
                  `Existing segments tagged with it stay in the DB until the next full enrich.`
                )) {
                  onDeleteTag(item.tag);
                }
              }}
              aria-label={`Delete ${item.tag}`}
              title={`Delete enrich-tag "${item.tag}"`}
            >
              <Trash2 size={11} strokeWidth={2} />
            </button>
          </div>
        ))}

        <div className="proto-view-sidebar-subheader">
          <User size={10} strokeWidth={2} />
          <span>Self-views</span>
          <button
            type="button"
            className="proto-view-sidebar-subheader-btn"
            onClick={onNewView}
            title="New self-view — rules / LLM / manual"
            aria-label="New self-view"
          >
            <Plus size={10} strokeWidth={2.5} />
          </button>
        </div>
        {userItems.length === 0 && (
          <div className="proto-view-sidebar-sub-empty">
            No self-views yet.
          </div>
        )}
        {userItems.length > 0 && (
          <>
            {userItems.map((item) => (
              <div key={item.key} className="proto-view-sidebar-item-wrap">
                <button
                  type="button"
                  className={cn(
                    "proto-view-sidebar-item",
                    activeKey === item.key && "proto-view-sidebar-item-active",
                  )}
                  onClick={() => onChange(item.key)}
                  onDoubleClick={() => onEditView(item.view)}
                  title={item.view.name}
                >
                  <span className="proto-view-sidebar-item-label">{item.view.name}</span>
                  {typeof item.view.member_count === "number" && (
                    <span className="proto-view-sidebar-item-count">{item.view.member_count}</span>
                  )}
                </button>
                <button
                  type="button"
                  className={cn(
                    "proto-view-sidebar-item-menu-btn",
                    menuOpen === item.key && "proto-view-sidebar-item-menu-btn-open",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen((m) => (m === item.key ? null : item.key));
                  }}
                  aria-label="View options"
                >
                  <MoreHorizontal size={12} strokeWidth={2} />
                </button>
                {menuOpen === item.key && (
                  <div
                    className="proto-view-sidebar-item-menu"
                    onClick={(e) => e.stopPropagation()}
                    onMouseLeave={() => setMenuOpen(null)}
                  >
                    <button type="button" onClick={() => { setMenuOpen(null); onEditView(item.view); }}>
                      <Pencil size={11} strokeWidth={2} /> Edit
                    </button>
                    <button type="button" onClick={() => { setMenuOpen(null); onRepopulateView(item.view); }}>
                      <RotateCw size={11} strokeWidth={2} /> Re-populate
                    </button>
                    <button
                      type="button"
                      className="proto-view-sidebar-item-menu-danger"
                      onClick={() => {
                        setMenuOpen(null);
                        if (confirm(`Delete view "${item.view.name}"? Source file is untouched.`)) {
                          onDeleteView(item.view);
                        }
                      }}
                    >
                      <Trash2 size={11} strokeWidth={2} /> Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      {activeKey !== null && (
        <div className="proto-view-sidebar-section">
          <div className="proto-view-sidebar-section-head">
            <span>Members</span>
            {activeUserView && (
              <button
                type="button"
                className="proto-view-sidebar-icon-btn"
                onClick={() => onRepopulateView(activeUserView)}
                title="Re-run rules & AI match"
                aria-label="Re-populate"
              >
                <RotateCw size={11} strokeWidth={2} />
              </button>
            )}
          </div>
          <div className="proto-view-sidebar-members">
            {activeMembers.length === 0 ? (
              <div className="proto-view-sidebar-empty">
                No lines yet. Select lines in the editor and click + to add, or
                edit the view to add rules.
              </div>
            ) : (
              activeMembers.map((m) => (
                <button
                  key={`${m.line_no}-${m.line_hash}`}
                  type="button"
                  className="proto-view-sidebar-member"
                  onClick={() => onJumpToLine(m.line_no)}
                  title={m.text}
                >
                  <SourceIcon source={m.source} />
                  <span className="proto-view-sidebar-member-line">{m.line_no}</span>
                  <span className="proto-view-sidebar-member-text">{m.text.trim() || " "}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MiniBtn({
  active, onClick, title, char, accent,
}: { active: boolean; onClick: () => void; title: string; char: React.ReactNode; accent?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "proto-view-sidebar-mini-btn",
        active && "proto-view-sidebar-mini-btn-active",
        accent && "proto-view-sidebar-mini-btn-auto",
      )}
      onClick={onClick}
      title={title}
    >
      {char}
    </button>
  );
}

function SourceIcon({ source }: { source: "rule" | "ai" | "manual" }) {
  if (source === "ai") return <Sparkles size={10} strokeWidth={2} className="proto-view-sidebar-src proto-view-sidebar-src-ai" />;
  if (source === "rule") return <Filter size={10} strokeWidth={2} className="proto-view-sidebar-src proto-view-sidebar-src-rule" />;
  return <User size={10} strokeWidth={2} className="proto-view-sidebar-src proto-view-sidebar-src-manual" />;
}

// Tag colors match the legacy NoteSegments palette so AI views keep their
// visual identity even though the tag strip is gone.
function colorFromName(name: string): string {
  const m: Record<string, string> = {
    red: "#e5484d", orange: "#f76b15", yellow: "#ffc53d",
    green: "#30a46c", blue: "#3e63dd", purple: "#8e4ec6", gray: "#7b7d82",
  };
  return m[name] || m.gray;
}
