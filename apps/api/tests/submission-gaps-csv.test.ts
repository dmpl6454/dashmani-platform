import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app";
import { prisma } from "@dashmani/db";
import { GAP_DAYS_CSV_HEADERS, todayIST } from "@dashmani/shared";
import {
  buildSubmissionGapDaysCsv,
  getSubmissionGapDays,
  getSubmissionGaps,
  invalidateSubmissionGapsCache,
  parseSubmissionGapDaysCsvQuery,
  shiftDay,
  type SubmissionGapDaysCsvParams,
} from "../src/services/submission-gaps.service";
import { createTestRole, generateToken } from "./helpers";
import "./setup";

/**
 * GET /admin/reports/submission-gaps/days.csv — the long-format day-by-day export for
 * every row the panel shows. DB-backed. "Today" is PINNED (2026-09-20) for the service
 * tests; the route tests use the real clock and a window of the last 7 days.
 *
 * Fixture (window 2026-09-10 → 2026-09-20, 11 days):
 *   asha  (Team One) → igA  assigned 2026-09-01. Posts 10 (1), 11 (2), 14 at 00:30 IST,
 *                           15 at 18:15 IST and today; the 12th has only scheduled /
 *                           null / blank links.
 *   asha             → fbB  assigned 2026-09-14T20:00Z = 15th 01:30 IST. Never posts.
 *   bilal (Team Two via membership) → igA assigned 2026-09-01, never posts.
 *   "=HYPERLINK(…)" (team "-Team Minus") → igAt ("@Channel At", handle "@evilhandle"),
 *                           assigned 2026-09-01, never posts — the formula-injection row.
 *   Excluded: a pure admin and an inactive employee (both assigned to igA, both post).
 */

const TODAY = "2026-09-20";
const START = "2026-09-10";
const END = "2026-09-20";
const EVIL_NAME = '=HYPERLINK("http://x.test","y")';
/** How that name reads back from the file — formula-guarded with a leading apostrophe. */
const EVIL_CELL = `'${EVIL_NAME}`;

let seq = 0;
let adminId: string;
let adminToken: string;
let ids: Record<string, string>;

function params(over: Partial<SubmissionGapDaysCsvParams> = {}): SubmissionGapDaysCsvParams {
  return {
    startDate: START,
    endDate: END,
    today: TODAY,
    teamId: null,
    platform: null,
    employeeId: null,
    accountId: null,
    view: "channels",
    q: "",
    minMissed: 0,
    ...over,
  };
}

async function mkUser(
  name: string,
  roleIds: string[],
  opts: { status?: "ACTIVE" | "INACTIVE"; orgUnitId?: string } = {},
): Promise<string> {
  const u = await prisma.user.create({
    data: {
      name,
      email: `gapscsv-${++seq}-${Date.now()}@test.local`,
      passwordHash: "not-a-real-hash",
      status: opts.status ?? "ACTIVE",
      orgUnitId: opts.orgUnitId ?? null,
      roles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
  });
  return u.id;
}

async function assign(employeeId: string, accountId: string, assignedAt: string) {
  await prisma.accountAssignment.create({
    data: { employeeId, accountId, assignedBy: adminId, assignedAt: new Date(assignedAt) },
  });
}

/** `count` links on the (employee, day) report — creating the report if needed. */
async function post(
  employeeId: string,
  accountId: string,
  day: string,
  opts: { firstSeenAt?: string; url?: string | null; scheduled?: boolean; reportCreatedAt?: string; count?: number } = {},
) {
  const date = new Date(`${day}T00:00:00.000Z`);
  const report =
    (await prisma.dailyReport.findUnique({ where: { employeeId_date: { employeeId, date } } })) ??
    (await prisma.dailyReport.create({
      data: { employeeId, date, ...(opts.reportCreatedAt ? { createdAt: new Date(opts.reportCreatedAt) } : {}) },
    }));
  const n = opts.count ?? 1;
  await prisma.reportLink.createMany({
    data: Array.from({ length: n }, () => ({
      reportId: report.id,
      accountId,
      url: opts.url === undefined ? `https://www.instagram.com/reel/${day}-${++seq}/` : opts.url,
      platform: "instagram",
      isScheduled: opts.scheduled ?? false,
      // Default: 10:00 IST on that day.
      firstSeenAt: new Date(opts.firstSeenAt ?? `${day}T04:30:00.000Z`),
    })),
  });
}

/** RFC-4180 parser (quoted cells, doubled quotes, CRLF), BOM stripped. */
function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && src[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

type Line = Record<(typeof GAP_DAYS_CSV_HEADERS)[number], string>;

async function exportLines(p: SubmissionGapDaysCsvParams): Promise<{ text: string; header: string[]; lines: Line[] }> {
  const csv = await buildSubmissionGapDaysCsv(p);
  const text = [...csv.chunks()].join("");
  const [header, ...body] = parseCsv(text);
  const lines = body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])) as Line);
  expect(lines).toHaveLength(csv.rowCount);
  return { text, header, lines };
}

