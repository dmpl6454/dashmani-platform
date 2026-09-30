import { describe, it, expect } from "vitest";
import {
  GAP_DAYS_CSV_HEADERS,
  GAP_MAX_RANGE_DAYS,
  buildGapDaySeries,
  filterGapPairs,
  filterGapPeople,
  gapChannelsOfPerson,
  gapDaysCsvRow,
  gapDayStatus,
  gapFileSlug,
  gapMonthAllowed,
  gapMonthEnd,
  gapMonthWindow,
  gapPersonRowFromPair,
  gapPostedFromDays,
  gapRangeProblem,
  gapShiftDay,
  gapShiftMonth,
  gapSpanDays,
  isGapDayKey,
  normalizeGapMinMissed,
  normalizeGapSearch,
  resolveGapDayWindow,
  selectGapExportPairs,
  stepGapDayWindow,
  type GapEmployeeRow,
  type GapPairRow,
  type GapPostedDay,
  type GapRowFilters,
} from "@dashmani/shared";

/**
 * Pure submission-gaps helpers from @dashmani/shared — the logic the internal portal's
 * panel and the API's day-by-day CSV both run. No database.
 */

const NO_FILTERS: GapRowFilters = { q: "", minMissed: 0, employeeId: null, accountId: null };

function pair(over: {
  emp: string;
  name: string;
  acc: string;
  channel: string;
  handle?: string;
  missed?: number;
  counted?: number;
  todayLinks?: number;
  todayStatus?: GapPairRow["todayStatus"];
}): GapPairRow {
  const counted = over.counted ?? 10;
  const missed = over.missed ?? 0;
  return {
    employee: { id: over.emp, name: over.name, team: null },
    account: { id: over.acc, handle: over.handle ?? over.acc, displayName: over.channel, platform: "instagram", platformName: "Instagram" },
    assignedSince: "2026-09-01",
    countedFrom: counted ? "2026-09-10" : null,
    countedThrough: counted ? "2026-09-19" : null,
    countedDays: counted,
    activeDays: counted - missed,
    missedDays: missed,
    activeRate: counted ? (counted - missed) / counted : null,
    missedRanges: missed ? [["2026-09-19", "2026-09-19"]] : [],
    missedRangeCount: missed ? 1 : 0,
    missedRangesTruncated: false,
    longestGapDays: missed ? 1 : 0,
    currentGapDays: missed ? 1 : 0,
    currentGapOpenEnded: false,
    lastPostedDay: "2026-09-18",
    lastPostedAt: "2026-09-18T04:30:00.000Z",
    lastPostedIST: "2026-09-18 10:00",
    lastPostedApprox: false,
    linkCount: counted - missed,
    todayStatus: over.todayStatus ?? "not_yet",
    todayLinks: over.todayLinks ?? 0,
  };
}

function person(emp: string, name: string, missed: number): GapEmployeeRow {
  return {
    ...gapPersonRowFromPair(pair({ emp, name, acc: "x", channel: "x", missed })),
    accountCount: 2,
    partialDays: 1,
    missedChannelDays: missed + 3,
  };
}

