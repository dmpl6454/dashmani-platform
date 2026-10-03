// API-usage tracking for the admin Cost Sheet.
//
// recordApiUsage() is the single chokepoint every billable API call funnels
// through. It is FAIL-OPEN, fire-and-forget: a logging failure must NEVER affect
// (or even be awaited by) the underlying API call. Call it without `await`.
//
// Cost is computed from PRICES at write time and stored on the row, so a later
// price-table edit never retroactively rewrites history. Prices are easy to keep
// current — edit the table below. Unknown model/unit → cost 0 (the call is still
// COUNTED; only the dollar figure is unknown, and the Cost Sheet flags it).

import { prisma } from "@dashmani/db";
import { createSingleFlightMemo } from "../utils/single-flight-memo";
import { withHeavyQuerySlot } from "../utils/heavy-query";

/**
 * DeepSeek peak/valley multiplier. Peak hours (2× price) are UTC 01:00-04:00 and
 * 06:00-10:00 (inclusive of the start hour, exclusive of the end hour). Off-peak = 1×.
 * Applied to the standard rate in LLM_PRICES so recorded cost matches the real bill.
 * Verified from the DeepSeek console notice (2026-07-15).
 */
export function deepseekPeakMultiplier(when: Date): number {
  const h = when.getUTCHours();
  const inPeak = (h >= 1 && h < 4) || (h >= 6 && h < 10);
  return inPeak ? 2 : 1;
}

export type UsageProvider = "openai" | "gemini" | "anthropic" | "meta" | "youtube" | "deepseek";

// ── Price table (USD). Keep current; edit here when a provider changes pricing. ──
// LLM prices are per 1,000,000 tokens (input/output separately). Sourced from each
// provider's public pricing as of 2026-06. These are the models we actually call.
// inPerM = uncached input $/1M; cachedPerM = CACHED input $/1M; outPerM = output $/1M.
// PROMPT CACHING (verified against OpenAI's billed export 2026-06-27): our extraction
// prompt sends a large STABLE prefix (system + the known-entities list) on every call,
// with only the caption varying at the END — the ideal shape for auto-caching. OpenAI
// bills the cached prefix at HALF, so charging full rate overstated cost (~40% high:
// our 28,559 Jun-26 calls were $55.98 at full rate, but OpenAI billed $33.74 — an
// effective 60% of full, i.e. ~40% of input was cached). cachedPerM corrects this.
const LLM_PRICES: Record<string, { inPerM: number; cachedPerM: number; outPerM: number }> = {
  // OpenAI — cached input is HALF the uncached rate.
  "gpt-4o-mini": { inPerM: 0.15, cachedPerM: 0.075, outPerM: 0.6 },
  "gpt-4o": { inPerM: 2.5, cachedPerM: 1.25, outPerM: 10 },
  // Google Gemini flash-lite (Standard tier). Cached-input is $0.01/M — live-verified
  // from ai.google.dev/gemini-api/docs/pricing (2026-07). The old 0.025 was the 2.5
  // *Flash* rate, not Flash-Lite. NOTE (2026-07): a live probe proved the extraction
  // cron gets ZERO implicit-cache hits (Gemini returns no cachedContentTokenCount for
  // our mutating-prefix prompt), so in practice every input token is billed at the
  // full $0.10/M — cachedPerM only applies if a future call actually reports cache hits.
  "gemini-2.5-flash-lite": { inPerM: 0.1, cachedPerM: 0.01, outPerM: 0.4 },
  // Anthropic — we don't set cache_control, so no auto-cache (cached == full rate).
  "claude-haiku-4-5": { inPerM: 1.0, cachedPerM: 1.0, outPerM: 5.0 },
  "claude-haiku-4-5-20251001": { inPerM: 1.0, cachedPerM: 1.0, outPerM: 5.0 },
  "claude-sonnet-4-20250514": { inPerM: 3.0, cachedPerM: 3.0, outPerM: 15.0 },
  // DeepSeek V4-Flash (non-thinking) — the ACTIVE extraction provider (2026-07-15).
  // Cache-hit input $0.0028/M, cache-miss $0.14/M, output $0.28/M — OFFICIAL, from
  // api-docs.deepseek.com. Cache is on-disk, enabled by default, NO storage fee.
  // cachedPerM = the cache-HIT rate; we pass prompt_cache_hit_tokens as cachedTokens.
  // ⚠️ PEAK PRICING: DeepSeek charges 2× during UTC 01:00-04:00 and 06:00-10:00.
  // The table below is the STANDARD (off-peak) rate; the 2× multiplier is applied at
  // the call site (deepseekExtract) based on the request's UTC hour, so the recorded
  // cost matches the real bill regardless of when the cron ran.
  "deepseek-v4-flash": { inPerM: 0.14, cachedPerM: 0.0028, outPerM: 0.28 },
};

