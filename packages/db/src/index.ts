import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

// Append pool-tuning defaults to DATABASE_URL if it sets none. WHY: a bare
// `new PrismaClient()` on the 1-vCPU prod box defaulted the pool to 3
// (num_cpus*2+1), which saturated under HR-submit load → P2024 pool timeouts →
// a crash-loop (incident 2026-07-08). See apps/api/src/db-url.ts for the same
// helper with the full rationale + unit tests. Fail-open: unparseable/empty →
// unchanged. Operators can override any value by putting it in DATABASE_URL.
const POOL_DEFAULTS: Record<string, string> = {
  connection_limit: "10",
  pool_timeout: "20",
  connect_timeout: "15",
};
function withConnectionPool(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const [base, existingQuery = ""] = url.split("?");
    if (!base.startsWith("postgres")) return url;
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
    const stmtMs = process.env.DB_STATEMENT_TIMEOUT_MS;
    if (stmtMs && /^\d+$/.test(stmtMs) && !params.has("options")) {
      qs += `${qs ? "&" : ""}options=-c%20statement_timeout%3D${stmtMs}`;
    }
    return qs ? `${base}?${qs}` : base;
  } catch {
    return url;
  }
}

const tunedUrl = withConnectionPool(process.env.DATABASE_URL);

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient(
    tunedUrl ? { datasources: { db: { url: tunedUrl } } } : undefined,
  );

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export * from "@prisma/client";
