/**
 * api_usage rollup: days older than the keep window collapse to one row per Cost Sheet
 * group, and the Cost Sheet must not be able to tell the difference.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import { getCostSheet, invalidateCostSheetCache, type CostSheet } from "../src/services/api-usage.service";
import {
  API_USAGE_ROLLUP_MARKER_KEY,
  rollupApiUsage,
  rollupApiUsageDay,
  runApiUsageRollupIfDue,
} from "../src/services/api-usage-rollup.service";

const NOW = new Date("2026-10-25T09:00:00.000Z");
const DAY_MS = 86_400_000;
const at = (daysAgo: number, hourUtc: number) => new Date(NOW.getTime() - daysAgo * DAY_MS + (hourUtc - 9) * 3_600_000);

/** The fixture: one OLD day (120 days back) with every row shape the Cost Sheet distinguishes,
 *  plus one RECENT day (10 days back) that must survive untouched. */
async function seed() {
  await prisma.apiUsage.createMany({
    data: [
      // priced LLM rows, same group — three calls that must sum
      { provider: "deepseek", model: "deepseek-v4-flash", operation: "extract", calls: 1, inputTokens: 1000, outputTokens: 10, costUsd: 0.0001428, createdAt: at(120, 2) },
      { provider: "deepseek", model: "deepseek-v4-flash", operation: "extract", calls: 1, inputTokens: 2000, outputTokens: 20, costUsd: 0.0002856, createdAt: at(120, 3) },
      { provider: "deepseek", model: "deepseek-v4-flash", operation: "extract", calls: 1, inputTokens: 3000, outputTokens: 30, costUsd: 0.0004284, createdAt: at(120, 4) },
      // a NEGATIVE input count: its own group (neg_input), must not pool with the three above
      { provider: "deepseek", model: "deepseek-v4-flash", operation: "extract", calls: 1, inputTokens: -5, outputTokens: 1, costUsd: 0, createdAt: at(120, 5) },
      // tokens_null rows (Meta Graph) — units null on one, 3 on the other; stored cost carries
      { provider: "meta", model: "", operation: "graph", calls: 1, units: null, costUsd: 0, createdAt: at(120, 6) },
      { provider: "meta", model: "", operation: "graph", calls: 2, units: 3, costUsd: 0, createdAt: at(120, 7) },
      // a reconstructed estimate: stays separate, keeps its stored cost
      { provider: "openai", model: "gpt-4o-mini", operation: "extract-reconstructed", calls: 1, costUsd: 0.01, createdAt: at(120, 8) },
      { provider: "openai", model: "gpt-4o-mini", operation: "extract-reconstructed", calls: 1, costUsd: 0.02, createdAt: at(120, 9) },
      // input null / output present: tokens_null=false, input contributes 0
      { provider: "youtube", model: "", operation: "channels.list", calls: 1, units: 1, inputTokens: null, outputTokens: 5, costUsd: 0, createdAt: at(120, 10) },
      // the recent day — inside the keep window, must stay row-for-row
      { provider: "deepseek", model: "deepseek-v4-flash", operation: "extract", calls: 1, inputTokens: 100, outputTokens: 1, costUsd: 0.00001, createdAt: at(10, 2) },
      { provider: "deepseek", model: "deepseek-v4-flash", operation: "extract", calls: 1, inputTokens: 200, outputTokens: 2, costUsd: 0.00002, createdAt: at(10, 3) },
    ],
  });
}

/** The Cost Sheet fields that are a pure function of the table (not of the clock). */
function tableDerived(sheet: CostSheet) {
  const { totalCostUsd, byProvider, byOperation, daily, trackingSince, hasReconstructed, estimatedHistoricalUsd } = sheet;
  return { totalCostUsd, byProvider, byOperation, daily, trackingSince, hasReconstructed, estimatedHistoricalUsd };
}

function expectSheetsEqual(a: CostSheet, b: CostSheet) {
  const x = tableDerived(a);
  const y = tableDerived(b);
  expect(y.totalCostUsd).toBeCloseTo(x.totalCostUsd, 9);
  expect(y.estimatedHistoricalUsd).toBeCloseTo(x.estimatedHistoricalUsd, 9);
  expect(y.trackingSince).toBe(x.trackingSince);
  expect(y.hasReconstructed).toBe(x.hasReconstructed);
  expect(y.byProvider.map((p) => [p.provider, p.calls, p.units, p.inputTokens, p.outputTokens])).toEqual(
    x.byProvider.map((p) => [p.provider, p.calls, p.units, p.inputTokens, p.outputTokens]),
  );
  y.byProvider.forEach((p, i) => expect(p.costUsd).toBeCloseTo(x.byProvider[i].costUsd, 9));
  expect(y.byOperation.map((o) => [o.provider, o.operation, o.calls])).toEqual(x.byOperation.map((o) => [o.provider, o.operation, o.calls]));
  y.byOperation.forEach((o, i) => expect(o.costUsd).toBeCloseTo(x.byOperation[i].costUsd, 9));
  expect(y.daily.map((d) => [d.date, d.calls])).toEqual(x.daily.map((d) => [d.date, d.calls]));
  y.daily.forEach((d, i) => expect(d.costUsd).toBeCloseTo(x.daily[i].costUsd, 9));
}

