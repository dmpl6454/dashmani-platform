/**
 * Meta OAuth — start (admin) + callback (PUBLIC).
 *
 * The callback lives OUTSIDE /admin deliberately, so its public-ness is legible
 * from the path itself. It must be public: Meta redirects the admin's browser here
 * with no Authorization header, and this API has no cookies. The session binding
 * comes from the one-time MetaOAuthState row, not from any credential on the request.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "@dashmani/db";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { requireAdminRole } from "../middleware/require-admin-role";
import { asyncHandler } from "../utils/async-handler";
import {
  metaOauthConfigured,
  metaOauthMissingEnv,
  metaOauthReturnUrl,
} from "../services/meta-oauth/meta-config";
import {
  startMetaOauth,
  consumeMetaOauthState,
  exchangeCodeForLongLivedToken,
  persistConnection,
  pruneExpiredOauthStates,
} from "../services/meta-oauth/meta-oauth.service";
import { scrubSecrets } from "../utils/token-crypto";

const router = Router();

/** The callback is unauthenticated, so it gets its own tight limiter. */
const callbackLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST (not GET) /admin/meta/oauth/start
 *
 * POST because it INSERTs a state row. A state-mutating GET is prefetchable by
 * browsers, link scanners and chat clients, which would silently burn state rows.
 */
router.post(
  "/admin/meta/oauth/start",
  authenticate,
  requirePermission("reports", "manage"),
  requireAdminRole,
  asyncHandler(async (req: Request, res: Response) => {
    if (!metaOauthConfigured()) {
      return res.status(503).json({
        success: false,
        error: {
          code: "META_NOT_CONFIGURED",
          message: "Meta OAuth is not configured on this server.",
          missing: metaOauthMissingEnv(),
        },
      });
    }

    // authenticate() guarantees req.user; JwtPayload.userId is the User.id.
    const userId = req.user!.userId;
    const body = (req.body ?? {}) as {
      mode?: "connect" | "reconnect";
      connectionId?: string;
      rerequest?: boolean;
    };

    // Opportunistic housekeeping; never blocks the response path.
    void pruneExpiredOauthStates();

    const started = await startMetaOauth({
      userId,
      mode: body.mode === "reconnect" ? "reconnect" : "connect",
      connectionId: body.connectionId,
      rerequest: body.rerequest === true,
    });

    return res.json({
      success: true,
      data: {
        authorizeUrl: started.authorizeUrl,
        state: started.state,
        expiresAt: started.expiresAt.toISOString(),
      },
    });
  }),
);

/**
 * GET /meta/oauth/callback — PUBLIC. Always 302, never JSON.
 *
 * ⚠️ asyncHandler is MANDATORY here, not decorative. Express 4 does not catch async
 * rejections: an unwrapped async handler that throws never calls next(), so
 * errorHandler never runs and THE REQUEST HANGS until the nginx timeout while
 * index.ts logs an unhandledRejection and (deliberately) keeps the process alive.
 * A hung browser tab is a far worse failure than a redirect carrying ?meta=error.
 * Hence asyncHandler AND an internal try/catch.
 *
 * ⚠️ NO validate() ON THE QUERY. middleware/validate.ts reassigns req[source] to the
 * parsed result, which would silently strip error, error_reason, error_description,
 * granted_scopes and denied_scopes — exactly the fields we need to tell "user said no"
 * apart from "something broke".
 */
