"use client";
import { useEffect, useState } from "react";

/**
 * false during the static render and the first client paint, true once React has hydrated.
 * Submit buttons stay disabled until then: a tap before hydration submits the form natively
 * (a GET reload of the same page) and throws away everything typed — seen live on the client
 * portal's phone sign-up.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
