import { useState } from "react";
import { Plus, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { NoteView } from "@/lib/api";
import type { SidebarViewItem } from "./NoteViewSidebar";

/* NoteViewStrip — horizontal chip row replacing the foldable sidebar.
 *
 * Per user feedback: "ai tag, view 和主题不连贯，折叠太多，没必要".
 * Views + AI tags now sit in one always-visible strip directly under
 * the breadcrumb, so the editor + lens + classification reads as one
 * coherent surface (no toggle to "open the sidebar to see views").
 *
 *   [Default] [User: my notes] [AI: 技术方案 12] [AI: 回传 8] [+ View]
 *
 * Interactions:
 *   - Click any chip → switch to that view (dim non-members in editor).
 *   - Active chip shows a tiny × that re-activates the Default view.
 *   - User chip on hover reveals ⚙ → small inline action row (Edit /
 *     Repopulate / Delete). Lower density than a popup; matches v3's
 *     "actions live in the surface, not behind menus" rule.
 *   - "+ View" at strip end opens the existing NoteViewDialog.
 */

type Props = {
  items: SidebarViewItem[];
  activeKey: string | null;
  onChange: (key: string | null) => void;
  // View CRUD is disabled until reimplemented on cloud. Pass undefined
  // to hide the "+ View" button and per-view edit affordances.
  onNewView?: () => void;
  onEditView?: (view: NoteView) => void;
  onRepopulateView: (view: NoteView) => void;
  onDeleteView: (view: NoteView) => void;
};

export function NoteViewStrip({
  items, activeKey, onChange, onNewView, onEditView, onRepopulateView, onDeleteView,
}: Props) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const userViews = items.filter((i): i is Extract<SidebarViewItem, { kind: "user" }> => i.kind === "user");
  const tagViews = items.filter((i): i is Extract<SidebarViewItem, { kind: "tag" }> => i.kind === "tag");

  return (
    <div className="proto-note-v3-strip" role="tablist" aria-label="Note views and AI tags">
      <Chip
        active={activeKey === null}
        label="Default"
        meta="all lines"
        onClick={() => onChange(null)}
      />

      {userViews.length > 0 && <Sep />}
      {userViews.map((u) => {
        const active = activeKey === u.key;
        const hovered = hoveredKey === u.key;
        return (
          <div
            key={u.key}
            className={cn(
              "proto-note-v3-strip-cluster",
              active && "proto-note-v3-strip-cluster-active",
            )}
            onMouseEnter={() => setHoveredKey(u.key)}
            onMouseLeave={() => setHoveredKey(null)}
          >
            <Chip
              active={active}
              label={u.view.name}
              kind="user"
              onClick={() => onChange(u.key)}
              onClear={active ? () => onChange(null) : undefined}
            />
            {(hovered || active) && onEditView && (
              <span className="proto-note-v3-strip-actions" aria-hidden={!hovered && !active}>
                <ActionBtn title="Edit view" onClick={() => onEditView(u.view)}>
                  <Pencil size={10} strokeWidth={2} />
                </ActionBtn>
                <ActionBtn title="Re-run filter" onClick={() => onRepopulateView(u.view)}>
                  <RefreshCw size={10} strokeWidth={2} />
                </ActionBtn>
                <ActionBtn title="Delete view" tone="danger" onClick={() => onDeleteView(u.view)}>
                  <Trash2 size={10} strokeWidth={2} />
                </ActionBtn>
              </span>
            )}
          </div>
        );
      })}

      {tagViews.length > 0 && <Sep />}
      {tagViews.map((t) => {
        const active = activeKey === t.key;
        return (
          <Chip
            key={t.key}
            active={active}
            label={t.tag}
            count={t.memberCount}
            kind="tag"
            color={t.color}
            onClick={() => onChange(t.key)}
            onClear={active ? () => onChange(null) : undefined}
          />
        );
      })}

      {onNewView && (
        <>
          <Sep />
          <button
            type="button"
            onClick={onNewView}
            className="proto-note-v3-strip-add"
            title="New custom view"
          >
            <Plus size={11} strokeWidth={2} /> View
          </button>
        </>
      )}
    </div>
  );
}

function Chip({
  active, label, meta, count, kind, color, onClick, onClear,
}: {
  active: boolean;
  label: string;
  meta?: string;
  count?: number;
  kind?: "user" | "tag";
  color?: string;
  onClick: () => void;
  onClear?: () => void;
}) {
  const tagStyle = kind === "tag" && color
    ? {
        background: `color-mix(in oklab, ${color} 14%, transparent)`,
        color,
        borderColor: "transparent",
      }
    : undefined;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "proto-note-v3-strip-chip",
        active && "proto-note-v3-strip-chip-active",
        kind === "user" && "proto-note-v3-strip-chip-user",
        kind === "tag"  && "proto-note-v3-strip-chip-tag",
      )}
      style={active ? undefined : tagStyle}
    >
      {kind === "user" && <span className="proto-note-v3-strip-chip-prefix">View</span>}
      {kind === "tag"  && <span className="proto-note-v3-strip-chip-prefix">AI</span>}
      <span className="proto-note-v3-strip-chip-label">{label}</span>
      {count !== undefined && <span className="proto-note-v3-strip-chip-count">{count}</span>}
      {meta && <span className="proto-note-v3-strip-chip-meta">{meta}</span>}
      {onClear && (
        <span
          className="proto-note-v3-strip-chip-clear"
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          role="button"
          aria-label="Deactivate"
        >
          <X size={10} strokeWidth={2} />
        </span>
      )}
    </button>
  );
}

function ActionBtn({
  children, title, tone, onClick,
}: {
  children: React.ReactNode;
  title: string;
  tone?: "danger";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "proto-note-v3-strip-action",
        tone === "danger" && "proto-note-v3-strip-action-danger",
      )}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="proto-note-v3-strip-sep" aria-hidden="true" />;
}
