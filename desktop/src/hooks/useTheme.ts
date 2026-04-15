import { useState, useEffect, useCallback } from "react";

export type ThemeMode = "system" | "light" | "dark" | "niho";

const THEME_KEY = "smartnote-theme";
const THEME_EVENT = "smartnote-theme-change";

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => {
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

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    localStorage.setItem(THEME_KEY, m);
    apply(m);
    // Notify other useTheme instances in the same window
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: m }));
  }, [apply]);

  // Listen for theme changes from other hook instances
  useEffect(() => {
    function onThemeChange(e: Event) {
      const newMode = (e as CustomEvent).detail as ThemeMode;
      setModeState(newMode);
    }
    window.addEventListener(THEME_EVENT, onThemeChange);
    return () => window.removeEventListener(THEME_EVENT, onThemeChange);
  }, []);

  // Apply on mount
  useEffect(() => {
    apply(mode);
  }, [mode, apply]);

  return { mode, setMode };
}
