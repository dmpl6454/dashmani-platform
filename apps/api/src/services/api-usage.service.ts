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
const LLM_PRICES: Record<string, { inPerM: number; outPerM: number }> = {
  // OpenAI — primary extraction model + any ai.service usage.
  "gpt-4o-mini": { inPerM: 0.15, outPerM: 0.6 },
  "gpt-4o": { inPerM: 2.5, outPerM: 10 },
  // Google Gemini — extraction fallback (lite only, per the no-break rule).
  "gemini-2.5-flash-lite": { inPerM: 0.1, outPerM: 0.4 },
  // Anthropic — extraction fallback (Haiku) + ai.service doc generators (Sonnet).
  "claude-haiku-4-5": { inPerM: 1.0, outPerM: 5.0 },
  "claude-haiku-4-5-20251001": { inPerM: 1.0, outPerM: 5.0 },
  "claude-sonnet-4-20250514": { inPerM: 3.0, outPerM: 15.0 },
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

/** Compute USD cost for an LLM call from token counts + the price table. */
export function llmCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = LLM_PRICES[model];
  if (!p) return 0;
  return (inputTokens / 1_000_000) * p.inPerM + (outputTokens / 1_000_000) * p.outPerM;
}

export interface RecordUsageInput {
  provider: UsageProvider;
  operation: string;
  model?: string;
  calls?: number;
  units?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
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
      costUsd = llmCostUsd(model, inputTokens ?? 0, outputTokens ?? 0);
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
      operation: true,
      calls: true,
      units: true,
      inputTokens: true,
      outputTokens: true,
      costUsd: true,
      createdAt: true,
    },
  });

  const byProviderMap = new Map<string, ProviderCost>();
  const byOpMap = new Map<string, { provider: string; operation: string; calls: number; costUsd: number }>();
  const dailyMap = new Map<string, { date: string; costUsd: number; calls: number }>();
  let totalCostUsd = 0;

  for (const r of rows) {
    totalCostUsd += r.costUsd;

    const pv = byProviderMap.get(r.provider) ?? { provider: r.provider, calls: 0, units: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    pv.calls += r.calls;
    pv.units += r.units ?? 0;
    pv.inputTokens += r.inputTokens ?? 0;
    pv.outputTokens += r.outputTokens ?? 0;
    pv.costUsd += r.costUsd;
    byProviderMap.set(r.provider, pv);

    const opKey = `${r.provider}:${r.operation}`;
    const op = byOpMap.get(opKey) ?? { provider: r.provider, operation: r.operation, calls: 0, costUsd: 0 };
    op.calls += r.calls;
    op.costUsd += r.costUsd;
    byOpMap.set(opKey, op);

    const dateKey = r.createdAt.toISOString().slice(0, 10);
    const d = dailyMap.get(dateKey) ?? { date: dateKey, costUsd: 0, calls: 0 };
    d.costUsd += r.costUsd;
    d.calls += r.calls;
    dailyMap.set(dateKey, d);
  }

  const projectedDailyUsd = totalCostUsd / days;
  return {
    windowDays: days,
    since: since.toISOString(),
    totalCostUsd,
    byProvider: [...byProviderMap.values()].sort((a, b) => b.costUsd - a.costUsd),
    byOperation: [...byOpMap.values()].sort((a, b) => b.costUsd - a.costUsd),
    daily: [...dailyMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    projectedDailyUsd,
    projectedMonthlyUsd: projectedDailyUsd * 30,
  };
}
