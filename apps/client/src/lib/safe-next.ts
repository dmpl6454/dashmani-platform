/**
 * `?next=` from the current URL, only when it is a same-site path (never `//evil.com` or an
 * absolute URL) — shared by the login redirect and the signup page.
 */
export function safeNext(): string | null {
  if (typeof window === "undefined") return null;
  const next = new URLSearchParams(window.location.search).get("next");
  return next && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : null;
}

/** The `?next=` query to carry over when linking between /login and /signup. */
export function nextQuery(): string {
  const n = safeNext();
  return n ? `?next=${encodeURIComponent(n)}` : "";
}
