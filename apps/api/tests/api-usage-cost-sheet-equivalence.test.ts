/**
 * Cost Sheet (GET /admin/api-usage/cost-sheet): the SQL aggregation must return exactly what
 * the old row-hydrating implementation returned.
 *
 * WHY (incident 2026-10-03): getCostSheet() hydrated EVERY api_usage row in the window with an
 * unbounded prisma.apiUsage.findMany (2,072,696 rows for 30 days on prod) and aggregated them in
 * JS. Opening the API Costs page drove the API process to 1.2-1.76 GB; pm2's 800M cap and the
 * kernel OOM killer restarted it 8 times (33 user-facing 502s), and the page's SWR retries
 * re-triggered it after every restart. The rewrite aggregates in Postgres (ONE grouped
 * statement, one row per group) and prices each group in JS with the existing pricing functions.
 *
 * The contract proven here, for every fixture and window: integers EQUAL, floats within 1e-9
 * relative (Postgres adds floats in a different order than the old loop did), every array in
 * the SAME order, every object's keys in the same order. `legacyCostSheet` below is the old
 * getCostSheet copied verbatim (only its name changed), run against the same database at the
 * same frozen instant.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../src/app";
import {
  costSheetGroupCostUsd,
  effectiveRowCostUsd,
  getCostSheet,
  invalidateCostSheetCache,
  llmCostUsd,
  type CostSheet,
  type ProviderCost,
} from "../src/services/api-usage.service";
import { heavyQueryGateStats, resetHeavyQueryGateForTests, withHeavyQuerySlot } from "../src/utils/heavy-query";
import { createTestRole, createTestUser, generateToken } from "./helpers";

// The bulkhead reads HEAVY_QUERY_MAX_WAIT_MS once, at module load: 400 ms instead of 15 s lets
// the saturated-gate test see its 503 quickly. ⚠️ Restored in afterAll — process.env is shared
// by every file in the single fork (the documented rate-limit stub leak).
const hoistedEnv = vi.hoisted(() => {
  const previous = process.env.HEAVY_QUERY_MAX_WAIT_MS;
  process.env.HEAVY_QUERY_MAX_WAIT_MS = "400";
  return { previous };
});
afterAll(() => {
  if (hoistedEnv.previous === undefined) delete process.env.HEAVY_QUERY_MAX_WAIT_MS;
  else process.env.HEAVY_QUERY_MAX_WAIT_MS = hoistedEnv.previous;
});

type GroupLike = Parameters<typeof costSheetGroupCostUsd>[0];

// ─────────────────────────── the old implementation, verbatim ───────────────────────────
// Copied from apps/api/src/services/api-usage.service.ts at origin/main 59422ec (lines
// 235-385). Only the first line differs: `export async function getCostSheet(` became
// `async function legacyCostSheet(`. Do not "tidy" it — it is the reference.
async function legacyCostSheet(windowDays = 30): Promise<CostSheet> {
  const days = Math.max(1, Math.min(365, windowDays));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.apiUsage.findMany({
    where: { createdAt: { gte: since } },
    select: {
      provider: true,
      model: true, // needed by effectiveRowCostUsd to price the row from tokens
      operation: true,
      calls: true,
      units: true,
      inputTokens: true,
      outputTokens: true,
      costUsd: true,
      createdAt: true,
    },
  });

  // Earliest row overall (not just in-window) — the true tracking horizon.
  const earliest = await prisma.apiUsage.aggregate({ _min: { createdAt: true } });
  const trackingSince = earliest._min.createdAt ?? null;

  const byProviderMap = new Map<string, ProviderCost>();
  const byOpMap = new Map<string, { provider: string; operation: string; calls: number; costUsd: number }>();
  const dailyMap = new Map<string, { date: string; costUsd: number; calls: number }>();
  // MEASURED = organically-recorded calls with REAL per-call token counts (accurate).
  // ESTIMATED = '-reconstructed' rows: pre-tracking history rebuilt from timestamps at
  // a FLAT per-call cost. Proven to OVERSTATE high-volume incident days (the prompt
  // grows over time → early calls were cheaper; mixed providers; shared key). So we
  // keep them SEPARATE — the headline is measured-only; the estimate is a labeled
  // rough ceiling, never summed into the precise figure.
  let totalCostUsd = 0;          // measured only
  let estimatedHistoricalUsd = 0; // reconstructed (rough ceiling)

  for (const r of rows) {
    // TRUTH RECOMPUTE: use the token-accurate cost at the CURRENT price table, not
    // the (possibly stale/buggy) cost_usd stored at write time. Estimates + non-LLM +
    // unknown-model rows fall through to their stored value (see effectiveRowCostUsd).
    const cost = effectiveRowCostUsd(r);
    const isReconstructed = r.operation.endsWith("-reconstructed");
    if (isReconstructed) estimatedHistoricalUsd += cost;
    else totalCostUsd += cost;

    const pv = byProviderMap.get(r.provider) ?? { provider: r.provider, calls: 0, units: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    pv.calls += r.calls;
    pv.units += r.units ?? 0;
    pv.inputTokens += r.inputTokens ?? 0;
    pv.outputTokens += r.outputTokens ?? 0;
    pv.costUsd += cost;
    byProviderMap.set(r.provider, pv);

    const opKey = `${r.provider}:${r.operation}`;
    const op = byOpMap.get(opKey) ?? { provider: r.provider, operation: r.operation, calls: 0, costUsd: 0 };
    op.calls += r.calls;
    op.costUsd += cost;
    byOpMap.set(opKey, op);

    const dateKey = r.createdAt.toISOString().slice(0, 10);
    const d = dailyMap.get(dateKey) ?? { date: dateKey, costUsd: 0, calls: 0 };
    d.costUsd += cost;
    d.calls += r.calls;
    dailyMap.set(dateKey, d);
  }

  const hasReconstructed = [...byOpMap.values()].some((o) => o.operation.endsWith("-reconstructed"));

  // ── Horizon-honest, steady-state projection ────────────────────────────────
  // TWO corrections over the naive `total / windowDays`:
  //
  // (1) HORIZON: if tracking is younger than the window, dividing the total by the
  //     full window understates the rate (e.g. 48 min of data / 30 days). Use the
  //     REAL elapsed span (now − trackingSince), capped to the window.
  //
  // (2) STEADY-STATE (the user's point): the window total is dominated by ONE-TIME
  //     backfill spend (the ~40k-caption historical enrichment). Projecting THAT
  //     run-rate forward would massively OVERSTATE future cost — going forward only
  //     the daily new-link inflow (~1.7k/day) is enriched, far cheaper. So the
  //     forward projection is based on the RECENT steady-state daily cost (the
  //     trailing 3 full days, EXCLUDING reconstructed backfill rows), NOT the
  //     backfill-inflated window average. The window TOTAL still reports actual spend.
  const now = Date.now();
  const trackedMs = trackingSince ? now - trackingSince.getTime() : days * 86400_000;
  const effectiveDays = Math.max(1 / 24, Math.min(days, trackedMs / 86400_000)); // ≥1h, ≤window
  const fullWindow = !!trackingSince && trackedMs >= days * 86400_000;

  // Steady-state daily rate: sum the trailing 3 days of NON-reconstructed (i.e.
  // organically-recorded, forward) cost, over the number of those days that have data.
  const THREE_DAYS_AGO = new Date(now - 3 * 86400_000);
  const recentForwardRows = rows.filter(
    (r) => !r.operation.endsWith("-reconstructed") && r.createdAt >= THREE_DAYS_AGO,
  );
  // Use the recomputed (truth) cost here too, so the forward projection reflects the
  // corrected rate — not the stale stored cost.
  const recentForwardCost = recentForwardRows.reduce((s, r) => s + effectiveRowCostUsd(r), 0);
  const recentDaysWithData = new Set(recentForwardRows.map((r) => r.createdAt.toISOString().slice(0, 10))).size || 1;
  // If we have organic forward data, project from it (the true go-forward rate).
  // Otherwise fall back to the horizon-honest window rate (total / real elapsed days).
  const steadyDailyUsd = recentForwardRows.length > 0 ? recentForwardCost / recentDaysWithData : totalCostUsd / effectiveDays;

  // ── Projection-reliability gate (the user's "never presume" point) ──────────
  // The forward projection is only meaningful once the system is at STEADY STATE.
  // TWO conditions must BOTH hold — gating on the backlog alone is not enough.
  //
  // (A) BACKLOG DRAINED: while a large historical backfill backlog is still draining,
  //     the cron runs at full catch-up speed (e.g. ~2,800/hr) — many times the true
  //     forward inflow (~1.7k/day). Gate on pending-extraction backlog.
  //
  // (B) ENOUGH ELAPSED TIME SINCE TRACKING BEGAN (2026-06-29, corrected): the backlog
  //     can drain to near-zero while the trailing cost we average is STILL almost
  //     entirely the one-time backfill burst (it just finished hours ago). That was
  //     the real bug behind the bogus "$466/mo" — backlog had fallen below 2000, so
  //     (A) passed, but `recentForwardCost` was dominated by the ~36k burst calls of
  //     the prior ~2 days, so the rate (and the ×30 projection) was the BURST
  //     extrapolated forward, not steady state.
  //     ⚠️ A FIRST attempt gated on "≥3 DISTINCT calendar days of organic data" — but
  //     a burst that merely STRADDLES two midnights trivially yields 3 date-buckets
  //     (e.g. Jun 27/28/29) while only ~1.8 real days have elapsed, so that gate let
  //     the burst through. The honest signal is ELAPSED TIME since tracking began
  //     (effectiveDays), not how many date-buckets got touched: only once enough real
  //     days have passed is the backfill genuinely BEHIND us and the trailing rate
  //     made of forward inflow. Require effectiveDays ≥ MIN_FORWARD_DAYS. Until then
  //     the UI shows "—" / "measuring true forward rate" instead of presuming.
  const pendingExtractionBacklog = await prisma.linkContent.count({
    where: { status: "ok", extractedAt: null },
  });
  const BACKLOG_RELIABLE_THRESHOLD = 2000; // below this, the cron is keeping up ≈ steady state
  const MIN_FORWARD_DAYS = 4; // need ≥4 real elapsed days of tracking before trusting the rate
  const backlogDrained = pendingExtractionBacklog < BACKLOG_RELIABLE_THRESHOLD;
  const enoughElapsedTime = effectiveDays >= MIN_FORWARD_DAYS;
  const projectionReliable = backlogDrained && enoughElapsedTime;

  return {
    windowDays: days,
    since: since.toISOString(),
    totalCostUsd,
    byProvider: [...byProviderMap.values()].sort((a, b) => b.costUsd - a.costUsd),
    byOperation: [...byOpMap.values()].sort((a, b) => b.costUsd - a.costUsd),
    daily: [...dailyMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    // Projection = forward STEADY-STATE rate (excludes one-time backfill), ×30.
    projectedDailyUsd: steadyDailyUsd,
    projectedMonthlyUsd: steadyDailyUsd * 30,
    trackingSince: trackingSince ? trackingSince.toISOString() : null,
    effectiveDays,
    fullWindow,
    hasReconstructed,
    projectionReliable,
    pendingExtractionBacklog,
    estimatedHistoricalUsd,
  };
}

// ───────────────────────────────────── comparison ─────────────────────────────────────────

/** Fields summed in floating point. Every other number (calls, units, tokens, windowDays,
 *  the backlog count) must match EXACTLY. */
