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

export function withConnectionPool(
  url: string | undefined,
  opts?: { statementTimeoutMs?: string },
): string | undefined {
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
    let qs = params.toString();
    // DB_STATEMENT_TIMEOUT_MS → a server-side statement_timeout for THIS process's
    // connections only. Prisma forwards the Postgres `options` connection parameter at
    // connection start (verified 2026-09-18: pg_sleep(5) through PrismaClient was
    // cancelled at 1.5s with SQLSTATE 57014). WHY: a statement that runs for minutes
    // holds a pooled connection for minutes — on 2026-09-18 six such statements held
    // the whole pool and login/HR-submit failed with P2024. A ceiling turns "stuck for
    // 10 minutes" into "clean error after N seconds, connection returned".
    // Deliberately ENV-DRIVEN, not a default: scripts, backups and `prisma db push`
    // run under the same role and may legitimately run long; only apps/api/.env sets
    // it (60000). An explicit `options` already in the URL wins. Encoded by hand
    // (%20 / %3D) rather than via URLSearchParams, which would emit `+` for the space.
    const stmtMs = opts?.statementTimeoutMs ?? process.env.DB_STATEMENT_TIMEOUT_MS;
    if (stmtMs && /^\d+$/.test(stmtMs) && !params.has("options")) {
      qs += `${qs ? "&" : ""}options=-c%20statement_timeout%3D${stmtMs}`;
    }
    return qs ? `${base}?${qs}` : base;
  } catch {
    return url; // never throw — fall back to the raw URL
  }
}
