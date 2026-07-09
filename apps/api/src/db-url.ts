/**
 * Append connection-pool tuning params to a Postgres DATABASE_URL, but ONLY for
 * params the URL doesn't already set. Operators can override any value by putting
 * it in the URL itself; this just supplies safe defaults when nothing is set.
 *
 * WHY THIS EXISTS (incident 2026-07-08): a bare `new PrismaClient()` + a DATABASE_URL
 * with no params → Prisma defaults the pool to `num_cpus*2+1`. On the 1-vCPU prod box
 * that is 3 connections. Under the daily HR-report submit load the 3-connection pool
 * saturated, `await`s timed out after 10s with P2024, and one unguarded await in the
 * RBAC middleware turned that into a multi-hour process crash-loop.
 *
 * Defaults chosen for a 2GB / 1-vCPU box with Postgres max_connections=100:
 *   connection_limit=10  — clears the 3-conn starvation with big Postgres headroom,
 *                          but stays low enough not to blow the memory-tight box.
 *   pool_timeout=20      — wait up to 20s for a free connection before P2024 (was 10).
 *   connect_timeout=15   — TCP connect timeout to Postgres.
 * Tune per box by putting an explicit value in DATABASE_URL — this helper won't stomp it.
 *
 * FAIL-OPEN: undefined/empty/unparseable input is returned unchanged; never throws.
 */
const POOL_DEFAULTS: Record<string, string> = {
  connection_limit: "10",
  pool_timeout: "20",
  connect_timeout: "15",
};

export function withConnectionPool(url: string | undefined): string | undefined {
  if (!url) return url; // undefined or "" → unchanged (fail-open)
  try {
    // Split the query string off manually rather than using the URL class, because a
    // Postgres connection string is not a WHATWG-parseable URL in all shapes and we
    // must not reorder/re-encode the userinfo or host. We only care about the params.
    const [base, existingQuery = ""] = url.split("?");
    if (!base.startsWith("postgres")) return url; // not a pg URL → leave it alone

    const params = new URLSearchParams(existingQuery);
    for (const [key, value] of Object.entries(POOL_DEFAULTS)) {
      if (!params.has(key)) params.set(key, value);
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  } catch {
    return url; // never throw — fall back to the raw URL
  }
}
