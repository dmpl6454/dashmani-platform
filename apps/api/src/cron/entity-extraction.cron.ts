import { prisma } from "@dashmani/db";
import { extractEntitiesFromContent } from "../services/entity-extraction.service";

// Per-run cap. Default 1500 (was 500) to keep up with the new-link rate (~1.7k/day
// IG+FB) AND chip at any backlog: 1500 × 4 runs/day = 6,000/day capacity. Override
// with ENTITY_EXTRACTION_CAP for a one-off deep drain of a large backlog.
const BATCH_CAP = Number(process.env.ENTITY_EXTRACTION_CAP) || 1500;

export async function runEntityExtraction(): Promise<void> {
  const startedAt = Date.now();
  // Run if EITHER provider is configured — extraction now falls back Anthropic→OpenAI,
  // so an out-of-credit/rate-limited Anthropic key no longer halts extraction.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.log("[entity-extraction] no LLM provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY) — skipping run");
    return;
  }
  // Idempotent selector: only rows with text fetched (status=ok) and not yet extracted.
  const rows = await prisma.linkContent.findMany({
    where: { status: "ok", extractedAt: null },
    select: { id: true, title: true, caption: true },
    take: BATCH_CAP,
    orderBy: { fetchedAt: "asc" },
  });
  if (rows.length === 0) {
    console.log("[entity-extraction] nothing to extract");
    return;
  }
  const remainingBefore = await prisma.linkContent.count({ where: { status: "ok", extractedAt: null } });
  console.log(`[entity-extraction] processing ${rows.length} of ${remainingBefore} pending (cap ${BATCH_CAP})`);
  const res = await extractEntitiesFromContent(rows);
  // `retry` rows stayed pristine (transient failure) → they remain pending and will be
  // re-attempted next run. `error` rows were terminally marked (extractedAt stamped,
  // status kept 'ok') → they leave the queue but stay searchable. Pending-after counts
  // the retry rows back in (they didn't advance).
  const stillPending = Math.max(0, remainingBefore - rows.length) + res.retry;
  console.log(
    `[entity-extraction] done in ${Date.now() - startedAt}ms — ${res.ok} ok, ${res.empty} empty, ${res.error} error, ${res.retry} retry; ${stillPending} still pending after this run`
  );
}
