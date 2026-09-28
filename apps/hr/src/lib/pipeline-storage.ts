/**
 * Remove every localStorage key starting `pl:` (Pipeline outbox, drafts, remembered
 * views). Called whenever an HR session ends — the session-expired branch of apiFetch
 * (P1) and HrAuthProvider.logout — so one person's Pipeline drafts never survive into
 * the next person's session on a shared device.
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