// Non-LLM per-unit prices (USD). Meta Graph + YouTube Data API are FREE within
// quota — the "cost" is quota consumption, not dollars. We still RECORD the calls
// (units) so the Cost Sheet can show usage volume and warn before a quota cliff,
// but the dollar cost is 0 unless a provider starts charging. Kept explicit so the
// intent ("free within quota") is documented, not implied.
const UNIT_PRICES: Record<UsageProvider, number> = {
  meta: 0, // Graph API: free within app rate limit (#4); usage = call count
  youtube: 0, // YouTube Data API: free within 10k units/day quota
  openai: 0,
  gemini: 0,
  anthropic: 0,
  deepseek: 0, // dollar cost flows through LLM_PRICES/llmCostUsd; unit fallback unused for token calls
};

/**
 * Compute USD cost for an LLM call. `cachedTokens` (a subset of inputTokens) is
 * billed at the cheaper cached rate; the rest of input at the full rate. Default 0
 * → behaves like before for callers that don't have the cached count.
 */
export function llmCostUsd(model: string, inputTokens: number, outputTokens: number, cachedTokens = 0): number {
  const p = LLM_PRICES[model];
  if (!p) return 0;
  const cached = Math.min(Math.max(0, cachedTokens), inputTokens);
  const uncached = inputTokens - cached;
  return (uncached / 1_000_000) * p.inPerM + (cached / 1_000_000) * p.cachedPerM + (outputTokens / 1_000_000) * p.outPerM;
}

// ── Display-layer truth recompute (2026-07) ──────────────────────────────────
// Historical api_usage rows stored a cost_usd computed at write time — but the
// Gemini extraction rows were booked at a WRONG effective rate (~$0.029/M instead
// of Google's real $0.10/M — a live probe proved the cron gets ZERO cache hits, so
// the stored cost is a ~3.5× under-count). Per the "forward-only + recompute
// display" decision, we DON'T rewrite the stored rows (they stay as an audit trail
// of what was booked); instead the Cost Sheet recomputes each row's cost from its
// raw token counts at the CURRENT, correct price table, at read time.
//
// Recompute rules (a row is only recomputed when we can price it token-accurately):
//  - '-reconstructed' estimate rows → keep stored cost (a labeled rough ceiling, not
//    token-accurate; recomputing an estimate would falsely present it as precise).
//  - known LLM model WITH token counts → recompute from tokens (the truth).
//  - unknown model, or no token counts (non-LLM meta/youtube, $0 within quota) →
//    keep stored cost (recompute can't price it → would zero-out a real figure).
export interface UsageRowForCost {
  provider: string;
  model: string;
  operation: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
}

export function effectiveRowCostUsd(row: UsageRowForCost): number {
  // Estimates are intentionally left as their labeled rough ceiling.
  if (row.operation.endsWith("-reconstructed")) return row.costUsd;
  // Only LLM token-priced rows are recomputable. No priceable model → keep stored.
  if (!(row.model in LLM_PRICES)) return row.costUsd;
  // No token counts recorded → can't recompute → keep stored.
  if (row.inputTokens == null && row.outputTokens == null) return row.costUsd;
  // Recompute from tokens. cachedTokens=0: we don't persist cached counts and the
  // cron gets no cache hits, so all input is billed uncached (the accurate figure).
  return llmCostUsd(row.model, row.inputTokens ?? 0, row.outputTokens ?? 0, 0);
}

export interface RecordUsageInput {
  provider: UsageProvider;
  operation: string;
  model?: string;
  calls?: number;
  units?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Cached input tokens (subset of inputTokens), billed at the cheaper cached rate.
   *  From OpenAI's usage.prompt_tokens_details.cached_tokens. Default 0. */
  cachedInputTokens?: number | null;
  /** Override the computed cost (rarely needed). If omitted, computed from prices. */
  costUsd?: number;
  /** Multiply the computed cost (e.g. DeepSeek 2× peak-hour surcharge). Default 1. */
  costMultiplier?: number;
}

