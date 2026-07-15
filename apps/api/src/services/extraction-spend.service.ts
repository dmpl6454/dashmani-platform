import { prisma } from "@dashmani/db";
import { EXTRACTION_SPEND_CEILING_KEY, DEFAULT_EXTRACTION_SPEND_CEILING_USD } from "../constants/enrichment";

// UTC-day start (DeepSeek bills + reports in UTC; the ceiling is a per-UTC-day cap to
// match the provider's own daily boundary and the console's UTC usage view).
function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
}

/** Sum of recorded DeepSeek extraction cost since 00:00 UTC today. */
export async function getTodayDeepseekSpendUsd(): Promise<number> {
  const agg = await prisma.apiUsage.aggregate({
    _sum: { costUsd: true },
    where: { provider: "deepseek", createdAt: { gte: utcDayStart() } },
  });
  return agg._sum.costUsd ?? 0;
}

/** The configured hard daily ceiling (USD). Unset → default. */
export async function getSpendCeilingUsd(): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: EXTRACTION_SPEND_CEILING_KEY } });
  if (!row) return DEFAULT_EXTRACTION_SPEND_CEILING_USD;
  const n = Number(row.value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_EXTRACTION_SPEND_CEILING_USD;
}

/** True once today's DeepSeek spend has reached/exceeded the ceiling. */
export async function isSpendCeilingReached(): Promise<boolean> {
  const [spend, ceiling] = await Promise.all([getTodayDeepseekSpendUsd(), getSpendCeilingUsd()]);
  return spend >= ceiling;
}
