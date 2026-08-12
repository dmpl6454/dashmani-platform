import { Router, Request, Response, NextFunction } from "express";
import { authenticateHr } from "../middleware/hr-auth";
import { validate } from "../middleware/validate";
import { submitDailyReportSchema, updateProfileSchema } from "@dashmani/shared";
import {
  getAssignedAccounts,
  submitDailyReport,
  getMyReports,
  getTodayReport,
} from "../services/daily-report.service";
import { prisma } from "@dashmani/db";
import { todayIST, istMidnight, canonicalKey } from "@dashmani/shared";
import {
  getGrowthForEmployee,
  getAccountGrowth,
} from "../services/account-growth.service";
import { getLeaderboard, getTeamDashboard } from "../services/leaderboard.service";
import { getProfile, updateProfile } from "../services/employee-profile.service";
import { success } from "../utils/response";

const router = Router();

// ===== Profile =====

// GET /hr/profile — get own profile
router.get("/hr/profile", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profile = await getProfile(req.user!.userId);
    return success(res, profile);
  } catch (err) {
    next(err);
  }
});

// PUT /hr/profile — update own profile (bank details, ID proofs, family contacts)
router.put(
  "/hr/profile",
  authenticateHr,
  validate(updateProfileSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await updateProfile(req.user!.userId, req.body);
      return success(res, profile);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Accounts =====

// GET /hr/accounts — assigned accounts for authenticated HR user
router.get("/hr/accounts", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = await getAssignedAccounts(req.user!.userId);
    return success(res, accounts);
  } catch (err) {
    next(err);
  }
});

// ===== Reports =====

// GET /hr/reports/today
router.get("/hr/reports/today", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await getTodayReport(req.user!.userId);
    return success(res, report);
  } catch (err) {
    next(err);
  }
});

// GET /hr/reports/my-link-urls?days=60
// Returns a map of { normalizedUrl -> earliestSubmittedDate (YYYY-MM-DD) } for the last N days
// Used client-side to auto-detect and remove cross-day duplicate links before submission.
// Today's own report is excluded so that editing today's report doesn't flag its own links.
router.get("/hr/reports/my-link-urls", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = Math.min(Number(req.query.days) || 60, 180);
    const today = istMidnight(todayIST());
    const since = new Date(today.getTime() - days * 86400000);

    const rows = await prisma.reportLink.findMany({
      where: {
        url: { not: null },
        isScheduled: false,
        report: {
          employeeId: req.user!.userId,
          date: {
            gte: since,
            // Exclude today — editing today's report must not see its own links as "previous"
            lt: today,
          },
        },
      },
      select: { url: true, report: { select: { date: true } } },
    });

    // Build canonicalKey -> earliest-date map. The frontend cross-day dedupe
    // looks up by canonicalKey(link.url), so the keys here MUST be canonical too
    // (otherwise a re-copied Instagram reel with a fresh ?igsh= token would never
    // match yesterday's stored URL). Both sides compute the key fresh on read;
    // the DB still stores raw URLs.
    const map: Record<string, string> = {};
    for (const r of rows) {
      if (!r.url) continue;
      const key = canonicalKey(r.url);
      if (!key) continue;
      const date = r.report.date.toISOString().slice(0, 10);
      if (!map[key] || date < map[key]) map[key] = date;
    }

    return success(res, map);
  } catch (err) {
    next(err);
  }
});

// GET /hr/reports — history (last 30)
router.get("/hr/reports", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
    const reports = await getMyReports(req.user!.userId, startDate, endDate);
    return success(res, reports);
  } catch (err) {
    next(err);
  }
});

// POST /hr/reports — submit daily report
router.post(
  "/hr/reports",
  authenticateHr,
  validate(submitDailyReportSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { date, links, notes, latitude, longitude } = req.body;
      const report = await submitDailyReport(
        req.user!.userId,
        date,
        links,
        notes,
        latitude,
        longitude,
      );
      return success(res, report, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Growth =====

// GET /hr/growth — all assigned accounts growth
router.get("/hr/growth", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = req.query.days ? parseInt(req.query.days as string) : 30;
    const growth = await getGrowthForEmployee(req.user!.userId, days);
    return success(res, growth);
  } catch (err) {
    next(err);
  }
});

// GET /hr/growth/:accountId — specific account growth
router.get("/hr/growth/:accountId", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = req.query.days ? parseInt(req.query.days as string) : 30;
    const growth = await getAccountGrowth(req.params.accountId, days);
    return success(res, growth);
  } catch (err) {
    next(err);
  }
});

