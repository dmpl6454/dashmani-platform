import { prisma } from "@dashmani/db";
import { extractEntitiesFromContent } from "../services/entity-extraction.service";

const BATCH_CAP = 500;

export async function runEntityExtraction(): Promise<void> {
  const startedAt = Date.now();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[entity-extraction] ANTHROPIC_API_KEY not set — skipping run");
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
  console.log(
    `[entity-extraction] done in ${Date.now() - startedAt}ms — ${res.ok} ok, ${res.empty} empty, ${res.error} error; ${Math.max(0, remainingBefore - rows.length)} still pending after this run`
  );
}