router.get(
  "/meta/oauth/callback",
  callbackLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    // Cloudflare fronts every host; a cached OAuth callback would be catastrophic.
    res.setHeader("Cache-Control", "no-store");

    const redirectBack = (search: string) => {
      try {
        return res.redirect(302, metaOauthReturnUrl(search));
      } catch {
        // Only reachable if META_OAUTH_RETURN_ORIGIN is malformed. Say so plainly
        // rather than emitting `Location: undefined/...`.
        return res
          .status(500)
          .type("text/plain")
          .send("Meta connection finished but META_OAUTH_RETURN_ORIGIN is misconfigured.");
      }
    };

    try {
      if (!metaOauthConfigured()) {
        return redirectBack("?meta=error&reason=config");
      }

      const q = req.query as Record<string, string | undefined>;

      // The user declined, or Meta refused before issuing a code.
      if (q.error) {
        const denied = q.error === "access_denied" || q.error_reason === "user_denied";
        return redirectBack(denied ? "?meta=denied" : "?meta=error&reason=denied");
      }

      const code = typeof q.code === "string" ? q.code : "";
      const state = typeof q.state === "string" ? q.state : "";
      if (!code || !state) {
        return redirectBack("?meta=error&reason=state");
      }

      // Atomic one-time consume. Unknown / reused / expired all land here.
      const consumed = await consumeMetaOauthState(state);
      if (!consumed) {
        return redirectBack("?meta=error&reason=state");
      }

      const outcome = await exchangeCodeForLongLivedToken(code);
      if (!outcome.ok || !outcome.longLivedToken || !outcome.debug) {
        // The Graph message goes to the server log only — never into a URL.
        console.error(
          "[meta-oauth] token exchange failed:",
          scrubSecrets(outcome.error ?? "unknown"),
        );
        return redirectBack(`?meta=error&reason=${outcome.reason ?? "exchange"}`);
      }

      const saved = await persistConnection({
        connectedById: consumed.userId,
        longLivedToken: outcome.longLivedToken,
        debug: outcome.debug,
      });

      // Discovery is ~61 Graph calls — FIRE AND FORGET, never awaited here.
      // (Wired in the next PR; the connection is already usable/inspectable.)

      const params = new URLSearchParams({ meta: "connected", conn: saved.id });
      if (saved.partialScope) params.set("partial", "1");
      return redirectBack(`?${params.toString()}`);
    } catch (e) {
      // NEVER next(e) — that would render the JSON error envelope into a browser tab.
      console.error("[meta-oauth] callback failed:", scrubSecrets(String(e)));
      return redirectBack("?meta=error&reason=unknown");
    }
  }),
);

/**
 * GET /admin/meta/connections — connection inventory for the admin UI.
 * Uses an explicit `select` so no *TokenEnc column can ever be serialised, even
 * if a future field is added to the model.
 */
router.get(
  "/admin/meta/connections",
  authenticate,
  requirePermission("reports", "manage"),
  requireAdminRole,
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await prisma.metaConnection.findMany({
      where: { revokedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        metaUserId: true,
        metaUserName: true,
        status: true,
        grantedScopes: true,
        granularScopes: false,
        tokenExpiresAt: true,
        dataAccessExpiresAt: true,
        graphVersion: true,
        discoveryState: true,
        capabilities: true,
        lastVerifiedAt: true,
        lastSyncedAt: true,
        lastError: true,
        createdAt: true,
        connectedBy: { select: { id: true, name: true } },
        _count: { select: { assets: true } },
      },
    });

    const { serializeConnection } = await import("../services/meta-oauth/meta-oauth.service");

    return res.json({
      success: true,
      data: {
        configured: metaOauthConfigured(),
        missingEnv: metaOauthMissingEnv(),
        connections: rows.map((r) => ({
          ...serializeConnection(r as never),
          assetCount: r._count.assets,
        })),
      },
    });
  }),
);

/**
 * DELETE /admin/meta/connections/:id — soft revoke.
 *
 * Nulls the user token AND every child Page token, so a revoked connection holds
 * no secret at rest. Posts are RETAINED (they are historical reporting data, not
 * credentials) and assets are stamped disconnectedAt.
 */
router.delete(
  "/admin/meta/connections/:id",
  authenticate,
  requirePermission("reports", "manage"),
  requireAdminRole,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const existing = await prisma.metaConnection.findUnique({ where: { id } });
      if (!existing) {
        return res
          .status(404)
          .json({ success: false, error: { code: "NOT_FOUND", message: "Connection not found" } });
      }

      const now = new Date();
      const [, assets] = await prisma.$transaction([
        prisma.metaConnection.update({
          where: { id },
          data: { status: "REVOKED", revokedAt: now, userTokenEnc: null },
        }),
        prisma.metaAsset.updateMany({
          where: { connectionId: id },
          data: { pageTokenEnc: null, disconnectedAt: now, selected: false },
        }),
      ]);

      const postsRetained = await prisma.metaPost.count({
        where: { asset: { connectionId: id } },
      });

      return res.json({
        success: true,
        data: {
          revoked: true,
          assetsDisconnected: assets.count,
          postsRetained,
          // Provider-side permission revoke is wired with discovery in the next PR.
          metaRevokeAttempted: false,
        },
      });
    } catch (e) {
      return next(e);
    }
  }),
);

export default router;