const FLOAT_KEYS = new Set([
  "costUsd",
  "totalCostUsd",
  "estimatedHistoricalUsd",
  "projectedDailyUsd",
  "projectedMonthlyUsd",
  "effectiveDays",
]);
const REL_TOL = 1e-9;

/**
 * Every difference between two sheets: exact equality everywhere except FLOAT_KEYS (≤ 1e-9
 * relative), arrays element by element IN ORDER, and each object's keys in the same order.
 */
function sheetDiffs(actual: unknown, expected: unknown, path = "sheet", key: string | null = null, out: string[] = []): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push(`${path}: expected an array, got ${JSON.stringify(actual)}`);
      return out;
    }
    if (actual.length !== expected.length) out.push(`${path}: length ${actual.length}, expected ${expected.length}`);
    for (let i = 0; i < Math.min(actual.length, expected.length); i++) sheetDiffs(actual[i], expected[i], `${path}[${i}]`, null, out);
    return out;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      out.push(`${path}: expected an object, got ${JSON.stringify(actual)}`);
      return out;
    }
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    if (actualKeys.join("|") !== expectedKeys.join("|")) {
      out.push(`${path}: keys [${actualKeys.join(", ")}], expected [${expectedKeys.join(", ")}]`);
    }
    for (const k of expectedKeys) {
      sheetDiffs((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${path}.${k}`, k, out);
    }
    return out;
  }
  if (actual === expected || Object.is(actual, expected)) return out;
  if (key !== null && FLOAT_KEYS.has(key) && typeof actual === "number" && typeof expected === "number") {
    const rel = Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected));
    if (!(rel <= REL_TOL)) out.push(`${path}: ${actual}, expected ${expected} (relative difference ${rel})`);
    return out;
  }
  out.push(`${path}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  return out;
}

/** Old vs new at the frozen instant, against the same rows. Returns both for extra checks. */
async function expectSameAsLegacy(days: number, label = `days=${days}`): Promise<{ legacy: CostSheet; sheet: CostSheet }> {
  const legacy = await legacyCostSheet(days);
  invalidateCostSheetCache();
  const sheet = await getCostSheet(days);
  expect(sheetDiffs(sheet, legacy), label).toEqual([]);
  return { legacy, sheet };
}

// ─────────────────────────────────────── fixtures ─────────────────────────────────────────

const DAY = 86_400_000;
// Every test runs at this frozen instant. Only Date is faked; real timers keep Prisma moving.
const NOW = Date.UTC(2026, 9, 3, 9, 30, 0, 0); // 2026-10-03T09:30:00.000Z
const sinceFor = (days: number): number => NOW - days * DAY;
const THREE_DAYS_AGO = NOW - 3 * DAY; // 2026-09-30T09:30:00.000Z

interface FixtureRow {
  provider: string;
  model: string;
  operation: string;
  calls: number;
  units: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  createdAt: Date;
}

function row(r: Partial<FixtureRow> & Pick<FixtureRow, "provider" | "createdAt">): FixtureRow {
  return { model: "", operation: "", calls: 1, units: null, inputTokens: null, outputTokens: null, costUsd: 0, ...r };
}
const at = (iso: string): Date => new Date(iso);
const ms = (t: number): Date => new Date(t);
const sleep = (n: number): Promise<void> => new Promise((r) => setTimeout(r, n));

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * api_usage is not in tests/setup.ts's TRUNCATE list (other suites' fire-and-forget
 * recordApiUsage rows linger), so every test empties it here. TRUNCATE, not DELETE: the heap
 * starts empty, so its physical order is exactly the insertion order (see seed()).
 */
async function emptyApiUsage(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$executeRawUnsafe("TRUNCATE TABLE api_usage");
      return;
    } catch (err) {
      const deadlock = String((err as Error)?.message ?? "").includes("deadlock detected");
      if (!deadlock || attempt >= 5) throw err;
      await sleep(50 * attempt);
    }
  }
}

