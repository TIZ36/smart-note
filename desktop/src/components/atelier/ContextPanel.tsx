import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { Activity, Info } from "lucide-react";
import type { ChannelId } from "@/lib/types";
import { ContextActivityFeed } from "./ContextActivityFeed";
import { ContextDetail } from "./ContextDetail";

/* Right-side context panel.
 *
 * Two modes:
 *   - "detail"   — what the current note/page is about (default).
 *                  Fed by the active channel; today shows a stub
 *                  hero, P3 wires the existing tag/related/memory
 *                  rows that NotePage already renders into its own
 *                  sidebar.
 *   - "activity" — A's stream view. Cross-cutting feed of what
 *                  agents + users + cloud have done lately. The user
 *                  swaps to this when they want context-on-the-system
 *                  rather than context-on-this-page.
 *
 * Mode persists in localStorage so the user's choice carries across
 * sessions. The mode toggle sits at the top of the panel; small,
 * label-only, no theatrical chrome.
 */

export type ContextMode = "detail" | "activity";

type Props = {
  activeChannel: ChannelId;
  onSelect: (channel: ChannelId) => void;
  // Controlled mode — owned by AtelierShell so other surfaces (the
  // inline presence callout's "See activity" button) can flip the
  // pane. ContextPanel still handles the localStorage persistence
  // since it's the canonical home for the user's mode preference.
  mode: ContextMode;
  onModeChange: (mode: ContextMode) => void;
};

const STORAGE_KEY = "smartnote-atelier-context-mode";

export function readPersistedMode(): ContextMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "activity" || v === "detail") return v;
  } catch { /* ignore */ }
  return "detail";
}

export function ContextPanel({ activeChannel, onSelect, mode, onModeChange }: Props) {
  // On mount, inform the parent of the persisted mode if it differs
  // from the initial value the parent rendered with. This keeps the
  // localStorage round-trip in one place without making the parent
  // import readPersistedMode.
  useEffect(() => {
    const persisted = readPersistedMode();
    if (persisted !== mode) onModeChange(persisted);
    // Intentionally one-shot on mount — parent owns the value after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
  }, [mode]);

  function setMode(next: ContextMode) {
    onModeChange(next);
  }

  return (
    <aside className="proto-atelier-ctx" aria-label="Context panel">
      <header className="proto-atelier-ctx-head">
        <button
          type="button"
          className={cn(
            "proto-atelier-ctx-mode",
            mode === "detail" && "proto-atelier-ctx-mode-active",
          )}
          onClick={() => setMode("detail")}
          aria-pressed={mode === "detail"}
        >
          <Info size={11} strokeWidth={2} />
          For this {channelKindLabel(activeChannel)}
        </button>
        <button
          type="button"
          className={cn(
            "proto-atelier-ctx-mode",
            mode === "activity" && "proto-atelier-ctx-mode-active",
          )}
          onClick={() => setMode("activity")}
          aria-pressed={mode === "activity"}
        >
          <Activity size={11} strokeWidth={2} />
          Activity
        </button>
      </header>

      <div className="proto-atelier-ctx-body">
        {mode === "detail" && (
          <ContextDetail activeChannel={activeChannel} onSelect={onSelect} />
        )}
        {mode === "activity" && <ContextActivityFeed onSelect={onSelect} />}
      </div>
    </aside>
  );
}

function channelKindLabel(ch: ChannelId): string {
  if (ch === "note") return "note";
  if (ch === "special-knowledge") return "wiki";
  if (ch === "source-list") return "wiki";
  if (ch.startsWith("source:")) return "wiki source";
  return "page";
}

/* Detail rendering moved to ContextDetail.tsx (real data + structured
 * sections matching the prototype). This file stays small — just
 * mode toggle + body slot. */
