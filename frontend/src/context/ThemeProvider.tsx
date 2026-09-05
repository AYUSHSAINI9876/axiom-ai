"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Theme } from "@/lib/types";

const STORAGE_KEY = "axiom-ai-theme";

interface ThemeContextValue {
  theme: Theme;
  /** The theme actually being rendered once "system" is resolved. */
  resolved: "light" | "dark";
  setTheme: (theme: Theme) => void;
  cycleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside a <ThemeProvider>");
  return context;
}

/**
 * Inlined into <head> so it runs before first paint.
 *
 * Without it the page would render with the default palette and then snap to
 * the stored theme once React hydrates — the classic dark-mode flash. Reading
 * localStorage synchronously here is the only way to avoid that.
 */
export const themeInitScript = `
(function(){
  try {
    var stored = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    if (stored === 'dark' || stored === 'light') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (e) {}
})();
`;

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    // Same SSR reasoning as AuthProvider: localStorage is client-only, so the
    // stored value is adopted after the first render. The inline script above
    // has already applied the attribute, so there is no visible flash.
    let stored: Theme = "system";
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === "dark" || raw === "light") stored = raw;
    } catch {
      // Unreadable storage just means the system preference wins.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see comment above
    setThemeState(stored);
    setSystemDark(systemPrefersDark());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      if (next === "system") {
        window.localStorage.removeItem(STORAGE_KEY);
        document.documentElement.removeAttribute("data-theme");
      } else {
        window.localStorage.setItem(STORAGE_KEY, next);
        document.documentElement.setAttribute("data-theme", next);
      }
    } catch {
      // Persisting failed; the in-memory choice still applies for this session.
      if (next !== "system") document.documentElement.setAttribute("data-theme", next);
    }
  }, []);

  const resolved: "light" | "dark" =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;

  const cycleTheme = useCallback(() => {
    const order: Theme[] = ["light", "dark", "system"];
    setTheme(order[(order.indexOf(theme) + 1) % order.length]);
  }, [theme, setTheme]);

  const value = useMemo(
    () => ({ theme, resolved, setTheme, cycleTheme }),
    [theme, resolved, setTheme, cycleTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
