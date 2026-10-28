/**
 * An href for a URL that came from user data, or `undefined` (no link) when it is not
 * http(s). React 18 renders `href="javascript:…"` as a live link, and report links are
 * submitted by employees: a `javascript:` URL clicked on /reports ran in the admin's
 * session and could read the stored tokens (security audit 2026-10-28). The API now
 * refuses non-http links, but rows stored before that still render through here.
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}