describe("submission gaps — shared calendar helpers", () => {
  it("validates real calendar days only", () => {
    expect(isGapDayKey("2026-09-30")).toBe(true);
    expect(isGapDayKey("2024-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "2026-9-1", "", null, undefined, 20260930, "2026-09-30T00:00"]) {
      expect(isGapDayKey(bad), String(bad)).toBe(false);
    }
  });

  it("shifts days across month and year ends, and counts inclusive spans", () => {
    expect(gapShiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(gapShiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(gapShiftDay("2024-03-01", -1)).toBe("2024-02-29");
    expect(gapSpanDays("2026-09-01", "2026-09-30")).toBe(30);
    expect(gapSpanDays("2026-09-30", "2026-09-30")).toBe(1);
    expect(gapSpanDays("2026-09-30", "2026-09-29")).toBe(0);
    // Across a leap day.
    expect(gapSpanDays("2024-02-28", "2024-03-01")).toBe(3);
  });

  it("shifts months across year boundaries in both directions", () => {
    expect(gapShiftMonth("2026-01", -1)).toBe("2025-12");
    expect(gapShiftMonth("2025-12", 1)).toBe("2026-01");
    expect(gapShiftMonth("2026-03", -14)).toBe("2025-01");
    expect(gapShiftMonth("2026-09", 16)).toBe("2028-01");
    expect(gapShiftMonth("2026-09", 0)).toBe("2026-09");
    expect(gapShiftMonth("2026-12", -12)).toBe("2025-12");
    expect(() => gapShiftMonth("2026-9", 1)).toThrow();
  });

  it("knows every month's last day, leap years included", () => {
    expect(gapMonthEnd("2024-02")).toBe("2024-02-29");
    expect(gapMonthEnd("2026-02")).toBe("2026-02-28");
    expect(gapMonthEnd("2026-04")).toBe("2026-04-30");
    expect(gapMonthEnd("2026-12")).toBe("2026-12-31");
  });

  it("clamps a month window to today and refuses a future month", () => {
    expect(gapMonthWindow("2026-09", "2026-09-20")).toEqual({ startDate: "2026-09-01", endDate: "2026-09-20" });
    expect(gapMonthWindow("2026-08", "2026-09-20")).toEqual({ startDate: "2026-08-01", endDate: "2026-08-31" });
    expect(gapMonthWindow("2026-09", "2026-09-01")).toEqual({ startDate: "2026-09-01", endDate: "2026-09-01" });
    expect(gapMonthWindow("2026-10", "2026-09-30")).toBeNull();
    // Across the year boundary: December is a past month in January.
    expect(gapMonthWindow("2025-12", "2026-01-05")).toEqual({ startDate: "2025-12-01", endDate: "2025-12-31" });
  });

  it("rejects bad windows with a readable reason, and allows exactly 366 days", () => {
    const today = "2026-09-30";
    expect(gapRangeProblem("2026-09-01", "2026-09-30", today)).toBeNull();
    expect(gapRangeProblem("", "2026-09-30", today)).toMatch(/start and an end/);
    expect(gapRangeProblem("2026-02-30", "2026-03-02", today)).toMatch(/start and an end/);
    expect(gapRangeProblem("2026-09-20", "2026-09-10", today)).toMatch(/on or before/);
    expect(gapRangeProblem("2024-12-31", "2025-01-05", today)).toMatch(/2025 or later/);
    expect(gapRangeProblem("2026-09-01", "2026-10-01", today)).toMatch(/after today/);
    // 366 days is the limit (inclusive); 367 is not.
    expect(gapSpanDays("2025-09-30", "2026-09-30")).toBe(366);
    expect(gapRangeProblem("2025-09-30", "2026-09-30", today)).toBeNull();
    expect(gapRangeProblem("2025-09-29", "2026-09-30", today)).toMatch(new RegExp(`at most ${GAP_MAX_RANGE_DAYS} days.*367`));
  });
});

describe("submission gaps — day-by-day navigation", () => {
  const today = "2026-09-20";
  const report = { startDate: "2026-08-22", endDate: "2026-09-20" }; // "Last 30 days"

  it("◀ from the report range opens the month before the one it ends in; ▶ stops at the current month", () => {
    const prev = stepGapDayWindow({ mode: "report" }, report, today, -1);
    expect(prev).toEqual({ mode: "month", month: "2026-08" });
    expect(resolveGapDayWindow(prev!, report, today)).toEqual({ startDate: "2026-08-01", endDate: "2026-08-31" });
    // The report range ends in the current month — nothing after today exists yet.
    expect(stepGapDayWindow({ mode: "report" }, report, today, 1)).toBeNull();
  });

  it("steps month by month, clamping the current month to today", () => {
    const aug = { mode: "month" as const, month: "2026-08" };
    const sep = stepGapDayWindow(aug, report, today, 1);
    expect(sep).toEqual({ mode: "month", month: "2026-09" });
    expect(resolveGapDayWindow(sep!, report, today)).toEqual({ startDate: "2026-09-01", endDate: "2026-09-20" });
    expect(stepGapDayWindow(sep!, report, today, 1)).toBeNull();
  });

  it("crosses the year boundary and stops at 2025", () => {
    const jan26 = { mode: "month" as const, month: "2026-01" };
    expect(stepGapDayWindow(jan26, report, today, -1)).toEqual({ mode: "month", month: "2025-12" });
    const jan25 = { mode: "month" as const, month: "2025-01" };
    expect(stepGapDayWindow(jan25, report, today, -1)).toBeNull();
    expect(gapMonthAllowed("2025-01", today)).toBe(true);
    expect(gapMonthAllowed("2024-12", today)).toBe(false);
    expect(gapMonthAllowed("2026-10", today)).toBe(false);
  });

  it("steps from a custom window's end month, and resolves a custom window as typed", () => {
    const custom = { mode: "custom" as const, startDate: "2026-06-10", endDate: "2026-07-05" };
    expect(resolveGapDayWindow(custom, report, today)).toEqual({ startDate: "2026-06-10", endDate: "2026-07-05" });
    expect(stepGapDayWindow(custom, report, today, -1)).toEqual({ mode: "month", month: "2026-06" });
    expect(stepGapDayWindow(custom, report, today, 1)).toEqual({ mode: "month", month: "2026-08" });
  });

  it("falls back to the report range for a month that is not allowed", () => {
    expect(resolveGapDayWindow({ mode: "month", month: "2026-12" }, report, today)).toEqual(report);
  });
});

describe("submission gaps — day series", () => {
  const posted = new Map<string, GapPostedDay>([
    ["2026-09-10", { linkCount: 2, firstPostedIST: "2026-09-10 09:00", lastPostedIST: "2026-09-10 21:15" }],
    ["2026-09-20", { linkCount: 1, firstPostedIST: "2026-09-20 08:30", lastPostedIST: "2026-09-20 08:30" }],
  ]);

  it("marks days before the assignment 'not assigned', today separately, and never produces a future day", () => {
    const cells = buildGapDaySeries({
      startDate: "2026-09-06",
      endDate: "2026-09-25",
      today: "2026-09-20",
      assignedSince: "2026-09-09",
      posted,
    });
    // Newest first, through TODAY (the 21st–25th do not exist yet).
    expect(cells.map((c) => c.date)[0]).toBe("2026-09-20");
    expect(cells).toHaveLength(15);
    const by = Object.fromEntries(cells.map((c) => [c.date, c]));
    expect(by["2026-09-20"]).toMatchObject({ status: "today_posted", linkCount: 1 });
    expect(by["2026-09-19"]).toMatchObject({ status: "missed", linkCount: 0, firstPostedIST: null });
    expect(by["2026-09-10"]).toMatchObject({ status: "posted", linkCount: 2, lastPostedIST: "2026-09-10 21:15" });
    expect(by["2026-09-09"]).toMatchObject({ status: "missed", linkCount: 0 }); // the assignment day counts
    // Before the assignment: not counted — no count at all, not a fabricated 0.
    for (const d of ["2026-09-06", "2026-09-07", "2026-09-08"]) {
      expect(by[d], d).toMatchObject({ status: "not_assigned", linkCount: null, firstPostedIST: null, approximate: false });
    }
  });

  it("reports today as pending, never missed", () => {
    const cells = buildGapDaySeries({ startDate: "2026-09-19", endDate: "2026-09-19", today: "2026-09-19", assignedSince: "2026-09-01", posted: new Map() });
    expect(cells).toEqual([
      { date: "2026-09-19", status: "today_pending", linkCount: 0, firstPostedIST: null, lastPostedIST: null, approximate: false },
    ]);
    expect(gapDayStatus("2026-09-19", 0, "2026-09-19")).toBe("today_pending");
    expect(gapDayStatus("2026-09-18", 0, "2026-09-19")).toBe("missed");
  });

  it("flags days before 2026-06-03 with links as approximate", () => {
    const cells = buildGapDaySeries({
      startDate: "2026-06-01",
      endDate: "2026-06-04",
      today: "2026-06-10",
      assignedSince: "2026-05-01",
      posted: new Map([
        ["2026-06-02", { linkCount: 1, firstPostedIST: "2026-06-02 10:30", lastPostedIST: "2026-06-02 10:30" }],
        ["2026-06-03", { linkCount: 1, firstPostedIST: "2026-06-03 11:00", lastPostedIST: "2026-06-03 11:00" }],
      ]),
    });
    const by = Object.fromEntries(cells.map((c) => [c.date, c]));
    expect(by["2026-06-02"].approximate).toBe(true);
    expect(by["2026-06-03"].approximate).toBe(false);
    expect(by["2026-06-01"].approximate).toBe(false); // a missed day has no time to be approximate
  });

  it("is bounded: a window longer than 366 days yields only the newest 366", () => {
    const cells = buildGapDaySeries({ startDate: "2025-01-01", endDate: "2026-09-20", today: "2026-09-20", assignedSince: "2025-01-01", posted: new Map() });
    expect(cells).toHaveLength(GAP_MAX_RANGE_DAYS);
    expect(cells[0].date).toBe("2026-09-20");
    expect(cells[cells.length - 1].date).toBe(gapShiftDay("2026-09-20", -(GAP_MAX_RANGE_DAYS - 1)));
  });

  it("builds the posted lookup from the /days rows (days with links only)", () => {
    const m = gapPostedFromDays([
      { date: "2026-09-02", status: "posted", linkCount: 3, firstPostedAt: null, lastPostedAt: null, firstPostedIST: "a", lastPostedIST: "b", approximate: false },
      { date: "2026-09-01", status: "missed", linkCount: 0, firstPostedAt: null, lastPostedAt: null, firstPostedIST: null, lastPostedIST: null, approximate: false },
    ]);
    expect([...m.keys()]).toEqual(["2026-09-02"]);
    expect(m.get("2026-09-02")).toEqual({ linkCount: 3, firstPostedIST: "a", lastPostedIST: "b" });
  });
});

describe("submission gaps — CSV rows", () => {
  const info = { personName: "Asha", teamName: "Team One", channelName: "Reels Daily", handle: "@reelsdaily", platformName: "Instagram" };

  it("formats every status and blanks the counts of a not-assigned day", () => {
    expect(GAP_DAYS_CSV_HEADERS).toHaveLength(12);
    expect(
      gapDaysCsvRow(info, { date: "2026-09-14", status: "posted", linkCount: 2, firstPostedIST: "2026-09-14 00:30", lastPostedIST: "2026-09-15 00:40", approximate: false }),
    ).toEqual(["Asha", "Team One", "Reels Daily", "reelsdaily", "Instagram", "2026-09-14", "Mon", "Posted", 2, "2026-09-14 00:30", "2026-09-15 00:40", ""]);
    expect(
      gapDaysCsvRow({ ...info, teamName: null }, { date: "2026-09-01", status: "not_assigned", linkCount: null, firstPostedIST: null, lastPostedIST: null, approximate: false }),
    ).toEqual(["Asha", "", "Reels Daily", "reelsdaily", "Instagram", "2026-09-01", "Tue", "Not assigned yet", "", "", "", ""]);
    const labels = (["missed", "today_posted", "today_pending"] as const).map(
      (status) => gapDaysCsvRow(info, { date: "2026-09-20", status, linkCount: 0, firstPostedIST: null, lastPostedIST: null, approximate: false })[7],
    );
    expect(labels).toEqual(["Missed", "Today (posted so far)", "Today (not yet)"]);
    expect(
      gapDaysCsvRow(info, { date: "2026-06-01", status: "posted", linkCount: 1, firstPostedIST: "2026-06-01 10:30", lastPostedIST: "2026-06-01 10:30", approximate: true })[11],
    ).toBe("Yes");
  });

  it("makes filename-safe slugs", () => {
    expect(gapFileSlug("Asha Khan")).toBe("asha-khan");
    expect(gapFileSlug("  --Weird__Name!! ")).toBe("weird-name");
    expect(gapFileSlug("आशा")).toBe("");
    expect(gapFileSlug("a".repeat(60))).toHaveLength(40);
  });
});

describe("submission gaps — row selection (panel filters = CSV filters)", () => {
  const rows: GapPairRow[] = [
    pair({ emp: "e1", name: "Asha", acc: "a1", channel: "Reels Daily", handle: "reelsdaily", missed: 6 }),
    pair({ emp: "e1", name: "Asha", acc: "a2", channel: "Filmy Page", handle: "filmypage", missed: 5, todayLinks: 2, todayStatus: "posted" }),
    pair({ emp: "e2", name: "Bilal", acc: "a1", channel: "Reels Daily", handle: "reelsdaily", missed: 10 }),
  ];
  const employees: GapEmployeeRow[] = [person("e1", "Asha", 4), person("e2", "Bilal", 10)];
  const data = { rows, employees };
  const keys = (rs: GapPairRow[]) => rs.map((r) => `${r.employee.id}/${r.account.id}`);

  it("normalises search and threshold identically everywhere", () => {
    expect(normalizeGapSearch("  AsHa  ")).toBe("asha");
    expect(normalizeGapSearch(normalizeGapSearch("  AsHa  "))).toBe("asha");
    expect(normalizeGapSearch(["a"])).toBe("");
    expect(normalizeGapSearch("x".repeat(150))).toHaveLength(100);
    expect(normalizeGapMinMissed("5")).toBe(5);
    expect(normalizeGapMinMissed("5.7")).toBe(5);
    expect(normalizeGapMinMissed("")).toBe(0);
    expect(normalizeGapMinMissed("abc")).toBe(0);
    expect(normalizeGapMinMissed("-3")).toBe(0);
    expect(normalizeGapMinMissed("123456")).toBe(9999);
  });

  it("filters pairs by person, channel, search (person, channel or handle) and missed days", () => {
    expect(keys(filterGapPairs(rows, NO_FILTERS))).toEqual(["e1/a1", "e1/a2", "e2/a1"]);
    expect(keys(filterGapPairs(rows, { ...NO_FILTERS, employeeId: "e1" }))).toEqual(["e1/a1", "e1/a2"]);
    expect(keys(filterGapPairs(rows, { ...NO_FILTERS, accountId: "a1" }))).toEqual(["e1/a1", "e2/a1"]);
    expect(keys(filterGapPairs(rows, { ...NO_FILTERS, q: "filmy" }))).toEqual(["e1/a2"]);
    expect(keys(filterGapPairs(rows, { ...NO_FILTERS, q: "reelsd" }))).toEqual(["e1/a1", "e2/a1"]);
    expect(keys(filterGapPairs(rows, { ...NO_FILTERS, q: "bilal" }))).toEqual(["e2/a1"]);
    expect(keys(filterGapPairs(rows, { ...NO_FILTERS, minMissed: 6 }))).toEqual(["e1/a1", "e2/a1"]);
    expect(keys(filterGapPairs(rows, { ...NO_FILTERS, employeeId: "e1", accountId: "a1" }))).toEqual(["e1/a1"]);
  });

  it("filters people by person, name search and no-link days — over all channels by default", () => {
    expect(filterGapPeople(data, NO_FILTERS).map((p) => p.employee.id)).toEqual(["e1", "e2"]);
    expect(filterGapPeople(data, { ...NO_FILTERS, minMissed: 5 }).map((p) => p.employee.id)).toEqual(["e2"]);
    // The person view's search is the name only — a channel name does not match people.
    expect(filterGapPeople(data, { ...NO_FILTERS, q: "reels" })).toEqual([]);
    expect(filterGapPeople(data, { ...NO_FILTERS, employeeId: "e2" }).map((p) => p.employee.id)).toEqual(["e2"]);
  });

  it("with a channel selected, computes each person's row over that channel alone", () => {
    const people = filterGapPeople(data, { ...NO_FILTERS, accountId: "a2" });
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      employee: { id: "e1" },
      accountCount: 1,
      missedDays: 5,
      partialDays: 0,
      missedChannelDays: 5,
      todayStatus: "posted",
      todayPostedAccounts: 1,
      todayLinks: 2,
    });
    // The threshold applies to the channel-scoped number (5), not the all-channel one (4).
    expect(filterGapPeople(data, { ...NO_FILTERS, accountId: "a2", minMissed: 5 })).toHaveLength(1);
    expect(filterGapPeople(data, { ...NO_FILTERS, accountId: "a2", minMissed: 6 })).toHaveLength(0);
    expect(keys(gapChannelsOfPerson(rows, "e1", "a2"))).toEqual(["e1/a2"]);
    expect(keys(gapChannelsOfPerson(rows, "e1", null))).toEqual(["e1/a1", "e1/a2"]);
  });

  it("exports exactly the rows on screen, in both views", () => {
    expect(keys(selectGapExportPairs(data, "channels", { ...NO_FILTERS, minMissed: 6 }))).toEqual(["e1/a1", "e2/a1"]);
    // By person: every channel of every listed person.
    expect(keys(selectGapExportPairs(data, "people", NO_FILTERS))).toEqual(["e1/a1", "e1/a2", "e2/a1"]);
    expect(keys(selectGapExportPairs(data, "people", { ...NO_FILTERS, minMissed: 5 }))).toEqual(["e2/a1"]);
    // By person + channel: only that channel of the people listed.
    expect(keys(selectGapExportPairs(data, "people", { ...NO_FILTERS, accountId: "a1" }))).toEqual(["e1/a1", "e2/a1"]);
    expect(keys(selectGapExportPairs(data, "people", { ...NO_FILTERS, accountId: "a1", minMissed: 7 }))).toEqual(["e2/a1"]);
  });
});
