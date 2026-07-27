"use client";
import { useEffect, useState } from "react";

/**
 * Reports whether the visitor actually has a physical keyboard, and which
 * modifier key to name in shortcut hints.
 *
 * Both values resolve after mount — they depend on `navigator`/`matchMedia`,
 * which don't exist during SSR. Until then `hasKeyboard` is false, so
 * keyboard affordances render nothing on the server and appear on hydration
 * rather than flashing the wrong platform's key.
 */
export function useInputDevice() {
  const [hasKeyboard, setHasKeyboard] = useState(false);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    const touchOnly = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    setHasKeyboard(!touchOnly);
    const id = navigator.platform || navigator.userAgent || "";
    setIsMac(/Mac|iPhone|iPad|iPod/i.test(id));
  }, []);

  // "⌘K" needs no separator; the Windows/Linux spelling does.
  return { hasKeyboard, searchShortcut: isMac ? "⌘K" : "Ctrl+K" };
}

/**
 * True when the viewport is narrow enough that the CSS has collapsed
 * multi-pane layouts down to one column.
 *
 * MUST stay in step with the `max-width: 767px` breakpoint in globals.css —
 * behaviour that depends on a pane being visible reads this, so if the two
 * disagree, a control silently stops doing anything.
 */
export function useIsCompact() {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const sync = () => setCompact(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return compact;
}
