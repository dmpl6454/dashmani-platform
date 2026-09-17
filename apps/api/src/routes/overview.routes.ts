import { Router, type Request, type Response } from "express";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { requireAdminRole } from "../middleware/require-admin-role";
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

// Same gate as the Meta channel endpoints: the payload carries revenue and
// per-channel earnings, which an Employee's reports.view permission must not reach.
const adminGate = [authenticate, requirePermission("reports", "manage"), requireAdminRole] as const;

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
  ...adminGate,
  asyncHandler(async (req: Request, res: Response) => {
    const days = pickPeriod(req.query.days, OVERVIEW_PERIODS, 7) as OverviewPeriod;
    const audDays = pickPeriod(req.query.aud, WIDGET_PERIODS, 30) as WidgetPeriod;
    const revDays = pickPeriod(req.query.rev, WIDGET_PERIODS, 30) as WidgetPeriod;
    const data = await getOverview({ days, audDays, revDays });
    return success(res, data);
  }),
);

export default router;