// Sorted by code unit on both sides of every assertion — the file itself orders people with
// localeCompare, where ICU puts "=" before letters.
const pairsOf = (lines: Line[]) => [...new Set(lines.map((l) => `${l.Person}/${l.Handle}`))].sort();
const sorted = (xs: string[]) => [...xs].sort();
const linesFor = (lines: Line[], personName: string, handle: string) =>
  lines.filter((l) => l.Person === personName && l.Handle === handle);

describe("submission gaps — day-by-day CSV (all rows)", () => {
  beforeEach(async () => {
    // ⚠️ Mandatory: module-level single-flight memos (summary AND the CSV aggregation).
    invalidateSubmissionGapsCache();
    seq = 0;

    const employeeRole = await createTestRole("Employee", [{ resource: "tasks", action: "view", scope: "own" }]);
    const adminRole = await createTestRole("Admin", [{ resource: "reports", action: "view", scope: "global" }]);

    const t1 = await prisma.orgUnit.create({ data: { name: "Team One", type: "TEAM" } });
    const t2 = await prisma.orgUnit.create({ data: { name: "Team Two", type: "TEAM" } });
    const tMinus = await prisma.orgUnit.create({ data: { name: "-Team Minus", type: "TEAM" } });

    adminId = await mkUser("Zed Admin", [adminRole.id]);
    adminToken = generateToken(adminId, "admin@test.local", ["Admin"]);

    const ig = await prisma.platform.create({ data: { name: "Instagram", slug: "instagram" } });
    const fb = await prisma.platform.create({ data: { name: "Facebook", slug: "facebook" } });
    const igA = await prisma.socialAccount.create({
      data: { handle: "reelsdaily", displayName: "Reels Daily", platformId: ig.id, status: "ACTIVE" },
    });
    const fbB = await prisma.socialAccount.create({
      data: { handle: "filmypage", displayName: "Filmy Page", platformId: fb.id, status: "ACTIVE" },
    });
    const igAt = await prisma.socialAccount.create({
      data: { handle: "@evilhandle", displayName: "@Channel At", platformId: ig.id, status: "ACTIVE" },
    });
    const other = await prisma.socialAccount.create({
      data: { handle: "notassigned", displayName: "Not Assigned", platformId: ig.id, status: "ACTIVE" },
    });

    const asha = await mkUser("Asha", [employeeRole.id], { orgUnitId: t1.id });
    const bilal = await mkUser("Bilal", [employeeRole.id]);
    await prisma.teamMembership.create({ data: { userId: bilal, orgUnitId: t2.id } });
    const evil = await mkUser(EVIL_NAME, [employeeRole.id], { orgUnitId: tMinus.id });
    const inactive = await mkUser("Chetan", [employeeRole.id], { status: "INACTIVE" });

    await assign(asha, igA.id, "2026-09-01T04:00:00.000Z");
    await assign(asha, fbB.id, "2026-09-14T20:00:00.000Z");
    await assign(bilal, igA.id, "2026-09-01T04:00:00.000Z");
    await assign(evil, igAt.id, "2026-09-01T04:00:00.000Z");
    await assign(adminId, igA.id, "2026-09-01T04:00:00.000Z");
    await assign(inactive, igA.id, "2026-09-01T04:00:00.000Z");

    await post(asha, igA.id, "2026-09-10");
    await post(asha, igA.id, "2026-09-11", { count: 2 });
    await post(asha, igA.id, "2026-09-12", { scheduled: true });
    await post(asha, igA.id, "2026-09-12", { url: null });
    await post(asha, igA.id, "2026-09-12", { url: "   " });
    // 00:30 IST on the 14th == 19:00 UTC on the 13th.
    await post(asha, igA.id, "2026-09-14", { firstSeenAt: "2026-09-13T19:00:00.000Z" });
    await post(asha, igA.id, "2026-09-15", { firstSeenAt: "2026-09-15T12:45:00.000Z" });
    await post(asha, igA.id, TODAY, { firstSeenAt: "2026-09-20T03:00:00.000Z" });
    await post(adminId, igA.id, "2026-09-16");
    await post(inactive, igA.id, "2026-09-16");

    ids = { asha, bilal, evil, inactive, igA: igA.id, fbB: fbB.id, igAt: igAt.id, other: other.id, t1: t1.id, t2: t2.id };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("rows and statuses", () => {
    it("writes one row per pair per day — posted, missed, not assigned yet and today", async () => {
      const { header, lines, text } = await exportLines(params());
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(header).toEqual([...GAP_DAYS_CSV_HEADERS]);
      // 4 current pairs (pure admin, inactive person excluded) × 11 days.
      expect(pairsOf(lines).sort()).toEqual(
        ["Asha/filmypage", "Asha/reelsdaily", "Bilal/reelsdaily", `${EVIL_CELL}/evilhandle`].sort(),
      );
      expect(lines).toHaveLength(4 * 11);

      const ig = linesFor(lines, "Asha", "reelsdaily");
      // Long format: oldest → newest within a pair.
      expect(ig.map((l) => l["Date (IST)"])).toEqual([
        "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15",
        "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20",
      ]);
      const by = Object.fromEntries(ig.map((l) => [l["Date (IST)"], l]));
      expect(by["2026-09-10"]).toMatchObject({
        Team: "Team One", Channel: "Reels Daily", Platform: "Instagram", Weekday: "Thu", Status: "Posted", Links: "1",
        "First posted (IST)": "2026-09-10 10:00", "Last posted (IST)": "2026-09-10 10:00", "Time approx? (before 3 Jun 2026)": "",
      });
      expect(by["2026-09-11"]).toMatchObject({ Status: "Posted", Links: "2" });
      // Scheduled / null / blank links only — still missed, a measured 0.
      expect(by["2026-09-12"]).toMatchObject({ Status: "Missed", Links: "0", "First posted (IST)": "" });
      expect(by["2026-09-15"]).toMatchObject({ Status: "Posted", "Last posted (IST)": "2026-09-15 18:15" });
      // Today is never "missed".
      expect(by[TODAY]).toMatchObject({ Status: "Today (posted so far)", Links: "1", "First posted (IST)": "2026-09-20 08:30" });

      const fb = Object.fromEntries(linesFor(lines, "Asha", "filmypage").map((l) => [l["Date (IST)"], l]));
      for (const d of ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"]) {
        // Before the assignment: its own status, and no count at all (not a fake 0).
        expect(fb[d], d).toMatchObject({ Status: "Not assigned yet", Links: "", "First posted (IST)": "" });
      }
      expect(fb["2026-09-15"]).toMatchObject({ Status: "Missed", Links: "0" });
      expect(fb[TODAY]).toMatchObject({ Status: "Today (not yet)", Links: "0" });
    });

    it("classifies every assigned day exactly like the /days view", async () => {
      const { lines } = await exportLines(params({ employeeId: ids.asha, accountId: ids.igA }));
      const view = await getSubmissionGapDays({ employeeId: ids.asha, accountId: ids.igA, startDate: START, endDate: END, today: TODAY });
      const label: Record<string, string> = {
        posted: "Posted", missed: "Missed", today_posted: "Today (posted so far)", today_pending: "Today (not yet)",
      };
      const fromCsv = Object.fromEntries(lines.map((l) => [l["Date (IST)"], [l.Status, l.Links, l["First posted (IST)"], l["Last posted (IST)"]]]));
      for (const d of view.days) {
        expect(fromCsv[d.date], d.date).toEqual([label[d.status], String(d.linkCount), d.firstPostedIST ?? "", d.lastPostedIST ?? ""]);
      }
    });

    it("attributes days in IST: a 00:30 IST post and a 01:30 IST assignment land on their IST day", async () => {
      const { lines } = await exportLines(params({ employeeId: ids.asha }));
      const ig = Object.fromEntries(linesFor(lines, "Asha", "reelsdaily").map((l) => [l["Date (IST)"], l]));
      // The 14th is posted and the 13th missed — a UTC reading would flip them.
      expect(ig["2026-09-13"].Status).toBe("Missed");
      expect(ig["2026-09-14"]).toMatchObject({ Status: "Posted", "First posted (IST)": "2026-09-14 00:30" });
      // Assigned at 20:00 UTC on the 14th = 01:30 IST on the 15th: the 14th is not counted.
      const fb = Object.fromEntries(linesFor(lines, "Asha", "filmypage").map((l) => [l["Date (IST)"], l]));
      expect(fb["2026-09-14"].Status).toBe("Not assigned yet");
      expect(fb["2026-09-15"].Status).toBe("Missed");
    });

    it("flags times before 2026-06-03 as approximate and uses the report's created time", async () => {
      const employeeRole = await prisma.role.findUniqueOrThrow({ where: { name: "Employee" } });
      const esha = await mkUser("Esha", [employeeRole.id]);
      await assign(esha, ids.igA, "2026-05-20T06:00:00.000Z");
      await post(esha, ids.igA, "2026-06-01", {
        firstSeenAt: "2026-06-01T13:00:00.000Z",
        reportCreatedAt: "2026-06-01T05:00:00.000Z",
      });
      await post(esha, ids.igA, "2026-06-04", { firstSeenAt: "2026-06-04T09:15:00.000Z" });

      const { lines } = await exportLines(
        params({ startDate: "2026-05-30", endDate: "2026-06-05", today: "2026-06-06", employeeId: esha }),
      );
      const by = Object.fromEntries(lines.map((l) => [l["Date (IST)"], l]));
      expect(by["2026-06-01"]).toMatchObject({
        Status: "Posted", "First posted (IST)": "2026-06-01 10:30", "Time approx? (before 3 Jun 2026)": "Yes",
      });
      expect(by["2026-06-04"]).toMatchObject({
        Status: "Posted", "First posted (IST)": "2026-06-04 14:45", "Time approx? (before 3 Jun 2026)": "",
      });
      expect(by["2026-06-02"]["Time approx? (before 3 Jun 2026)"]).toBe("");
    });
  });

  describe("filters (the panel's, applied identically)", () => {
    it("narrows by team, platform, person and channel", async () => {
      expect(pairsOf((await exportLines(params({ teamId: ids.t1 }))).lines).sort()).toEqual(sorted(["Asha/filmypage", "Asha/reelsdaily"]));
      // Team by membership only.
      expect(pairsOf((await exportLines(params({ teamId: ids.t2 }))).lines)).toEqual(sorted(["Bilal/reelsdaily"]));
      expect(pairsOf((await exportLines(params({ platform: "facebook" }))).lines)).toEqual(sorted(["Asha/filmypage"]));
      expect(pairsOf((await exportLines(params({ employeeId: ids.bilal }))).lines)).toEqual(sorted(["Bilal/reelsdaily"]));
      expect(pairsOf((await exportLines(params({ accountId: ids.igA }))).lines)).toEqual(sorted(["Asha/reelsdaily", "Bilal/reelsdaily"]));
      expect(pairsOf((await exportLines(params({ employeeId: ids.asha, accountId: ids.fbB }))).lines)).toEqual(sorted(["Asha/filmypage"]));
    });

    it("applies the search (person, channel or handle) and the minimum missed days", async () => {
      expect(pairsOf((await exportLines(params({ q: "filmy" }))).lines)).toEqual(sorted(["Asha/filmypage"]));
      expect(pairsOf((await exportLines(params({ q: "reelsd" }))).lines)).toEqual(sorted(["Asha/reelsdaily", "Bilal/reelsdaily"]));
      expect(pairsOf((await exportLines(params({ q: "asha" }))).lines)).toEqual(sorted(["Asha/filmypage", "Asha/reelsdaily"]));
      // Missed days (counted 10–19): asha/igA 6, asha/fbB 5, bilal/igA 10, the formula row 10.
      expect(pairsOf((await exportLines(params({ minMissed: 6 }))).lines)).toEqual(sorted([
        "Asha/reelsdaily", "Bilal/reelsdaily", `${EVIL_CELL}/evilhandle`,
      ]));
      expect(pairsOf((await exportLines(params({ minMissed: 10 }))).lines)).toEqual(sorted(["Bilal/reelsdaily", `${EVIL_CELL}/evilhandle`]));
      const none = await exportLines(params({ minMissed: 11 }));
      expect(none.lines).toHaveLength(0);
      expect(none.header).toEqual([...GAP_DAYS_CSV_HEADERS]);
    });

    it("By person: every channel of every listed person, with the threshold on no-link days", async () => {
      // Asha has no link on ANY channel on 6 days (12, 13, 16–19) — both her channels go.
      expect(pairsOf((await exportLines(params({ view: "people", minMissed: 6 }))).lines)).toEqual(sorted([
        "Asha/filmypage", "Asha/reelsdaily", "Bilal/reelsdaily", `${EVIL_CELL}/evilhandle`,
      ]));
      expect(pairsOf((await exportLines(params({ view: "people", minMissed: 7 }))).lines)).toEqual(sorted([
        "Bilal/reelsdaily", `${EVIL_CELL}/evilhandle`,
      ]));
      // The person view's search is the name only.
      expect((await exportLines(params({ view: "people", q: "filmy" }))).lines).toHaveLength(0);
      // With a channel selected, a person's row is computed over that channel alone:
      // Asha's fbB missed 5 → listed at ≥ 5 even though her all-channel figure is 6.
      expect(pairsOf((await exportLines(params({ view: "people", accountId: ids.fbB, minMissed: 5 }))).lines)).toEqual(sorted([
        "Asha/filmypage",
      ]));
      expect((await exportLines(params({ view: "people", accountId: ids.fbB, minMissed: 6 }))).lines).toHaveLength(0);
    });
  });

  describe("safety", () => {
    it("guards every text cell against formula injection and drops a handle's '@'", async () => {
      const { text, lines } = await exportLines(params({ employeeId: ids.evil }));
      const row = lines[0];
      expect(row.Person).toBe(EVIL_CELL);
      expect(row.Team).toBe("'-Team Minus");
      expect(row.Channel).toBe("'@Channel At");
      expect(row.Handle).toBe("evilhandle");
      // On the wire the cell is quoted (it holds quotes and a comma) and starts with the guard.
      expect(text).toContain(`"'=HYPERLINK(""http://x.test"",""y"")"`);
      // No cell of any row starts with a raw formula trigger.
      for (const l of lines) for (const v of Object.values(l)) expect(/^[=+\-@]/.test(v), v).toBe(false);
    });

    it("is bounded: link rows are grouped in SQL in ONE statement and the file is pairs × days", async () => {
      // Heavy history the export must not read into Node: 300 links on one counted day,
      // 120 links before the window, 80 on a channel nobody is assigned to.
      await post(ids.asha, ids.igA, "2026-09-16", { count: 300 });
      await post(ids.asha, ids.igA, "2026-08-15", { count: 120 });
      await post(ids.asha, ids.other, "2026-09-17", { count: 80 });
      // Warm the summary the panel would already have loaded.
      await getSubmissionGaps({ startDate: START, endDate: END, today: TODAY, teamId: null, platform: null, employeeId: null });

      const spy = vi.spyOn(prisma, "$queryRaw");
      const { lines } = await exportLines(params());
      expect(spy).toHaveBeenCalledTimes(1);
      // The aggregation returns one row per PAIR that has links in the window — asha/igA
      // only — not one per link (the fixture has 300+ links on it).
      const aggregated = (await spy.mock.results[0].value) as unknown[];
      expect(aggregated).toHaveLength(1);
      // The file is exactly pairs × days — history outside the window adds nothing.
      expect(lines).toHaveLength(4 * 11);
      const d16 = linesFor(lines, "Asha", "reelsdaily").find((l) => l["Date (IST)"] === "2026-09-16")!;
      expect(d16).toMatchObject({ Status: "Posted", Links: "300" });
      expect(lines.some((l) => l.Channel === "Not Assigned")).toBe(false);
    });

    it("refuses an export above the row cap with a clean 400 — before any aggregation runs", async () => {
      const spy = vi.spyOn(prisma, "$queryRaw");
      await expect(buildSubmissionGapDaysCsv(params(), { maxRows: 43 })).rejects.toMatchObject({
        statusCode: 400,
        code: "EXPORT_TOO_LARGE",
        message: expect.stringMatching(/44 rows — at most 43/),
      });
      // Only the summary ran (the cap is checked before the aggregation).
      expect(spy).toHaveBeenCalledTimes(1);
      // Exactly at the cap is fine.
      const ok = await buildSubmissionGapDaysCsv(params(), { maxRows: 44 });
      expect(ok.rowCount).toBe(44);
    });

    it("shares one aggregation between repeat exports until the memo is invalidated", async () => {
      await exportLines(params());
      const spy = vi.spyOn(prisma, "$queryRaw");
      await exportLines(params());
      expect(spy).toHaveBeenCalledTimes(0); // summary and aggregation both memoised
      invalidateSubmissionGapsCache();
      await exportLines(params());
      expect(spy).toHaveBeenCalledTimes(2); // summary + aggregation, once each
    });

    it("validates its own parameters with clean 400s", () => {
      const expect400 = (q: Record<string, unknown>) => {
        let thrown: unknown;
        try {
          parseSubmissionGapDaysCsvQuery(q, TODAY);
        } catch (e) {
          thrown = e;
        }
        expect((thrown as { statusCode?: number } | undefined)?.statusCode, JSON.stringify(q)).toBe(400);
      };
      expect400({ view: "table" });
      expect400({ minMissed: "-1" });
      expect400({ minMissed: "2.5" });
      expect400({ minMissed: "abc" });
      expect400({ q: ["a", "b"] });
      expect400({ q: "x".repeat(201) });
      expect400({ accountId: "bad id!" });
      expect400({ startDate: "2025-09-19", endDate: "2026-09-20" }); // 367 days
      expect(parseSubmissionGapDaysCsvQuery({ q: "  AsHa ", minMissed: "3", view: "people" }, TODAY)).toMatchObject({
        q: "asha", minMissed: 3, view: "people", startDate: shiftDay(TODAY, -29), endDate: TODAY,
      });
    });
  });

  describe("route", () => {
    const today = todayIST();
    const from = shiftDay(today, -6);
    const url = (qs: string) => `/v1/admin/reports/submission-gaps/days.csv?${qs}`;

    it("requires authentication (401) and the reports.view permission (403)", async () => {
      const anon = await request(app).get(url(`startDate=${from}&endDate=${today}`));
      expect(anon.status).toBe(401);
      const employeeToken = generateToken(ids.asha, "asha@test.local", ["Employee"]);
      const forbidden = await request(app)
        .get(url(`startDate=${from}&endDate=${today}`))
        .set("Authorization", `Bearer ${employeeToken}`);
      expect(forbidden.status).toBe(403);
    });

    it("streams text/csv named after the range, one line per pair per day", async () => {
      const res = await request(app)
        .get(url(`startDate=${from}&endDate=${today}`))
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/csv/);
      expect(res.headers["content-disposition"]).toBe(
        `attachment; filename="submission-gaps-day-by-day-by-channel-${from}_${today}.csv"`,
      );
      expect(res.headers["cache-control"]).toBe("no-store");
      const [header, ...body] = parseCsv(res.text);
      expect(header).toEqual([...GAP_DAYS_CSV_HEADERS]);
      expect(body).toHaveLength(4 * 7);

      const filtered = await request(app)
        .get(url(`startDate=${from}&endDate=${today}&view=people&employeeId=${ids.asha}&platform=instagram&minMissed=1`))
        .set("Authorization", `Bearer ${adminToken}`);
      expect(filtered.status).toBe(200);
      expect(filtered.headers["content-disposition"]).toBe(
        `attachment; filename="submission-gaps-day-by-day-by-person-${from}_${today}-instagram-asha-filtered.csv"`,
      );
    });

    it("400s a range above 366 days and accepts exactly 366", async () => {
      const tooLong = await request(app)
        .get(url(`startDate=${shiftDay(today, -366)}&endDate=${today}`))
        .set("Authorization", `Bearer ${adminToken}`);
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.success).toBe(false);
      expect(tooLong.body.error.code).toBe("INVALID_PARAMS");

      const exact = await request(app)
        .get(url(`startDate=${shiftDay(today, -365)}&endDate=${today}`))
        .set("Authorization", `Bearer ${adminToken}`);
      expect(exact.status).toBe(200);
      expect(parseCsv(exact.text)).toHaveLength(1 + 4 * 366);

      const badView = await request(app).get(url("view=grid")).set("Authorization", `Bearer ${adminToken}`);
      expect(badView.status).toBe(400);
      expect(badView.body.error.code).toBe("INVALID_PARAMS");
    });
  });
});
