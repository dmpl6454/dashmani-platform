"use client";
import { useEffect, useState } from "react";

/** matchMedia as state. `false` on the server and the first client render. */
export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** Phones: < 768 px (spec §9.5). */
export const usePhone = () => useMedia("(max-width: 767px)");
/** Below the HR `lg` breakpoint (the mobile top bar is visible). */
export const useBelowLg = () => useMedia("(max-width: 1023px)");
