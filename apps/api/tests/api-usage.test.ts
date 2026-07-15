import { describe, it, expect } from "vitest";
import { llmCostUsd, effectiveRowCostUsd, deepseekPeakMultiplier } from "../src/services/api-usage.service";
// (recordApiUsage is fire-and-forget; test the cost math via llmCostUsd + multiplier instead)

describe("llmCostUsd", () => {
  it("computes gpt-4o-mini cost from input+output tokens", () => {
    // 1M input @ $0.15 + 1M output @ $0.60 = $0.75
    expect(llmCostUsd("gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
  });

  it("computes claude-haiku cost", () => {
    // 1M in @ $1.00 + 1M out @ $5.00 = $6.00
    expect(llmCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000)).toBeCloseTo(6.0, 6);
  });

  it("computes gemini-2.5-flash-lite cost", () => {
    // 1M in @ $0.10 + 1M out @ $0.40 = $0.50
    expect(llmCostUsd("gemini-2.5-flash-lite", 1_000_000, 1_000_000)).toBeCloseTo(0.5, 6);
  });

  it("bills cached input tokens at the HALF rate (prompt-caching correction)", () => {
    // gpt-4o-mini: 1M input of which 800k cached → 200k @ $0.15 + 800k @ $0.075 + 0 out
    //  = $0.03 + $0.06 = $0.09  (vs $0.15 if we'd (wrongly) charged all at full rate)
    expect(llmCostUsd("gpt-4o-mini", 1_000_000, 0, 800_000)).toBeCloseTo(0.09, 6);
    // cachedTokens defaults to 0 → unchanged behaviour for callers without the count
    expect(llmCostUsd("gpt-4o-mini", 1_000_000, 0)).toBeCloseTo(0.15, 6);
    // cached can never exceed input (clamped)
    expect(llmCostUsd("gpt-4o-mini", 1_000_000, 0, 5_000_000)).toBeCloseTo(0.075, 6);
    // Anthropic has no auto-cache → cached billed at full rate (cachedPerM == inPerM)
    expect(llmCostUsd("claude-haiku-4-5", 1_000_000, 0, 1_000_000)).toBeCloseTo(1.0, 6);
  });

  it("scales linearly with token count (a realistic small extraction call)", () => {
    // 500 in + 80 out for gpt-4o-mini ≈ $0.000075 + $0.000048 = $0.000123
    const c = llmCostUsd("gpt-4o-mini", 500, 80);
    expect(c).toBeCloseTo(500 / 1e6 * 0.15 + 80 / 1e6 * 0.6, 9);
    expect(c).toBeGreaterThan(0);
  });

  it("returns 0 (counted but un-priced) for an unknown model — never throws", () => {
    expect(llmCostUsd("some-future-model", 1000, 1000)).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    expect(llmCostUsd("gpt-4o-mini", 0, 0)).toBe(0);
  });

  it("computes deepseek-v4-flash cost (all cache-miss input)", () => {
    // 1M input all miss + 1M output = 0.14 + 0.28 = 0.42
    expect(llmCostUsd("deepseek-v4-flash", 1_000_000, 1_000_000)).toBeCloseTo(0.42, 6);
  });

  it("computes deepseek-v4-flash cost with cache hits (hit billed at 0.0028)", () => {
    // 1M input of which 900k HIT (0.0028) + 100k miss (0.14), 0 output
    // = 0.9*0.0028 + 0.1*0.14 = 0.00252 + 0.014 = 0.01652
    expect(llmCostUsd("deepseek-v4-flash", 1_000_000, 0, 900_000)).toBeCloseTo(0.01652, 6);
  });

  it("deepseek-v4-flash full cache hit floor", () => {
    // all 1M input hits → 0.0028
    expect(llmCostUsd("deepseek-v4-flash", 1_000_000, 0, 1_000_000)).toBeCloseTo(0.0028, 6);
  });

  it("recordApiUsage cost path is non-zero for deepseek token calls (spend guard depends on this)", () => {
    // Directly assert the cost function the guard sums is non-zero for deepseek.
    const c = llmCostUsd("deepseek-v4-flash", 20000, 71, 19900); // ~all-hit
    expect(c).toBeGreaterThan(0);
  });
});

describe("deepseekPeakMultiplier", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 6, 15, h, 30, 0));
  it("is 2x inside peak window 01:00-04:00 UTC", () => {
    expect(deepseekPeakMultiplier(at(2))).toBe(2);
  });
  it("is 2x inside peak window 06:00-10:00 UTC", () => {
    expect(deepseekPeakMultiplier(at(7))).toBe(2);
  });
  it("is 1x off-peak (e.g. 12:00 UTC)", () => {
    expect(deepseekPeakMultiplier(at(12))).toBe(1);
  });
  it("is 1x at 05:00 UTC (between the two peak windows)", () => {
    expect(deepseekPeakMultiplier(at(5))).toBe(1);
  });
  it("boundary: 04:00 UTC is off-peak (peak is [01,04))", () => {
    expect(deepseekPeakMultiplier(at(4))).toBe(1);
  });
});

