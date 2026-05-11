import { useState, useCallback, useEffect } from "react";
import { saveRawPathForHotkey } from "@/lib/electron";

const PREF_KEY = "intellinote-prefs";

type Prefs = {
  rawPath: string;
  notePath: string;
};

/* No default file paths. Earlier this hard-coded a developer's
 * `routinework/mvp/sample/raw.md`, which (a) never exists on a real
 * user's machine — silently breaks the editor — and (b) on the dev
 * machine where it DID exist, hid the Note landing screen so users
 * couldn't see the onboarding flow. Empty path → landing renders. */
const DEFAULTS: Prefs = {
  rawPath: "",
  notePath: "",
};

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(() => {
    try {
      const saved = localStorage.getItem(PREF_KEY);
      if (saved) return { ...DEFAULTS, ...JSON.parse(saved) };
    } catch {}
    return DEFAULTS;
  });

  useEffect(() => {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
    // Sync rawPath to Electron main process for global hotkey
    try {
      if (prefs.rawPath) saveRawPathForHotkey(prefs.rawPath).catch(() => {});
    } catch {}
  }, [prefs]);

  const setRawPath = useCallback(
    (rawPath: string) => setPrefs((p) => ({ ...p, rawPath })),
    []
  );
  const setNotePath = useCallback(
    (notePath: string) => setPrefs((p) => ({ ...p, notePath })),
    []
  );

  return { ...prefs, setRawPath, setNotePath };
}
