"use client";
/** Reports user input to the SyncEngine (throttled to once a second, passive listeners). */
import { useEffect } from "react";

const EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

export function useIdle(onInput: (() => void) | null) {
  useEffect(() => {
    if (!onInput) return;
    let last = 0;
    const handler = () => {
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      onInput();
    };
    for (const e of EVENTS) window.addEventListener(e, handler, { passive: true, capture: true });
    return () => {
      for (const e of EVENTS) window.removeEventListener(e, handler, { capture: true });
    };
  }, [onInput]);
}