/**
 * Insert in created_at order. The legacy findMany has no ORDER BY, so it returns rows in the
 * heap's physical order; on prod's append-only table that is chronological, and it is the
 * order whose Map insertion decided the old sort's ties. Distinct instants keep it unambiguous.
 */
async function seed(rows: FixtureRow[]): Promise<void> {
  expect(new Set(rows.map((r) => r.createdAt.getTime())).size, "fixture instants must be distinct").toBe(rows.length);
  await emptyApiUsage();
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (let i = 0; i < sorted.length; i += 1000) {
    await prisma.apiUsage.createMany({ data: sorted.slice(i, i + 1000) });
  }
}

/**
 * Every pricing branch and every boundary, at distinct instants:
 *  - both edges of the 30-day and 7-day windows (since - 1 ms out, since in, since + 1 ms in);
 *  - both sides of the 3-day "recent" edge and of a UTC midnight;
 *  - a priced model with both / only-input / only-output / no token counts, zero tokens, an
 *    unknown model, an empty model, and a stale stored cost the recompute corrects;
 *  - '-reconstructed' rows (kept at their stored estimate), recent ones (excluded from the
 *    steady-state projection) and an UPPER-case look-alike (endsWith is case-sensitive);
 *  - calls > 1, units null / 1 / 100, an empty operation, and a row a minute in the future;
 *  - a tracking start 40 days back, so 41+ days is a partial window.
 */
