import { useState, useRef } from "react";
import {
  Search,
  FolderInput,
  Activity,
  Tag,
  Settings,
  Loader2,
  Plus,
  X,
  Pencil,
  GripVertical,
  FileEdit,
  BookPlus,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { ChannelId, ViewItem } from "@/lib/types";
import type { TagInfo } from "@/lib/api";
import * as api from "@/lib/api";

type Props = {
  activeChannel: ChannelId;
  onSelect: (channel: ChannelId) => void;
  views: ViewItem[];
  tags: TagInfo[];
  onTagsChanged: () => void;
  gatewayOnline: boolean;
  ingestBusy: boolean;
  embeddingMode: string;
  kbVersion?: string;
};

function SectionLabel({ children, trailing }: { children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="proto-section-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <span>{children}</span>
      {trailing}
    </div>
  );
}

function NavItem({
  label, icon, active, onClick, trailing,
}: {
  label: string; icon: React.ReactNode; active: boolean;
  onClick: () => void; trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("proto-nav-item", active && "proto-nav-item-active")}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

export function Sidebar({ activeChannel, onSelect, views, tags, onTagsChanged, gatewayOnline, ingestBusy, embeddingMode }: Props) {
  const [editMode, setEditMode] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const [colorPickerTag, setColorPickerTag] = useState<string | null>(null);

  const TAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];

  async function handleSetColor(name: string, color: string) {
    if (busy) return;
    setBusy(true);
    try { await api.setTagColor(name, color); onTagsChanged(); } catch {}
    setBusy(false);
    setColorPickerTag(null);
  }

  async function handleAddTag() {
    const raw = newTag.trim();
    if (!raw || busy) return;
    // Support "name:description" syntax
    const colonIdx = raw.indexOf(":");
    const name = colonIdx > 0 ? raw.slice(0, colonIdx).trim() : raw;
    const desc = colonIdx > 0 ? raw.slice(colonIdx + 1).trim() : "";
    if (!name) return;
    setBusy(true);
    try { await api.addTag(name, desc); setNewTag(""); onTagsChanged(); } catch {}
    setBusy(false);
  }

  async function handleDeleteTag(name: string) {
    if (busy) return;
    setBusy(true);
    try { await api.deleteTag(name); onTagsChanged(); } catch {}
    setBusy(false);
  }

  async function handleDrop(targetIdx: number) {
    if (dragIdx === null || dragIdx === targetIdx || busy) return;
    const order = tags.map((t) => t.name);
    const [moved] = order.splice(dragIdx, 1);
    order.splice(targetIdx, 0, moved);
    setBusy(true);
    try { await api.reorderTags(order); onTagsChanged(); } catch {}
    setBusy(false);
    setDragIdx(null);
    setDropIdx(null);
  }

  return (
    <div className="proto-sidebar">
      <div className="h-12 shrink-0" style={{ WebkitAppRegion: "drag" } as React.CSSProperties} />

      <div className="proto-sidebar-nav">
        <NavItem label="Search" icon={<Search size={15} strokeWidth={2} />} active={activeChannel === "search"} onClick={() => onSelect("search")} />

        <SectionLabel>Tools</SectionLabel>
        <NavItem
          label="Note"
          icon={<FileEdit size={15} strokeWidth={2} />}
          active={activeChannel === "note"}
          onClick={() => onSelect("note")}
          trailing={ingestBusy ? <Loader2 size={12} className="text-[var(--color-accent)] animate-spin ml-auto shrink-0" /> : undefined}
        />
        <NavItem
          label="Special Knowledge"
          icon={<BookPlus size={15} strokeWidth={2} />}
          active={activeChannel === "special-knowledge"}
          onClick={() => onSelect("special-knowledge")}
        />
        <NavItem
          label="Sync Rate"
          icon={<Activity size={15} strokeWidth={2} />}
          active={activeChannel === "sync-rate"}
          onClick={() => onSelect("sync-rate")}
        />

        <SectionLabel
          trailing={
            <button
              type="button"
              onClick={() => setEditMode(!editMode)}
              className="proto-sidebar-edit-btn"
            >
              {editMode ? "Done" : <Pencil size={11} />}
            </button>
          }
        >
          Tags
        </SectionLabel>

        <div className="space-y-px">
          {tags.map((t, i) => (
            <div
              key={t.name}
              draggable={editMode}
              onDragStart={() => setDragIdx(i)}
              onDragOver={(e) => { e.preventDefault(); setDropIdx(i); }}
              onDragLeave={() => setDropIdx(null)}
              onDrop={(e) => { e.preventDefault(); handleDrop(i); }}
              onDragEnd={() => { setDragIdx(null); setDropIdx(null); }}
              className={cn(
                "proto-tag-drag-item",
                dragIdx === i && "proto-tag-dragging",
                dropIdx === i && dragIdx !== i && "proto-tag-drop-target"
              )}
            >
              {editMode && (
                <span className="proto-tag-grip">
                  <GripVertical size={12} />
                </span>
              )}
              <NavItem
                label={t.name}
                icon={
                  editMode ? (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setColorPickerTag(colorPickerTag === t.name ? null : t.name); }}
                      className={cn("proto-tag-dot", `proto-tag-dot-${t.color || "gray"}`)}
                      title="Change color"
                    />
                  ) : (
                    <span className={cn("proto-tag-dot", `proto-tag-dot-${t.color || "gray"}`)} />
                  )
                }
                active={activeChannel === `tag:${t.name}`}
                onClick={() => onSelect(`tag:${t.name}`)}
                trailing={
                  editMode ? (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleDeleteTag(t.name); }}
                      disabled={busy}
                      className="proto-tag-delete-btn"
                    >
                      <X size={12} />
                    </button>
                  ) : t.segments > 0 ? (
                    <span className="proto-nav-badge">{t.segments}</span>
                  ) : undefined
                }
              />
              {/* Color picker popup */}
              {editMode && colorPickerTag === t.name && (
                <div className="proto-tag-color-picker" style={{ paddingLeft: 32 }}>
                  {TAG_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleSetColor(t.name, c); }}
                      className={cn("proto-tag-color-swatch", `proto-tag-dot-${c}`, t.color === c && "proto-tag-color-swatch-active")}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

          {editMode && (
            <div className="proto-tag-add-row">
              <input
                type="text"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
                placeholder="name:description"
                className="proto-form-input proto-tag-add-input"
              />
              <button type="button" onClick={handleAddTag} disabled={!newTag.trim() || busy} className="proto-btn proto-btn-primary proto-tag-add-btn">
                <Plus size={12} />
              </button>
            </div>
          )}

          {tags.length === 0 && !editMode && (
            <p className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
              Ingest notes to classify by tags.
            </p>
          )}
        </div>
      </div>

      <div className="proto-sidebar-footer">
        <NavItem label="Settings" icon={<Settings size={15} strokeWidth={2} />} active={activeChannel === "settings"} onClick={() => onSelect("settings")} />
        <div className="proto-sidebar-status">
          <span className={cn("proto-status-dot", !gatewayOnline && "proto-status-dot-offline")} />
          {gatewayOnline ? "Online" : "Offline"} · {embeddingMode || "local"}
        </div>
      </div>
    </div>
  );
}
