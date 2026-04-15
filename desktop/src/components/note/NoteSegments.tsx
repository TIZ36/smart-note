import { useState, useEffect } from "react";
import { Tag, ChevronRight, Pencil, Plus, X, GripVertical } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "../../lib/cn";
import * as api from "../../lib/api";

const EASE_OUT_QUART = [0.25, 1, 0.5, 1] as const;
const TAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];

type Props = {
  refreshKey?: string | number | null;
  tags: { name: string; color?: string; desc?: string; segments: number }[];
  onScrollToLine?: (lineStart: number, lineEnd: number) => void;
  onTagsChanged?: () => void;
};

export function NoteSegments({ refreshKey, tags, onScrollToLine, onTagsChanged }: Props) {
  const [segments, setSegments] = useState<api.NoteSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedTag, setExpandedTag] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [colorPickerTag, setColorPickerTag] = useState<string | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  const tagColorMap = Object.fromEntries(tags.map((t) => [t.name, t.color || "gray"]));

  useEffect(() => {
    setLoading(true);
    api.fetchAllTagSegments()
      .then((d) => setSegments(d.segments))
      .catch(() => setSegments([]))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  useEffect(() => {
    if (!editMode) setColorPickerTag(null);
  }, [editMode]);

  // Group segments by tag
  const grouped = segments.reduce<Record<string, api.NoteSegment[]>>((acc, seg) => {
    if (!acc[seg.tag]) acc[seg.tag] = [];
    acc[seg.tag].push(seg);
    return acc;
  }, {});

  const tagOrder = tags.map((t) => t.name).filter((n) => grouped[n]);
  for (const k of Object.keys(grouped)) {
    if (!tagOrder.includes(k)) tagOrder.push(k);
  }
  // Include tags with no segments (so they can be edited)
  for (const t of tags) {
    if (!tagOrder.includes(t.name)) tagOrder.push(t.name);
  }

  async function handleAddTag() {
    const raw = newTag.trim();
    if (!raw || busy) return;
    const colonIdx = raw.indexOf(":");
    const name = colonIdx > 0 ? raw.slice(0, colonIdx).trim() : raw;
    const desc = colonIdx > 0 ? raw.slice(colonIdx + 1).trim() : "";
    if (!name) return;
    setBusy(true);
    try { await api.addTag(name, desc); setNewTag(""); onTagsChanged?.(); } catch {}
    setBusy(false);
  }

  async function handleDeleteTag(name: string) {
    if (busy) return;
    setBusy(true);
    try { await api.deleteTag(name); onTagsChanged?.(); } catch {}
    setBusy(false);
  }

  async function handleSetColor(name: string, color: string) {
    if (busy) return;
    setBusy(true);
    try { await api.setTagColor(name, color); onTagsChanged?.(); } catch {}
    setBusy(false);
    setColorPickerTag(null);
  }

  async function handleDrop(targetIdx: number) {
    if (dragIdx === null || dragIdx === targetIdx || busy) return;
    const order = [...tagOrder];
    const [moved] = order.splice(dragIdx, 1);
    order.splice(targetIdx, 0, moved);
    setBusy(true);
    try { await api.reorderTags(order); onTagsChanged?.(); } catch {}
    setBusy(false);
    setDragIdx(null);
    setDropIdx(null);
  }

  if (loading) {
    return (
      <div className="proto-note-segments">
        <div className="proto-note-segments-header">
          <span className="proto-note-segments-title">Tags</span>
        </div>
        <div className="proto-note-segments-empty">Loading...</div>
      </div>
    );
  }

  const expandedSegs = expandedTag ? (grouped[expandedTag] || []) : [];

  return (
    <div className="proto-note-segments">
      {/* Horizontal tag row */}
      <div className="proto-note-tags-row">
        <div className="proto-note-tags-chips">
          {tagOrder.map((tagName, i) => {
            const segs = grouped[tagName] || [];
            const color = tagColorMap[tagName] || "gray";
            const isActive = expandedTag === tagName;

            return (
              <div
                key={tagName}
                className={cn(
                  "proto-note-tag-chip",
                  `proto-tag-color-${color}`,
                  isActive && "proto-note-tag-chip-active",
                  editMode && dragIdx === i && "proto-note-seg-dragging",
                  editMode && dropIdx === i && dragIdx !== i && "proto-note-seg-drop-target"
                )}
                draggable={editMode}
                onDragStart={() => setDragIdx(i)}
                onDragOver={(e) => { e.preventDefault(); setDropIdx(i); }}
                onDragLeave={() => setDropIdx(null)}
                onDrop={(e) => { e.preventDefault(); handleDrop(i); }}
                onDragEnd={() => { setDragIdx(null); setDropIdx(null); }}
              >
                {editMode && <GripVertical size={10} className="proto-note-tag-grip" />}
                <button
                  type="button"
                  className="proto-note-tag-chip-btn"
                  onClick={() => !editMode && setExpandedTag(isActive ? null : tagName)}
                >
                  <Tag size={11} strokeWidth={2} />
                  <span>{tagName}</span>
                  {!editMode && segs.length > 0 && (
                    <span className="proto-note-tag-chip-count">{segs.length}</span>
                  )}
                </button>
                {editMode && (
                  <>
                    <button
                      type="button"
                      onClick={() => setColorPickerTag(colorPickerTag === tagName ? null : tagName)}
                      className="proto-note-tag-chip-color-btn"
                      title="Change color"
                    >
                      <span className={cn("proto-tag-dot-sm", `proto-tag-dot-${color}`)} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteTag(tagName)}
                      disabled={busy}
                      className="proto-note-tag-chip-x"
                    >
                      <X size={10} />
                    </button>
                  </>
                )}

                {/* Color picker popover */}
                <AnimatePresence initial={false}>
                  {editMode && colorPickerTag === tagName && (
                    <motion.div
                      className="proto-note-tag-color-popover"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ duration: 0.1 }}
                    >
                      {TAG_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => handleSetColor(tagName, c)}
                          className={cn("proto-tag-color-swatch", `proto-tag-dot-${c}`, color === c && "proto-tag-color-swatch-active")}
                        />
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}

          {/* Empty state */}
          {tagOrder.length === 0 && !editMode && (
            <span className="proto-note-tags-empty">No tags yet</span>
          )}

          {/* Add tag inline (edit mode) */}
          {editMode && (
            <div className="proto-note-tag-add">
              <input
                type="text"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
                placeholder="name:desc"
                className="proto-note-tag-add-input"
              />
              <button
                type="button"
                onClick={handleAddTag}
                disabled={!newTag.trim() || busy}
                className="proto-note-tag-add-btn"
              >
                <Plus size={11} />
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setEditMode(!editMode)}
          className="proto-note-segments-edit-btn"
        >
          {editMode ? "Done" : <Pencil size={11} />}
        </button>
      </div>

      {/* Expanded segments detail */}
      <AnimatePresence initial={false}>
        {expandedTag && !editMode && expandedSegs.length > 0 && (
          <motion.div
            className="proto-note-seg-expanded"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT_QUART }}
            style={{ overflow: "hidden" }}
          >
            <div className="proto-note-seg-expanded-inner">
              {expandedSegs.map((seg) => (
                <button
                  key={seg.id}
                  type="button"
                  className="proto-note-seg-item"
                  onClick={() => onScrollToLine?.(seg.line_start, seg.line_end)}
                >
                  <span className="proto-note-seg-range">
                    L{seg.line_start}–{seg.line_end}
                  </span>
                  {seg.topic_name && (
                    <span className="proto-note-seg-topic">{seg.topic_name}</span>
                  )}
                  {seg.is_credential && (
                    <span className="proto-note-seg-cred">cred</span>
                  )}
                  {seg.summary && (
                    <p className="proto-note-seg-summary">{seg.summary}</p>
                  )}
                  {seg.keywords.length > 0 && (
                    <div className="proto-note-seg-keywords">
                      {seg.keywords.slice(0, 6).map((kw, ki) => (
                        <span key={ki} className="proto-tag-keyword">{kw}</span>
                      ))}
                      {seg.keywords.length > 6 && (
                        <span className="proto-tag-keyword" style={{ opacity: 0.5 }}>+{seg.keywords.length - 6}</span>
                      )}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
