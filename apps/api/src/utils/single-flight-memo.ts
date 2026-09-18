// Single-flight TTL memo — the shared cache primitive for heavy analytics reads.
//
// WHY (incident 2026-09-18): the insights + leaderboard services each carried a
// value-only 60s TTL cache. That collapses REPEAT reads inside the TTL, but it does
// nothing for the first burst: N concurrent COLD requests for the same key (the
// dashboard fires several per load, and several admins land at once after a deploy)
// each ran the compute — each holding a pooled DB connection for the whole query.
// When the query got slow, that burst alone drained the 10-connection pool and
// login/HR-submit failed with P2024. Storing the in-flight PROMISE (the pattern
// true-links.service.ts already used) means N concurrent cold callers share ONE
// compute and ONE connection.
//
// Semantics:
//   • Hit inside TTL → the stored promise (resolved or still pending) is returned.
//   • A rejected compute self-evicts immediately, so a failure is never served for
//     the TTL and the next caller retries. Callers awaiting the original promise
//     still receive the rejection (the .catch here is on a DERIVED promise).
//   • Entry count is bounded: expired entries are swept when the map grows; a hard
//     clear is the last resort (worst case = one extra cold compute, never
//     unbounded memory from distinct custom windows).
//   • clear() exists for tests — module-level caches are the documented cross-test
//     pollution class; every test file touching a memoised service MUST call the
//     service's invalidate*() in beforeEach.
export interface SingleFlightMemo {
  memo<T>(key: string, compute: () => Promise<T>): Promise<T>;
  clear(): void;
  /** Number of live entries (for tests/diagnostics). */
  size(): number;
}

export function createSingleFlightMemo(opts: { ttlMs: number; maxEntries?: number }): SingleFlightMemo {
  const ttlMs = opts.ttlMs;
  const maxEntries = opts.maxEntries ?? 200;
  const cache = new Map<string, { promise: Promise<unknown>; builtAt: number }>();

  function memo<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.builtAt < ttlMs) return hit.promise as Promise<T>;

    if (cache.size >= maxEntries) {
      for (const [k, v] of cache) {
        if (now - v.builtAt >= ttlMs) cache.delete(k);
      }
      if (cache.size >= maxEntries) cache.clear();
    }

    // Wrap so a synchronous throw inside compute() becomes a rejection too.
    const promise = (async () => compute())();
    cache.set(key, { promise, builtAt: now });
    promise.catch(() => {
      const cur = cache.get(key);
      if (cur && cur.promise === promise) cache.delete(key);
    });
    return promise;
  }

  return {
    memo,
    clear: () => cache.clear(),
    size: () => cache.size,
  };
}
