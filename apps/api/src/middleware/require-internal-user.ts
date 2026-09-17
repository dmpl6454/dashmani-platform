import { Request, Response, NextFunction } from "express";
import { error } from "../utils/response";

/**
 * Allows any signed-in INTERNAL (employee-portal) user through, with no role or
 * permission check at all.
 *
 * ⚠️ WHY THIS EXISTS, AND WHY `authenticate` ALONE IS NOT ENOUGH.
 * `authenticate` (middleware/auth.ts) only verifies the JWT signature — it never
 * inspects `payload.type`. All three portals mint their access tokens with the
 * SAME `signAccessToken()` over the SAME `JWT_SECRET`, so an HR token
 * (`type: "hr"`) and a CLIENT token (`type: "client"`, `roles: []`) both verify
 * there. Until 2026-09-17 they were stopped further down the chain by accident
 * rather than design: `requirePermission` looked up `userRole` rows for a client
 * id that is not a User id and got [] → 403, and `requireAdminRole` saw an empty
 * roles array → 403. Drop those two and a CLIENT-PORTAL login would read the
 * whole company's revenue.
 *
 * So the rule is: no ROLE restriction (every employee, Team Lead, Senior
 * Employee, Admin and Super Admin is welcome), but the token must be an
 * internal one. `type: "employee"` is set by all three internal minting paths —
 * auth.service.ts login (:35) and refresh (:109), and the accept-invite path in
 * admin-features.routes.ts (:1365).
 *
 * Do NOT replace this with `requirePermission("reports", "view")`: the Employee
 * role does not hold that permission (seed.ts grants it employees.view,
 * tasks.view, tasks.edit, accounts.view, attendance.view, attendance.create),
 * so it would 403 the very people this gate exists to admit.
 */
export function requireInternalUser(req: Request, res: Response, next: NextFunction) {
  if (req.user?.type !== "employee") {
    return error(res, "FORBIDDEN", "Internal portal access only", 403);
  }
  next();
}
