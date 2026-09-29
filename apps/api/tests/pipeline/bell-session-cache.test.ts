import { describe, it, expect } from "vitest";
import { mutate } from "swr";
import { cache, SWRGlobalState } from "swr/_internal";
import { clearSwrCache as clearHrSwrCache } from "../../../hr/src/lib/swr-cache";
import { clearSwrCache as clearInternalSwrCache } from "../../../internal/src/lib/swr-cache";

/**
 * P3 follow-up: on a shared browser, user B must never see user A's bell rows.
 *
 * Both portals sign in and out with router.push, so the JS context and SWR's
 * global cache survive a user switch. The bell list is fetched only while its
 * panel is open, so B's first open read A's cached rows straight from the cache
 * — and if B's own fetch then failed (429, 5xx, offline) they stayed on screen,
 * clickable, under "Couldn't refresh notifications". login() and logout() now
 * call clearSwrCache(); these tests pin what that helper must do.
 *
 * Both portals import the same `swr` module instance (it is hoisted to the repo
 * root), so the `cache` imported here is the cache the helpers clear.
 */

const HR_KEYS = ["/hr/notifications", "/hr/notifications/count", "/hr/reports/today"];
const INTERNAL_KEYS = ["/admin/notifications", "/admin/notifications/count"];

async function seed(keys: string[]) {
  for (const k of keys) {
    await mutate(k, { success: true, data: [{ id: `user-a-${k}` }] }, { revalidate: false });
  }
  for (const k of keys) expect(cache.get(k)?.data).toBeDefined();
}

function mutationTimestamp(key: string): number | undefined {
  const state = SWRGlobalState.get(cache) as unknown as [unknown, Record<string, [number, number]>];
  return state?.[1]?.[key]?.[0];
}

describe("clearSwrCache — no previous user's data survives a sign-in/out", () => {
  it("HR: drops the bell list, badge count and every other cached response, synchronously", async () => {
    await seed(HR_KEYS);

    // login()/logout() do not await it, so the clear must land before they call setUser.
    void clearHrSwrCache();

    for (const k of HR_KEYS) expect(cache.get(k)?.data).toBeUndefined();
  });

  it("internal: drops the admin bell list and count", async () => {
    await seed(INTERNAL_KEYS);

    void clearInternalSwrCache();

    for (const k of INTERNAL_KEYS) expect(cache.get(k)?.data).toBeUndefined();
  });

  it("stamps a NEW mutation per key, so a request of the old user still in flight is discarded", async () => {
    // SWR discards a response whose request started at or before the key's last
    // mutation timestamp. A cache.delete()/clear() would stamp nothing, and user
    // A's in-flight list response would land in the cache AFTER the clear.
    await seed(HR_KEYS);
    const before = HR_KEYS.map(mutationTimestamp);

    await clearHrSwrCache();

    HR_KEYS.forEach((k, i) => {
      const after = mutationTimestamp(k);
      expect(after).toBeDefined();
      expect(after as number).toBeGreaterThan(before[i] as number);
    });
  });

  it("the trap it avoids: a bare mutate(filter) only revalidates and keeps the cached data", async () => {
    await seed(HR_KEYS);

    await mutate(() => true);

    for (const k of HR_KEYS) expect(cache.get(k)?.data).toBeDefined();
    await clearHrSwrCache();
  });

  it("is idempotent", async () => {
    await clearHrSwrCache();
    await expect(clearHrSwrCache()).resolves.toBeDefined();
    for (const k of HR_KEYS) expect(cache.get(k)?.data).toBeUndefined();
  });
});
