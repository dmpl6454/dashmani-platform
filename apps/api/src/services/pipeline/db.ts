/**
 * The pipeline's OWN Prisma client (spec §3.2, §8.3).
 *
 * WHY A SECOND CLIENT. The main client has 10 connections shared by login, RBAC, HR
 * submit, the bells and every cron; analytics is capped at 2 so at least 8 stay free.
 * Pipeline traffic (a poll every ~10 s per open tab) must never draw from that pool — the
 * 2026-07-08 and 2026-09-18 outages were exactly "one feature held the shared pool, so
 * login failed with P2024". These connections are IN ADDITION to the main 10:
 *
 *   connection_limit = PIPELINE_DB_CONNECTIONS (default 3; 1 in the main test suite)
 *   pool_timeout     = 2 s   → pipeline pool exhaustion is a fast, pipeline-only P2024 → 503
 *   connect_timeout  = 5 s
 *   statement_timeout = 2.5 s, lock_timeout = 1 s (server-side, on every connection)
 *
 * so a slow plan or a lock queue costs at most seconds on 3 connections and answers 503,
 * never a stuck request and never a main-pool connection.
 *
 * ⚠️ DB ACCESS RULE 1 (CI-enforced by scripts/ci/guards.sh "pipeline-db-import"): this is
 * the ONLY pipeline file that may import from @dashmani/db / @prisma/client. Everything
 * else under services/pipeline, routes/pipeline.routes.ts and middleware/pipeline-*.ts
 * imports `pipelineDb` (and the Prisma types re-exported below) from here. A call on the
 * global `prisma` inside a pipeline transaction would break the pool arithmetic and can
 * deadlock at connection_limit=1.
 */
import { PrismaClient, Prisma } from "@dashmani/db";

export { Prisma };
export type PipelineTx = Prisma.TransactionClient;
export type PipelineDbClient = PrismaClient;

const DEFAULT_CONNECTIONS = 3;
const MAX_CONNECTIONS = 10;

/** PIPELINE_DB_CONNECTIONS → an integer in 1..10, else the default 3. */
export function parsePipelineDbConnections(raw: string | undefined): number {
  if (raw == null || raw === "") return DEFAULT_CONNECTIONS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_CONNECTIONS;
  return Math.min(n, MAX_CONNECTIONS);
}

/**
 * Query params that describe WHERE/HOW to connect rather than how to pool. They survive
 * the rewrite so the pipeline client reaches the same database the same way as the main
 * client (dropping `sslmode=require` or a unix-socket `host` would silently change that).
 * Every pool/timeout param, and any `options`, is replaced.
 */
const KEEP_PARAMS = ["schema", "sslmode", "sslcert", "sslidentity", "sslpassword", "sslaccept", "host"];

/**
 * DATABASE_URL → the pipeline URL: the query string is replaced by the pipeline pool and
 * timeout settings. `options` is encoded by hand (%20 / %3D) exactly like
 * withConnectionPool — URLSearchParams would emit "+" for the space, which Postgres
 * does not read as a space inside `options`. Fail-open: empty/undefined is returned as is.
 */
export function buildPipelineDbUrl(url: string | undefined, connections: number): string | undefined {
  if (!url) return url;
  const q = url.indexOf("?");
  const base = q >= 0 ? url.slice(0, q) : url;
  const existing = new URLSearchParams(q >= 0 ? url.slice(q + 1) : "");
  let qs =
    `connection_limit=${connections}&pool_timeout=2&connect_timeout=5` +
    `&options=-c%20statement_timeout%3D2500%20-c%20lock_timeout%3D1000`;
  for (const key of KEEP_PARAMS) {
    const value = existing.get(key);
    if (value !== null) qs += `&${key}=${encodeURIComponent(value)}`;
  }
  return `${base}?${qs}`;
}

/** How many connections this process's pipeline pool has (the bulkhead is sized from it). */
export const pipelineDbConnections = parsePipelineDbConnections(process.env.PIPELINE_DB_CONNECTIONS);

const pipelineUrl = buildPipelineDbUrl(process.env.DATABASE_URL, pipelineDbConnections);

// One client per process. Cached on globalThis outside production for the same reason the
// main client is: `tsx watch` reloads and vitest's per-file module registries would
// otherwise construct a new query engine each time.
const globalForPipeline = globalThis as unknown as { __pipelineDb?: PrismaClient };

export const pipelineDb: PrismaClient =
  globalForPipeline.__pipelineDb ??
  new PrismaClient(pipelineUrl ? { datasources: { db: { url: pipelineUrl } } } : undefined);

if (process.env.NODE_ENV !== "production") {
  globalForPipeline.__pipelineDb = pipelineDb;
}
