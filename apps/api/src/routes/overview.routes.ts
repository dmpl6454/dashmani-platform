import { Router, type Request, type Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireInternalUser } from "../middleware/require-internal-user";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import {
  getOverview,
  OVERVIEW_PERIODS,
  WIDGET_PERIODS,
  type OverviewPeriod,
  type WidgetPeriod,
} from "../services/overview.service";

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

/**
 * GET /admin/overview?days=7|14|30|90&aud=7|30|90&rev=7|30|90
 *
 * `days` drives the KPI strip and the channel tables; `aud`/`rev` are the
 * Audience Growth and Revenue widgets' own periods, which the design lets an
 * admin override independently. Unknown values fall back to the defaults so a
 * stale bookmark degrades to the normal view, never a 400.
 */
router.get(
  "/admin/overview",
  ...overviewGate,
  asyncHandler(async (req: Request, res: Response) => {
    const days = pickPeriod(req.query.days, OVERVIEW_PERIODS, 7) as OverviewPeriod;
    const audDays = pickPeriod(req.query.aud, WIDGET_PERIODS, 30) as WidgetPeriod;
    const revDays = pickPeriod(req.query.rev, WIDGET_PERIODS, 30) as WidgetPeriod;
    const data = await getOverview({ days, audDays, revDays });
    return success(res, data);
  }),
);

export default router;
