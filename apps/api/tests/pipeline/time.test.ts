/**
 * pipeline/time.test.ts — the HR pipeline's date and time labels (owner request 2026-10-01:
 * "accurate date depicted e2e") and the bootstrap re-check decisions (GA, G2).
 *
 * Pure functions from @dashmani/shared (packages/shared/src/pipeline/time.ts): the HR bundle
 * runs them and this suite is the only test runner that can (apps/hr has none).
 *
 * Instants are built with the LOCAL Date constructor (`new Date(y, m, d, h, mi)`), so every
 * expectation holds in any machine timezone; "today" is always passed in as a day key. The
 * 00:00–05:30 IST cases pin process.env.TZ for ONE synchronous test and restore it (Node
 * honours a runtime TZ change), because that window is exactly where a UTC day key is wrong.
 */
import { describe, it, expect } from "vitest";
import {
  PIPELINE_LIMITS,
  dayMonthShort,
  daySeparatorBefore,
  daySeparatorLabel,
  dueState,
  groupsWithPrevious,
  isWithinUndoWindow,
  localDayKey,
  msUntilNextLocalMidnight,
  msUntilNextMinute,
  relativeAgo,
  relativeShort,
  PIPELINE_MODE_RECHECK_MS,
  shouldRecheckBootstrapForMode,
  shouldRecheckBootstrapPeriodically,
  shouldRevalidateBootstrapOnMount,
  startOfMinute,
  timeLabel,
  undoWindowEndsAt,
  type PipelineBootstrap,
} from "@dashmani/shared";

/** A local instant (month is 1-based here). */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms);
const iso = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => at(y, mo, d, h, mi, s).toISOString();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Run `fn` with the process timezone pinned, restoring it even if `fn` throws. Keep `fn` synchronous. */
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

describe("localDayKey — the browser-local day (the repo's IST rule)", () => {
  it("formats the local calendar day, zero-padded", () => {
    expect(localDayKey(at(2026, 10, 1, 9, 5))).toBe("2026-10-01");
    expect(localDayKey(at(2026, 12, 31, 23, 59, 59))).toBe("2026-12-31");
    expect(localDayKey(at(2027, 1, 1, 0, 0, 0))).toBe("2027-01-01");
  });

  it("00:00–05:30 IST is still TODAY in IST, though the UTC day is yesterday", () => {
    // 2026-09-30T19:30Z is 01:00 IST on Thu 1 Oct.
    const instant = new Date("2026-09-30T19:30:00.000Z");
    expect(instant.toISOString().slice(0, 10)).toBe("2026-09-30"); // the bug class: the UTC day
    expect(withTZ("Asia/Kolkata", () => localDayKey(instant))).toBe("2026-10-01");
    // It is the BROWSER-local day by design: a device set to UTC still reads 30 Sep.
    expect(withTZ("UTC", () => localDayKey(instant))).toBe("2026-09-30");
  });
});

describe("dueState — the board chip, against an injected today key", () => {
  it("overdue / today / tomorrow / later, and nothing for Done or no date", () => {
    const today = "2026-10-01";
    expect(dueState("2026-09-30", false, today)).toBe("overdue");
    expect(dueState("2026-10-01", false, today)).toBe("today");
    expect(dueState("2026-10-02", false, today)).toBe("tomorrow");
    expect(dueState("2026-10-03", false, today)).toBe("later");
    expect(dueState("2026-09-30", true, today)).toBeNull(); // terminal (Done): no chip
    expect(dueState(null, false, today)).toBeNull();
  });

  it("tomorrow crosses month, year and leap-day boundaries by calendar arithmetic", () => {
    expect(dueState("2026-11-01", false, "2026-10-31")).toBe("tomorrow");
    expect(dueState("2027-01-01", false, "2026-12-31")).toBe("tomorrow");
    expect(dueState("2026-03-01", false, "2026-02-28")).toBe("tomorrow"); // 2026 is not a leap year
    expect(dueState("2028-02-29", false, "2028-02-28")).toBe("tomorrow");
    expect(dueState("2028-03-01", false, "2028-02-28")).toBe("later");
  });

  it("midnight rollover: the same card moves tomorrow → today → overdue as the key changes", () => {
    expect(dueState("2026-10-01", false, "2026-09-30")).toBe("tomorrow");
    expect(dueState("2026-10-01", false, "2026-10-01")).toBe("today");
    expect(dueState("2026-10-01", false, "2026-10-02")).toBe("overdue");
  });

  it("at 00:30 IST the chip uses the IST day, not the UTC day", () => {
    // 2026-09-30T19:00Z = 00:30 IST Thu 1 Oct.
    const today = withTZ("Asia/Kolkata", () => localDayKey(new Date("2026-09-30T19:00:00.000Z")));
    expect(today).toBe("2026-10-01");
    expect(dueState("2026-09-30", false, today)).toBe("overdue");
    expect(dueState("2026-10-01", false, today)).toBe("today");
  });

  it("an unreadable key never invents a chip", () => {
    expect(dueState("2026-10-03", false, "garbage")).toBe("later"); // not a red Overdue
    expect(dueState("2026-02-30", false, "2026-10-01")).toBeNull();
    expect(dueState("soon", false, "2026-10-01")).toBeNull();
  });
});

