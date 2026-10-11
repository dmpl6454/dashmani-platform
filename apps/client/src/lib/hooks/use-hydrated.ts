"use client";
import { useEffect, useState } from "react";

/**
 * false during server render and the first client paint, true once React has hydrated.
 *
 * Why it exists: a `<form onSubmit>` only gets its handler after hydration. A visitor on a slow
 * phone who types quickly and taps the submit button BEFORE that submits the form natively —
 * a GET reload of the same page that drops everything they typed (seen live on
 * /campaigns/new: the page came back as `?ctype=brand` with empty fields). Submit buttons are
 * disabled until this flips, so the worst case is a button that is briefly not clickable.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
