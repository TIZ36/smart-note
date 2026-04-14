import { useState, useEffect, useCallback } from "react";

export type ThemeMode = "system" | "light" | "dark";

const THEME_KEY = "intellinote-theme";

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    return (localStorage.getItem(THEME_KEY) as ThemeMode) || "system";
  });

  const apply = useCallback((m: ThemeMode) => {
    const root = document.documentElement;
    if (m === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", m);
    }
  }, []);

  useEffect(() => {
    apply(mode);
    localStorage.setItem(THEME_KEY, mode);
  }, [mode, apply]);

  return { mode, setMode };
}
