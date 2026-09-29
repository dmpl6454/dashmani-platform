import { mutate } from "swr";

/**
 * Forget every SWR response held in memory. Called by login() and logout().
 *
 * Signing in and out navigates with router.push, so the JS context — and SWR's
 * global cache — survive a user switch on a shared browser. Without this, user
 * B's first open of the bell (its list is fetched only while the panel is open)
 * returns user A's cached rows at once, and if B's own fetch then fails they stay
 * on screen and stay clickable. The same goes for every other SWR-backed view.
 *
 * ⚠️ It must be exactly mutate(filter, undefined, { revalidate: false }):
 *   - a bare mutate(filter) has fewer than three arguments, so SWR only
 *     REVALIDATES and the cached data stays;
 *   - cache.delete()/clear() stamps no mutation timestamp, so a request of the
 *     old user still in flight lands in the cache AFTER the clear. The stamp is
 *     what makes SWR discard a response to a request started before it.
 * revalidate:false — nothing refetches under the old session; hooks mounted
 * afterwards fetch for whoever is signed in then. The clear itself is
 * synchronous (no await before SWR writes the cache), so callers need not await.
 *
 * Locked by apps/api/tests/pipeline/bell-session-cache.test.ts.
 */
export function clearSwrCache(): Promise<unknown> {
  return mutate(() => true, undefined, { revalidate: false });
}
