import { FileEdit, Library, Cloud, Settings, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ChannelId } from "@/lib/types";

/* 48px left rail · v3 stream-centric.
 *
 *   SN logo            ← onClick = setActiveChannel("stream")
 *   Note               ← full-canvas markdown editor
 *   Library            ← Docs (now also hosts knowledge processing) ·
 *                        Memories · Skills
 *   <spacer>
 *   Cloud              ← opens center modal (NOT a channel)
 *   Settings           ← full-canvas settings
 *
 * Stream is "home" — there is no rail icon for it; the logo doubles
 * as a return affordance. Cloud doesn't change the channel either —
 * it overlays a modal on whatever surface is showing. The old RAG
 * (knowledge-processing) page was folded into Library Docs: bulk
 * Embed/Enrich, retrieval-path status, and tag CRUD all live there.
 */

type Props = {
  activeChannel: ChannelId;
  onSelect: (channel: ChannelId) => void;
  onOpenCloud: () => void;
  ingestBusy: boolean;
  /** Pending memory count (proposals awaiting review). 0 hides the badge. */
  pendingMemoryCount: number;
};

export function IconRail({
  activeChannel,
  onSelect,
  onOpenCloud,
  ingestBusy,
  pendingMemoryCount,
}: Props) {
  const inLibrary = activeChannel.startsWith("library:") || activeChannel.startsWith("source:");

  return (
    <aside className="proto-atelier-rail" aria-label="Primary navigation">
      <div
        className="proto-atelier-rail-logo"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        onClick={() => onSelect("stream")}
        title="SmartNote — back to Stream"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect("stream");
          }
        }}
      >
        <span className="proto-atelier-rail-logo-mark" aria-label="SmartNote">
          <span className="proto-atelier-rail-logo-s">S</span>
          <span className="proto-atelier-rail-logo-n">N</span>
        </span>
      </div>

      <RailButton
        active={activeChannel === "note"}
        onClick={() => onSelect("note")}
        title="Note"
      >
        {ingestBusy
          ? <Loader2 size={16} className="animate-spin" style={{ color: "var(--color-accent)" }} />
          : <FileEdit size={16} strokeWidth={1.7} />}
      </RailButton>

      <RailButton
        active={inLibrary}
        onClick={() => onSelect("library:docs")}
        title="Library — Docs · Memories · Skills"
        badge={pendingMemoryCount > 0 ? pendingMemoryCount : undefined}
        badgeTitle={
          pendingMemoryCount > 0
            ? `${pendingMemoryCount} memor${pendingMemoryCount === 1 ? "y" : "ies"} awaiting review`
            : undefined
        }
      >
        <Library size={16} strokeWidth={1.7} />
      </RailButton>

      <div className="proto-atelier-rail-spacer" />

      <RailButton
        active={false}
        onClick={onOpenCloud}
        title="Workspace · Cloud"
      >
        <Cloud size={16} strokeWidth={1.7} />
      </RailButton>

      <RailButton
        active={activeChannel === "settings"}
        onClick={() => onSelect("settings")}
        title="Settings"
      >
        <Settings size={16} strokeWidth={1.7} />
      </RailButton>
    </aside>
  );
}

function RailButton({
  active,
  onClick,
  title,
  badge,
  badgeTitle,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  badge?: number;
  badgeTitle?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn("proto-atelier-rail-btn", active && "proto-atelier-rail-btn-active")}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span className="proto-atelier-rail-badge" title={badgeTitle}>{badge}</span>
      )}
    </button>
  );
}
