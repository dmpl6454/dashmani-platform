import { describe, it, expect } from "vitest";
import {
  bellListView,
  pipelineNotificationPath,
  BELL_LIST_LIMIT,
} from "@dashmani/shared";

/**
 * P3/P4 (spec §7.10, §9.8, §10): the bell's decision logic, kept pure so it is
 * testable here. The HR and internal bells render from these results only.
 *
 * The rule under test: only a LOADED response may claim emptiness; a failed
 * request must say so.
 */

const row = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `n${i}`,
  type: "GENERAL",
  title: `Title ${i}`,
  message: `Message ${i}`,
  read: false,
  metadata: null,
  createdAt: "2026-09-26T10:00:00.000Z",
  ...extra,
});

describe("bellListView — honest loading / error / empty states", () => {
  it("shows the skeleton while nothing has loaded and nothing has failed", () => {
    const v = bellListView(undefined, undefined);
    expect(v).toEqual({ loading: true, failed: false, empty: false, rows: [] });
  });

  it("a failed first load is an error, never 'No notifications yet'", () => {
    const v = bellListView(undefined, new Error("502"));
    expect(v.failed).toBe(true);
    expect(v.empty).toBe(false);
    expect(v.loading).toBe(false);
    expect(v.rows).toEqual([]);
  });

  it("a loaded [] is the ONLY way to claim emptiness", () => {
    const v = bellListView({ success: true, data: [] }, undefined);
    expect(v).toEqual({ loading: false, failed: false, empty: true, rows: [] });
  });

  it("a loaded [] followed by a failed refresh does not claim emptiness", () => {
    const v = bellListView({ success: true, data: [] }, new Error("503"));
    expect(v.failed).toBe(true);
    expect(v.empty).toBe(false);
  });

  it("keeps previously loaded rows visible when a refresh fails (flagged as failed)", () => {
    const rows = [row(1), row(2)];
    const v = bellListView({ success: true, data: rows }, new Error("timeout"));
    expect(v.failed).toBe(true);
    expect(v.empty).toBe(false);
    expect(v.loading).toBe(false);
    expect(v.rows).toEqual(rows);
  });

  it("renders loaded rows unchanged and in order", () => {
    const rows = [row(1), row(2), row(3)];
    const v = bellListView({ success: true, data: rows }, undefined);
    expect(v).toEqual({ loading: false, failed: false, empty: false, rows });
    // Same object identities — rows are passed through, not rebuilt.
    expect(v.rows[0]).toBe(rows[0]);
  });

  it("caps the list at BELL_LIST_LIMIT (50), matching the server's take:50", () => {
    expect(BELL_LIST_LIMIT).toBe(50);
    const rows = Array.from({ length: 60 }, (_, i) => row(i));
    const v = bellListView({ success: true, data: rows }, undefined);
    expect(v.rows).toHaveLength(50);
    expect(v.rows[49]).toBe(rows[49]);
  });

  it("a malformed success body (no array) is a failure, not emptiness", () => {
    for (const bad of [null, {}, { success: true }, { success: true, data: { count: 3 } }, "oops", 42]) {
      const v = bellListView(bad, undefined);
      expect(v.failed, JSON.stringify(bad)).toBe(true);
      expect(v.empty, JSON.stringify(bad)).toBe(false);
      expect(v.loading, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("pipelineNotificationPath — HR bell deep link (P3)", () => {
  const pipe = (path: unknown, extra: Record<string, unknown> = {}) =>
    row(1, { type: "PIPELINE", metadata: { v: 1, kind: "mention", path }, ...extra });

  it("returns metadata.path for a PIPELINE row whose path starts with /pipeline/", () => {
    expect(pipelineNotificationPath(pipe("/pipeline/abc?m=m1&t=r1"))).toBe("/pipeline/abc?m=m1&t=r1");
    expect(pipelineNotificationPath(pipe("/pipeline/abc"))).toBe("/pipeline/abc");
  });

  it("returns null for every non-PIPELINE row, even one carrying a pipeline path", () => {
    for (const type of ["GENERAL", "ANNOUNCEMENT", "TASK_ASSIGNED", undefined, null, "pipeline"]) {
      expect(pipelineNotificationPath(row(1, { type, metadata: { path: "/pipeline/abc" } }))).toBeNull();
    }
  });

  it("returns null when the path is missing, not a string, or outside /pipeline/", () => {
    expect(pipelineNotificationPath(row(1, { type: "PIPELINE", metadata: null }))).toBeNull();
    expect(pipelineNotificationPath(row(1, { type: "PIPELINE", metadata: undefined }))).toBeNull();
    expect(pipelineNotificationPath(row(1, { type: "PIPELINE", metadata: "x" }))).toBeNull();
    expect(pipelineNotificationPath(row(1, { type: "PIPELINE", metadata: [] }))).toBeNull();
    for (const bad of [
      undefined,
      null,
      42,
      { path: "/pipeline/x" },
      "",
      "/pipeline", // not /pipeline/
      "/pipelines/x",
      "/dashboard",
      "pipeline/x",
      "//evil.com/pipeline/x",
      "https://evil.com/pipeline/x",
      "javascript:alert(1)",
    ]) {
      expect(pipelineNotificationPath(pipe(bad)), String(bad)).toBeNull();
    }
  });

  it("rejects an unreasonably long path without scanning it (length-bounded)", () => {
    expect(pipelineNotificationPath(pipe("/pipeline/" + "a".repeat(5000)))).toBeNull();
  });

  it("does not throw on hostile input", () => {
    expect(pipelineNotificationPath(null as unknown as object)).toBeNull();
    expect(pipelineNotificationPath(undefined as unknown as object)).toBeNull();
    expect(pipelineNotificationPath("x" as unknown as object)).toBeNull();
  });
});
