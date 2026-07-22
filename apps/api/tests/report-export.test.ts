import { describe, it, expect } from "vitest";
import {
  buildExportRows,
  buildDuplicateRows,
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

describe("buildExportRows — employee scoping", () => {
  const twoEmployeeInput = (): ExportInput => ({
    accounts: [
      acc({ id: "a1", displayName: "Chan One" }),
      acc({ id: "a2", displayName: "Chan Two" }),
    ],
    windowLinks: [
      link({ accountId: "a1", employeeId: "e1", employeeName: "Emp One", firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01", channelName: "Chan One" }),
      link({ accountId: "a1", employeeId: "e1", employeeName: "Emp One", firstSeenAt: IST("05:30"), reportDateKey: "2026-06-01", channelName: "Chan One" }),
      link({ accountId: "a2", employeeId: "e2", employeeName: "Emp Two", firstSeenAt: IST("06:30"), reportDateKey: "2026-06-01", channelName: "Chan Two" }),
    ],
    todayLinks: [],
    startKey: "2026-06-01",
    endKey: "2026-06-01",
  });

  it("team view (no employeeId) includes ALL accounts + ALL employees' links", () => {
    const { summary, breakdown } = buildExportRows(twoEmployeeInput());
    expect(summary.length).toBe(2); // both channels
    expect(breakdown.length).toBe(3); // all three links
  });

  it("scopes summary + breakdown to the selected employee only", () => {
    const { summary, breakdown } = buildExportRows({ ...twoEmployeeInput(), employeeId: "e1" });
    // Only the channel e1 posted to (Chan One), not Chan Two.
    expect(summary.map((s) => s.channel)).toEqual(["Chan One"]);
    expect(summary[0].totalLinks).toBe(2);
    // Only e1's two links appear in the breakdown; e2's link is excluded.
    expect(breakdown.length).toBe(2);
    expect(breakdown.every((r) => r.employee === "Emp One")).toBe(true);
  });

  it("scoped export for an employee with no links yields empty summary + breakdown", () => {
    const { summary, breakdown } = buildExportRows({ ...twoEmployeeInput(), employeeId: "e-nobody" });
    expect(summary.length).toBe(0);
    expect(breakdown.length).toBe(0);
  });
});

describe("buildDuplicateRows — cross-employee duplicate links", () => {
  it("groups the SAME link posted by two DIFFERENT employees; ignores unique + same-employee", () => {
    const shared = "https://www.instagram.com/reel/ABC123/";
    const links: ExportLink[] = [
      link({ accountId: "a1", employeeId: "e1", employeeName: "Emp One", url: shared, firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01" }),
      link({ accountId: "a1", employeeId: "e2", employeeName: "Emp Two", url: shared, firstSeenAt: IST("06:30"), reportDateKey: "2026-06-01" }),
      // unique to e1 → not a dupe
      link({ accountId: "a1", employeeId: "e1", employeeName: "Emp One", url: "https://www.instagram.com/reel/UNIQUE1/", firstSeenAt: IST("05:00"), reportDateKey: "2026-06-01" }),
    ];
    const rows = buildDuplicateRows(links);
    expect(rows.length).toBe(2); // only the two submissions of the shared link
    expect(rows.every((r) => r.groupNo === 1)).toBe(true);
    expect(rows.every((r) => r.employeesOnLink === 2)).toBe(true);
    // first submitter first (time asc): Emp One (10:00 IST) before Emp Two (12:00 IST)
    expect(rows.map((r) => r.employee)).toEqual(["Emp One", "Emp Two"]);
    expect(rows[0].submitTime).toBe("10:00");
    expect(rows[1].submitTime).toBe("12:00");
  });

  it("treats the same IG reel with different ?igsh tokens as ONE link (canonicalKey)", () => {
    const links: ExportLink[] = [
      link({ accountId: "a1", employeeId: "e1", employeeName: "Emp One", url: "https://www.instagram.com/reel/XYZ/?igsh=AAA", firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01" }),
      link({ accountId: "a1", employeeId: "e2", employeeName: "Emp Two", url: "https://www.instagram.com/reel/XYZ/?igsh=BBB", firstSeenAt: IST("05:30"), reportDateKey: "2026-06-01" }),
    ];
    const rows = buildDuplicateRows(links);
    expect(rows.length).toBe(2);
    expect(rows[0].employeesOnLink).toBe(2);
  });

  it("does NOT flag a link one employee posted twice (needs ≥2 distinct employees)", () => {
    const url = "https://www.instagram.com/reel/SOLO/";
    const links: ExportLink[] = [
      link({ accountId: "a1", employeeId: "e1", employeeName: "Emp One", url, firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01" }),
      link({ accountId: "a1", employeeId: "e1", employeeName: "Emp One", url, firstSeenAt: IST("05:30"), reportDateKey: "2026-06-02" }),
    ];
    expect(buildDuplicateRows(links).length).toBe(0);
  });

  it("when scoped to an employee, keeps only dup groups that INCLUDE that employee", () => {
    const linkA = "https://www.instagram.com/reel/AAA/"; // e1 + e2
    const linkB = "https://www.instagram.com/reel/BBB/"; // e2 + e3
    const links: ExportLink[] = [
      link({ accountId: "a1", employeeId: "e1", employeeName: "Emp One", url: linkA, firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01" }),
      link({ accountId: "a1", employeeId: "e2", employeeName: "Emp Two", url: linkA, firstSeenAt: IST("05:30"), reportDateKey: "2026-06-01" }),
      link({ accountId: "a1", employeeId: "e2", employeeName: "Emp Two", url: linkB, firstSeenAt: IST("06:30"), reportDateKey: "2026-06-01" }),
      link({ accountId: "a1", employeeId: "e3", employeeName: "Emp Three", url: linkB, firstSeenAt: IST("07:30"), reportDateKey: "2026-06-01" }),
    ];
    // Unscoped: both groups.
    const grpNos = new Set(buildDuplicateRows(links).map((r) => r.groupNo));
    expect(grpNos.size).toBe(2);
    // Scoped to e1: only linkA (which includes e1). linkB (e2+e3) is dropped.
    const scoped = buildDuplicateRows(links, "e1");
    expect(scoped.length).toBe(2); // both submissions of linkA
    expect(new Set(scoped.map((r) => r.url))).toEqual(new Set([linkA]));
    // …but linkA's group still shows the OTHER employee (Emp Two).
    expect(new Set(scoped.map((r) => r.employee))).toEqual(new Set(["Emp One", "Emp Two"]));
  });

  it("skips links with no URL (nothing to key on)", () => {
    const links: ExportLink[] = [
      link({ accountId: "a1", employeeId: "e1", employeeName: "Emp One", url: null, firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01" }),
      link({ accountId: "a1", employeeId: "e2", employeeName: "Emp Two", url: null, firstSeenAt: IST("05:30"), reportDateKey: "2026-06-01" }),
    ];
    expect(buildDuplicateRows(links).length).toBe(0);
  });
});

describe("buildReportsWorkbook — serialization", () => {
  it("produces a lean 2-sheet xlsx (Channel Summary + Cross-Employee Duplicates; NO Day-wise Breakdown — that moved to the streamed CSV)", () => {
    const input: ExportInput = {
      accounts: [acc({ id: "a1", displayName: "C", assignedEmployees: [{ id: "e1", name: "Emp One", phone: "1", email: "e1@x.com" }] })],
      windowLinks: [
        // two employees on the same link → a cross-employee dup so that sheet has a row
        link({ accountId: "a1", employeeId: "e1", employeeName: "Emp One", url: "https://instagram.com/reel/AAA/", firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01" }),
        link({ accountId: "a1", employeeId: "e2", employeeName: "Emp Two", url: "https://instagram.com/reel/AAA/?igsh=x", firstSeenAt: IST("05:30"), reportDateKey: "2026-06-01" }),
      ],
      todayLinks: [],
      startKey: "2026-05-03",
      endKey: "2026-06-01",
    };
    const buf = buildReportsWorkbook(input, IST("04:30"));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);

    const wb = XLSX.read(buf, { type: "buffer" });
    // The huge per-link Day-wise Breakdown is GONE from the workbook (it OOM'd at
    // scale; it now lives in the streamed All-Links CSV). Only the two small sheets remain.
    expect(wb.SheetNames).toEqual(["Channel Summary", "Cross-Employee Duplicates"]);
    expect(wb.SheetNames).not.toContain("Day-wise Breakdown");

    const summaryHeader = (XLSX.utils.sheet_to_json(wb.Sheets["Channel Summary"], { header: 1 }) as any[][])[0];
    expect(summaryHeader).toContain("Channel");
    expect(summaryHeader).toContain("Total Links");
    expect(summaryHeader).toContain("Who Posted");

    const dupHeader = (XLSX.utils.sheet_to_json(wb.Sheets["Cross-Employee Duplicates"], { header: 1 }) as any[][])[0];
    expect(dupHeader).toContain("Link URL");
    expect(dupHeader).toContain("Posting Time (IST)");
    expect(dupHeader).toContain("Employees Sharing");
  });

  it("buildExportRows skips the breakdown allocation when includeBreakdown:false", () => {
    const input: ExportInput = {
      accounts: [acc({ id: "a1", displayName: "C" })],
      windowLinks: [link({ accountId: "a1", firstSeenAt: IST("04:30"), reportDateKey: "2026-06-01" })],
      todayLinks: [],
      startKey: "2026-06-01",
      endKey: "2026-06-01",
    };
    // Default still builds the breakdown (back-compat for other callers/tests).
    expect(buildExportRows(input).breakdown.length).toBe(1);
    // The workbook path opts out — no breakdown rows allocated.
    expect(buildExportRows(input, { includeBreakdown: false }).breakdown.length).toBe(0);
    // Summary + duplicates are unaffected by the flag.
    expect(buildExportRows(input, { includeBreakdown: false }).summary.length).toBe(1);
  });
});