import { useCallback, useEffect, useState, type ReactNode } from "react";

export type AtelierShellContext = {
  openPalette: () => void;
  openWorkspace: () => void;
};
import { IconRail } from "./IconRail";
import { ContextPanel, type ContextMode } from "./ContextPanel";
import { BottomBar } from "./BottomBar";
import { CommandPalette } from "./CommandPalette";
import { WorkspaceSheet } from "./WorkspaceSheet";
import { InlinePresenceCard } from "./InlinePresenceCard";
import type { ChannelId } from "@/lib/types";

/* AtelierShell — the new top-level layout (C × A × B hybrid).
 *
 * Replaces the channel-tabs Sidebar + bare main pattern with:
 *   - 48px left icon rail (always visible, minimal)
 *   - center canvas: hosts whatever the active channel renders
 *   - 300px right context panel (conditional — only on
 *     note/source/wiki-shaped channels; collapses for full-canvas
 *     channels like Cloud Console / Settings)
 *   - 32px bottom ambient bar (always visible)
 *
 * Plus two overlay surfaces:
 *   - ⌘K command palette (B-style library-tree-aware search)
 *   - Workspace bottom sheet (devices + plan + provider)
 *
 * The shell is render-only — channel state stays in App.tsx so the
 * existing route table is intact. Old Sidebar.tsx keeps building
 * until we delete it; nothing imports it after this lands.
 */

type Props = {
  activeChannel: ChannelId;
  onSelect: (channel: ChannelId) => void;
  ingestBusy: boolean;
  wikiTopicCount: number;
  // Render-prop so child surfaces (StreamHome's ⌘K topbar, etc.)
  // can call into shell-owned overlays without prop drilling.
  children: ReactNode | ((ctx: AtelierShellContext) => ReactNode);
};

/* Channels where the right context panel makes sense (note-shaped,
 * wiki-shaped). On these the layout is 48 / 1fr / 300; everywhere
 * else the panel collapses and the canvas takes the whole middle.
 *
 * The check is by-prefix to cover sub-channels like `source:foo` and
 * `smart-table:bar`. */
function shouldShowContextPanel(ch: ChannelId): boolean {
  if (ch === "note") return true;
  if (ch === "special-knowledge") return true;     // wiki home
  if (ch === "source-list") return true;
  if (ch.startsWith("source:")) return true;
  return false;
}

export function AtelierShell({
  activeChannel,
  onSelect,
  ingestBusy,
  wikiTopicCount,
  children,
}: Props) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  // Lifted-up mode for ContextPanel so the inline presence callout
  // can flip the right pane to "Activity" via its "See activity"
  // button. ContextPanel still owns the localStorage persistence;
  // it reads the initial mode and writes back to localStorage on
  // change. Here we just hold the live value as a controlled prop.
  const [contextMode, setContextMode] = useState<ContextMode>("detail");

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openWorkspace = useCallback(() => setWorkspaceOpen(true), []);
  const closeWorkspace = useCallback(() => setWorkspaceOpen(false), []);
  const showActivity = useCallback(() => setContextMode("activity"), []);

  // Global ⌘K. Closes overlays on Esc — the components themselves
  // also handle Esc internally, but a top-level guard means nothing
  // ever gets stuck open if focus drifts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (e.key === "Escape") {
        setPaletteOpen(false);
        setWorkspaceOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const showContext = shouldShowContextPanel(activeChannel);

  return (
    <div
      className="proto-atelier"
      data-context={showContext ? "shown" : "hidden"}
    >
      <IconRail
        activeChannel={activeChannel}
        onSelect={onSelect}
        ingestBusy={ingestBusy}
        wikiTopicCount={wikiTopicCount}
        onOpenPalette={openPalette}
        onOpenWorkspace={openWorkspace}
      />
      <main className="proto-atelier-canvas">
        {showContext && (
          <InlinePresenceCard onShowActivity={showActivity} />
        )}
        {typeof children === "function"
          ? children({ openPalette, openWorkspace })
          : children}
      </main>
      {showContext && (
        <ContextPanel
          activeChannel={activeChannel}
          onSelect={onSelect}
          mode={contextMode}
          onModeChange={setContextMode}
        />
      )}
      <BottomBar
        onOpenPalette={openPalette}
        onOpenWorkspace={openWorkspace}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        onSelect={onSelect}
      />
      <WorkspaceSheet
        open={workspaceOpen}
        onClose={closeWorkspace}
        onSelect={onSelect}
      />
    </div>
  );
}