describe("dayMonthShort — '30 Sep', with the year only when it differs", () => {
  it("same year: no year; another year: the year", () => {
    expect(dayMonthShort("2026-09-30", "2026-10-01")).toBe("30 Sep");
    expect(dayMonthShort("2026-10-01", "2026-10-01")).toBe("1 Oct");
    expect(dayMonthShort("2027-09-30", "2026-10-01")).toBe("30 Sep 2027");
    expect(dayMonthShort("2025-12-30", "2026-01-02")).toBe("30 Dec 2025");
  });
  it("an unparsable key is shown as is (never a wrong date)", () => {
    expect(dayMonthShort("2026-13-01", "2026-10-01")).toBe("2026-13-01");
    expect(dayMonthShort("not-a-day", "2026-10-01")).toBe("not-a-day");
  });
});

describe("timeLabel — fixed English, 12-hour lowercase am/pm (never the browser locale)", () => {
  const today = "2026-10-01";
  it("today: the time only", () => {
    expect(timeLabel(iso(2026, 10, 1, 10, 5), today)).toBe("10:05 am");
    expect(timeLabel(iso(2026, 10, 1, 0, 0), today)).toBe("12:00 am");
    expect(timeLabel(iso(2026, 10, 1, 12, 0), today)).toBe("12:00 pm");
    expect(timeLabel(iso(2026, 10, 1, 23, 50), today)).toBe("11:50 pm");
    expect(timeLabel(iso(2026, 10, 1, 9, 5), today)).toBe("9:05 am");
  });
  it("another day: weekday, day, month, time; another year: the year too", () => {
    expect(timeLabel(iso(2026, 9, 30, 23, 50), today)).toBe("Wed, 30 Sep, 11:50 pm");
    expect(timeLabel(iso(2025, 9, 30, 10, 5), today)).toBe("Tue, 30 Sep 2025, 10:05 am");
    expect(timeLabel(iso(2027, 10, 1, 10, 5), today)).toBe("Fri, 1 Oct 2027, 10:05 am");
  });
  it("the same instant reads differently once the day changes (the memo key is the day)", () => {
    const m = iso(2026, 9, 30, 23, 50);
    expect(timeLabel(m, "2026-09-30")).toBe("11:50 pm");
    expect(timeLabel(m, "2026-10-01")).toBe("Wed, 30 Sep, 11:50 pm");
  });
  it("accepts epoch milliseconds and Dates; an unreadable instant is empty", () => {
    expect(timeLabel(at(2026, 10, 1, 14, 5).getTime(), today)).toBe("2:05 pm");
    expect(timeLabel(at(2026, 10, 1, 14, 5), today)).toBe("2:05 pm");
    expect(timeLabel("nope", today)).toBe("");
  });
  it("00:00–05:30 IST: a message at 01:00 IST is 'today', not the UTC yesterday", () => {
    withTZ("Asia/Kolkata", () => {
      const msg = "2026-09-30T19:30:00.000Z"; // 01:00 IST Thu 1 Oct
      const todayIst = localDayKey(new Date("2026-10-01T03:00:00.000Z")); // 08:30 IST
      expect(todayIst).toBe("2026-10-01");
      expect(timeLabel(msg, todayIst)).toBe("1:00 am");
      expect(timeLabel("2026-09-30T18:20:00.000Z", todayIst)).toBe("Wed, 30 Sep, 11:50 pm");
    });
  });
});

