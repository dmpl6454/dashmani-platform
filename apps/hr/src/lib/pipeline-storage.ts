/**
 * Pipeline browser storage (spec §9.3). Every key is `pl:v1:<userId>:…` so two people
 * sharing one browser can never see — or send — each other's drafts and outbox.
 * Every access is wrapped in try/catch: localStorage throws in private windows and
 * when site data is blocked, and a convenience must never break the page.
 *
 * Its own tiny module on purpose: HrAuthProvider sits in the root layout, and importing
 * the purge from lib/api.ts would pull the whole API client into /login's bundle. This is
 * the ONE purge implementation — apiFetch's session-expired branch, HrAuthProvider.logout
 * and HrAuthProvider.login (user switch) all call it.
 */
const PREFIX = "pl:";

export function plKey(userId: string, ...parts: string[]): string {
  return ["pl", "v1", userId, ...parts].join(":");
}

export function plRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function plWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota or blocked storage — the in-memory copy still works */
  }
}

export function plRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function plReadJson<T>(key: string): T | null {
  const raw = plRead(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Remove every localStorage key starting `pl:` (Pipeline outbox, drafts, remembered
 * views). Called whenever an HR session ends — the session-expired branch of apiFetch
 * (P1) and HrAuthProvider.logout — and, via purgePipelineStorageOnUserSwitch, when
 * login() receives a different user than the one stored (spec §9.3), so one person's
 * Pipeline drafts never survive into the next person's session on a shared device.
 */
export function purgePipelineStorage(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* storage blocked (private mode) — nothing to purge */
  }
}

/**
 * Spec §9.3, third purge point: HrAuthProvider.login() calls this BEFORE it overwrites
 * `hrUser`. If the stored user is known and differs from the one signing in (person B
 * signing in over person A's still-valid session, without A signing out), every `pl:` key
 * is purged. The same user signing in again keeps their drafts. An absent or unreadable
 * stored user purges nothing — there is no one to compare against (and every path that
 * clears `hrUser` — logout, the session-expired branch — has already purged). Never throws.
 */
export function purgePipelineStorageOnUserSwitch(nextUserId: string): void {
  let prevId: unknown;
  try {
    const prev = JSON.parse(localStorage.getItem("hrUser") || "null") as { id?: unknown } | null;
    prevId = prev && typeof prev === "object" ? prev.id : undefined;
  } catch {
    return; // unreadable stored user, or storage blocked
  }
  if (typeof prevId === "string" && prevId.length > 0 && prevId !== nextUserId) purgePipelineStorage();
}