// ===== Leaderboard & Team =====

// GET /hr/leaderboard — performance leaderboard
router.get("/hr/leaderboard", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
    const leaderboard = await getLeaderboard(startDate, endDate);
    return success(res, leaderboard);
  } catch (err) {
    next(err);
  }
});

// GET /hr/team — team dashboard for current user
router.get("/hr/team", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dashboard = await getTeamDashboard(req.user!.userId);
    return success(res, dashboard);
  } catch (err) {
    next(err);
  }
});

// ===== Report Draft =====
// GET /hr/reports/draft?date=YYYY-MM-DD — fetch today's draft (if any)
// Returns null data when no draft exists — never 404.
router.get("/hr/reports/draft", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // todayIST(), not new Date() + getFullYear/getMonth/getDate: the server runs in
    // UTC (verified on prod — getTimezoneOffset() === 0), so the local-date form
    // returns YESTERDAY's key between 00:00 and 05:30 IST and would read the wrong
    // day's draft. Drafts are keyed on an IST date, so the fallback must be IST too.
    const dateKey = (req.query.date as string) || todayIST();
    const draft = await prisma.reportDraft.findUnique({
      where: { employeeId_dateKey: { employeeId: req.user!.userId, dateKey } },
      select: { notes: true, linksJson: true, savedAt: true },
    });
    if (!draft) return success(res, null);
    return success(res, {
      notes: draft.notes ?? "",
      links: JSON.parse(draft.linksJson),
      savedAt: draft.savedAt,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /hr/reports/draft — upsert today's draft
// Body: { date: "YYYY-MM-DD", notes: string, links: LinkEntry[] }
// Idempotent — safe to call on every keystroke (after debounce).
// Clearing the draft: send links: [] and notes: "".
router.put("/hr/reports/draft", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { date, notes, links } = req.body;
    if (!date || !Array.isArray(links)) {
      return res.status(400).json({ success: false, error: "date and links are required" });
    }
    const draft = await prisma.reportDraft.upsert({
      where: { employeeId_dateKey: { employeeId: req.user!.userId, dateKey: date } },
      create: {
        employeeId: req.user!.userId,
        dateKey: date,
        notes: notes ?? "",
        linksJson: JSON.stringify(links),
      },
      update: {
        notes: notes ?? "",
        linksJson: JSON.stringify(links),
        savedAt: new Date(),
      },
      select: { savedAt: true },
    });
    return success(res, { savedAt: draft.savedAt });
  } catch (err) {
    next(err);
  }
});

// DELETE /hr/reports/draft?date=YYYY-MM-DD — explicitly clear a draft
router.delete("/hr/reports/draft", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Same IST rule as the GET above — and it mattered more here. This fallback was
    // load-bearing because the post-submit clear in apps/hr/src/app/report/page.tsx
    // sent no ?date, so between 00:00 and 05:30 IST a successful submit deleted
    // YESTERDAY's draft key and left today's draft behind as stale. The client now
    // passes ?date explicitly; this keeps the fallback correct for any other caller.
    const dateKey = (req.query.date as string) || todayIST();
    await prisma.reportDraft.deleteMany({
      where: { employeeId: req.user!.userId, dateKey },
    });
    return success(res, null);
  } catch (err) {
    next(err);
  }
});

// GET /hr/reports/my-link-insights?days=30 — employee's own YouTube insights
// Returns list of links submitted in the window with their latest metric snapshot.
// Only returns YouTube links (or links on supported platforms). Used by HR report page insights panel.
router.get("/hr/reports/my-link-insights", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 90);
    const { getMyLinkInsights } = await import("../services/social-insights.service");
    const insights = await getMyLinkInsights(req.user!.userId, days);
    return success(res, insights);
  } catch (err) {
    next(err);
  }
});

export default router;
