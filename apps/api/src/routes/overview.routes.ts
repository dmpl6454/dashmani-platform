import { Router, type Request, type Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireInternalUser } from "../middleware/require-internal-user";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import {
  getOverview,
  DEFAULT_OVERVIEW_PERIOD,
  MAX_RANGE_DAYS,
  OVERVIEW_PERIODS,
  WIDGET_PERIODS,
  type OverviewPeriod,
  type WidgetPeriod,
} from "../services/overview.service";
import {
  getTopPosts,
  TOP_POST_PERIODS,
  TOP_POST_PLATFORMS,
  type TopPostPeriod,
  type TopPostPlatform,
} from "../services/top-posts.service";

const router = Router();

// ⚠️ DELIBERATELY NOT ROLE-GATED (owner decision, 2026-09-17). The Overview is a
// company-wide command centre: EVERY internal user sees it — Employee, Senior
// Employee, Team Lead, Admin, Super Admin alike — and that INCLUDES the revenue and
// per-channel earnings figures. This is a conscious departure from the Meta channel
// endpoints next door (meta.routes.ts), which stay on reports.manage +
// requireAdminRole. Do not "restore" a role gate here without the owner saying so: it
// would silently blank the page for 111 of the 115 active users.
//
// ⚠️ But it is NOT ungated. `authenticate` verifies only the SIGNATURE, and all three
// portals sign with the same secret — so `authenticate` alone would admit HR and
// CLIENT-PORTAL tokens, handing org-wide revenue to external clients. Previously the
// reports.manage/requireAdminRole pair blocked those by accident (a client id is not a
// User id → no roles → 403). requireInternalUser replaces that accident with an
// explicit `type === "employee"` check. Never reduce this to `[authenticate]`.
const overviewGate = [authenticate, requireInternalUser] as const;

function pickPeriod<T extends readonly number[]>(raw: unknown, allowed: T, dflt: T[number]): T[number] {
  const n = Number(raw);
  return (allowed as readonly number[]).includes(n) ? (n as T[number]) : dflt;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * Parse an optional `start`/`end` pair into a window, or null.
 *
 * ⚠️ IT DEGRADES, IT DOES NOT 400. Everything else on this endpoint whitelists and falls
 * back (an unknown `days` becomes DEFAULT_OVERVIEW_PERIOD, an unknown card period
 * becomes 0), so a stale
 * bookmark renders a coherent page rather than an error. A malformed range behaves the
 * same way: it is ignored and the preset `days` drives the page. Returning 400 here would
 * make a mistyped URL a broken dashboard.
 *
 * Rejects: non-ISO input, a real-date check (so 2026-02-31 cannot slip through), an
 * inverted pair, and anything longer than MAX_RANGE_DAYS. An end in the future is NOT
 * rejected — the service clamps it to the last closed day and says so, which is more
 * useful than refusing.
 */
function pickRange(rawStart: unknown, rawEnd: unknown): { start: string; end: string } | null {
  if (typeof rawStart !== "string" || typeof rawEnd !== "string") return null;
  if (!ISO_DAY.test(rawStart) || !ISO_DAY.test(rawEnd)) return null;
  const s = Date.parse(`${rawStart}T00:00:00Z`);
  const e = Date.parse(`${rawEnd}T00:00:00Z`);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  // Round-trip guard: Date.parse("2026-02-31") succeeds and rolls over to March.
  if (new Date(s).toISOString().slice(0, 10) !== rawStart) return null;
  if (new Date(e).toISOString().slice(0, 10) !== rawEnd) return null;
  if (s > e) return null;
  if (Math.round((e - s) / DAY_MS) + 1 > MAX_RANGE_DAYS) return null;
  return { start: rawStart, end: rawEnd };
}

/**
 * GET /admin/overview?days=7|14|30|90&aud=&rev=&vbc=&trac=&start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * `start`+`end` (both required together) define an explicit inclusive window that
 * OVERRIDES `days`, capped at MAX_RANGE_DAYS and clamped to the last day the estate has
 * closed. A malformed or over-long pair is ignored rather than rejected — see pickRange.
 *
 * `days` is the GLOBAL period (default DEFAULT_OVERVIEW_PERIOD = 30 closed days): it
 * drives the KPI strip, the channel tables and every
 * card that has not been detached. `aud` (Audience Growth), `rev` (Revenue Overview),
 * `vbc` (Views by Channel) and `trac` (Content Traction) are per-card overrides which
 * accept the same values plus **0 = follow the global**, which is their default.
 *
 * ⚠️ A card's own period beats the global FOR THAT CARD ONLY — see the contract on
 * WIDGET_PERIODS. Unknown values fall back to 0 (follow), so a stale bookmark degrades
 * to a perfectly coherent whole-page view rather than a 400.
 */
router.get(
  "/admin/overview",
  ...overviewGate,
  asyncHandler(async (req: Request, res: Response) => {
    // ⚠️ The default lives in THREE places and they must agree: here, and the two
    // frontend defaults (the useState literal and the localStorage fallback in
    // page.tsx). If the server said 7 while the client asked for 30 every load would
    // burn a second cache entry and a wasted build; if the client's useState said 30
    // while its stored fallback said 7, the first paint would fetch 7 and immediately
    // refetch 30.
    const days = pickPeriod(req.query.days, OVERVIEW_PERIODS, DEFAULT_OVERVIEW_PERIOD) as OverviewPeriod;
    const widget = (raw: unknown) => pickPeriod(raw, WIDGET_PERIODS, 0) as WidgetPeriod;
    const data = await getOverview({
      days,
      range: pickRange(req.query.start, req.query.end),
      audDays: widget(req.query.aud),
      revDays: widget(req.query.rev),
      vbcDays: widget(req.query.vbc),
      tracDays: widget(req.query.trac),
    });
    return success(res, data);
  }),
);

/**
 * GET /admin/overview/top-posts?days=1|7|30|90&platform=all|instagram|facebook
 *
 * The best-performing links our employees SUBMITTED, ranked by views.
 *
 * ⚠️ A SEPARATE ENDPOINT ON PURPOSE — see the header of top-posts.service.ts. Folding
 * this into the overview payload would multiply that endpoint's 60-entry cache key
 * space by twelve AND put a heavier table inside the Promise.all that builds the KPI
 * strip. Here, a slow Top Posts delays one card and nothing else.
 *
 * ⚠️ It carries the SAME gate as the overview itself, which is the point: the existing
 * /admin/reports/top-links route is gated on `reports.view`, which 108 of 116 active
 * users do not hold — reusing it here would 403 for 93% of this page's audience.
 *
 * Params DEGRADE, never 400, exactly like the overview's: an unknown value falls back
 * to the default so a stale bookmark renders a coherent card instead of an error.
 */
router.get(
  "/admin/overview/top-posts",
  ...overviewGate,
  asyncHandler(async (req: Request, res: Response) => {
    const days = pickPeriod(req.query.days, TOP_POST_PERIODS, 30) as TopPostPeriod;
    const raw = String(req.query.platform ?? "");
    const platform = ((TOP_POST_PLATFORMS as readonly string[]).includes(raw)
      ? raw
      : "all") as TopPostPlatform;
    return success(res, await getTopPosts({ platform, days }));
  }),
);

export default router;
