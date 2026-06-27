import { describe, it, expect } from "vitest";
import { llmCostUsd } from "../src/services/api-usage.service";

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
});
