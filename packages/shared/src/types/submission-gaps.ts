// Response shapes of the Submission gaps API (Links Analytics → "Submission gaps" tab):
//   GET /admin/reports/submission-gaps        → SubmissionGapsResult
//   GET /admin/reports/submission-gaps/days   → SubmissionGapDaysResult
//
// One definition, used by the API service that builds them, the internal portal that
// renders them, and the pure helpers in utils/submission-gaps.ts that filter them — so
// the on-screen list and the CSV exports can never disagree about a field.

export interface GapTeam {
  id: string;
  name: string;
}

/** A missed run as [first, last] IST calendar days. */
export type GapRange = [string, string];

export interface GapPairRow {
  employee: { id: string; name: string; team: GapTeam | null };
  account: { id: string; handle: string; displayName: string; platform: string; platformName: string };
  /** IST day the current assignment began. */
  assignedSince: string;
  /** First / last counted day; null when nothing in the window is countable yet. */
  countedFrom: string | null;
  countedThrough: string | null;
  countedDays: number;
  activeDays: number;
  missedDays: number;
  /** activeDays / countedDays, or null when countedDays is 0. */
  activeRate: number | null;
  /** Missed runs, chronological; the newest MAX_RANGES_PER_ROW. */
  missedRanges: GapRange[];
  missedRangeCount: number;
  missedRangesTruncated: boolean;
  longestGapDays: number;
  /** Consecutive missed days ending on the last counted day (yesterday for a window ending today). */
  currentGapDays: number;
  /** The current gap runs back to the window start while the assignment is older — it may be longer. */
  currentGapOpenEnded: boolean;
  /** Latest report day (IST) with a link on counted days or today, and the last posting time that day. */
  lastPostedDay: string | null;
  lastPostedAt: string | null;
  lastPostedIST: string | null;
  lastPostedApprox: boolean;
  /** Links on counted days (today excluded). */
  linkCount: number;
  todayStatus: "posted" | "not_yet" | null;
  todayLinks: number;
}

export interface GapEmployeeRow {
  employee: { id: string; name: string; team: GapTeam | null };
  accountCount: number;
  countedFrom: string | null;
  countedThrough: string | null;
  /** Days on which at least one assigned channel was being counted. */
  countedDays: number;
  /** Days with a link on at least one assigned channel. */
  activeDays: number;
  /** Days with NO link on ANY assigned channel. */
  missedDays: number;
  /** Days with links on some, but not all, of the channels being counted that day. */
  partialDays: number;
  /** Sum of the per-channel missed days. */
  missedChannelDays: number;
  activeRate: number | null;
  missedRanges: GapRange[];
  missedRangeCount: number;
  missedRangesTruncated: boolean;
  longestGapDays: number;
  currentGapDays: number;
  currentGapOpenEnded: boolean;
  /** Latest report day (IST) with a link on counted days or today, and the last posting time that day. */
  lastPostedDay: string | null;
  lastPostedAt: string | null;
  lastPostedIST: string | null;
  lastPostedApprox: boolean;
  linkCount: number;
  todayStatus: "posted" | "partial" | "not_yet" | null;
  todayPostedAccounts: number;
  todayLinks: number;
}

export interface SubmissionGapsResult {
  range: {
    startDate: string;
    endDate: string;
    today: string;
    includesToday: boolean;
    /** The last day that can be counted in this window (min(endDate, yesterday)). */
    countedThrough: string;
    exactTimesSince: string;
  };
  rows: GapPairRow[];
  employees: GapEmployeeRow[];
  totals: {
    assignments: number;
    employees: number;
    countedDays: number;
    missedDays: number;
    /** Pairs not yet posted today, or null when the window does not include today. */
    notYetToday: number | null;
    truncated: boolean;
  };
  excluded: {
    /** Current assignments to PAUSED / ARCHIVED channels — nobody is expected to post there. */
    inactiveChannelAssignments: number;
  };
  filters: { teams: GapTeam[]; platforms: { slug: string; name: string }[] };
}

/** A day the server counts or reports (today). Days before the assignment are never sent. */
export type GapDayStatus = "posted" | "missed" | "today_posted" | "today_pending";

export interface GapDay {
  date: string;
  status: GapDayStatus;
  linkCount: number;
  firstPostedAt: string | null;
  lastPostedAt: string | null;
  firstPostedIST: string | null;
  lastPostedIST: string | null;
  approximate: boolean;
}

export interface SubmissionGapDaysResult {
  employee: { id: string; name: string };
  account: { id: string; handle: string; displayName: string; platform: string; platformName: string; status: string };
  assignedSince: string;
  range: { startDate: string; endDate: string; today: string; includesToday: boolean; exactTimesSince: string };
  /** Newest first, from max(startDate, assignedSince) to min(endDate, today). */
  days: GapDay[];
}