describe("relativeShort / relativeAgo — floor at every step, like both bells", () => {
  it("never rounds up (B6)", () => {
    expect(relativeShort(0)).toBe("now");
    expect(relativeShort(59_999)).toBe("now");
    expect(relativeShort(MIN)).toBe("1m");
    expect(relativeShort(89_000)).toBe("1m");
    expect(relativeShort(90_000)).toBe("1m"); // round() said 2m
    expect(relativeShort(HOUR - 1)).toBe("59m");
    expect(relativeShort(HOUR)).toBe("1h");
    expect(relativeShort(HOUR + 30 * MIN)).toBe("1h"); // round() said 2h; the bells say 1h
    expect(relativeShort(DAY - 1)).toBe("23h");
    expect(relativeShort(DAY)).toBe("1d");
    expect(relativeShort(36 * HOUR)).toBe("1d"); // round() said 2d
    expect(relativeShort(10 * DAY)).toBe("10d");
  });
  it("a negative age (a clock ahead of ours) is 'now'; an unknown one is empty", () => {
    expect(relativeShort(-5 * MIN)).toBe("now");
    expect(relativeShort(Number.NaN)).toBe("");
    expect(relativeAgo(Number.NaN)).toBe("");
  });
  it("relativeAgo uses the bells' words", () => {
    // The HR and internal bells: s < 60 "just now", then floor "Xm ago" / "Xh ago" / "Xd ago".
    const bell = (ms: number) => {
      const s = Math.floor(ms / 1000);
      if (s < 60) return "just now";
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    };
    for (const ms of [0, 30_000, MIN, 90_000, 59 * MIN, HOUR, 5400_000, 23 * HOUR + 59 * MIN, DAY, 36 * HOUR, 40 * DAY]) {
      expect(relativeAgo(ms)).toBe(bell(ms));
    }
  });
});

describe("day separators (Today / Yesterday / a date)", () => {
  it("labels", () => {
    expect(daySeparatorLabel("2026-10-01", "2026-10-01")).toBe("Today");
    expect(daySeparatorLabel("2026-09-30", "2026-10-01")).toBe("Yesterday");
    expect(daySeparatorLabel("2026-09-29", "2026-10-01")).toBe("Tue, 29 Sep");
    expect(daySeparatorLabel("2026-12-31", "2027-01-01")).toBe("Yesterday");
    expect(daySeparatorLabel("2026-12-30", "2027-01-01")).toBe("Wed, 30 Dec 2026");
  });
  it("one before the first row, then only where the local day changes", () => {
    const today = "2026-10-01";
    expect(daySeparatorBefore(null, iso(2026, 9, 30, 23, 58), today)).toBe("Yesterday");
    expect(daySeparatorBefore(iso(2026, 9, 30, 23, 58), iso(2026, 9, 30, 23, 59), today)).toBeNull();
    expect(daySeparatorBefore(iso(2026, 9, 30, 23, 58), iso(2026, 10, 1, 0, 1), today)).toBe("Today");
    expect(daySeparatorBefore(iso(2026, 9, 30, 23, 58), "nope", today)).toBeNull();
  });
});

describe("groupsWithPrevious — one author within 5 minutes, on the same local day", () => {
  const msg = (authorId: string, createdAt: string, deletedAt: string | null = null) => ({ authorId, createdAt, deletedAt });
  it("groups the same author within 5 minutes", () => {
    expect(groupsWithPrevious(msg("a", iso(2026, 10, 1, 10, 0)), msg("a", iso(2026, 10, 1, 10, 4)))).toBe(true);
  });
  it("never across local midnight (R8)", () => {
    expect(groupsWithPrevious(msg("a", iso(2026, 9, 30, 23, 58)), msg("a", iso(2026, 10, 1, 0, 1)))).toBe(false);
  });
  it("not after a tombstone, another author, 5 minutes or more, or a negative gap", () => {
    expect(groupsWithPrevious(msg("a", iso(2026, 10, 1, 10, 0), iso(2026, 10, 1, 10, 1)), msg("a", iso(2026, 10, 1, 10, 3)))).toBe(false);
    expect(groupsWithPrevious(msg("a", iso(2026, 10, 1, 10, 0)), msg("b", iso(2026, 10, 1, 10, 1)))).toBe(false);
    expect(groupsWithPrevious(msg("a", iso(2026, 10, 1, 10, 0)), msg("a", iso(2026, 10, 1, 10, 5)))).toBe(false);
    expect(groupsWithPrevious(msg("a", iso(2026, 10, 1, 10, 3)), msg("a", iso(2026, 10, 1, 10, 0)))).toBe(false);
    expect(groupsWithPrevious(undefined, msg("a", iso(2026, 10, 1, 10, 0)))).toBe(false);
  });
});