/**
 * Record one billable API call (or batch). FAIL-OPEN: never throws, never blocks.
 * Do NOT await on the hot path — call it fire-and-forget:
 *   recordApiUsage({ provider: "openai", operation: "entity-extraction", model, inputTokens, outputTokens });
 */
export function recordApiUsage(input: RecordUsageInput): void {
  const model = input.model ?? "";
  const calls = input.calls ?? 1;
  const inputTokens = input.inputTokens ?? null;
  const outputTokens = input.outputTokens ?? null;

  let costUsd = input.costUsd;
  if (costUsd == null) {
    if (inputTokens != null || outputTokens != null) {
      costUsd = llmCostUsd(model, inputTokens ?? 0, outputTokens ?? 0, input.cachedInputTokens ?? 0);
      if (input.costMultiplier && input.costMultiplier !== 1) costUsd *= input.costMultiplier;
    } else {
      const unitPrice = UNIT_PRICES[input.provider] ?? 0;
      costUsd = (input.units ?? 0) * unitPrice;
    }
  }

  // Fire-and-forget. A failure to log usage must never surface to the caller.
  prisma.apiUsage
    .create({
      data: {
        provider: input.provider,
        model,
        operation: input.operation,
        calls,
        units: input.units ?? null,
        inputTokens,
        outputTokens,
        costUsd: costUsd ?? 0,
      },
    })
    .catch(() => {
      /* swallow — usage logging is best-effort and must not break the API call */
    });
}

// ── Cost Sheet aggregation (read side) ───────────────────────────────────────

