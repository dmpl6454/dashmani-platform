/**
 * Remove every localStorage key starting `pl:` (Pipeline outbox, drafts, remembered
 * views). Called whenever an HR session ends — the session-expired branch of apiFetch
 * (P1) and HrAuthProvider.logout — and, via purgePipelineStorageOnUserSwitch, when
 * login() receives a different user than the one stored (spec §9.3), so one person's
 * Pipeline drafts never survive into the next person's session on a shared device.
 *
 * Its own tiny module on purpose: HrAuthProvider sits in the root layout, and importing
 * it from lib/api.ts would pull the whole API client into /login's bundle.
 */
export function purgePipelineStorage(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("pl:")) keys.push(k);
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
 * stored user purges nothing — there is no one to compare against. Never throws.
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
