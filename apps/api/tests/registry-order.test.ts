import { describe, it, expect } from "vitest";
import { getAllSlugs } from "../src/services/social-insights";

// The provider array order in registry.ts IS the 6h-cron metric-sweep order
// (getSupportedSlugs is consumed only by social-insights.cron.ts). After the
// 2026-06-26 fix, order is no longer the SOLE defense against starvation (the
// per-provider SWEEP_BUDGET_MS budget guarantees the loop reaches every provider),
// but the priority is still pinned: cheapest/most-reliable first, slowest last.
describe("social-insights provider order", () => {
  it("YouTube stays first (cheap, fast Data API)", () => {
    expect(getAllSlugs()[0]).toBe("youtube");
  });

  it("Facebook is ordered before Instagram (FB scraper is reliable; IG sweep is the slow one)", () => {
    const order = getAllSlugs();
    expect(order.indexOf("facebook")).toBeLessThan(order.indexOf("instagram"));
  });

  it("all three platforms are present", () => {
    const order = getAllSlugs();
    expect(order).toContain("youtube");
    expect(order).toContain("facebook");
    expect(order).toContain("instagram");
  });
});
