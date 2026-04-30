import { useCallback, useEffect, useState, type ReactNode } from "react";

export type AtelierShellContext = {
  openPalette: () => void;
  openCloud: () => void;
};

import { IconRail } from "./IconRail";
import { BottomBar } from "./BottomBar";
import { CommandPalette } from "./CommandPalette";
import { CloudModal } from "../cloud-modal/CloudModal";
import type { ChannelId } from "@/lib/types";

/* AtelierShell — v3 stream-centric layout.
 *
 *   48px left rail · 1fr canvas · 32px ambient bottom bar
 *
 * Active surface fills the canvas. Cloud is overlaid as a center
 * modal, not a channel — the rail's Cloud icon toggles it. ⌘K still
 * opens the command palette.
 *
 * NOTE — v2's right-side ContextPanel + InlinePresenceCard are gone.
 * Per the v3 prototype, all "context" (memories, related docs, agent
 * activity) lives inside Stream rows or the Library Memories pane.
 */

type Props = {
  activeChannel: ChannelId;
  onSelect: (channel: ChannelId) => void;
  ingestBusy: boolean;
  pendingMemoryCount: number;
  /** Render-prop so child surfaces (StreamHome's ⌘K topbar etc.)
   *  can call into shell-owned overlays without prop drilling. */
  children: ReactNode | ((ctx: AtelierShellContext) => ReactNode);
};

export function AtelierShell({
  activeChannel,
  onSelect,
  ingestBusy,
  pendingMemoryCount,
  children,
}: Props) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openCloud = useCallback(() => setCloudOpen(true), []);
  const closeCloud = useCallback(() => setCloudOpen(false), []);

  // Allow nested components (e.g. KPSession's "Open Cloud panel"
  // remediation button) to request the modal without prop-drilling
  // openCloud through every layer.
  useEffect(() => {
    function handler() { setCloudOpen(true); }
    window.addEventListener("smartnote:open-cloud-panel", handler);
    return () => window.removeEventListener("smartnote:open-cloud-panel", handler);
  }, []);

  // Global ⌘K. Esc unwinds whatever is open.
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
        setCloudOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="proto-atelier">
      <IconRail
        activeChannel={activeChannel}
        onSelect={onSelect}
        onOpenCloud={openCloud}
        ingestBusy={ingestBusy}
        pendingMemoryCount={pendingMemoryCount}
      />
      <main className="proto-atelier-canvas">
        {typeof children === "function"
          ? children({ openPalette, openCloud })
          : children}
      </main>
      <BottomBar onOpenPalette={openPalette} onOpenWorkspace={openCloud} />

      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        onSelect={onSelect}
      />
      <CloudModal open={cloudOpen} onClose={closeCloud} />
    </div>
  );
}
