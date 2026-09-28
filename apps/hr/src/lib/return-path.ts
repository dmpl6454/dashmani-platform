/**
 * P5 — the HR login return path.
 *
 * A deep link opened while signed out (an internal-bell link to a Pipeline project, or a
 * session that ended mid-visit) is carried through /login as `?next=<path+query>` and
 * restored after a successful sign-in.
 *
 * ⚠️ ONLY /pipeline paths are honoured. Everything else, and anything that could leave
 * this origin (`//host`, `/\host`, `https://…`, control characters, or dot segments such as
 * `/pipeline/..//host`), goes to /dashboard exactly as before. Keep this an allowlist.
 *
 * ⚠️ Callers read `window.location`, never `useSearchParams()`: that hook forces a
 * Suspense boundary and breaks the static prerender of /login and every page that uses it.
 *
 * Pure (no DOM access) so the apps/api vitest suite tests it directly. No regex, so no
 * lookbehind that would crash older iOS Safari.
 */
export const DEFAULT_AFTER_LOGIN = "/dashboard";

const ALLOWED_PREFIX = "/pipeline";
/** Bound before any scan; a real Pipeline link is well under this. */
const MAX_NEXT_LENGTH = 2048;
/** A throwaway base that can never be a real host; only used to resolve the path. */
const PARSE_BASE = "http://hr.invalid";

/**
 * ⚠️ The allowlist judges the NORMALISED path, not the raw string. The URL parser resolves
 * dot segments (`..`, `.`, and their `%2e` spellings), so a raw "/pipeline/..//evil.com"
 * would navigate to "//evil.com" — a scheme-relative URL for another host. The cheap raw
 * checks run first (they also refuse control characters, which the parser would silently
 * strip), then the parsed pathname must itself be a /pipeline path. The normalised form is
 * what is returned, so what was checked is exactly what the router navigates to.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return DEFAULT_AFTER_LOGIN;
  if (!raw.startsWith(ALLOWED_PREFIX) || raw.startsWith("//") || raw.includes("\\")) return DEFAULT_AFTER_LOGIN;
  // Browsers silently strip tab / newline inside URLs; refuse any control character.
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return DEFAULT_AFTER_LOGIN;
  }
  let u: URL;
  try {
    u = new URL(raw, PARSE_BASE);
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
  if (u.origin !== PARSE_BASE) return DEFAULT_AFTER_LOGIN;
  const p = u.pathname;
  // "/pipeline" itself or a path under "/pipeline/" — never "/pipeline-evil" or "//host".
  if (p.startsWith("//") || !(p === ALLOWED_PREFIX || p.startsWith(ALLOWED_PREFIX + "/"))) return DEFAULT_AFTER_LOGIN;
  return p + u.search + u.hash;
}

/** `/login?next=<encoded path+query>` for the page the user is on now. */
export function loginHrefWithNext(loc: { pathname: string; search: string }): string {
  return "/login?next=" + encodeURIComponent(loc.pathname + loc.search);
}

/** Where to go after a successful sign-in, given `window.location.search`. */
export function nextPathFromSearch(search: string): string {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(search).get("next");
  } catch {
    raw = null;
  }
  return safeNextPath(raw);
}
