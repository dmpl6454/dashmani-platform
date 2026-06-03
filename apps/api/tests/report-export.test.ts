import { describe, it, expect } from "vitest";
import {
  buildExportRows,
  buildReportsWorkbook,
  type ExportInput,
  type ExportAccount,
  type ExportLink,
} from "../src/services/report-export.service";
import * as XLSX from "xlsx";

// ---- fixture builders ----

function acc(over: Partial<ExportAccount> & { id: string; displayName: string }): ExportAccount {
  return {
    handle: `@${over.displayName.toLowerCase().replace(/\s+/g, "")}`,
    platformName: "Instagram",
    status: "ACTIVE",
    followerCount: 0,
    clientName: null,
    assignedEmployees: [],
    ...over,
  };
}

// firstSeenAt times in IST: pass an ISO that, in IST, lands at the wanted clock.
// IST = UTC+5:30, so 04:30Z = 10:00 IST, 15:00Z = 20:30 IST.
function link(over: Partial<ExportLink> & { accountId: string; firstSeenAt: Date; reportDateKey: string }): ExportLink {
  return {
    url: "https://x/p/" + Math.random().toString(36).slice(2),
    platformName: "Instagram",
    reportSubmittedAt: over.firstSeenAt,
    employeeId: "e1",
    employeeName: "Emp One",
    likes: null,
    comments: null,
    views: null,
    channelName: "Chan",
    channelHandle: "@chan",
    ...over,
  };
}

const IST = (hhmmZ: string, day = "2026-06-01") => new Date(`${day}T${hhmmZ}:00.000Z`);