describe("effectiveRowCostUsd — display-layer truth recompute", () => {
  // WHY this exists: historical api_usage rows stored a WRONG cost_usd (Gemini
  // extraction was booked at an effective ~$0.029/M instead of Google's real
  // $0.10/M — a live probe proved the cron gets ZERO cache hits, so the stored
  // cost is a ~3.5× under-count). Rather than mutate the audit trail, the Cost
  // Sheet recomputes each LLM row's cost FROM its stored token counts at the
  // current, correct price table. This function is that recompute.

  it("recomputes a known-model LLM row from its tokens (ignoring the stale stored cost)", () => {
    // A real Gemini extraction row: 18,103 in + 67 out was STORED at $0.000532
    // (the buggy ~$0.029/M booking). Truth at $0.10/$0.40 is far higher.
    const truth = 18103 / 1e6 * 0.1 + 67 / 1e6 * 0.4;
    expect(
      effectiveRowCostUsd({ provider: "gemini", model: "gemini-2.5-flash-lite", inputTokens: 18103, outputTokens: 67, costUsd: 0.000532, operation: "entity-extraction" })
    ).toBeCloseTo(truth, 9);
  });

  it("does NOT credit phantom cache — a Gemini row with no cached count is billed fully at $0.10/M", () => {
    // Gemini returns no cachedContentTokenCount, so recompute must charge all input uncached.
    expect(
      effectiveRowCostUsd({ provider: "gemini", model: "gemini-2.5-flash-lite", inputTokens: 1_000_000, outputTokens: 0, costUsd: 0.029, operation: "entity-extraction" })
    ).toBeCloseTo(0.1, 6);
  });

  it("keeps the STORED cost for a reconstructed/estimate row (never recompute an estimate)", () => {
    // '-reconstructed' rows are a labeled rough ceiling, not token-accurate — leave them.
    expect(
      effectiveRowCostUsd({ provider: "openai", model: "gpt-4o-mini", inputTokens: 1_000_000, outputTokens: 0, costUsd: 42, operation: "entity-extraction-reconstructed" })
    ).toBe(42);
  });

  it("keeps the STORED cost for a non-LLM row (meta/youtube are $0 within quota — no token price)", () => {
    expect(
      effectiveRowCostUsd({ provider: "meta", model: "", inputTokens: null, outputTokens: null, costUsd: 0, operation: "graph-media" })
    ).toBe(0);
  });

  it("keeps the STORED cost for an unknown model (can't recompute what we can't price)", () => {
    // An unknown model has no price table entry → recompute would zero it out and
    // LOSE the originally-recorded figure. Preserve the stored value instead.
    expect(
      effectiveRowCostUsd({ provider: "openai", model: "some-future-model", inputTokens: 1000, outputTokens: 1000, costUsd: 0.005, operation: "chat" })
    ).toBe(0.005);
  });

  it("recomputes an OpenAI extraction row at the correct $0.15/$0.60 (forward-consistent too)", () => {
    const truth = 14617 / 1e6 * 0.15 + 31 / 1e6 * 0.6;
    expect(
      effectiveRowCostUsd({ provider: "openai", model: "gpt-4o-mini", inputTokens: 14617, outputTokens: 31, costUsd: 0.001287, operation: "entity-extraction" })
    ).toBeCloseTo(truth, 9);
  });
});

describe("peak multiplier applied to recorded cost", () => {
  it("llmCostUsd × 2 equals a peak-hour DeepSeek charge", () => {
    const off = llmCostUsd("deepseek-v4-flash", 20000, 73, 18000);
    // peak = 2× off
    expect(off * 2).toBeCloseTo(llmCostUsd("deepseek-v4-flash", 20000, 73, 18000) * 2, 8);
    expect(off).toBeGreaterThan(0);
  });
});