describe("api_usage rollup", () => {
  beforeEach(async () => {
    await prisma.apiUsage.deleteMany();
    await prisma.systemSetting.deleteMany({ where: { key: API_USAGE_ROLLUP_MARKER_KEY } });
    invalidateCostSheetCache();
  });

  it("collapses an old day to one row per Cost Sheet group and leaves the Cost Sheet identical", async () => {
    await seed();
    const before = await getCostSheet(365);
    expect(before.daily).toHaveLength(2);

    const result = await rollupApiUsage({ now: NOW });
    expect(result.days.map((d) => d.day)).toEqual([at(120, 2).toISOString().slice(0, 10)]);
    expect(result.rowsBefore).toBe(9);
    // groups: deepseek/extract (pos), deepseek/extract (neg), meta/graph, openai/reconstructed, youtube
    expect(result.rowsAfter).toBe(5);
    expect(await prisma.apiUsage.count()).toBe(5 + 2);

    invalidateCostSheetCache();
    const after = await getCostSheet(365);
    expectSheetsEqual(before, after);
  });

  it("stores exact sums, keeps NULL where every row was NULL, and the group's earliest created_at", async () => {
    await seed();
    const day = at(120, 2).toISOString().slice(0, 10);
    await rollupApiUsageDay(day);
    const rows = await prisma.apiUsage.findMany({
      where: { createdAt: { lt: at(100, 0) } },
      orderBy: [{ provider: "asc" }, { operation: "asc" }, { inputTokens: "asc" }],
    });
    expect(rows).toHaveLength(5);
    const pos = rows.find((r) => r.provider === "deepseek" && (r.inputTokens ?? 0) > 0)!;
    expect([pos.calls, pos.inputTokens, pos.outputTokens]).toEqual([3, 6000, 60]);
    expect(pos.costUsd).toBeCloseTo(0.0008568, 12);
    expect(pos.createdAt.toISOString()).toBe(at(120, 2).toISOString());
    const neg = rows.find((r) => r.provider === "deepseek" && (r.inputTokens ?? 0) < 0)!;
    expect([neg.calls, neg.inputTokens, neg.outputTokens]).toEqual([1, -5, 1]);
    const meta = rows.find((r) => r.provider === "meta")!;
    expect([meta.calls, meta.units, meta.inputTokens, meta.outputTokens]).toEqual([3, 3, null, null]);
    expect(meta.createdAt.toISOString()).toBe(at(120, 6).toISOString());
    const yt = rows.find((r) => r.provider === "youtube")!;
    expect([yt.units, yt.inputTokens, yt.outputTokens]).toEqual([1, null, 5]);
    const recon = rows.find((r) => r.provider === "openai")!;
    expect([recon.operation, recon.calls]).toEqual(["extract-reconstructed", 2]);
    expect(recon.costUsd).toBeCloseTo(0.03, 12);
  });

  it("never touches days inside the keep window and is a no-op the second time", async () => {
    await seed();
    await rollupApiUsage({ now: NOW });
    expect(await prisma.apiUsage.count({ where: { createdAt: { gte: at(11, 0) } } })).toBe(2);
    const again = await rollupApiUsage({ now: NOW });
    expect(again.days).toEqual([]);
    expect(await prisma.apiUsage.count()).toBe(7);
  });

  it("respects keepDays exactly: the cutoff day itself is kept row-for-row", async () => {
    await seed();
    // keepDays = 120 puts the fixture's old day ON the cutoff date → not rollable
    const r = await rollupApiUsage({ now: NOW, keepDays: 120 });
    expect(r.days).toEqual([]);
    expect(await prisma.apiUsage.count()).toBe(11);
  });

  it("runs only in the quiet IST window and once per IST day", async () => {
    await seed();
    const twoAmIst = new Date("2026-10-24T20:30:00.000Z");
    expect(await runApiUsageRollupIfDue({ now: twoAmIst })).toEqual({ status: "skipped", reason: "hours" });

    const fourTwentyIst = new Date("2026-10-24T22:50:00.000Z");
    const ran = await runApiUsageRollupIfDue({ now: fourTwentyIst });
    expect(ran.status).toBe("ran");
    const marker = await prisma.systemSetting.findUnique({ where: { key: API_USAGE_ROLLUP_MARKER_KEY } });
    expect(marker?.value).toBe("2026-10-25");

    expect(await runApiUsageRollupIfDue({ now: fourTwentyIst })).toEqual({ status: "skipped", reason: "done" });
  });
});
