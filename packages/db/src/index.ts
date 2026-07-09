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
    const qs = params.toString();
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
