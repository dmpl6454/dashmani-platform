/**
 * entity-extraction-cron.test.ts — admin kill-switch gate for runEntityExtraction().
 *
 * Context: entity extraction is the only PAID (per-token LLM) step in the social-
 * insights pipeline — follower sync, engagement-metric polling, and caption
 * harvesting are all free Graph/scraper calls and must keep running regardless.
 * While the org is low on API credits, an admin needs to be able to pause just
 * this spend from /api-costs, without a deploy. The gate reads a system_settings
 * row keyed "enrichment.enabled" — value "false" disables, anything else (or the
 * row being absent entirely) means enabled, matching pre-existing behavior.
 *
 * Follows the mocked-prisma convention from social-insights-cron.test.ts (this is
 * a cron-level control-flow test, not a DB-record-behavior test — that's already
 * covered by entity-extraction.test.ts's real-DB tests for extractEntitiesFromContent).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock prisma before importing the cron ──────────────────────────────────

const findUniqueMock = vi.fn();
const findManyMock = vi.fn();
const countMock = vi.fn();
const aggregateMock = vi.fn();

vi.mock("@dashmani/db", () => ({
  prisma: {
    systemSetting: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
    },
    linkContent: {
      findMany: (...args: unknown[]) => findManyMock(...args),
      count: (...args: unknown[]) => countMock(...args),
    },
    apiUsage: {
      aggregate: (...args: unknown[]) => aggregateMock(...args),
    },
  },
}));

const extractEntitiesFromContentMock = vi.fn();
vi.mock("../src/services/entity-extraction.service", () => ({
  extractEntitiesFromContent: (...args: unknown[]) => extractEntitiesFromContentMock(...args),
}));

import { runEntityExtraction } from "../src/cron/entity-extraction.cron";
import { ENRICHMENT_ENABLED_KEY } from "../src/constants/enrichment";

describe("runEntityExtraction — admin enrichment toggle gate", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, DEEPSEEK_API_KEY: "sk-test" };
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);
    aggregateMock.mockResolvedValue({ _sum: { costUsd: 0 } }); // today's deepseek spend = $0 → under ceiling
    // findUniqueMock is used for BOTH the enrichment toggle key AND the spend-ceiling key.
    // Default it to null (toggle enabled, ceiling defaults) unless a test overrides.
    findUniqueMock.mockResolvedValue(null);
  });

  it("skips the run — no linkContent query, no LLM call — when enrichment.enabled='false'", async () => {
    findUniqueMock.mockResolvedValue({ key: ENRICHMENT_ENABLED_KEY, value: "false" });

    await runEntityExtraction();

    // Asserts the cron reads the SAME shared constant the route imports (../src/constants/enrichment) —
    // guards against the two call sites drifting onto different literal key strings.
    expect(findUniqueMock).toHaveBeenCalledWith({ where: { key: ENRICHMENT_ENABLED_KEY } });
    expect(findManyMock).not.toHaveBeenCalled();
    expect(extractEntitiesFromContentMock).not.toHaveBeenCalled();
  });

  it("runs normally when the key is absent (default enabled) — critical: a fresh deploy must not silently disable extraction", async () => {
    findUniqueMock.mockResolvedValue(null);
    findManyMock.mockResolvedValue([{ id: "c1", title: null, caption: "hello" }]);
    countMock.mockResolvedValue(1);
    extractEntitiesFromContentMock.mockResolvedValue({ ok: 1, empty: 0, error: 0, retry: 0 });

    await runEntityExtraction();

    expect(findManyMock).toHaveBeenCalled();
    expect(extractEntitiesFromContentMock).toHaveBeenCalled();
  });

  it("runs normally when the key is explicitly 'true'", async () => {
    findUniqueMock.mockResolvedValue({ key: ENRICHMENT_ENABLED_KEY, value: "true" });
    findManyMock.mockResolvedValue([{ id: "c1", title: null, caption: "hello" }]);
    countMock.mockResolvedValue(1);
    extractEntitiesFromContentMock.mockResolvedValue({ ok: 1, empty: 0, error: 0, retry: 0 });

    await runEntityExtraction();

    expect(findManyMock).toHaveBeenCalled();
    expect(extractEntitiesFromContentMock).toHaveBeenCalled();
  });

  it("still short-circuits on the pre-existing no-provider-configured gate even when the toggle is enabled", async () => {
    process.env = { ...OLD_ENV };
    delete process.env.DEEPSEEK_API_KEY;

    await runEntityExtraction();

    // Never even reaches the toggle check — the provider gate returns first.
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("skips the run when today's deepseek spend has reached the ceiling", async () => {
    // DEEPSEEK_API_KEY is set in beforeEach. Toggle enabled (findUnique null for the toggle key).
    // spend-ceiling key → "0.01"; today's spend aggregate → $5 (over ceiling).
    findUniqueMock.mockImplementation(({ where }: { where: { key: string } }) =>
      where.key === "extraction.spendCeilingUsd" ? { key: where.key, value: "0.01" } : null,
    );
    aggregateMock.mockResolvedValue({ _sum: { costUsd: 5 } }); // over the $0.01 ceiling

    await runEntityExtraction();

    // Ceiling reached → cron returns before querying pending rows or extracting.
    expect(findManyMock).not.toHaveBeenCalled();
    expect(extractEntitiesFromContentMock).not.toHaveBeenCalled();
  });
});
