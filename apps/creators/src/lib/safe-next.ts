/**
 * `?next=` from the current URL, only when it is a same-site path (never `//evil.com` or an
 * absolute URL) — shared by the sign-in redirect and the sign-up page.
 */
export function safeNext(): string | null {
  if (typeof window === "undefined") return null;
  return safeNextValue(new URLSearchParams(window.location.search).get("next"));
}

/** The same check on a value you already hold (e.g. from useSearchParams). */
export function safeNextValue(next: string | null | undefined): string | null {
  return next && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : null;
}

/** The `?next=` query to carry over when linking between /login and /signup. */
export function nextQueryFor(next: string | null | undefined): string {
  const n = safeNextValue(next);
  return n ? `?next=${encodeURIComponent(n)}` : "";
}