function handBuiltFixture(): FixtureRow[] {
  const ext = { provider: "deepseek", model: "deepseek-v4-flash", operation: "entity-extraction" };
  return [
    // Tracking start: outside every window shorter than 40 days.
    row({ provider: "meta", operation: "graph-media", units: 1, createdAt: ms(NOW - 40 * DAY) }),
    // The 30-day window's edges.
    row({ provider: "meta", operation: "graph-media", units: 1, createdAt: ms(sinceFor(30) - 1) }),
    row({ provider: "youtube", operation: "youtube-videos", units: 1, createdAt: ms(sinceFor(30)) }),
    row({ provider: "openai", model: "gpt-4o-mini", operation: "entity-extraction", inputTokens: 14_617, outputTokens: 31, costUsd: 0.001287, createdAt: ms(sinceFor(30) + 1) }),
    // A reconstructed estimate keeps its stored cost even with tokens on a priced model.
    row({ provider: "openai", model: "gpt-4o-mini", operation: "entity-extraction-reconstructed", inputTokens: 1_000_000, outputTokens: 0, costUsd: 42, createdAt: at("2026-09-10T08:00:00.000Z") }),
    // The upper-case look-alike is NOT reconstructed, so it is priced from its tokens.
    row({ provider: "openai", model: "gpt-4o-mini", operation: "Entity-Extraction-RECONSTRUCTED", inputTokens: 2_000, outputTokens: 20, costUsd: 9.99, createdAt: at("2026-09-11T10:00:00.000Z") }),
    // Token-count states on a priced model.
    row({ provider: "openai", model: "gpt-4o-mini", operation: "chat", inputTokens: null, outputTokens: 500, costUsd: 0.0123, createdAt: at("2026-09-12T01:02:03.004Z") }),
    row({ provider: "openai", model: "gpt-4o-mini", operation: "chat", inputTokens: 1_200, outputTokens: null, costUsd: 0.0456, createdAt: at("2026-09-12T05:06:07.008Z") }),
    row({ provider: "openai", model: "gpt-4o-mini", operation: "chat", inputTokens: null, outputTokens: null, costUsd: 0.0789, createdAt: at("2026-09-12T09:10:11.012Z") }),
    // Unknown and empty models keep their stored cost.
    row({ provider: "openai", model: "some-future-model", operation: "chat", inputTokens: 1_000, outputTokens: 1_000, costUsd: 0.005, createdAt: at("2026-09-13T12:00:00.000Z") }),
    row({ provider: "openai", model: "", operation: "chat", inputTokens: 777, outputTokens: 111, costUsd: 0.0042, createdAt: at("2026-09-13T13:00:00.000Z") }),
    // Anthropic, two priced models.
    row({ provider: "anthropic", model: "claude-sonnet-4-20250514", operation: "ai-generate", inputTokens: 3_000, outputTokens: 900, costUsd: 0.05, createdAt: at("2026-09-14T07:00:00.000Z") }),
    row({ provider: "anthropic", model: "claude-haiku-4-5", operation: "ai-generate", inputTokens: 4_000, outputTokens: 1_000, costUsd: 0.01, createdAt: at("2026-09-15T07:00:00.000Z") }),
    // Gemini: a stale stored cost the recompute corrects, and zero tokens (priced at 0, not stored).
    row({ provider: "gemini", model: "gemini-2.5-flash-lite", operation: "entity-extraction", inputTokens: 18_103, outputTokens: 67, costUsd: 0.000532, createdAt: at("2026-09-16T07:00:00.000Z") }),
    row({ provider: "gemini", model: "gemini-2.5-flash-lite", operation: "entity-extraction", inputTokens: 0, outputTokens: 0, costUsd: 0.0011, createdAt: at("2026-09-17T07:00:00.000Z") }),
    // Free, quota-only providers: calls > 1, units null / 1 / 100, an empty operation.
    row({ provider: "meta", operation: "meta-oauth:posts", calls: 3, units: 3, createdAt: at("2026-09-20T03:00:00.000Z") }),
    row({ provider: "youtube", operation: "youtube-search", calls: 2, units: 200, createdAt: at("2026-09-21T03:00:00.000Z") }),
    row({ provider: "youtube", operation: "youtube-channels", units: null, createdAt: at("2026-09-22T03:00:00.000Z") }),
    row({ provider: "meta", operation: "", units: 1, createdAt: at("2026-09-23T03:00:00.000Z") }),
    // The 7-day window's edges.
    row({ ...ext, inputTokens: 21_000, outputTokens: 70, costUsd: 0.0005, createdAt: ms(sinceFor(7) - 1) }),
    row({ ...ext, inputTokens: 20_000, outputTokens: 71, costUsd: 0.00042, createdAt: ms(sinceFor(7)) }),
    row({ ...ext, inputTokens: 19_500, outputTokens: 80, costUsd: 0.0003, createdAt: ms(sinceFor(7) + 1) }),
    // A UTC midnight.
    row({ ...ext, inputTokens: 21_000, outputTokens: 60, costUsd: 0.0009, createdAt: at("2026-09-28T23:59:59.999Z") }),
    row({ ...ext, inputTokens: 22_000, outputTokens: 61, costUsd: 0.0008, createdAt: at("2026-09-29T00:00:00.000Z") }),
    // The 3-day "recent" edge.
    row({ ...ext, inputTokens: 23_000, outputTokens: 62, costUsd: 0.0007, createdAt: ms(THREE_DAYS_AGO - 1) }),
    row({ ...ext, inputTokens: 24_000, outputTokens: 63, costUsd: 0.0006, createdAt: ms(THREE_DAYS_AGO) }),
    row({ ...ext, inputTokens: 25_000, outputTokens: 64, costUsd: 0.0005, createdAt: ms(THREE_DAYS_AGO + 1) }),
    // Recent reconstructed rows: in the window's totals, never in the steady-state projection.
    row({ provider: "meta", operation: "graph-reconstructed", calls: 2, units: 2, costUsd: 0.75, createdAt: at("2026-10-01T04:00:00.000Z") }),
    row({ provider: "deepseek", model: "deepseek-v4-flash", operation: "entity-extraction-reconstructed", costUsd: 1.25, createdAt: at("2026-10-01T05:00:00.000Z") }),
    // More recent forward rows, on three calendar days.
    row({ ...ext, inputTokens: 26_000, outputTokens: 65, costUsd: 0.0004, createdAt: at("2026-10-01T12:00:00.000Z") }),
    row({ provider: "meta", operation: "fb-reel-scraper", calls: 5, units: 5, createdAt: at("2026-10-02T03:00:00.000Z") }),
    row({ ...ext, inputTokens: 27_000, outputTokens: 66, costUsd: 0.0003, createdAt: ms(NOW - 60_000) }),
    // Clock skew: a row a minute in the future (the window has no upper bound).
    row({ ...ext, inputTokens: 28_000, outputTokens: 67, costUsd: 0.0002, createdAt: ms(NOW + 60_000) }),
  ];
}

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function mulberry32(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `n` rows at distinct instants over the last 45 days: all six providers, priced / unknown /
 * empty models, reconstructed and look-alike operations, every token state (including a rare
 * NEGATIVE input count), calls 1-9, units null / 1 / 100, costs from 0 to $50.
 */
function randomFixture(seedValue: number, n: number): FixtureRow[] {
  const rand = mulberry32(seedValue);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const PROVIDERS = ["meta", "youtube", "deepseek", "openai", "gemini", "anthropic"] as const;
  const MODELS: Record<string, readonly string[]> = {
    meta: [""],
    youtube: [""],
    deepseek: ["deepseek-v4-flash", "deepseek-v4-flash", ""],
    openai: ["gpt-4o-mini", "gpt-4o", "some-future-model", ""],
    gemini: ["gemini-2.5-flash-lite", "gemini-9-experimental"],
    anthropic: ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-20250514", ""],
  };
  const OPERATIONS: Record<string, readonly string[]> = {
    meta: ["graph-media", "meta-oauth:posts", "meta-oauth:channels", "fb-reel-scraper", "snap-spotlight-scraper", "", "graph-reconstructed"],
    youtube: ["youtube-videos", "youtube-channels", "youtube-search"],
    deepseek: ["entity-extraction", "entity-extraction-reconstructed"],
    openai: ["entity-extraction", "entity-extraction-reconstructed", "chat", "Chat-RECONSTRUCTED"],
    gemini: ["entity-extraction", "entity-extraction-reconstructed"],
    anthropic: ["entity-extraction", "ai-generate"],
  };
  const used = new Set<number>();
  const rows: FixtureRow[] = [];
  for (let i = 0; i < n; i++) {
    let t: number;
    do {
      t = NOW - Math.floor(rand() * 45 * DAY);
    } while (used.has(t));
    used.add(t);
    const provider = pick(PROVIDERS);
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    const state = rand();
    if (state < 0.55) {
      inputTokens = Math.floor(rand() * 30_000);
      outputTokens = Math.floor(rand() * 400);
    } else if (state < 0.65) {
      outputTokens = Math.floor(rand() * 400);
    } else if (state < 0.75) {
      inputTokens = Math.floor(rand() * 30_000);
    } else if (state < 0.77) {
      inputTokens = -1 - Math.floor(rand() * 500);
      outputTokens = Math.floor(rand() * 50);
    } // else: both null
    const calls = rand() < 0.8 ? 1 : 1 + Math.floor(rand() * 9);
    rows.push({
      provider,
      model: pick(MODELS[provider]),
      operation: pick(OPERATIONS[provider]),
      calls,
      units: rand() < 0.5 ? null : pick([1, 1, 100]) * calls,
      inputTokens,
      outputTokens,
      costUsd: rand() < 0.3 ? 0 : rand() < 0.95 ? rand() * 0.01 : rand() * 50,
      createdAt: ms(t),
    });
  }
  return rows;
}

/**
 * Prod-shaped traffic: mostly free Graph/scraper calls plus one LLM extraction stream, so a
 * window collapses to a few groups per operation per day — as on prod, where 2,072,696 rows
 * in 30 days aggregate to a few thousand groups.
 */
function prodLikeFixture(seedValue: number, n: number, spanDays: number): FixtureRow[] {
  const rand = mulberry32(seedValue);
  const META_OPS = ["graph-media", "meta-oauth:posts", "meta-oauth:channels", "fb-reel-scraper", "snap-spotlight-scraper"];
  const YOUTUBE_OPS = ["youtube-videos", "youtube-channels"];
  const used = new Set<number>();
  const rows: FixtureRow[] = [];
  for (let i = 0; i < n; i++) {
    let t: number;
    do {
      t = NOW - Math.floor(rand() * spanDays * DAY);
    } while (used.has(t));
    used.add(t);
    const kind = rand();
    if (kind < 0.7) {
      rows.push(row({ provider: "meta", operation: META_OPS[Math.floor(rand() * META_OPS.length)], units: 1, createdAt: ms(t) }));
    } else if (kind < 0.75) {
      rows.push(row({ provider: "youtube", operation: YOUTUBE_OPS[Math.floor(rand() * YOUTUBE_OPS.length)], units: 1, createdAt: ms(t) }));
    } else {
      rows.push(
        row({
          provider: "deepseek",
          model: "deepseek-v4-flash",
          operation: "entity-extraction",
          inputTokens: 18_000 + Math.floor(rand() * 4_000),
          outputTokens: 40 + Math.floor(rand() * 60),
          costUsd: rand() * 0.003,
          createdAt: ms(t),
        }),
      );
    }
  }
  return rows;
}

async function seedBacklog(pending: number): Promise<void> {
  const data: Array<{ canonicalKey: string; platform: string; status: string; extractedAt?: Date }> = [];
  for (let i = 0; i < pending; i++) data.push({ canonicalKey: `yt:pending-${i}`, platform: "youtube", status: "ok" });
  // Not counted: already tagged, or not a usable caption.
  data.push({ canonicalKey: "yt:tagged", platform: "youtube", status: "ok", extractedAt: ms(NOW - DAY) });
  data.push({ canonicalKey: "yt:not-ok", platform: "youtube", status: "pending" });
  for (let i = 0; i < data.length; i += 1000) await prisma.linkContent.createMany({ data: data.slice(i, i + 1000) });
}

/**
 * Count calls to prisma.apiUsage.findMany. vi.spyOn cannot wrap it: Prisma's model delegate is
 * a Proxy that mints a fresh action function on every read and reports an own descriptor with
 * `value: undefined`, so spyOn captures `undefined` as the original (and restoring it leaves
 * findMany undefined for the rest of the file). An own property shadows the minted function.
 * ⚠️ Restore by re-pointing it at a real minted function, never `delete`: the proxy remembers
 * deleted keys, and this client is shared (globalThis) by every later file in the fork.
 */
function watchApiUsageFindMany(): { calls: () => number; restore: () => void } {
  const delegate = prisma.apiUsage as unknown as Record<string, unknown>;
  const real = delegate.findMany as (...args: unknown[]) => unknown;
  let calls = 0;
  const define = (value: unknown) =>
    Object.defineProperty(delegate, "findMany", { configurable: true, enumerable: true, writable: true, value });
  define((...args: unknown[]) => {
    calls++;
    return real(...args);
  });
  return { calls: () => calls, restore: () => define(real) };
}

async function adminToken(): Promise<string> {
  await createTestRole("Admin", [{ resource: "employees", action: "edit", scope: "global" }]);
  const admin = await createTestUser({ roleNames: ["Admin"] });
  return generateToken(admin.id, admin.email, ["Admin"]);
}

const COST_SHEET_URL = "/v1/admin/api-usage/cost-sheet";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  invalidateCostSheetCache();
  resetHeavyQueryGateForTests();
  await emptyApiUsage();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetHeavyQueryGateForTests();
});

