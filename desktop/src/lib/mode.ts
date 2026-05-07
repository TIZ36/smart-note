/* Mode flag — local (single-machine SQLite) vs cloud (FastAPI cluster).
 *
 * `cloud-api.ts` reads this synchronously to decide whether to
 * dispatch to local IPC or HTTP. Because settings are async, we
 * resolve once on module load and cache; the value is updated when
 * the user toggles in Settings.
 *
 * Default: local. The personal-version build ships with cloud
 * services NOT running by default, so local is the only mode that
 * "just works" out of the box.
 */

import { readSettings } from "./electron";

let _mode: "local" | "cloud" = "local";
let _initPromise: Promise<void> | null = null;

export function isLocalMode(): boolean {
  return _mode === "local";
}

export function setMode(m: "local" | "cloud") {
  _mode = m;
}

/** Resolve mode once at app boot. Idempotent. */
export function ensureModeResolved(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const s = await readSettings();
      // Cloud mode is opt-in: user has explicitly set local_mode=false.
      _mode = s.local_mode === false ? "cloud" : "local";
    } catch {
      _mode = "local";
    }
  })();
  return _initPromise;
}

// Kick off resolution at import time.
void ensureModeResolved();
