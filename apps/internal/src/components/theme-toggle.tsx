"use client";
import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";

/* Storage key shared with the inline no-flash init script in layout.tsx.
   Keep them in sync — the script reads this key before first paint. */
export const THEME_KEY = "ds-theme";
type Theme = "light" | "dark";

function applyTheme(next: Theme, animate: boolean) {
  const root = document.documentElement;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (animate && !reduce) {
    root.classList.add("theme-anim");
    window.setTimeout(() => root.classList.remove("theme-anim"), 320);
  }
  root.setAttribute("data-theme", next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode / blocked storage */ }
}

/**
 * Dark / Light theme toggle for the top navbar. Visual-only: it flips the
 * `data-theme` attribute the whole token system reads (globals.css) and nothing
 * else. A compact two-segment pill (Sun | Moon) shows the active mode.
 */
export function ThemeToggle() {
  // Start null so SSR + first client render agree (no hydration mismatch); the
  // real value is read from the DOM (set by the init script) after mount.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const cur = document.documentElement.getAttribute("data-theme");
    setTheme(cur === "light" ? "light" : "dark");
  }, []);

  function toggle() {
    const next: Theme = theme === "light" ? "dark" : "light";
    setTheme(next);
    applyTheme(next, true);
  }

  const isLight = theme === "light";

  return (
    <button
      onClick={toggle}
      role="switch"
      aria-checked={isLight}
      aria-label={`Switch to ${isLight ? "dark" : "light"} theme`}
      title={theme === null ? "Toggle theme" : isLight ? "Switch to dark theme" : "Switch to light theme"}
      className="flex items-center gap-0.5 h-8 p-0.5 rounded-xl border-2 border-ink/12 bg-surface btn-3d transition-colors"
    >
      <span
        className={`flex items-center justify-center h-6 w-6 rounded-lg transition-colors ${
          !isLight ? "bg-action-soft text-action" : "text-ink-4"
        }`}
      >
        <Moon className="h-3.5 w-3.5" />
      </span>
      <span
        className={`flex items-center justify-center h-6 w-6 rounded-lg transition-colors ${
          isLight ? "bg-action-soft text-action" : "text-ink-4"
        }`}
      >
        <Sun className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}
