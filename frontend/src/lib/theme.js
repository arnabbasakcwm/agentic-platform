import { createContext, useCallback, useContext, useEffect, useState } from "react";

// Light / dark theme. With no choice made the console follows the operating system; a
// choice made with the toggle is remembered per browser (localStorage) and applied as
// <html data-theme="…">, which the stylesheet honours over the system setting.
// index.html applies a saved choice before the first paint, so there is no flash.

const KEY = "agentic-platform.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function storedChoice() {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function systemTheme() {
  return window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

export function useThemeState() {
  const [choice, setChoice] = useState(storedChoice); // null = follow the system
  const [system, setSystem] = useState(systemTheme);

  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return undefined;
    const onChange = (e) => setSystem(e.matches ? "dark" : "light");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (choice) root.dataset.theme = choice;
    else delete root.dataset.theme;
  }, [choice]);

  const theme = choice ?? system;

  const toggle = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setChoice(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Not remembered across visits; still applies to this one.
    }
  }, [theme]);

  return { theme, toggle };
}

export const ThemeContext = createContext({ theme: "light", toggle: () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}