describe("the undo-add window (B8)", () => {
  const added = iso(2026, 10, 1, 10, 0);
  const t0 = Date.parse(added);
  it("is open for exactly PIPELINE_LIMITS.undoAddMinutes after member_added_at", () => {
    expect(PIPELINE_LIMITS.undoAddMinutes).toBe(10);
    expect(undoWindowEndsAt(added)).toBe(t0 + 10 * MIN);
    expect(isWithinUndoWindow(added, t0)).toBe(true);
    expect(isWithinUndoWindow(added, t0 + 10 * MIN - 1)).toBe(true);
    expect(isWithinUndoWindow(added, t0 + 10 * MIN)).toBe(false);
  });
  it("is closed when the time is unknown", () => {
    expect(isWithinUndoWindow(null, t0)).toBe(false);
    expect(isWithinUndoWindow(undefined, t0)).toBe(false);
    expect(isWithinUndoWindow("nope", t0)).toBe(false);
    expect(undoWindowEndsAt(null)).toBeNull();
  });
});

describe("timers: the next local midnight and the next minute", () => {
  it("msUntilNextLocalMidnight", () => {
    expect(msUntilNextLocalMidnight(at(2026, 9, 30, 23, 59, 59))).toBe(1000);
    expect(msUntilNextLocalMidnight(at(2026, 10, 1, 0, 0, 0))).toBe(DAY);
    expect(msUntilNextLocalMidnight(at(2026, 12, 31, 12, 0, 0))).toBe(12 * HOUR);
  });
  it("startOfMinute / msUntilNextMinute", () => {
    const t = Date.UTC(2026, 9, 1, 4, 35, 30, 500);
    expect(startOfMinute(t)).toBe(Date.UTC(2026, 9, 1, 4, 35, 0, 0));
    expect(msUntilNextMinute(t)).toBe(29_500);
    expect(msUntilNextMinute(Date.UTC(2026, 9, 1, 4, 35, 0, 0))).toBe(MIN);
  });
});

describe("bootstrap re-checks (GA: a cached 'not enabled' must not outlive a pipeline.mode flip)", () => {
  const disabled = (reason: "off" | "paused" | "not_in_pilot" | "inactive"): PipelineBootstrap => ({ enabled: false, reason });
  it("revalidates once on mount whenever the cached answer is 'not enabled'", () => {
    expect(shouldRevalidateBootstrapOnMount(undefined)).toBe(false); // nothing cached: SWR fetches anyway
    for (const r of ["off", "paused", "not_in_pilot", "inactive"] as const) {
      expect(shouldRevalidateBootstrapOnMount(disabled(r))).toBe(true);
    }
    const enabled = { enabled: true } as unknown as PipelineBootstrap;
    expect(shouldRevalidateBootstrapOnMount(enabled)).toBe(false);
  });
  it("re-checks on a timer while paused, off or not in the pilot — never for an inactive account", () => {
    expect(shouldRecheckBootstrapPeriodically("off")).toBe(true);
    expect(shouldRecheckBootstrapPeriodically("paused")).toBe(true);
    expect(shouldRecheckBootstrapPeriodically("not_in_pilot")).toBe(true);
    expect(shouldRecheckBootstrapPeriodically("inactive")).toBe(false);
    expect(shouldRecheckBootstrapPeriodically(null)).toBe(false);
  });
  it("re-checks when a sync reports another mode (a focused /pipeline tab at the flip) — at most once per 2 minutes", () => {
    const now = 1_790_000_000_000;
    expect(PIPELINE_MODE_RECHECK_MS).toBe(2 * MIN);
    expect(shouldRecheckBootstrapForMode("pilot", undefined, 0, now)).toBe(false); // an older server says nothing
    expect(shouldRecheckBootstrapForMode("pilot", "pilot", 0, now)).toBe(false);
    expect(shouldRecheckBootstrapForMode("on", "on", 0, now)).toBe(false);
    expect(shouldRecheckBootstrapForMode("pilot", "on", 0, now)).toBe(true); // the GA flip
    expect(shouldRecheckBootstrapForMode("on", "pilot", 0, now)).toBe(true);
    // A failed or lagging re-check must not make every sync hit bootstrap.
    expect(shouldRecheckBootstrapForMode("pilot", "on", now - PIPELINE_MODE_RECHECK_MS + 1, now)).toBe(false);
    expect(shouldRecheckBootstrapForMode("pilot", "on", now - PIPELINE_MODE_RECHECK_MS, now)).toBe(true);
  });
});
