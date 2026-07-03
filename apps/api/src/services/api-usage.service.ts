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

export type UsageProvider = "openai" | "gemini" | "anthropic" | "meta" | "youtube";

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

/**
 * Aggregate recorded usage over the last `windowDays` into a Cost Sheet. Pure
 * read; never writes. All money is summed from the per-row costUsd captured at
 * write time (price-stable). The projection is a simple linear run-rate:
 * (total over window / windowDays) → per-day, ×30 → per-month.
 */
export async function getCostSheet(windowDays = 30): Promise<CostSheet> {
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