// ───────────────────────────────────── equivalence ────────────────────────────────────────

describe("getCostSheet: the SQL aggregation returns exactly what the row loop returned", () => {
  it("hand-built fixture: every pricing branch and every edge, at 14 windows", async () => {
    await seed(handBuiltFixture());
    // 1000 and 0.5 are clamped (365 and 1); 40 puts the tracking start exactly on the edge.
    for (const days of [1, 2, 3, 6.5, 7, 7.5, 14, 30, 39, 40, 41, 365, 1000, 0.5]) {
      await expectSameAsLegacy(days);
    }

    // The fixture really exercises what it claims (anchors computed by hand, not by either
    // implementation).
    const { sheet } = await expectSameAsLegacy(30);
    expect(sheet.hasReconstructed).toBe(true);
    expect(sheet.estimatedHistoricalUsd).toBe(44); // 42 + 0.75 + 1.25, stored estimates
    const op = (provider: string, operation: string) =>
      sheet.byOperation.find((o) => o.provider === provider && o.operation === operation);
    // Upper-case look-alike: priced from tokens, not its stored 9.99.
    expect(op("openai", "Entity-Extraction-RECONSTRUCTED")?.costUsd).toBeCloseTo((2_000 / 1e6) * 0.15 + (20 / 1e6) * 0.6, 12);
    // chat: output-only + input-only priced, no-tokens + unknown model + empty model stored.
    expect(op("openai", "chat")?.costUsd).toBeCloseTo((500 / 1e6) * 0.6 + (1_200 / 1e6) * 0.15 + 0.0789 + 0.005 + 0.0042, 12);
    // Gemini: 18,103 in + 67 out at $0.10/$0.40 (not the stored 0.000532), zero tokens → 0.
    expect(op("gemini", "entity-extraction")?.costUsd).toBeCloseTo((18_103 / 1e6) * 0.1 + (67 / 1e6) * 0.4, 12);
    const meta = sheet.byProvider.find((p) => p.provider === "meta") as ProviderCost;
    // In the 30-day window: meta-oauth:posts 3, "" 1, graph-reconstructed 2, fb-reel-scraper 5
    // (the graph-media row at since - 1 ms is outside).
    expect(meta).toMatchObject({ calls: 3 + 1 + 2 + 5, units: 3 + 1 + 2 + 5, inputTokens: 0, outputTokens: 0 });
    expect(sheet.daily.map((d) => d.date)).toContain("2026-09-28");
    expect(sheet.daily.map((d) => d.date)).toContain("2026-09-29");
    expect(sheet.since).toBe("2026-09-03T09:30:00.000Z");
    expect(sheet.trackingSince).toBe(ms(NOW - 40 * DAY).toISOString());
  });

  it("ties keep the old first-appearance order, not alphabetical (zero-cost and exactly-equal entries)", async () => {
    const t = (h: number): Date => ms(NOW - 10 * DAY + h * 3_600_000);
    await seed([
      row({ provider: "youtube", operation: "youtube-videos", units: 1, createdAt: t(0) }),
      row({ provider: "deepseek", model: "deepseek-v4-flash", operation: "entity-extraction", inputTokens: 20_000, outputTokens: 70, costUsd: 0.0004, createdAt: t(1) }),
      row({ provider: "meta", operation: "meta-oauth:posts", units: 1, createdAt: t(2) }),
      row({ provider: "openai", operation: "tie-zeta", costUsd: 0.25, createdAt: t(3) }),
      row({ provider: "meta", operation: "graph-media", units: 1, createdAt: t(4) }),
      row({ provider: "openai", operation: "tie-alpha", costUsd: 0.5, createdAt: t(5) }),
      row({ provider: "youtube", operation: "youtube-channels", createdAt: t(6) }),
      row({ provider: "openai", operation: "tie-zeta", costUsd: 0.25, createdAt: t(7) }),
      row({ provider: "meta", operation: "fb-reel-scraper", units: 1, createdAt: t(8) }),
      row({ provider: "meta", operation: "", units: 1, createdAt: t(9) }),
    ]);
    const { sheet } = await expectSameAsLegacy(30);
    // youtube ($0) was seen before meta ($0); tie-zeta ($0.50) before tie-alpha ($0.50).
    expect(sheet.byProvider.map((p) => p.provider)).toEqual(["openai", "deepseek", "youtube", "meta"]);
    expect(sheet.byOperation.map((o) => o.operation)).toEqual([
      "tie-zeta",
      "tie-alpha",
      "entity-extraction",
      "youtube-videos",
      "meta-oauth:posts",
      "graph-media",
      "youtube-channels",
      "fb-reel-scraper",
      "",
    ]);
  });

  it("prices a NEGATIVE input count exactly as the per-row formula does", async () => {
    // llmCostUsd clamps cached = min(max(0, cachedTokens), inputTokens). With cachedTokens = 0 a
    // negative input lands entirely in `cached` and is billed at the cached rate, not the full
    // one, so per-row pricing is linear only within one sign of input_tokens. Providers never
    // report negative counts, but the column has no CHECK constraint.
    const t = (m: number): Date => ms(NOW - 2 * DAY + m * 60_000);
    const ext = { provider: "deepseek", model: "deepseek-v4-flash", operation: "entity-extraction" };
    await seed([
      row({ ...ext, inputTokens: 20_000, outputTokens: 50, createdAt: t(0) }),
      row({ ...ext, inputTokens: -5_000, outputTokens: 10, createdAt: t(1) }),
      row({ ...ext, inputTokens: 30_000, outputTokens: 70, createdAt: t(2) }),
    ]);
    const { sheet } = await expectSameAsLegacy(30);
    const perRow =
      (20_000 / 1e6) * 0.14 + (50 / 1e6) * 0.28 + ((-5_000 / 1e6) * 0.0028 + (10 / 1e6) * 0.28) + (30_000 / 1e6) * 0.14 + (70 / 1e6) * 0.28;
    expect(sheet.totalCostUsd).toBeCloseTo(perRow, 12);
    // Pooling the three rows would have billed the -5,000 at the full $0.14/M.
    expect(Math.abs(llmCostUsd("deepseek-v4-flash", 45_000, 130) - perRow)).toBeGreaterThan(1e-4);
  });

  it("seeded random fixture: 3,000 rows over 45 days, at 13 windows", async () => {
    await seed(randomFixture(20261003, 3_000));
    for (const days of [1, 2, 2.25, 3, 5, 7, 14, 30, 44, 45, 60, 90, 365]) {
      await expectSameAsLegacy(days);
    }
  });

  it("an empty table", async () => {
    for (const days of [1, 7, 30, 365]) {
      const { sheet } = await expectSameAsLegacy(days);
      expect(sheet).toMatchObject({ trackingSince: null, byProvider: [], byOperation: [], daily: [], totalCostUsd: 0, hasReconstructed: false });
    }
  });

  it("rows only outside the window", async () => {
    await seed([
      row({ provider: "meta", operation: "graph-media", units: 1, createdAt: ms(NOW - 50 * DAY) }),
      row({ provider: "deepseek", model: "deepseek-v4-flash", operation: "entity-extraction", inputTokens: 1_000, outputTokens: 10, costUsd: 0.1, createdAt: ms(NOW - 31 * DAY) }),
    ]);
    const { sheet } = await expectSameAsLegacy(30);
    expect(sheet).toMatchObject({ byProvider: [], byOperation: [], daily: [], fullWindow: true });
    await expectSameAsLegacy(365);
  });

  it("only reconstructed rows: an estimate, no measured spend, no steady-state rows", async () => {
    await seed([
      row({ provider: "openai", model: "gpt-4o-mini", operation: "entity-extraction-reconstructed", inputTokens: 5_000, outputTokens: 50, costUsd: 3.5, createdAt: ms(NOW - 20 * DAY) }),
      row({ provider: "openai", model: "gpt-4o-mini", operation: "entity-extraction-reconstructed", costUsd: 1.5, createdAt: ms(NOW - DAY) }),
      row({ provider: "meta", operation: "graph-reconstructed", calls: 4, units: 4, costUsd: 0.25, createdAt: ms(NOW - 2 * DAY) }),
    ]);
    for (const days of [1, 3, 7, 30]) await expectSameAsLegacy(days);
    const { sheet } = await expectSameAsLegacy(30);
    expect(sheet).toMatchObject({ totalCostUsd: 0, estimatedHistoricalUsd: 5.25, hasReconstructed: true, projectedDailyUsd: 0 });
  });

  it("tracking younger than the window: the horizon fields match", async () => {
    await seed([
      row({ provider: "deepseek", model: "deepseek-v4-flash", operation: "entity-extraction", inputTokens: 9_000, outputTokens: 90, createdAt: ms(NOW - 30 * 3_600_000) }),
      row({ provider: "meta", operation: "graph-media", units: 1, createdAt: ms(NOW - 2 * 3_600_000) }),
    ]);
    for (const days of [1, 2, 7, 30]) await expectSameAsLegacy(days);
    const { sheet } = await expectSameAsLegacy(30);
    expect(sheet.fullWindow).toBe(false);
    expect(sheet.effectiveDays).toBeCloseTo(30 / 24, 12);
    expect(sheet.projectionReliable).toBe(false);
  });

  it("the pending-extraction backlog gates the projection the same way", async () => {
    await seed(handBuiltFixture());
    await seedBacklog(1_999);
    const below = await expectSameAsLegacy(30);
    expect(below.sheet).toMatchObject({ pendingExtractionBacklog: 1_999, projectionReliable: true });
    await prisma.linkContent.create({ data: { canonicalKey: "yt:pending-2000th", platform: "youtube", status: "ok" } });
    const at2000 = await expectSameAsLegacy(30);
    expect(at2000.sheet).toMatchObject({ pendingExtractionBacklog: 2_000, projectionReliable: false });
  });

  // SET TIME ZONE is per connection, so this is exact only on the single-connection pool the
  // suite pins (connection_limit=1, as in CI); on a larger pool it would test whichever
  // connection each query happened to get.
  const singleConnectionPool = /[?&]connection_limit=1(?:&|$)/.test(process.env.DATABASE_URL ?? "");
  it.runIf(singleConnectionPool)("keeps the window, the 3-day edge and the day keys in UTC when the DB session TimeZone is not UTC", async () => {
    // A bare JS Date in $queryRaw binds as timestamptz, which Postgres compares with the
    // timestamp(3) column through the SESSION TimeZone; findMany does not. The edge rows at
    // since ± 1 ms and THREE_DAYS_AGO ± 1 ms catch any shift.
    await seed(handBuiltFixture());
    for (const tz of ["Asia/Kolkata", "America/Los_Angeles"]) {
      // connection_limit=1: the SET applies to the one pooled connection every query below uses.
      await prisma.$executeRawUnsafe(`SET TIME ZONE '${tz}'`);
      try {
        const [{ zone }] = await prisma.$queryRaw<Array<{ zone: string }>>`SELECT current_setting('TimeZone') AS zone`;
        expect(zone).toBe(tz);
        for (const days of [3, 7, 30]) await expectSameAsLegacy(days, `${tz} days=${days}`);
      } finally {
        await prisma.$executeRawUnsafe("RESET TIME ZONE");
      }
    }
  });

  it("the route serves the same sheet over HTTP", async () => {
    await seed(handBuiltFixture());
    const token = await adminToken();
    const legacy = JSON.parse(JSON.stringify(await legacyCostSheet(30))) as CostSheet;
    invalidateCostSheetCache();
    const res = await request(app).get(`${COST_SHEET_URL}?days=30`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(sheetDiffs(res.body.data, legacy)).toEqual([]);
  });
});

// ─────────────────────────────── bounded, memoised, bulkheaded ─────────────────────────────

describe("getCostSheet: bounded, memoised and behind the heavy-query bulkhead", () => {
  it("never hydrates rows: no apiUsage.findMany, ONE $queryRaw returning one row per group", async () => {
    const rows = prodLikeFixture(7, 8_000, 35);
    await seed(rows);
    const findMany = watchApiUsageFindMany();
    const raw = vi.spyOn(prisma, "$queryRaw");
    let legacy!: CostSheet;
    let sheet!: CostSheet;
    try {
      // Positive control: the watcher does see the old implementation's findMany (which
      // issues no $queryRaw).
      legacy = await legacyCostSheet(30);
      expect(findMany.calls()).toBe(1);
      sheet = await getCostSheet(30);
      expect(findMany.calls()).toBe(1); // the new code added none
    } finally {
      findMany.restore();
    }
    expect(sheetDiffs(sheet, legacy)).toEqual([]);
    expect(raw).toHaveBeenCalledTimes(1);
    const groups = (await raw.mock.results[0].value) as unknown[];
    const inWindow = rows.filter((r) => r.createdAt.getTime() >= sinceFor(30));
    const expectedGroups = new Set(
      inWindow.map((r) =>
        [
          r.provider,
          r.operation,
          r.model,
          r.createdAt.toISOString().slice(0, 10),
          r.inputTokens == null && r.outputTokens == null,
          (r.inputTokens ?? 0) < 0,
          r.createdAt.getTime() >= THREE_DAYS_AGO,
        ].join("\u0000"),
      ),
    ).size;
    expect(groups).toHaveLength(expectedGroups);
    expect(groups.length).toBeLessThan(inWindow.length / 10);
  });

  it("serves a repeat within 60 s from the memo, shares one compute between concurrent cold callers, and recomputes after expiry", async () => {
    await seed(handBuiltFixture());
    const raw = vi.spyOn(prisma, "$queryRaw");
    const [a, b] = await Promise.all([getCostSheet(30), getCostSheet(30)]);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);

    vi.setSystemTime(NOW + 59_999);
    expect(await getCostSheet(30)).toBe(a);
    expect(raw).toHaveBeenCalledTimes(1);

    // Each window is its own entry; an out-of-range window shares its clamped one.
    await getCostSheet(7);
    expect(raw).toHaveBeenCalledTimes(2);
    const year = await getCostSheet(365);
    expect(await getCostSheet(1000)).toBe(year);
    expect(raw).toHaveBeenCalledTimes(3);

    vi.setSystemTime(NOW + 60_000);
    const c = await getCostSheet(30);
    expect(c).not.toBe(a);
    expect(raw).toHaveBeenCalledTimes(4);
  });

  it("a cold compute waits for a heavy-query slot; a memo hit never touches the gate", async () => {
    await seed(handBuiltFixture());
    const raw = vi.spyOn(prisma, "$queryRaw");
    const holds = [deferred(), deferred()];
    const holders = holds.map((d, i) => withHeavyQuerySlot(`test-hold-${i}`, () => d.promise));

    const cold = getCostSheet(30);
    await sleep(50);
    expect(heavyQueryGateStats()).toMatchObject({ active: 2, queued: 1 });
    expect(raw).not.toHaveBeenCalled();
    holds[0].resolve();
    const sheet = await cold;
    expect(raw).toHaveBeenCalledTimes(1);

    // Saturate the gate again: the cached sheet still answers at once, without queueing.
    const third = deferred();
    const thirdHolder = withHeavyQuerySlot("test-hold-2", () => third.promise);
    expect(heavyQueryGateStats()).toMatchObject({ active: 2, queued: 0 });
    expect(await getCostSheet(30)).toBe(sheet);
    expect(heavyQueryGateStats()).toMatchObject({ active: 2, queued: 0 });
    expect(raw).toHaveBeenCalledTimes(1);

    holds[1].resolve();
    third.resolve();
    await Promise.all([...holders, thirdHolder]);
  });

  it("a saturated gate answers 503 REPORTS_BUSY (never a 500 or a hang), and the failure is not cached", async () => {
    await seed(handBuiltFixture());
    const token = await adminToken();
    const holds = [deferred(), deferred()];
    const holders = holds.map((d, i) => withHeavyQuerySlot(`test-hold-${i}`, () => d.promise));

    const busy = await request(app).get(`${COST_SHEET_URL}?days=30`).set("Authorization", `Bearer ${token}`);
    expect(busy.status).toBe(503);
    expect(busy.body).toMatchObject({ success: false, error: { code: "REPORTS_BUSY" } });

    holds.forEach((d) => d.resolve());
    await Promise.all(holders);
    const ok = await request(app).get(`${COST_SHEET_URL}?days=30`).set("Authorization", `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(sheetDiffs(ok.body.data, JSON.parse(JSON.stringify(await legacyCostSheet(30))))).toEqual([]);
  });
});

// ─────────────────────────────────── the pure group price ──────────────────────────────────

describe("costSheetGroupCostUsd: one group priced exactly as the sum of its rows", () => {
  const base: GroupLike = {
    provider: "openai",
    model: "gpt-4o-mini",
    operation: "entity-extraction",
    tokensNull: false,
    inputTokens: 3_000,
    outputTokens: 200,
    storedCostUsd: 7,
  };

  it("keeps the stored sum for an estimate, an unpriced or empty model, and a group with no token counts", () => {
    expect(costSheetGroupCostUsd({ ...base, operation: "entity-extraction-reconstructed" })).toBe(7);
    expect(costSheetGroupCostUsd({ ...base, model: "some-future-model" })).toBe(7);
    expect(costSheetGroupCostUsd({ ...base, model: "" })).toBe(7);
    expect(costSheetGroupCostUsd({ ...base, tokensNull: true, inputTokens: 0, outputTokens: 0 })).toBe(7);
  });

  it("prices a group with token counts from its token sums at the current table", () => {
    expect(costSheetGroupCostUsd(base)).toBe(llmCostUsd("gpt-4o-mini", 3_000, 200, 0));
  });

  it("equals Σ effectiveRowCostUsd over the rows, for groups of either input sign", () => {
    const rand = mulberry32(42);
    for (const model of ["gpt-4o-mini", "gemini-2.5-flash-lite", "deepseek-v4-flash", "claude-haiku-4-5"]) {
      for (const sign of [1, -1]) {
        const rows = Array.from({ length: 200 }, () => {
          const state = rand();
          const input = state < 0.8 ? sign * Math.floor(1 + rand() * 30_000) : null;
          const output = state < 0.4 || state >= 0.8 ? Math.floor(rand() * 500) : null;
          return { provider: "x", model, operation: "entity-extraction", inputTokens: input, outputTokens: input == null && output == null ? 1 : output, costUsd: rand() };
        });
        const perRow = rows.reduce((s, r) => s + effectiveRowCostUsd(r), 0);
        const group = costSheetGroupCostUsd({
          provider: "x",
          model,
          operation: "entity-extraction",
          tokensNull: false,
          inputTokens: rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
          outputTokens: rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
          storedCostUsd: rows.reduce((s, r) => s + r.costUsd, 0),
        });
        expect(Math.abs(group - perRow) / Math.abs(perRow), `${model} sign=${sign}`).toBeLessThan(1e-12);
      }
    }
  });
});
