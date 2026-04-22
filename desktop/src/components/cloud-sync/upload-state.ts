/**
 * App-wide cloud sync upload state.
 *
 * Why a module singleton rather than React state?
 *
 * The upload is a potentially long-running async loop. If it lives inside
 * a component, two things break the moment the user navigates away:
 *   1. The component unmounts — state resets, progress bar disappears.
 *   2. The navbar cloud icon, which was getting progress via a
 *      custom-event broadcast from that component, stops updating.
 *
 * Moving the state + the loop out to module scope means:
 *   - The loop keeps running regardless of which page is mounted.
 *   - Any component can subscribe via `useCloudSyncUpload()` and see
 *     live progress on (re)mount.
 *   - Cancel still works from any subscriber — the AbortController is
 *     held in the singleton, not inside a component ref.
 *
 * This state intentionally does NOT survive an Electron window close /
 * hard reload — for that we'd need to checkpoint per-item completion
 * on the backend, which is a bigger change.
 */

import { useEffect, useState } from "react";
import * as api from "@/lib/api";

export type UploadPhase =
  | { phase: "idle" }
  | { phase: "uploading"; current: number; total: number; currentName: string }
  | { phase: "canceled"; completed: number; total: number }
  | { phase: "done"; completed: number; total: number }
  | { phase: "error"; error: string; completed: number; total: number };

let _state: UploadPhase = { phase: "idle" };
let _abort: AbortController | null = null;
const _subs = new Set<(s: UploadPhase) => void>();

function publish() {
  for (const cb of _subs) {
    try { cb(_state); } catch { /* swallow */ }
  }
}

function set(next: UploadPhase) {
  _state = next;
  publish();
}

/** Imperative peek — useful one-off (e.g. guarding "start another upload"). */
export function getUploadState(): UploadPhase {
  return _state;
}

/** Subscribe; returns an unsubscribe fn. */
export function subscribeUpload(cb: (s: UploadPhase) => void): () => void {
  _subs.add(cb);
  cb(_state);                     // fire once immediately so subscribers don't race
  return () => { _subs.delete(cb); };
}

/** React hook — returns the current singleton state, re-renders on change. */
export function useCloudSyncUpload(): UploadPhase {
  const [s, setS] = useState<UploadPhase>(_state);
  useEffect(() => subscribeUpload(setS), []);
  return s;
}

/** Kick off the per-item upload loop. Safe to call from any component —
 *  the loop runs to completion regardless of navigation. No-ops if
 *  another upload is already in flight. */
export async function startUpload(preview: api.CloudSyncPreview): Promise<void> {
  if (_state.phase === "uploading") return;

  const tasks: { kind: string; localId: string; name: string }[] = [];
  for (const [kind, info] of Object.entries(preview.kinds)) {
    for (const item of info.items) {
      if (item.status === "unchanged") continue;
      tasks.push({ kind, localId: item.local_id, name: item.name });
    }
  }
  if (tasks.length === 0) return;

  _abort = new AbortController();
  set({ phase: "uploading", current: 0, total: tasks.length, currentName: tasks[0].name });

  let completed = 0;
  let errored: { name: string; error: string } | null = null;

  for (const t of tasks) {
    if (_abort.signal.aborted) break;
    set({ phase: "uploading", current: completed, total: tasks.length, currentName: t.name });
    try {
      const r = await api.pushSyncOne(t.kind, t.localId, _abort.signal);
      if (r.action === "error") {
        errored = { name: t.name, error: r.error || "unknown" };
        break;
      }
    } catch (e) {
      const err = e as { name?: string };
      if (_abort.signal.aborted || err.name === "AbortError") break;
      errored = { name: t.name, error: String(e) };
      break;
    }
    completed += 1;
  }

  const total = tasks.length;
  _abort = null;

  if (errored) {
    set({ phase: "error", error: `failed on "${errored.name}": ${errored.error}`, completed, total });
  } else if (completed < total) {
    set({ phase: "canceled", completed, total });
  } else {
    set({ phase: "done", completed, total });
    // Auto-reset to idle after a beat so the nav icon doesn't stay
    // stuck at 100% fill forever. 2.5s is long enough for the user
    // to notice the "done" flash without being annoying.
    setTimeout(() => {
      if (_state.phase === "done") set({ phase: "idle" });
    }, 2500);
  }
}

/** Cancel a running upload. No-op if idle. */
export function cancelUpload(): void {
  if (_abort) _abort.abort();
}

/** Progress ratio for the nav icon fill (0..1). Errors show where we
 *  stopped; canceled freezes at the current position; done pins to 1. */
export function progressOf(s: UploadPhase): number {
  if (s.phase === "idle") return 0;
  if (s.phase === "done") return 1;
  if (s.phase === "uploading") return s.total === 0 ? 0 : s.current / s.total;
  if (s.phase === "canceled" || s.phase === "error") {
    return s.total === 0 ? 0 : s.completed / s.total;
  }
  return 0;
}

/** Whether the nav icon should pulse. */
export function isAnimating(s: UploadPhase): boolean {
  return s.phase === "uploading";
}
