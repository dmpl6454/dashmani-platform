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
 * GET /admin/overview?days=7|14|30|90&aud=&rev=&vbc=&trac=
 *
 * `days` is the GLOBAL period: it drives the KPI strip, the channel tables and every
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
    const days = pickPeriod(req.query.days, OVERVIEW_PERIODS, 7) as OverviewPeriod;
    const widget = (raw: unknown) => pickPeriod(raw, WIDGET_PERIODS, 0) as WidgetPeriod;
    const data = await getOverview({
      days,
      audDays: widget(req.query.aud),
      revDays: widget(req.query.rev),
      vbcDays: widget(req.query.vbc),
      tracDays: widget(req.query.trac),
    });
    return success(res, data);
  }),
);

export default router;
