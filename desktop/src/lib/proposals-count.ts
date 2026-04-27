/* App-wide proposals count poller.
 *
 * One singleton polls /v1/memories/proposals every POLL_MS while at
 * least one component is subscribed (sidebar badge, Insights card).
 * Two reasons this is centralized:
 *
 *   1. Two surfaces — sidebar badge and Insights ProposalsCard — both
 *      need the count and would otherwise double the request rate.
 *   2. After accept/reject the user expects the badge to update
 *      immediately. `bump()` lets ProposalsCard nudge the count
 *      without waiting for the next poll tick.
 *
 * No-op when cloud isn't configured. Polling pauses when nobody is
 * subscribed (sidebar is always mounted, but defensive anyway).
 */
import { useEffect, useState } from "react";
import { isCloudConfigured, listProposals } from "./cloud-api";

const POLL_MS = 30_000;

let _count = 0;
let _loaded = false;
const _subs = new Set<(n: number) => void>();
let _timer: ReturnType<typeof setInterval> | null = null;
let _inflight = false;

async function refresh(): Promise<void> {
  if (_inflight) return;
  _inflight = true;
  try {
    const ok = await isCloudConfigured();
    if (!ok) {
      setCount(0);
      return;
    }
    // We only need the total — limit=1 keeps the response tiny while
    // still populating the `total` field the API returns.
    const r = await listProposals(1);
    setCount(r.total);
  } catch {
    // Stay quiet — a failed poll shouldn't spam the UI. The next tick
    // will retry; a real connection error already shows up in the
    // Insights card's own error surface.
  } finally {
    _inflight = false;
    _loaded = true;
  }
}

function setCount(n: number): void {
  if (n === _count && _loaded) return;
  _count = n;
  for (const cb of _subs) cb(n);
}

function ensureTimer(): void {
  if (_timer || _subs.size === 0) return;
  _timer = setInterval(refresh, POLL_MS);
  // Kick off an immediate fetch on first subscriber so the badge
  // doesn't take 30s to appear after app startup.
  refresh();
}

function maybeStopTimer(): void {
  if (_subs.size === 0 && _timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/** Optimistic count adjustment after accept/reject so badges flip
 * before the next poll. Negative delta clamps at 0. */
export function bumpProposalsCount(delta: number): void {
  setCount(Math.max(0, _count + delta));
}

/** Force an immediate re-fetch (e.g. after the user pairs a new
 * device — cloud config might have changed under us). */
export function refreshProposalsCount(): Promise<void> {
  return refresh();
}

export function useProposalsCount(): number {
  const [n, setN] = useState(_count);
  useEffect(() => {
    _subs.add(setN);
    ensureTimer();
    // Sync to current value on mount in case it changed before
    // subscription (singleton state may already be populated).
    setN(_count);
    return () => {
      _subs.delete(setN);
      maybeStopTimer();
    };
  }, []);
  return n;
}
