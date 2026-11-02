/**
 * Pipeline browser storage (spec §9.3). Every key is `pl:v1:<userId>:…` so two people
 * sharing one browser can never see — or send — each other's drafts and outbox.
 * Every access is wrapped in try/catch: localStorage throws in private windows and
 * when site data is blocked, and a convenience must never break the page.
 *
 * Ported from apps/hr/src/lib/pipeline-storage.ts. In the sales portal the purge is called
 * from lib/api.ts: clearSession() (sign-out and the session-expired branch) and
 * storeSession() when a different person signs in on this browser.
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
 * views). Called whenever a sales session ends (clearSession) and when a different user
 * signs in over the stored one (storeSession, spec §9.3), so one person's Pipeline drafts
 * never survive into the next person's session on a shared device.
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
