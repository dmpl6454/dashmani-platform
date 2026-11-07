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
  if (!next || next.length > 2048 || !/^\/(?!\/)[\w\-/?=&.%]*$/.test(next)) return null;
  // ⚠️ The regex allows `.` and `/`, so "/.//evil.com" or "/a/..//evil.com" passed it and
  // normalise to "//evil.com" — another host (security audit 2026-10-28). Judge the
  // NORMALISED path, and return it, so what was checked is what the router navigates to.
  let u: URL;
  try {
    u = new URL(next, "http://next.invalid");
  } catch {
    return null;
  }
  if (u.origin !== "http://next.invalid" || u.pathname.startsWith("//")) return null;
  return `${u.pathname}${u.search}`;
}

/** The `?next=` query to carry over when linking between /login and /signup. */
export function nextQueryFor(next: string | null | undefined): string {
  const n = safeNextValue(next);
  return n ? `?next=${encodeURIComponent(n)}` : "";
}