export interface ProviderCost {
  provider: string;
  calls: number;
  units: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostSheet {
  windowDays: number;
  since: string; // ISO
  totalCostUsd: number;
  byProvider: ProviderCost[];
  byOperation: Array<{ provider: string; operation: string; calls: number; costUsd: number }>;
  daily: Array<{ date: string; costUsd: number; calls: number }>;
  // Forward projection from the observed daily run-rate over the window.
  projectedMonthlyUsd: number;
  projectedDailyUsd: number;
  // ── Horizon honesty (2026-06-27) ───────────────────────────────────────────
  // trackingSince = the earliest api_usage row's timestamp. If usage tracking is
  // younger than the requested window, the headline + projection must NOT pretend
  // to cover the full window. effectiveDays = the REAL elapsed span the numbers
  // cover (so the projection divides by real days, not the requested 30).
  trackingSince: string | null;
  effectiveDays: number;
  fullWindow: boolean; // true once tracking ≥ requested window (numbers cover it fully)
  // hasReconstructed = some rows are ESTIMATED (operation endsWith '-reconstructed'),
  // so the UI flags the figure as an estimate and points to provider billing consoles.
  hasReconstructed: boolean;
  // projectionReliable = false while a one-time backfill backlog is still DRAINING
  // (the extraction cron runs at catch-up speed, far above the true forward inflow),
  // so any forward projection measured now would OVERSTATE steady-state. When false,
  // the UI suppresses the dollar projection and explains why instead of presuming.
  projectionReliable: boolean;
  pendingExtractionBacklog: number; // captions captured but not yet tagged (drives the gate)
  // estimatedHistoricalUsd = reconstructed pre-tracking spend, a ROUGH CEILING that
  // overstates incident days (flat per-call rate × variable history + mixed providers).
  // Kept SEPARATE from totalCostUsd (measured) and clearly labeled in the UI.
  estimatedHistoricalUsd: number;
}

// ── One SQL aggregation, priced per group (incident 2026-10-03) ──────────────
// getCostSheet used to hydrate EVERY api_usage row in the window with an unbounded
// prisma.apiUsage.findMany and aggregate them in JS: 2,072,696 rows for 30 days on
// prod. Opening the API Costs page drove the API process to 1.2-1.76 GB; pm2's 800M
// cap and the kernel OOM killer restarted it 8 times (33 user-facing 502s), and the
// page's SWR retries re-triggered it after every restart.
//
// Postgres now does the summing in ONE grouped statement that returns one row per
// (provider, operation, model, UTC day, tokens_null, neg_input, recent) group — a few
// hundred rows a month, not millions — and JS prices each GROUP with the same
// functions that priced each row. Every output field is rebuilt exactly as before;
// tests/api-usage-cost-sheet-equivalence.test.ts runs the old row loop (verbatim) and
// this code on the same rows and requires integers equal, floats within 1e-9 relative
// and every array in the same order. ⚠️ Never reintroduce a findMany over api_usage
// here: the table gains ~80-97k rows a day.

/**
 * One row of the Cost Sheet's SQL aggregation: the api_usage rows in the window that
 * share every key below, summed by Postgres.
 */
export interface CostSheetGroup {
  provider: string;
  operation: string;
  model: string;
  /** UTC calendar date of created_at, "YYYY-MM-DD" (the old createdAt.toISOString().slice(0, 10)). */
  day: string;
  /** Every row has input_tokens AND output_tokens NULL. */
  tokensNull: boolean;
  /** Every row has a negative input_tokens (see costSheetGroupCostUsd). */
  negInput: boolean;
  /** Every row has created_at >= the steady-state projection's three-days-ago edge. */
  recent: boolean;
  rowCount: number;
  calls: number;
  /** sum(coalesce(units, 0)) */
  units: number;
  /** sum(coalesce(input_tokens, 0)) */
  inputTokens: number;
  /** sum(coalesce(output_tokens, 0)) */
  outputTokens: number;
  /** sum(cost_usd), the costs stored at write time */
  storedCostUsd: number;
  /** Epoch ms of the group's earliest row (orders groups by first appearance). */
  firstSeenMs: number;
}

/**
 * Price one group exactly as summing effectiveRowCostUsd over its rows would. It hands
 * the group's sums to effectiveRowCostUsd itself, so the two rule sets cannot drift:
 *  - a '-reconstructed' estimate, a model not in LLM_PRICES, or a group with no token
 *    counts keeps its stored cost — and each of its rows kept its own stored cost, so
 *    the group's is their sum;
 *  - anything else is llmCostUsd(model, Σinput, Σoutput, 0). That is linear in the
 *    token counts (cost of the sums = sum of the costs) with ONE kink: llmCostUsd clamps
 *    cached = min(max(0, cachedTokens), inputTokens), so a NEGATIVE input count is billed
 *    at the cached rate, not the full one. The SQL therefore never pools a negative
 *    input with a non-negative one (neg_input). Providers never report negative counts,
 *    but the column has no CHECK constraint.
 */
export function costSheetGroupCostUsd(
  group: Pick<CostSheetGroup, "provider" | "model" | "operation" | "tokensNull" | "inputTokens" | "outputTokens" | "storedCostUsd">,
): number {
  return effectiveRowCostUsd({
    provider: group.provider,
    model: group.model,
    operation: group.operation,
    inputTokens: group.tokensNull ? null : group.inputTokens,
    outputTokens: group.tokensNull ? null : group.outputTokens,
    costUsd: group.storedCostUsd,
  });
}

interface CostSheetGroupSqlRow {
  provider: string;
  operation: string;
  model: string;
  day: string;
  tokens_null: boolean;
  neg_input: boolean;
  recent: boolean;
  row_count: number;
  calls: bigint;
  units: bigint;
  input_tokens: bigint;
  output_tokens: bigint;
  cost_usd: number;
  first_seen: Date;
}

/**
 * A Postgres int8 sum as a JS number. Exact below 2^53 (9.0e15): these are per-group sums
 * of int4 columns (one provider/operation/model/day), many orders of magnitude below it.
 */
function sqlInt(value: bigint | number | null): number {
  return value == null ? 0 : Number(value);
}

/**
 * The ONE statement. Reads only the window's rows and returns one row per group.
 *
 * ⚠️ The window edges are `${date}::timestamptz AT TIME ZONE 'UTC'`, never a bare
 * `${date}`. created_at is timestamp(3) WITHOUT time zone holding UTC wall-clock time
 * (Prisma writes it in UTC even under a non-UTC session — verified). Prisma binds a JS Date
 * in $queryRaw as timestamptz, and Postgres compares timestamptz with that column through
 * the SESSION TimeZone, so a bare `created_at >= ${since}` moves the window by the
 * session's UTC offset (measured: empty under Asia/Kolkata, hours too wide under
 * America/Los_Angeles). findMany compared in UTC whatever the session said;
 * `AT TIME ZONE 'UTC'` reproduces that exactly. The created_at index stays usable.
 *
 * Plan cost: Prisma runs this as a cached prepared statement. Its first five executions
 * per connection get custom plans, where the edge folds to a constant; then Postgres
 * switches to a generic plan (verified: generic=3 custom=5 after eight runs), where
 * `recent` re-evaluates the conversion for every row. Measured on 2.07M rows: ~1.0 s
 * custom, ~1.2 s generic. A scalar sub-SELECT (InitPlan) edge was measured too: a flat
 * ~1.1 s in both modes. That is not a clear win, so the simpler form stays.
 *
 * The day key is created_at::date, the wall-clock date of a timestamp without time zone,
 * so no TimeZone is involved. It is formatted through ::timestamp, because
 * to_char(date, ...) would resolve to the timestamptz overload.
 */
async function queryCostSheetGroups(since: Date, threeDaysAgo: Date): Promise<CostSheetGroup[]> {
  const rows = await prisma.$queryRaw<CostSheetGroupSqlRow[]>`
    SELECT
      provider,
      operation,
      model,
      to_char(utc_day::timestamp, 'YYYY-MM-DD') AS day,
      tokens_null,
      neg_input,
      recent,
      count(*)::int                             AS row_count,
      sum(calls)::bigint                        AS calls,
      sum(coalesce(units, 0))::bigint           AS units,
      sum(coalesce(input_tokens, 0))::bigint    AS input_tokens,
      sum(coalesce(output_tokens, 0))::bigint   AS output_tokens,
      sum(cost_usd)::float8                     AS cost_usd,
      min(created_at)                           AS first_seen
    FROM (
      SELECT
        provider,
        operation,
        model,
        calls,
        units,
        input_tokens,
        output_tokens,
        cost_usd,
        created_at,
        created_at::date                                                AS utc_day,
        (input_tokens IS NULL AND output_tokens IS NULL)                AS tokens_null,
        coalesce(input_tokens < 0, false)                               AS neg_input,
        created_at >= (${threeDaysAgo}::timestamptz AT TIME ZONE 'UTC') AS recent
      FROM api_usage
      WHERE created_at >= (${since}::timestamptz AT TIME ZONE 'UTC')
    ) AS usage_in_window
    GROUP BY provider, operation, model, utc_day, tokens_null, neg_input, recent
  `;
  return rows.map((r) => ({
    provider: r.provider,
    operation: r.operation,
    model: r.model,
    day: r.day,
    tokensNull: r.tokens_null,
    negInput: r.neg_input,
    recent: r.recent,
    rowCount: sqlInt(r.row_count),
    calls: sqlInt(r.calls),
    units: sqlInt(r.units),
    inputTokens: sqlInt(r.input_tokens),
    outputTokens: sqlInt(r.output_tokens),
    storedCostUsd: Number(r.cost_usd),
    firstSeenMs: r.first_seen.getTime(),
  }));
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Groups in order of first appearance. The old loop walked findMany's rows in the heap's
 * physical order (no ORDER BY), which on this append-only table is chronological, so each
 * Map received its keys in order of FIRST APPEARANCE — and the final stable sorts broke
 * cost ties (every $0 Meta/YouTube entry ties) by that order. Feeding the same Maps the
 * groups earliest-first reproduces it. The key comparison only decides between firsts in
 * the same millisecond, where the old order was the heap's, i.e. arbitrary; here it is
 * deterministic.
 */
function compareByFirstSeen(a: CostSheetGroup, b: CostSheetGroup): number {
  return (
    a.firstSeenMs - b.firstSeenMs ||
    compareText(a.provider, b.provider) ||
    compareText(a.operation, b.operation) ||
    compareText(a.model, b.model) ||
    compareText(a.day, b.day) ||
    Number(a.tokensNull) - Number(b.tokensNull) ||
    Number(a.negInput) - Number(b.negInput) ||
    Number(a.recent) - Number(b.recent)
  );
}

// ── 60 s single-flight memo + heavy-query bulkhead ───────────────────────────
// The memo is keyed by the clamped window, so a burst of page loads and SWR retries
// shares ONE compute and repeats inside the TTL cost nothing. The bulkhead sits INSIDE
// the memo, around the raw compute only — the contract in utils/heavy-query.ts and the
// pattern of top-posts, insights and submission-gaps:
//   • a memo hit never waits for, or holds, one of the 2 heavy-query slots. Taken in the
//     route around the memoised call, every hit would queue behind genuine heavy
//     computes and could 503 with nothing to compute;
//   • concurrent cold callers share ONE compute and therefore ONE slot. In the route,
//     each caller would take its own slot while awaiting the same promise — two of them
//     would hold both slots for one query and stall every other heavy reader.
// Past HEAVY_QUERY_MAX_WAIT_MS a queued compute rejects with 503 REPORTS_BUSY (the route
// passes it to the error handler); the memo evicts a rejected promise at once, so a
// failure is never served from cache.
const COST_SHEET_TTL_MS = 60_000;
// The page offers four windows (7/14/30/90). Hitting the cap costs one extra cold compute.
const costSheetMemo = createSingleFlightMemo({ ttlMs: COST_SHEET_TTL_MS, maxEntries: 16 });

/** Tests only. Module-level caches are the documented cross-test pollution class: every
 *  test file that calls getCostSheet must call this in beforeEach. */
export function invalidateCostSheetCache(): void {
  costSheetMemo.clear();
}

/**
 * Aggregate recorded usage over the last `windowDays` into a Cost Sheet. Pure read; never
 * writes. Money is recomputed per group from the stored token counts at the current price
 * table (see effectiveRowCostUsd / costSheetGroupCostUsd). The projection is the recent
 * steady-state daily rate ×30, gated by projectionReliable.
 */
export function getCostSheet(windowDays = 30): Promise<CostSheet> {
  const days = Math.max(1, Math.min(365, windowDays));
  return costSheetMemo.memo(String(days), () => withHeavyQuerySlot("cost-sheet", () => computeCostSheet(days)));
}

async function computeCostSheet(days: number): Promise<CostSheet> {
  // One clock reading for the whole sheet. The window start and the 3-day steady-state
  // edge are bound into the single aggregation, and effectiveDays reads the same instant.
  // (The old code read the clock again after its queries; effectiveDays only differs by
  // that query time, and only while tracking is younger than the window.)
  const now = Date.now();
  const since = new Date(now - days * 24 * 60 * 60 * 1000);
  const THREE_DAYS_AGO = new Date(now - 3 * 86400_000);

  const groups = await queryCostSheetGroups(since, THREE_DAYS_AGO);
  groups.sort(compareByFirstSeen);

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
  // The steady-state inputs: non-reconstructed rows with createdAt >= THREE_DAYS_AGO.
  // `recent` is a group key, so every group is entirely in or entirely out.
  let recentForwardRows = 0;
  let recentForwardCost = 0;
  const recentForwardDays = new Set<string>();

  for (const g of groups) {
    // TRUTH RECOMPUTE: use the token-accurate cost at the CURRENT price table, not
    // the (possibly stale/buggy) cost_usd stored at write time. Estimates + non-LLM +
    // unknown-model groups fall through to their stored value (see costSheetGroupCostUsd).
    const cost = costSheetGroupCostUsd(g);
    const isReconstructed = g.operation.endsWith("-reconstructed");
    if (isReconstructed) estimatedHistoricalUsd += cost;
    else totalCostUsd += cost;

    const pv = byProviderMap.get(g.provider) ?? { provider: g.provider, calls: 0, units: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    pv.calls += g.calls;
    pv.units += g.units;
    pv.inputTokens += g.inputTokens;
    pv.outputTokens += g.outputTokens;
    pv.costUsd += cost;
    byProviderMap.set(g.provider, pv);

    const opKey = `${g.provider}:${g.operation}`;
    const op = byOpMap.get(opKey) ?? { provider: g.provider, operation: g.operation, calls: 0, costUsd: 0 };
    op.calls += g.calls;
    op.costUsd += cost;
    byOpMap.set(opKey, op);

    const d = dailyMap.get(g.day) ?? { date: g.day, costUsd: 0, calls: 0 };
    d.costUsd += cost;
    d.calls += g.calls;
    dailyMap.set(g.day, d);

    if (!isReconstructed && g.recent && g.rowCount > 0) {
      recentForwardRows += g.rowCount;
      recentForwardCost += cost;
      recentForwardDays.add(g.day);
    }
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
  const trackedMs = trackingSince ? now - trackingSince.getTime() : days * 86400_000;
  const effectiveDays = Math.max(1 / 24, Math.min(days, trackedMs / 86400_000)); // ≥1h, ≤window
  const fullWindow = !!trackingSince && trackedMs >= days * 86400_000;

  // Steady-state daily rate: the trailing 3 days of NON-reconstructed (i.e.
  // organically-recorded, forward) cost — already the recomputed (truth) cost — over the
  // number of those days that have data.
  const recentDaysWithData = recentForwardDays.size || 1;
  // If we have organic forward data, project from it (the true go-forward rate).
  // Otherwise fall back to the horizon-honest window rate (total / real elapsed days).
  const steadyDailyUsd = recentForwardRows > 0 ? recentForwardCost / recentDaysWithData : totalCostUsd / effectiveDays;

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
