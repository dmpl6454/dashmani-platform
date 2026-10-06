/**
 * oauthGraphFetch — the two behaviours the posting watch relies on, with fetch stubbed:
 *  - recordUsage:false writes no per-call api_usage row (the watch records ONE aggregate
 *    row per tick instead);
 *  - Meta's usage headers are read on every dimension Meta throttles on (calls, CPU,
 *    time), plus its own estimate of when a throttle in force lifts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/services/api-usage.service", () => ({ recordApiUsage: vi.fn() }));

import { recordApiUsage } from "../src/services/api-usage.service";
import { oauthGraphFetch } from "../src/services/meta-oauth/oauth-graph";

const mockedRecord = vi.mocked(recordApiUsage);

function respond(body: unknown, headers: Record<string, string> = {}, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })),
  );
}

const usageOf = async (headers: Record<string, string>) => {
  respond({ data: [] }, headers);
  return (await oauthGraphFetch("1/x", {}, "t", { recordUsage: false })).usage;
};

describe("oauthGraphFetch", () => {
  beforeEach(() => {
    mockedRecord.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes one api_usage row per call by default", async () => {
    respond({ data: [] });
    await oauthGraphFetch("1/x", {}, "t", { label: "x" });
    expect(mockedRecord).toHaveBeenCalledTimes(1);
    expect(mockedRecord).toHaveBeenCalledWith(expect.objectContaining({ operation: "meta-oauth:x", calls: 1 }));
  });

  it("recordUsage:false writes none", async () => {
    respond({ data: [] });
    const r = await oauthGraphFetch("1/x", {}, "t", { label: "x", recordUsage: false });
    expect(r.ok).toBe(true);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("BUC usage: the highest of calls, CPU and time, and Meta's regain estimate", async () => {
    const buc = (entry: Record<string, number>) => ({ "x-business-use-case-usage": JSON.stringify({ "1234": [{ type: "pages", ...entry }] }) });
    expect(await usageOf(buc({ call_count: 4, total_cputime: 12, total_time: 81, estimated_time_to_regain_access: 0 }))).toEqual({
      source: "buc",
      callCountPct: 4,
      usagePct: 81,
      regainMinutes: null,
    });
    expect(await usageOf(buc({ call_count: 100, total_cputime: 30, total_time: 40, estimated_time_to_regain_access: 17 }))).toEqual({
      source: "buc",
      callCountPct: 100,
      usagePct: 100,
      regainMinutes: 17,
    });
  });

  it("app usage reads the same three dimensions", async () => {
    expect(await usageOf({ "x-app-usage": JSON.stringify({ call_count: 2, total_cputime: 77, total_time: 5 }) })).toEqual({
      source: "app",
      callCountPct: 2,
      usagePct: 77,
      regainMinutes: null,
    });
  });

  it("no header, or a garbled one, is 'unknown' — never an invented number", async () => {
    expect(await usageOf({})).toBeNull();
    expect(await usageOf({ "x-app-usage": "not json" })).toBeNull();
    expect(await usageOf({ "x-business-use-case-usage": JSON.stringify({ "1": [{ type: "pages" }] }) })).toBeNull();
  });
});
