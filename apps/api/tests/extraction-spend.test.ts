import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@dashmani/db";
import { getTodayDeepseekSpendUsd, getSpendCeilingUsd, isSpendCeilingReached } from "../src/services/extraction-spend.service";
import { DEFAULT_EXTRACTION_SPEND_CEILING_USD, EXTRACTION_SPEND_CEILING_KEY } from "../src/constants/enrichment";

describe("extraction-spend service", () => {
  beforeEach(async () => {
    await prisma.apiUsage.deleteMany({ where: { provider: "deepseek" } });
    await prisma.systemSetting.deleteMany({ where: { key: EXTRACTION_SPEND_CEILING_KEY } });
  });
  afterAll(async () => {
    await prisma.apiUsage.deleteMany({ where: { provider: "deepseek" } });
  });

  it("getSpendCeilingUsd returns the default when unset", async () => {
    expect(await getSpendCeilingUsd()).toBe(DEFAULT_EXTRACTION_SPEND_CEILING_USD);
  });

  it("getSpendCeilingUsd returns the stored override", async () => {
    await prisma.systemSetting.create({ data: { key: EXTRACTION_SPEND_CEILING_KEY, value: "1.5" } });
    expect(await getSpendCeilingUsd()).toBe(1.5);
  });

  it("getTodayDeepseekSpendUsd sums only today's deepseek rows", async () => {
    await prisma.apiUsage.create({
      data: { provider: "deepseek", model: "deepseek-v4-flash", operation: "entity-extraction", calls: 1, inputTokens: 20000, outputTokens: 70, costUsd: 2.0 },
    });
    const spend = await getTodayDeepseekSpendUsd();
    expect(spend).toBeCloseTo(2.0, 6);
  });

  it("isSpendCeilingReached is true once today's spend >= ceiling", async () => {
    await prisma.systemSetting.create({ data: { key: EXTRACTION_SPEND_CEILING_KEY, value: "1.0" } });
    await prisma.apiUsage.create({
      data: { provider: "deepseek", model: "deepseek-v4-flash", operation: "entity-extraction", calls: 1, costUsd: 1.25 },
    });
    expect(await isSpendCeilingReached()).toBe(true);
  });

  it("isSpendCeilingReached is false when under ceiling", async () => {
    await prisma.systemSetting.create({ data: { key: EXTRACTION_SPEND_CEILING_KEY, value: "5.0" } });
    await prisma.apiUsage.create({
      data: { provider: "deepseek", model: "deepseek-v4-flash", operation: "entity-extraction", calls: 1, costUsd: 0.5 },
    });
    expect(await isSpendCeilingReached()).toBe(false);
  });
});
