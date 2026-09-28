/**
 * P5 — the HR login return path.
 *
 * A deep link opened while signed out (an internal-bell link to a Pipeline project, or a
 * session that ended mid-visit) is carried through /login as `?next=<path+query>` and
 * restored after a successful sign-in.
 *
 * ⚠️ ONLY /pipeline paths are honoured. Everything else, and anything that could leave
 * this origin (`//host`, `/\host`, `https://…`, control characters), goes to /dashboard
 * exactly as before. Keep this an allowlist.
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

export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return DEFAULT_AFTER_LOGIN;
  if (!raw.startsWith(ALLOWED_PREFIX) || raw.startsWith("//") || raw.includes("\\")) return DEFAULT_AFTER_LOGIN;
  // "/pipeline" itself, or "/pipeline" followed by "/", "?" or "#" — never "/pipeline-evil".
  if (raw.length > ALLOWED_PREFIX.length) {
    const c = raw.charAt(ALLOWED_PREFIX.length);
    if (c !== "/" && c !== "?" && c !== "#") return DEFAULT_AFTER_LOGIN;
  }
  // Browsers silently strip tab / newline inside URLs; refuse any control character.
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return DEFAULT_AFTER_LOGIN;
  }
  return raw;
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
