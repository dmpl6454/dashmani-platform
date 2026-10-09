"use client";

import { useEffect, useState } from "react";

/**
 * Portal colour theme — "dark" (default) or "light". The value lives on
 * <html data-theme> (globals.css switches every ds colour off it) and is remembered per
 * browser in localStorage. THEME_INIT_SCRIPT applies it before first paint so a light
 * user never sees a dark flash; React never renders the attribute itself, so hydration
 * can't fight it.
 */
export type Theme = "dark" | "light";

const KEY = "ds-theme";
const EVENT = "ds-theme-change";

/** Inline in <head>: runs before paint. Every storage access can throw (private mode). */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${KEY}");document.documentElement.setAttribute("data-theme",t==="light"?"light":"dark");}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function setTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
  try { window.localStorage.setItem(KEY, t); } catch { /* not remembered, still applied */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useTheme(): [Theme, (t: Theme) => void] {
  // Starts "dark" on the server and the first client render, then syncs — the toggle
  // icon is the only thing that reads it, so a one-frame icon swap is harmless.
  const [theme, setState] = useState<Theme>("dark");
  useEffect(() => {
    const sync = () => setState(readTheme());
    sync();
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  return [theme, setTheme];
}
