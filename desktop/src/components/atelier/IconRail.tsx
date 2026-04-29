import {
  FileEdit, BookOpen, Search, Layers,
  Loader2, Table, Activity, Cloud,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { ChannelId } from "@/lib/types";

/* 48px left icon rail. Six icons in two clusters separated by a
 * spacer:
 *
 *   Top cluster (canvas-content):
 *     Note · Wiki · Smart tables · Search (⌘K)
 *
 *   Bottom cluster (workspace-level):
 *     Workspace sheet · Settings
 *
 * Hover/keyboard focus surfaces the label via `title=` (browser
 * tooltip). Search opens the ⌘K palette directly — no separate
 * search page on the rail; the dedicated Search route is reachable
 * via the palette's "see all results" affordance (P3+).
 */

type Props = {
  activeChannel: ChannelId;
  onSelect: (channel: ChannelId) => void;
  ingestBusy: boolean;
  wikiTopicCount: number;
  onOpenPalette: () => void;
  onOpenWorkspace: () => void;
};

export function IconRail({
  activeChannel, onSelect, ingestBusy, wikiTopicCount,
  onOpenPalette, onOpenWorkspace,
}: Props) {
  return (
    <aside className="proto-atelier-rail" aria-label="Primary navigation">
      <div className="proto-atelier-rail-logo" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
        <span className="proto-logo-s">S</span><span className="proto-logo-n">N</span>
      </div>

      <RailButton
        active={activeChannel === "stream"}
        onClick={() => onSelect("stream")}
        title="Stream — recent activity"
      >
        <Activity size={16} strokeWidth={2} />
      </RailButton>

      <RailButton
        active={activeChannel === "note"}
        onClick={() => onSelect("note")}
        title="Note"
      >
        {ingestBusy
          ? <Loader2 size={16} className="animate-spin" style={{ color: "var(--color-accent)" }} />
          : <FileEdit size={16} strokeWidth={2} />}
      </RailButton>

      <RailButton
        active={activeChannel === "special-knowledge" || activeChannel === "source-list" || activeChannel.startsWith("source:")}
        onClick={() => onSelect("special-knowledge")}
        title="Wiki"
        badge={wikiTopicCount > 0 ? wikiTopicCount : undefined}
      >
        <BookOpen size={16} strokeWidth={2} />
      </RailButton>

      <RailButton
        active={activeChannel === "smart-table" || activeChannel.startsWith("smart-table:")}
        onClick={() => onSelect("smart-table")}
        title="Smart tables"
      >
        <Table size={16} strokeWidth={2} />
      </RailButton>

      <RailButton
        active={activeChannel === "search"}
        onClick={onOpenPalette}
        title="Search (⌘K)"
      >
        <Search size={16} strokeWidth={2} />
      </RailButton>

      <div className="proto-atelier-rail-spacer" />

      {/* Cloud Console — first-class entry point. The sync console is
          the user's window into agent reads, memory drafts, and
          subscription state, so it deserves a primary rail slot
          rather than living buried in the workspace sheet. */}
      <RailButton
        active={activeChannel === "cloud-sync"}
        onClick={() => onSelect("cloud-sync")}
        title="Cloud Console"
      >
        <Cloud size={16} strokeWidth={2} />
      </RailButton>

      {/* Workspace sheet — devices, plan, provider. Settings live
          inside the sheet (no separate icon) to keep the rail at six. */}
      <RailButton
        active={false}
        onClick={onOpenWorkspace}
        title="Workspace"
      >
        <Layers size={16} strokeWidth={2} />
      </RailButton>
    </aside>
  );
}

function RailButton({
  active, onClick, title, badge, children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  badge?: number;
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
      {badge !== undefined && (
        <span className="proto-atelier-rail-badge">{badge}</span>
      )}
    </button>
  );
}
