/**
 * Online presence for the sales-portal chat ("green dot"). In memory, no database.
 *
 * Every gated /pipeline/* request stamps its user (routes/pipeline.routes.ts), and an open
 * Pipeline tab syncs every 10–30 s while visible, so "seen in the last minute" means "has
 * the Pipeline open". A hidden tab stops syncing and goes grey within a minute.
 *
 * ⚠️ One API process (pm2 `api`) holds this map. If the API ever runs more than one process,
 * presence must move to a shared store (Redis), or each process would only see its own users.
 */
export const PRESENCE_WINDOW_MS = 60_000;
/** Bound on the map; entries older than the window are dropped on every sweep. */
const MAX_ENTRIES = 5_000;

const lastSeen = new Map<string, number>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < PRESENCE_WINDOW_MS && lastSeen.size < MAX_ENTRIES) return;
  lastSweep = now;
  for (const [id, at] of lastSeen) if (now - at > PRESENCE_WINDOW_MS) lastSeen.delete(id);
}

export function touchPresence(userId: string, now: number = Date.now()): void {
  lastSeen.set(userId, now);
  sweep(now);
}

/** User ids seen within the window, sorted. */
export function onlineUserIds(now: number = Date.now()): string[] {
  sweep(now);
  const out: string[] = [];
  for (const [id, at] of lastSeen) if (now - at <= PRESENCE_WINDOW_MS) out.push(id);
  return out.sort();
}

/** Tests only. */
export function resetPresenceForTests(): void {
  lastSeen.clear();
  lastSweep = 0;
}
