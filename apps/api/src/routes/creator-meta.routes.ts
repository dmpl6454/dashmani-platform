import { Router, type Request, type Response } from "express";
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
  creatorOauthStateIsLive,
  pruneCreatorOauthStates,
  revokeCreatorConnections,
  startCreatorMetaOauth,
  type ConnectError,
} from "../services/creator/creator-oauth.service";
import { discoverCreatorAssets } from "../services/creator/creator-discovery.service";
import { makeBudget } from "../services/meta-oauth/oauth-graph";
import { DISCOVERY_STALE_MS, toAssetView, toConnectionView } from "../services/creator/creator-view";

// Creator portal — Facebook Login ("Connect your pages"). Contract: Phase A "Meta connect".
// ⚠️ Two steps, so the creator who STARTED the flow is the one who finishes it:
//  1. GET /oauth/callback is PUBLIC (Meta redirects the browser here with no Authorization
//     header). It exchanges NOTHING: it hands `state` + `code` back to the creators app in a URL
//     fragment (never sent to a server, never in a log or a Referer).
//  2. The creators app POSTs them to /oauth/complete with the creator's own bearer token; the
//     state is consumed only when it was started by that same creator.
// A public callback that exchanged the code itself would attach whoever clicked the facebook.com
// link to whichever account started it (review SEC-1).
const router = Router();

const startSchema = z.object({ rerequest: z.boolean().optional() }).strict();
const completeSchema = z
  .object({
    state: z.string().min(1).max(200),
    code: z.string().min(1).max(2048),
  })
  .strict();

/** Our error codes → HTTP status for /oauth/complete. The code itself is the lower-case form. */
const COMPLETE_STATUS: Record<ConnectError | "expired" | "wrong_account", number> = {
  expired: 400,
  wrong_account: 403,
  already_linked: 409,
  staff_account: 409,
  app_mismatch: 400,
  exchange_failed: 502,
  disabled: 403,
};
const COMPLETE_MESSAGE: Record<keyof typeof COMPLETE_STATUS, string> = {
  expired: "That connection attempt expired or was already used. Please start it again.",
  wrong_account: "This Facebook connection was started from a different creator account.",
  already_linked: "That Facebook account is already connected to another creator account.",
  staff_account: "This Facebook account is used by our own team and can't be connected as a creator account.",
  app_mismatch: "Facebook answered for a different app. Please start the connection again.",
  exchange_failed: "Facebook didn't finish the connection. Please try again in a moment.",
  disabled: "Connecting pages is not available for this account right now.",
};
const connectFailure = (code: keyof typeof COMPLETE_STATUS) =>
  new AppError(COMPLETE_STATUS[code], code.toUpperCase(), COMPLETE_MESSAGE[code]);

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
 * ALWAYS a 302 to the creators app — never JSON, never a hang (asyncHandler + an inner
 * try/catch): `/connect#state=…&code=…` for a live state, else `/connect?error=<code>`.
 * It reads one row and writes nothing; the exchange happens in POST /oauth/complete.
 */
router.get(
  "/creator/meta/oauth/callback",
  noStore,
  asyncHandler(async (req: Request, res: Response) => {
    const back = (suffix: string) => res.redirect(302, creatorMetaReturnUrl(suffix));
    try {
      if (!creatorConfig.enabled() || !creatorMetaConfigured()) return back("?error=disabled");
      const q = req.query as Record<string, unknown>;
      if (q.error) return back("?error=denied");
      const code = typeof q.code === "string" ? q.code : "";
      const state = typeof q.state === "string" ? q.state : "";
      if (!code || !state || code.length > 2048 || state.length > 200) return back("?error=expired");
      if (!(await creatorOauthStateIsLive(state))) {
        console.warn("[creator-meta] callback with an unknown, used or expired state");
        return back("?error=expired");
      }
      return back(`#${new URLSearchParams({ state, code }).toString()}`);
    } catch (e) {
      console.error("[creator-meta] callback failed:", scrubSecrets(String(e)));
      return back("?error=exchange_failed");
    }
  }),
);

/** Finish the connect from the creator's own signed-in browser (see the header). */
router.post(
  "/creator/meta/oauth/complete",
  requireCreatorsEnabled,
  noStore,
  authenticateCreator,
  requireActiveCreator,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = completeSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw connectFailure("expired");
    if (!creatorMetaConfigured()) {
      throw new AppError(503, "META_NOT_CONFIGURED", "Connecting Facebook is not available yet — please try again later.");
    }
    const creatorId = creatorOf(req).id;
    const consumed = await consumeCreatorOauthState(parsed.data.state, creatorId);
    if (!consumed.ok) throw connectFailure(consumed.error);
    let result;
    try {
      result = await completeCreatorConnect(creatorId, parsed.data.code);
    } catch (e) {
      console.error("[creator-meta] connect failed:", scrubSecrets(String(e)));
      throw connectFailure("exchange_failed");
    }
    if (!result.ok) throw connectFailure(result.error);
    success(res, { connected: true });
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
      select: { id: true, discoveryState: true, updatedAt: true },
    });
    if (!conn) throw new AppError(409, "NOT_CONNECTED", "Connect your Facebook account first.");
    // One discovery per connection at a time: two overlapping passes race on the same rows.
    // A "running" left behind by a restart counts as interrupted after DISCOVERY_STALE_MS.
    if (conn.discoveryState === "running" && Date.now() - conn.updatedAt.getTime() < DISCOVERY_STALE_MS) {
      throw new AppError(409, "DISCOVERY_RUNNING", "We're still checking your pages — give it a minute.");
    }

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
