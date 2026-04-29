import { useEffect, useState } from "react";
import { SpotlightPalette } from "./SpotlightPalette";
import { readSettings } from "@/lib/electron";

/* SpotlightApp — root component for the dedicated frameless window
 * that opens on ⌘K. Renders only the SpotlightPalette filling the
 * window; no rail / canvas / chrome.
 *
 * The Spotlight BrowserWindow is created ONCE at app startup and
 * just toggled visible/hidden. To make every ⌘K still feel like
 * a fresh pop-in (animation + cleared input) we key the palette by
 * the count of spotlight-open events received from main, forcing
 * React to remount the palette tree on each press.
 */

export function SpotlightApp() {
  const [rawPath, setRawPath] = useState<string | null>(null);
  // Bumped on every "smartnote:spotlight-open" IPC. The Palette
  // is keyed by this so the open animation + initial focus +
  // empty input all happen fresh on each ⌘K.
  const [openSeq, setOpenSeq] = useState(0);

  useEffect(() => {
    let alive = true;
    readSettings()
      .then((s) => { if (alive) setRawPath((s as { raw_path?: string }).raw_path || null); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Subscribe to the per-press signal from main.
  useEffect(() => {
    const off = window.desktop?.onSpotlightOpen?.(() => {
      setOpenSeq((n) => n + 1);
    });
    return () => { off?.(); };
  }, []);

  function handleClose() {
    window.desktop?.invoke("spotlight:close").catch(() => {});
  }

  function handlePick(channel: string) {
    window.desktop?.invoke("spotlight:pick", { channel }).catch(() => {});
  }

  return (
    <div className="proto-spotlight-window-root">
      <SpotlightPalette
        key={openSeq}
        open={true}
        windowMode={true}
        onClose={handleClose}
        rawPath={rawPath}
        onPickSource={handlePick}
      />
    </div>
  );
}
