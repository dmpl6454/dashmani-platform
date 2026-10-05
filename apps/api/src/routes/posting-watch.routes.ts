/**
 * Posting watch route — the dashboard's "assigned channels with no new post for 2h+" card.
 * Service: services/meta-oauth/posting-watch.service.ts (rules: posting-watch-rules.ts).
 *
 * DB-only: Meta is called by the background poller, never here.
 */
import { Router, type Request, type Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireInternalUser } from "../middleware/require-internal-user";
import { requireAdminRole } from "../middleware/require-admin-role";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import { getPostingWatch } from "../services/meta-oauth/posting-watch.service";

const router = Router();

/**
 * Admins only, decided from the signed JWT with NO database query.
 *
 * The card polls once a minute per open dashboard, and the Meta adminGate's
 * requirePermission runs a multi-query permission lookup on EVERY request — a cost worth
 * paying on a write, not on a poll. The payload is channel names, post times and the
 * names of the people assigned to them (no revenue, no tokens), so the JWT's role claim is
 * the right weight of check; requireInternalUser keeps HR- and client-portal tokens out
 * (all three portals sign with the same secret).
 */
const readGate = [authenticate, requireInternalUser, requireAdminRole] as const;

/** GET /admin/meta/posting-watch — the card's payload. Always 200 with an honest status. */
router.get(
  "/admin/meta/posting-watch",
  ...readGate,
  asyncHandler(async (_req: Request, res: Response) => {
    const data = await getPostingWatch();
    // A live monitor: never serve it from a browser or proxy cache.
    res.setHeader("Cache-Control", "no-store");
    return success(res, data);
  }),
);

export default router;
