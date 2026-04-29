import { useEffect, useState } from "react";
import { onWsEvent, type WsEvent } from "@/lib/electron";

/**
 * Tracks "is an AI agent currently calling our MCP". Single source of
 * truth across BottomBar / Stream banner / wherever else needs the
 * "Now reading: Claude Code" indicator.
 *
 * State machine:
 *   idle       — no agent_active in the last 8s
 *   active     — last agent_active within 8s
 *
 * Auto-clears via a debounce timer; new events refresh it.
 */

export type AgentActivity = {
  agent: string;       // "Claude Code" / "Cursor" / …
  tool: string;        // last tool name (e.g. "search_memory")
  at: number;          // timestamp ms
};

const ACTIVE_WINDOW_MS = 8_000;

type Listener = (a: AgentActivity | null) => void;
const _listeners = new Set<Listener>();
let _current: AgentActivity | null = null;
let _decayTimer: ReturnType<typeof setTimeout> | null = null;
let _wired = false;

function _set(next: AgentActivity | null) {
  _current = next;
  for (const fn of _listeners) {
    try { fn(_current); } catch {}
  }
}

function _scheduleDecay() {
  if (_decayTimer) clearTimeout(_decayTimer);
  _decayTimer = setTimeout(() => {
    _decayTimer = null;
    _set(null);
  }, ACTIVE_WINDOW_MS);
}

function _wireOnce() {
  if (_wired) return;
  _wired = true;
  onWsEvent((evt: WsEvent) => {
    if (evt.type !== "agent_active") return;
    const e = evt as { agent: string; tool: string; at?: string };
    _set({
      agent: e.agent || "AI agent",
      tool: e.tool || "",
      at: e.at ? new Date(e.at).getTime() : Date.now(),
    });
    _scheduleDecay();
  });
}

export function useAgentActivity(): AgentActivity | null {
  const [val, setVal] = useState<AgentActivity | null>(_current);
  useEffect(() => {
    _wireOnce();
    _listeners.add(setVal);
    return () => { _listeners.delete(setVal); };
  }, []);
  return val;
}