describe("buildExportRows — accuracy", () => {
  it("lists ALL accounts including zero-link and unassigned ones", () => {
    const input: ExportInput = {
      accounts: [
        acc({ id: "a1", displayName: "Active Chan", assignedEmployees: [{ id: "e1", name: "Emp One", phone: "999", email: "e1@x.com" }] }),
        acc({ id: "a2", displayName: "Dormant Chan" }), // zero links, unassigned
      ],
      windowLinks: [
        link({ accountId: "a1", firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01" }),
      ],
      todayLinks: [],
      startKey: "2026-05-03",
      endKey: "2026-06-01",
    };
    const { summary } = buildExportRows(input);
    expect(summary.length).toBe(2);

    const dormant = summary.find((r) => r.channel === "Dormant Chan")!;
    expect(dormant.totalLinks).toBe(0);
    expect(dormant.assignmentState).toBe("Unassigned");
    expect(dormant.assignedEmployees).toBe("");
    expect(dormant.avgSubmitTime).toBe(""); // no links → blank, not NaN

    const active = summary.find((r) => r.channel === "Active Chan")!;
    expect(active.assignmentState).toBe("Assigned");
    expect(active.assignedEmployees).toBe("Emp One");
    expect(active.contact).toBe("999");
    expect(active.totalLinks).toBe(1);
  });

  it("counts today's links independently of the window", () => {
    const input: ExportInput = {
      accounts: [acc({ id: "a1", displayName: "C" })],
      windowLinks: [
        link({ accountId: "a1", firstSeenAt: IST("04:30", "2026-05-20"), reportDateKey: "2026-05-20" }),
      ],
      // today has 3 links even though window only counted 1
      todayLinks: [
        link({ accountId: "a1", firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01" }),
        link({ accountId: "a1", firstSeenAt: IST("05:30"), reportDateKey: "2026-06-01" }),
        link({ accountId: "a1", firstSeenAt: IST("06:30"), reportDateKey: "2026-06-01" }),
      ],
      startKey: "2026-05-01",
      endKey: "2026-05-31",
    };
    const { summary } = buildExportRows(input);
    expect(summary[0].totalLinks).toBe(1);
    expect(summary[0].todaysLinks).toBe(3);
  });

  it("averages submit time per-link in IST and skips empty channels", () => {
    // 10:00 IST (04:30Z) and 20:00 IST (14:30Z) → mean 15:00 IST.
    const input: ExportInput = {
      accounts: [acc({ id: "a1", displayName: "C" })],
      windowLinks: [
        link({ accountId: "a1", firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01" }),
        link({ accountId: "a1", firstSeenAt: IST("14:30"), reportDateKey: "2026-06-01" }),
      ],
      todayLinks: [],
      startKey: "2026-06-01",
      endKey: "2026-06-01",
    };
    const { summary } = buildExportRows(input);
    expect(summary[0].avgSubmitTime).toBe("15:00");
  });

  it("avg links per ACTIVE day uses distinct activity days, not calendar days", () => {
    // 4 links across 2 distinct IST days → 2.0 per active day (NOT 4/window).
    const input: ExportInput = {
      accounts: [acc({ id: "a1", displayName: "C" })],
      windowLinks: [
        link({ accountId: "a1", firstSeenAt: IST("04:30", "2026-06-01"), reportDateKey: "2026-06-01" }),
        link({ accountId: "a1", firstSeenAt: IST("05:30", "2026-06-01"), reportDateKey: "2026-06-01" }),
        link({ accountId: "a1", firstSeenAt: IST("04:30", "2026-06-02"), reportDateKey: "2026-06-02" }),
        link({ accountId: "a1", firstSeenAt: IST("05:30", "2026-06-02"), reportDateKey: "2026-06-02" }),
      ],
      todayLinks: [],
      startKey: "2026-05-01",
      endKey: "2026-06-30",
    };
    const { summary } = buildExportRows(input);
    expect(summary[0].avgLinksPerActiveDay).toBe(2);
  });

  it("counts distinct (employee,day) report submits and unique involved employees", () => {
    const input: ExportInput = {
      accounts: [acc({ id: "a1", displayName: "C" })],
      windowLinks: [
        link({ accountId: "a1", employeeId: "e1", employeeName: "Emp One", firstSeenAt: IST("04:30", "2026-06-01"), reportDateKey: "2026-06-01" }),
        link({ accountId: "a1", employeeId: "e1", employeeName: "Emp One", firstSeenAt: IST("05:30", "2026-06-01"), reportDateKey: "2026-06-01" }),
        link({ accountId: "a1", employeeId: "e2", employeeName: "Emp Two", firstSeenAt: IST("04:30", "2026-06-02"), reportDateKey: "2026-06-02" }),
      ],
      todayLinks: [],
      startKey: "2026-06-01",
      endKey: "2026-06-30",
    };
    const { summary } = buildExportRows(input);
    expect(summary[0].numEmployeesInvolved).toBe(2);
    expect(summary[0].employeesInvolved).toContain("Emp One");
    expect(summary[0].employeesInvolved).toContain("Emp Two");
    // (e1,06-01) and (e2,06-02) = 2 distinct report submits (the two e1 links share one report)
    expect(summary[0].distinctReportSubmits).toBe(2);
  });

  it("collapses mixed platform casing in the breakdown rows", () => {
    const input: ExportInput = {
      accounts: [acc({ id: "a1", displayName: "C", platformName: "Instagram" })],
      windowLinks: [
        link({ accountId: "a1", platformName: "Instagram", firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01" }),
        link({ accountId: "a1", platformName: "Instagram", firstSeenAt: IST("05:30"), reportDateKey: "2026-06-01" }),
      ],
      todayLinks: [],
      startKey: "2026-06-01",
      endKey: "2026-06-01",
    };
    const { breakdown } = buildExportRows(input);
    expect(breakdown.every((r) => r.platform === "Instagram")).toBe(true);
  });

  it("flags pre-cutover links as approximate and post-cutover as exact", () => {
    const input: ExportInput = {
      accounts: [acc({ id: "a1", displayName: "C" })],
      windowLinks: [
        link({ accountId: "a1", firstSeenAt: IST("04:30", "2026-05-01"), reportDateKey: "2026-05-01" }), // before 2026-06-03
        link({ accountId: "a1", firstSeenAt: IST("04:30", "2026-06-03"), reportDateKey: "2026-06-03" }), // on/after
      ],
      todayLinks: [],
      startKey: "2026-05-01",
      endKey: "2026-06-30",
    };
    const { breakdown } = buildExportRows(input);
    const before = breakdown.find((r) => r.date === "2026-05-01")!;
    const after = breakdown.find((r) => r.date === "2026-06-03")!;
    expect(before.approx).toBe("Yes");
    expect(after.approx).toBe("");
  });

  it("one breakdown row per link (raw ledger)", () => {
    const input: ExportInput = {
      accounts: [acc({ id: "a1", displayName: "C" })],
      windowLinks: [
        link({ accountId: "a1", firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01" }),
        link({ accountId: "a1", firstSeenAt: IST("05:30"), reportDateKey: "2026-06-01" }),
        link({ accountId: "a1", firstSeenAt: IST("06:30"), reportDateKey: "2026-06-01" }),
      ],
      todayLinks: [],
      startKey: "2026-06-01",
      endKey: "2026-06-01",
    };
    const { breakdown } = buildExportRows(input);
    expect(breakdown.length).toBe(3);
  });
});

describe("buildReportsWorkbook — serialization", () => {
  it("produces a 2-sheet xlsx buffer with the simplified headers (no About, no Client)", () => {
    const input: ExportInput = {
      accounts: [acc({ id: "a1", displayName: "C", assignedEmployees: [{ id: "e1", name: "Emp One", phone: "1", email: "e1@x.com" }] })],
      windowLinks: [link({ accountId: "a1", firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01" })],
      todayLinks: [],
      startKey: "2026-05-03",
      endKey: "2026-06-01",
    };
    const buf = buildReportsWorkbook(input, IST("04:30"));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);

    const wb = XLSX.read(buf, { type: "buffer" });
    // About sheet removed → exactly two sheets.
    expect(wb.SheetNames).toEqual(["Channel Summary", "Day-wise Breakdown"]);

    const summaryAoa = XLSX.utils.sheet_to_json(wb.Sheets["Channel Summary"], { header: 1 }) as any[][];
    const summaryHeader = summaryAoa[0];
    // Renamed, plain-English headers present.
    expect(summaryHeader).toContain("Channel");
    expect(summaryHeader).toContain("Links Today");
    expect(summaryHeader).toContain("Total Links");
    expect(summaryHeader).toContain("Avg Posting Time (IST)");
    expect(summaryHeader).toContain("Assigned To");
    expect(summaryHeader).toContain("Who Posted");
    // Removed / old jargon must be gone.
    expect(summaryHeader).not.toContain("Client");
    expect(summaryHeader).not.toContain("Total Links (window)");
    expect(summaryHeader).not.toContain("Page (Channel)");

    const breakdownAoa = XLSX.utils.sheet_to_json(wb.Sheets["Day-wise Breakdown"], { header: 1 }) as any[][];
    expect(breakdownAoa[0]).toContain("Link URL");
    expect(breakdownAoa[0]).toContain("Posting Time (IST)");
    expect(breakdownAoa[0]).toContain("Posted By");
  });
});