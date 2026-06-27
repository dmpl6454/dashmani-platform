/**
 * One-off: reconstruct HISTORICAL api_usage from durable evidence.
 *
 * WHY: the api_usage ledger only began recording when the table was created
 * (2026-06-27). Every API call BEFORE that — ~40k LLM extraction calls, the FB/IG
 * caption backfills, ~338k Meta/YouTube metric fetches, weeks of crons — was never
 * logged, so the Cost Sheet's "last 30 days" showed only minutes of data (~$4 vs a
 * real ~$80-120). This backfills the gap from records that DO carry historical
 * timestamps, so the 30-day view reflects reality.
 *
 * SOURCES (each row = at least one real API call, stamped at its real time):
 *   • link_content.extracted_at  → one LLM extraction call (entity-extraction).
 *   • link_metrics.fetched_at    → one external metric fetch (youtube/meta).
 *
 * ESTIMATION (clearly labeled — these are RECONSTRUCTED, not measured):
 *   • LLM cost uses the MEASURED average tokens/call from the real (post-table)
 *     api_usage rows, at gpt-4o-mini rates (the deployed PRIMARY + the funded key;
 *     Anthropic was out of credit for the window — its attempts 400'd at $0 — and
 *     Gemini served a minority). So this is a FLOOR-to-typical OpenAI estimate.
 *   • Meta/YouTube are free within quota → cost 0; only call VOLUME is reconstructed.
 *   • operation gets a "-reconstructed" suffix so estimated rows are distinguishable
 *     from precisely-measured ones in the by-operation breakdown.
 *
 * ⚠️ The AUTHORITATIVE spend is each provider's billing console. This reconstruction
 * is the best estimate from our own data; the UI says so.
 *
 * SAFETY: DRY-RUN default; --apply to write. Idempotent — it first DELETES any prior
 * "-reconstructed" rows in the window, then re-inserts, so re-running can't double-count.
 * Bounded to a window (default 30 days) via --days=N.
 *
 * Usage:
 *   cd packages/db && npx tsx ../../scripts/backfill-api-usage.ts            # dry-run, 30d
 *   cd packages/db && npx tsx ../../scripts/backfill-api-usage.ts --apply
 *   cd packages/db && npx tsx ../../scripts/backfill-api-usage.ts --apply --days=45
 */

import { prisma } from "@dashmani/db";
import { llmCostUsd } from "../apps/api/src/services/api-usage.service";

const APPLY = process.argv.includes("--apply");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1]) || 30;

// gpt-4o-mini fallback token averages if there's no measured sample yet.
const FALLBACK_IN = 12893;
const FALLBACK_OUT = 33;
const OPENAI_MODEL = "gpt-4o-mini";

async function main() {
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  console.log(`\nbackfill-api-usage — mode: ${APPLY ? "APPLY" : "DRY-RUN"}  window: ${DAYS}d (since ${since.toISOString()})`);

  // 1. Measured token average from the REAL (post-table) extraction rows.
  const measured = await prisma.apiUsage.aggregate({
    where: { provider: "openai", operation: "entity-extraction", inputTokens: { not: null } },
    _avg: { inputTokens: true, outputTokens: true },
    _count: { _all: true },
  });
  const avgIn = Math.round(measured._avg.inputTokens ?? FALLBACK_IN);
  const avgOut = Math.round(measured._avg.outputTokens ?? FALLBACK_OUT);
  console.log(`measured token avg (from ${measured._count._all} real rows): in=${avgIn} out=${avgOut}`);

  // 2. Historical extraction calls = link_content rows extracted in-window, MINUS the
  //    ones already precisely recorded in api_usage (so we don't double-count the last
  //    ~hour). We reconstruct one estimated row per extracted caption, stamped at
  //    extracted_at, that ISN'T already covered by a real api_usage row.
  const realExtractionRows = measured._count._all; // precisely-recorded extraction calls
  const extracted = await prisma.linkContent.findMany({
    where: { extractedAt: { gte: since } },
    select: { id: true, extractedAt: true },
    orderBy: { extractedAt: "asc" },
  });
  // The most-recent `realExtractionRows` extractions are already in api_usage; reconstruct the rest.
  const toReconstruct = extracted.slice(0, Math.max(0, extracted.length - realExtractionRows));
  console.log(`extracted in window: ${extracted.length}; already-recorded: ${realExtractionRows}; to reconstruct: ${toReconstruct.length}`);

  // 3. Historical metric fetches by platform (one external call each), in-window.
  const metrics = await prisma.linkMetric.groupBy({
    by: ["platform"],
    where: { fetchedAt: { gte: since } },
    _count: { _all: true },
  });
  for (const m of metrics) console.log(`  metric fetches [${m.platform}]: ${m._count._all}`);

  const perCallCost = llmCostUsd(OPENAI_MODEL, avgIn, avgOut);
  const estExtractionCost = toReconstruct.length * perCallCost;
  console.log(`\nestimated reconstructed extraction cost: $${estExtractionCost.toFixed(2)} (${toReconstruct.length} calls × $${perCallCost.toFixed(6)})`);

  if (!APPLY) {
    console.log("\nDRY-RUN — no rows written. Re-run with --apply.");
    await prisma.$disconnect();
    return;
  }

  // 4. Idempotent: clear prior reconstructed rows in-window, then re-insert.
  const del = await prisma.apiUsage.deleteMany({
    where: { operation: { endsWith: "-reconstructed" }, createdAt: { gte: since } },
  });
  console.log(`cleared ${del.count} prior reconstructed rows`);

  // LLM extraction rows — batched createMany, stamped at the real extracted_at.
  const llmRows = toReconstruct.map((r) => ({
    provider: "openai",
    model: OPENAI_MODEL,
    operation: "entity-extraction-reconstructed",
    calls: 1,
    inputTokens: avgIn,
    outputTokens: avgOut,
    costUsd: perCallCost,
    createdAt: r.extractedAt!,
  }));
  // Insert in chunks to stay well under any statement limit.
  const CHUNK = 5000;
  let inserted = 0;
  for (let i = 0; i < llmRows.length; i += CHUNK) {
    const res = await prisma.apiUsage.createMany({ data: llmRows.slice(i, i + CHUNK) });
    inserted += res.count;
  }
  console.log(`inserted ${inserted} reconstructed extraction rows`);

  // Meta/YouTube volume — ONE aggregate row per platform (free, $0), stamped now-ish
  // but dated within the window via createdAt = since (so it shows in the window).
  // (Per-call timestamps for 338k metric rows would bloat the table; an aggregate is
  // the honest volume signal for free-quota providers.)
  for (const m of metrics) {
    const provider = m.platform === "youtube" ? "youtube" : "meta";
    await prisma.apiUsage.create({
      data: {
        provider,
        operation: `metric-fetch-reconstructed`,
        calls: m._count._all,
        units: m._count._all,
        costUsd: 0,
        createdAt: since,
      },
    });
  }
  console.log(`inserted ${metrics.length} reconstructed metric-volume rows`);

  console.log(`\n=== done === reconstructed ~$${estExtractionCost.toFixed(2)} of historical LLM spend + ${metrics.reduce((n, m) => n + m._count._all, 0).toLocaleString()} free metric calls`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("backfill-api-usage failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
