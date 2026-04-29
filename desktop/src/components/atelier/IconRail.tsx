import { FileEdit, Library, Cloud, Settings, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ChannelId } from "@/lib/types";

/* 48px left rail · v3 stream-centric.
 *
 * Four buttons + a top-anchored SN logo that returns to Stream:
 *
 *   SN logo            ← onClick = setActiveChannel("stream")
 *   ─────              ← Note (full-canvas markdown editor)
 *   Library            ← Docs · Memories · Skills (3 sub-tabs)
 *   <spacer>
 *   Cloud              ← opens center modal (NOT a channel)
 *   Settings           ← full-canvas settings
 *
 * Stream is "home" — there is no rail icon for it; the logo doubles
 * as a return affordance. Cloud doesn't change the channel either —
 * it overlays a modal on whatever surface is showing.
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
        <SmartNoteMark />
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

/* SmartNote logo mark — stylized note glyph with corner fold + two
 * subtle text-line strokes + a small accent dot. Drawn in 24×24
 * viewBox; rendered ~20px inside the 28×28 rail-logo container
 * which provides the dark fill background. */
function SmartNoteMark() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8.5 4h6l4.5 4.5V19a2 2 0 0 1-2 2H8.5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
      <path d="M14.5 4v4.5H19" />
      <line x1="10" y1="13.5" x2="15.5" y2="13.5" opacity="0.85" />
      <line x1="10" y1="16.5" x2="13.5" y2="16.5" opacity="0.55" />
    </svg>
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
