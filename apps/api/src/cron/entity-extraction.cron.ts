import { prisma } from "@dashmani/db";
import { extractEntitiesFromContent } from "../services/entity-extraction.service";
import { ENRICHMENT_ENABLED_KEY } from "../constants/enrichment";

// Per-run cap. Default 1500 (was 500) to keep up with the new-link rate (~1.7k/day
// IG+FB) AND chip at any backlog: 1500 × 4 runs/day = 6,000/day capacity. Override
// with ENTITY_EXTRACTION_CAP for a one-off deep drain of a large backlog.
const BATCH_CAP = Number(process.env.ENTITY_EXTRACTION_CAP) || 1500;

export async function runEntityExtraction(): Promise<void> {
  const startedAt = Date.now();
  // Run if ANY provider is configured — extraction falls back Anthropic→OpenAI→Gemini-lite,
  // so a single out-of-credit/rate-limited provider no longer halts extraction.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY && !process.env.GOOGLE_GEMINI_API_KEY) {
    console.log("[entity-extraction] no LLM provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GEMINI_API_KEY) — skipping run");
    return;
  }
  // Admin-controlled kill-switch: this is the ONLY paid-per-token step in the whole
  // social-insights pipeline (follower sync, engagement-metric polling, and caption
  // harvesting are all free Graph/scraper calls that must keep running). While the
  // org is low on API credits, an admin can flip this off from /api-costs without a
  // deploy to stop the spend immediately. Absent key or any value other than the
  // literal string "false" = enabled (unchanged default behavior on a fresh deploy
  // where the key has never been set).
  const toggle = await prisma.systemSetting.findUnique({ where: { key: ENRICHMENT_ENABLED_KEY } });
  if (toggle?.value === "false") {
    console.log("[entity-extraction] disabled by admin toggle (enrichment.enabled=false) — skipping run");
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
