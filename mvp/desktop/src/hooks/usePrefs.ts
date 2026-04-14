import { useState, useCallback, useEffect } from "react";

const PREF_KEY = "intellinote-prefs";

type Prefs = {
  rawPath: string;
  notePath: string;
};

const DEFAULTS: Prefs = {
  rawPath: "/Users/lilithgames/aiproj/routinework/mvp/sample/raw.md",
  notePath: "/Users/lilithgames/aiproj/routinework/mvp/sample/note.md",
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
