import { describe, it, expect } from "vitest";
import {
  safeNextPath,
  loginHrefWithNext,
  nextPathFromSearch,
  DEFAULT_AFTER_LOGIN,
} from "../../../hr/src/lib/return-path";

/**
 * P5 — the HR login return path. A deep link opened while signed out (an internal-bell
 * link to a Pipeline project) must survive the trip through /login. Only /pipeline
 * paths are honoured; anything else, and anything that could leave the origin, lands
 * on /dashboard exactly as before.
 */
describe("safeNextPath (P5 allowlist)", () => {
  it("defaults to /dashboard", () => {
    expect(DEFAULT_AFTER_LOGIN).toBe("/dashboard");
  });

  it.each([
    "/pipeline",
    "/pipeline/",
    "/pipeline/9f1c2e4a-0b1d-4c6e-9a55-2f0d6c7b8e11",
    "/pipeline/p1?view=board",
    "/pipeline?view=archived",
    "/pipeline/p1?m=42#msg-42",
    "/pipeline#top",
  ])("accepts %s", (p) => {
    expect(safeNextPath(p)).toBe(p);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["/dashboard"],
    ["/report"],
    ["/report?date=2026-09-28"],
    ["/login"],
    ["/"],
    ["//evil.com"],
    ["//pipeline"],
    ["/\\evil.com"],
    ["/pipeline\\..\\evil"],
    ["/pipeline/\\\\evil.com"],
    ["https://evil.com/pipeline"],
    ["http://localhost:3002/pipeline"],
    ["javascript:alert(1)"],
    ["pipeline/p1"],
    [" /pipeline"],
    ["/PIPELINE"],
    ["/pipelinex"],
    ["/pipeline-evil.com"],
    ["/pipeline/\t/evil.com"],
    ["/pipeline/\n//evil.com"],
    ["/pipeline/\u0000"],
    ["/pipeline/\u007f"],
  ])("rejects %j → /dashboard", (p) => {
    expect(safeNextPath(p as string | null | undefined)).toBe("/dashboard");
  });

  // ⚠️ Dot segments. The raw string starts with /pipeline, but the URL parser resolves
  // "..", so the path the router actually navigates to is somewhere else — and
  // "/pipeline/..//evil.com" resolves to "//evil.com", a scheme-relative URL. The
  // allowlist must judge the NORMALISED path, not the raw one.
  it.each([
    ["/pipeline/../report"],
    ["/pipeline/..//evil.com"],
    ["/pipeline/..//evil.com/phish"],
    ["/pipeline/%2e%2e//evil.com"],
    ["/pipeline/%2E%2E//evil.com"],
    ["/pipeline/.%2e//evil.com"],
    ["/pipeline/./../x"],
    ["/pipeline/p1/../../dashboard"],
    ["/pipeline/.."],
    ["/pipeline/..?next=x"],
  ])("rejects dot-segment escape %j → /dashboard", (p) => {
    expect(safeNextPath(p)).toBe("/dashboard");
  });

  it("an encoded dot-segment escape inside ?next= is refused", () => {
    expect(nextPathFromSearch("?next=/pipeline/%2e%2e//evil.com/phish")).toBe("/dashboard");
    expect(nextPathFromSearch("?next=%2Fpipeline%2F..%2F%2Fevil.com")).toBe("/dashboard");
  });

  it("dot segments that stay inside /pipeline normalise to the resolved path", () => {
    expect(safeNextPath("/pipeline/./p1")).toBe("/pipeline/p1");
    expect(safeNextPath("/pipeline/a/../p1?view=board")).toBe("/pipeline/p1?view=board");
  });

  it("returns an already-normal deep link byte-unchanged", () => {
    expect(safeNextPath("/pipeline/p1?view=board")).toBe("/pipeline/p1?view=board");
  });

  it("rejects a non-string", () => {
    expect(safeNextPath(42 as unknown as string)).toBe("/dashboard");
    expect(safeNextPath({} as unknown as string)).toBe("/dashboard");
  });

  it("bounds the length before scanning (a 1 MB value is rejected fast)", () => {
    const huge = "/pipeline/" + "a".repeat(1_000_000);
    const t0 = performance.now();
    expect(safeNextPath(huge)).toBe("/dashboard");
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("accepts a long but reasonable path (2 kB)", () => {
    const p = "/pipeline/" + "a".repeat(2000);
    expect(safeNextPath(p)).toBe(p);
  });
});

describe("loginHrefWithNext + nextPathFromSearch round trip", () => {
  it("encodes the current path + query into ?next=", () => {
    expect(loginHrefWithNext({ pathname: "/pipeline/p1", search: "?view=board" }))
      .toBe("/login?next=%2Fpipeline%2Fp1%3Fview%3Dboard");
  });

  it("the login page decodes it back to the original deep link", () => {
    const href = loginHrefWithNext({ pathname: "/pipeline/p1", search: "?view=board&m=7" });
    const search = href.slice("/login".length);
    expect(nextPathFromSearch(search)).toBe("/pipeline/p1?view=board&m=7");
  });

  it("a non-pipeline origin page still round-trips to /dashboard (unchanged behaviour)", () => {
    const href = loginHrefWithNext({ pathname: "/report", search: "" });
    expect(href).toBe("/login?next=%2Freport");
    expect(nextPathFromSearch(href.slice("/login".length))).toBe("/dashboard");
  });

  it("no ?next= → /dashboard", () => {
    expect(nextPathFromSearch("")).toBe("/dashboard");
    expect(nextPathFromSearch("?foo=bar")).toBe("/dashboard");
  });

  it("an encoded scheme-relative next is refused", () => {
    expect(nextPathFromSearch("?next=%2F%2Fevil.com")).toBe("/dashboard");
    expect(nextPathFromSearch("?next=%2F%5Cevil.com")).toBe("/dashboard");
    expect(nextPathFromSearch("?next=https%3A%2F%2Fevil.com")).toBe("/dashboard");
  });

  it("uses the first next= when several are present", () => {
    expect(nextPathFromSearch("?next=%2Fpipeline%2Fa&next=%2F%2Fevil")).toBe("/pipeline/a");
  });

  it("a malformed percent-escape does not throw", () => {
    expect(nextPathFromSearch("?next=%E0%A4%A")).toBe("/dashboard");
  });
});
