import { describe, it, expect, afterEach } from "vitest";
import { parseOpenAiCosts, fetchOpenAiBilling, __setOpenAiFetchForTesting } from "../src/services/openai-costs.service";

// Fixture mirrors the REAL OpenAI Costs API / export shape (cost_*.json the owner
// provided): buckets with results[].amount.value, project_id, api_key_id.
const FIXTURE = [
  {
    object: "bucket",
    start_time: 1782432000, // 2026-06-26
    end_time: 1782518400,
    results: [
      { object: "organization.costs.result", amount: { value: "33.74420185", currency: "usd" }, project_id: "proj_X", api_key_id: "key_Se5i65WfDSLziD3P", line_item: null },
    ],
  },
  {
    object: "bucket",
    start_time: 1782518400, // 2026-06-27
    end_time: 1782604800,
    results: [
      { object: "organization.costs.result", amount: { value: "8.6672562", currency: "usd" }, project_id: "proj_X", api_key_id: "key_Se5i65WfDSLziD3P", line_item: null },
    ],
  },
];

afterEach(() => __setOpenAiFetchForTesting(null));

describe("parseOpenAiCosts", () => {
  it("sums billed amounts across buckets to the authoritative total", () => {
    const r = parseOpenAiCosts(FIXTURE, 2);
    expect(r.available).toBe(true);
    expect(r.totalUsd).toBeCloseTo(33.74420185 + 8.6672562, 6); // = 42.41145805
    expect(r.daily).toHaveLength(2);
  });

  it("produces a sorted daily series with correct per-day totals", () => {
    const r = parseOpenAiCosts(FIXTURE, 2);
    expect(r.daily[0].date).toBe("2026-06-26");
    expect(r.daily[0].costUsd).toBeCloseTo(33.74420185, 6);
    expect(r.daily[1].date).toBe("2026-06-27");
    expect(r.daily[1].costUsd).toBeCloseTo(8.6672562, 6);
  });

  it("breaks down by project/key (future-proof: a dedicated key would isolate here)", () => {
    const r = parseOpenAiCosts(FIXTURE, 2);
    expect(r.byProject).toHaveLength(1);
    expect(r.byProject[0].apiKeyId).toBe("key_Se5i65WfDSLziD3P");
    expect(r.byProject[0].costUsd).toBeCloseTo(42.41145805, 6);
  });

  it("reports the earliest bucket as `since`", () => {
    expect(parseOpenAiCosts(FIXTURE, 2).since).toBe("2026-06-26");
  });
});

describe("fetchOpenAiBilling", () => {
  it("DARK: no admin key → available:false, NO network call", async () => {
    const prev = process.env.OPENAI_ADMIN_KEY;
    delete process.env.OPENAI_ADMIN_KEY;
    let called = false;
    __setOpenAiFetchForTesting((async () => { called = true; return new Response("{}"); }) as typeof fetch);
    const r = await fetchOpenAiBilling(30);
    expect(r.available).toBe(false);
    expect(called).toBe(false);
    if (prev) process.env.OPENAI_ADMIN_KEY = prev;
  });

  it("FAIL-OPEN: non-200 → available:false (never throws)", async () => {
    process.env.OPENAI_ADMIN_KEY = "sk-admin-test";
    __setOpenAiFetchForTesting((async () => new Response("nope", { status: 401 })) as typeof fetch);
    const r = await fetchOpenAiBilling(30);
    expect(r.available).toBe(false);
    expect(r.reason).toContain("401");
    delete process.env.OPENAI_ADMIN_KEY;
  });

  it("parses a successful Costs API response into the authoritative total", async () => {
    process.env.OPENAI_ADMIN_KEY = "sk-admin-test";
    __setOpenAiFetchForTesting((async () =>
      new Response(JSON.stringify({ data: FIXTURE, has_more: false, next_page: null }), { status: 200 })) as typeof fetch);
    const r = await fetchOpenAiBilling(2);
    expect(r.available).toBe(true);
    expect(r.totalUsd).toBeCloseTo(42.41145805, 6);
    delete process.env.OPENAI_ADMIN_KEY;
  });
});
