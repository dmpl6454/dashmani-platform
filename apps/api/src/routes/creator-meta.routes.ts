import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "@dashmani/db";
import { asyncHandler } from "../utils/async-handler";
import { AppError } from "../middleware/error-handler";
import { success } from "../utils/response";
import { scrubSecrets } from "../utils/token-crypto";
import { authenticateCreator, creatorOf, requireActiveCreator, requireCreatorsEnabled } from "../middleware/creator-auth";
import { creatorConfig } from "../services/creator/creator-config";
import { creatorMetaConfigured, creatorMetaReturnUrl } from "../services/creator/creator-meta-config";
import {
  completeCreatorConnect,
  consumeCreatorOauthState,
  pruneCreatorOauthStates,
  revokeCreatorConnections,
  startCreatorMetaOauth,
} from "../services/creator/creator-oauth.service";
import { discoverCreatorAssets } from "../services/creator/creator-discovery.service";
import { makeBudget } from "../services/meta-oauth/oauth-graph";
import { toAssetView, toConnectionView } from "../services/creator/creator-view";

// Creator portal — Facebook Login ("Connect your pages"). Contract: Phase A "Meta connect".
// The callback is PUBLIC (Meta redirects the browser here with no Authorization header); the
// one-time creator_oauth_states row binds it to the creator who started it.
const router = Router();

const callbackLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });
const startSchema = z.object({ rerequest: z.boolean().optional() }).strict();

/** Re-running discovery by hand: at most once per 10 minutes per creator. */
const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
const lastRefresh = new Map<string, number>();
/** Test hook: the cooldown map is module state (the documented cross-test class). */
export function resetCreatorRefreshThrottle() {
  lastRefresh.clear();
}

/** The creator's live connection (newest non-revoked) and every page they have connected. */
async function connectionPayload(creatorId: string) {
  const [conn, assets] = await Promise.all([
    prisma.creatorConnection.findFirst({ where: { creatorId, revokedAt: null }, orderBy: { createdAt: "desc" } }),
    prisma.creatorAsset.findMany({
      where: { creatorId },
      orderBy: [{ disconnectedAt: { sort: "asc", nulls: "first" } }, { kind: "asc" }, { name: "asc" }],
    }),
  ]);
  return { connection: conn ? toConnectionView(conn) : null, assets: assets.map(toAssetView) };
}

const noStore = (_req: Request, res: Response, next: () => void) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

router.post(
  "/creator/meta/oauth/start",
  requireCreatorsEnabled,
  noStore,
  authenticateCreator,
  requireActiveCreator,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = startSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid request");
    if (!creatorMetaConfigured()) {
      throw new AppError(503, "META_NOT_CONFIGURED", "Connecting Facebook is not available yet — please try again later.");
    }
    void pruneCreatorOauthStates();
    const { authorizeUrl } = await startCreatorMetaOauth({ creatorId: creatorOf(req).id, rerequest: parsed.data.rerequest === true });
    success(res, { authorizeUrl });
  }),
);

/**
 * ALWAYS a 302 to `${appUrl}/connect?connected=1` or `?error=<code>` — never JSON, never a hang
 * (asyncHandler + an inner try/catch). The query is one of our literal codes; Meta's own
 * error text goes to the log only, scrubbed.
 */
router.get(
  "/creator/meta/oauth/callback",
  callbackLimiter,
  noStore,
  asyncHandler(async (req: Request, res: Response) => {
    const back = (search: string) => res.redirect(302, creatorMetaReturnUrl(search));
    try {
      if (!creatorConfig.enabled() || !creatorMetaConfigured()) return back("?error=disabled");
      const q = req.query as Record<string, unknown>;
      if (q.error) return back("?error=denied");
      const code = typeof q.code === "string" ? q.code : "";
      const state = typeof q.state === "string" ? q.state : "";
      if (!code || !state || code.length > 2048) return back("?error=expired");

      const consumed = await consumeCreatorOauthState(state);
      if (!consumed) {
        console.warn("[creator-meta] callback with an unknown, used or expired state");
        return back("?error=expired");
      }
      const result = await completeCreatorConnect(consumed.creatorId, code);
      return back(result.ok ? "?connected=1" : `?error=${result.error}`);
    } catch (e) {
      console.error("[creator-meta] callback failed:", scrubSecrets(String(e)));
      return back("?error=exchange_failed");
    }
  }),
);

router.get(
  "/creator/meta/connection",
  requireCreatorsEnabled,
  noStore,
  authenticateCreator,
  asyncHandler(async (req: Request, res: Response) => {
    success(res, await connectionPayload(creatorOf(req).id));
  }),
);

router.post(
  "/creator/meta/refresh",
  requireCreatorsEnabled,
  noStore,
  authenticateCreator,
  requireActiveCreator,
  asyncHandler(async (req: Request, res: Response) => {
    const creatorId = creatorOf(req).id;
    const conn = await prisma.creatorConnection.findFirst({
      where: { creatorId, revokedAt: null, userTokenEnc: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!conn) throw new AppError(409, "NOT_CONNECTED", "Connect your Facebook account first.");

    const now = Date.now();
    const last = lastRefresh.get(creatorId);
    if (last && now - last < REFRESH_COOLDOWN_MS) {
      const mins = Math.ceil((REFRESH_COOLDOWN_MS - (now - last)) / 60_000);
      throw new AppError(429, "TOO_SOON", `You can refresh again in ${mins} minute${mins === 1 ? "" : "s"}.`);
    }
    lastRefresh.set(creatorId, now);
    // Bounded: drop stale entries so the map cannot grow without limit.
    if (lastRefresh.size > 5000) {
      for (const [k, t] of lastRefresh) if (now - t >= REFRESH_COOLDOWN_MS) lastRefresh.delete(k);
    }

    await discoverCreatorAssets(conn.id, makeBudget(150));
    success(res, await connectionPayload(creatorId));
  }),
);

/** LOCAL revoke only. ⚠️ Never calls Meta's DELETE /{user}/permissions. */
router.delete(
  "/creator/meta/connection",
  requireCreatorsEnabled,
  noStore,
  authenticateCreator,
  asyncHandler(async (req: Request, res: Response) => {
    await revokeCreatorConnections(creatorOf(req).id);
    success(res, { disconnected: true });
  }),
);

export default router;
