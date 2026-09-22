/**
 * The YouTube and Snapchat boards on Account Growth, plus their add/remove.
 *
 * ⚠️ Gated on reports.manage + requireAdminRole, matching meta.routes.ts — NOT reports.view.
 * seed.ts grants the Employee role reports.view, and rbac.ts ignores scope, so a view-gate
 * would open this to every employee. These endpoints sit on the same page as the Meta
 * board, so they must not be easier to reach than it.
 */

import { Router, type Request, type Response } from "express";
import { prisma } from "@dashmani/db";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { requireAdminRole } from "../middleware/require-admin-role";
import { asyncHandler } from "../utils/async-handler";
import {
  getChannelBoard,
  CHANNEL_PLATFORMS,
  CHANNEL_PERIODS,
  DEFAULT_CHANNEL_PERIOD,
  type ChannelPlatform,
  type ChannelPeriod,
} from "../services/channel-growth.service";
import { scrapeSnapchatProfile, snapchatProfileUrl } from "../services/social-insights/snapchat-profile";
import { resolveYouTubeChannel } from "../services/social-insights/youtube-followers";

const router = Router();
const adminGate = [authenticate, requirePermission("reports", "manage"), requireAdminRole] as const;

/**
 * Single-flight per (platform, handle) so a double-click cannot fire two outbound
 * lookups. The lookup is awaited inside the request — deliberately, because a typo must
 * fail loudly — but it is bounded by the resolver's own 10–12s AbortController and holds
 * NO database connection while it runs.
 */
const resolving = new Set<string>();

function isPlatform(v: unknown): v is ChannelPlatform {
  return typeof v === "string" && (CHANNEL_PLATFORMS as readonly string[]).includes(v);
}

function pickPeriod(raw: unknown): ChannelPeriod {
  const n = Number(raw);
  return (CHANNEL_PERIODS as readonly number[]).includes(n) ? (n as ChannelPeriod) : DEFAULT_CHANNEL_PERIOD;
}

/** Normalise whatever was pasted into a storable handle. */
function cleanHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").split(/[?#]/)[0].trim();
}

/** GET /admin/channels?platform=youtube|snapchat&days=30 */
router.get(
  "/admin/channels",
  ...adminGate,
  asyncHandler(async (req: Request, res: Response) => {
    const platform = req.query.platform;
    if (!isPlatform(platform)) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_PLATFORM", message: `platform must be one of ${CHANNEL_PLATFORMS.join(", ")}` },
      });
    }
    const board = await getChannelBoard(platform, pickPeriod(req.query.days));
    return res.json({ success: true, data: board });
  }),
);

/**
 * POST /admin/channels — add a channel, resolving it LIVE first.
 *
 * The resolve is the point of this endpoint: it is what turns a mistyped handle into an
 * immediate, explainable rejection instead of a row that silently never collects data.
 * The response echoes back the resolved title and follower count so the admin can see
 * WHICH channel they just added — a handle resolving 200 proves a page exists, not that
 * it is the right one.
 */
router.post(
  "/admin/channels",
  ...adminGate,
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { platform?: unknown; handle?: unknown };
    if (!isPlatform(body.platform) || typeof body.handle !== "string" || !body.handle.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "Provide platform (youtube|snapchat) and handle." },
      });
    }
    const platform = body.platform;
    const handle = cleanHandle(body.handle);
    if (!handle) {
      return res.status(400).json({ success: false, error: { code: "BAD_REQUEST", message: "Handle is empty." } });
    }

    const plat = await prisma.platform.findUnique({ where: { slug: platform }, select: { id: true } });
    if (!plat) {
      return res.status(400).json({
        success: false,
        error: { code: "NO_PLATFORM", message: `Platform "${platform}" is not configured.` },
      });
    }

    // Already tracked? Restore it rather than creating a duplicate — the pair is unique.
    const existing = await prisma.socialAccount.findFirst({
      where: { platformId: plat.id, handle: { equals: handle, mode: "insensitive" } },
      select: { id: true, handle: true, displayName: true, status: true },
    });
    if (existing && existing.status !== "ARCHIVED") {
      return res.status(409).json({
        success: false,
        error: { code: "ALREADY_TRACKED", message: `@${existing.handle} is already on this board.` },
      });
    }

    const key = `${platform}:${handle.toLowerCase()}`;
    if (resolving.has(key)) {
      return res.status(409).json({
        success: false,
        error: { code: "IN_PROGRESS", message: "That handle is already being looked up." },
      });
    }
    resolving.add(key);

    // ── resolve BEFORE touching the database; hold no connection across the network ──
    let displayName: string;
    let profileUrl: string;
    let followers: number | null = null;
    let precision: number | null = null;
    let totalViews: number | null = null;
    let videoCount: number | null = null;
    try {
      if (platform === "youtube") {
        const yt = await resolveYouTubeChannel(handle);
        if (!yt) {
          return res.status(400).json({
            success: false,
            error: {
              code: "NOT_FOUND",
              message: `YouTube has no channel for "${handle}". Paste the @handle, the channel URL, or the UC… id.`,
            },
          });
        }
        displayName = yt.title;
        profileUrl = `https://www.youtube.com/channel/${yt.channelId}`;
        followers = yt.subscribers;
        precision = yt.subscriberPrecision;
        totalViews = yt.totalViews;
        videoCount = yt.videoCount;
      } else {
        const sc = await scrapeSnapchatProfile(handle);
        if (!sc.ok) {
          return res.status(400).json({
            success: false,
            error: {
              code: "NOT_FOUND",
              message: sc.walled
                ? "Snapchat did not answer just now. Try again in a minute."
                : `Snapchat has no public profile at @${handle}. Check the spelling.`,
            },
          });
        }
        displayName = sc.displayName ?? handle;
        profileUrl = snapchatProfileUrl(handle).replace("?locale=en-US", "");
        followers = sc.followers;
      }
    } finally {
      resolving.delete(key);
    }

    const data = {
      handle,
      displayName,
      profileUrl,
      platformId: plat.id,
      status: "ACTIVE" as const,
      // ⚠️ Only write a follower count we actually measured. Snapchat withholds it on 7 of
      // 34 profiles, and a stored 0 would render as a real "no followers".
      ...(followers != null ? { followerCount: followers, syncSource: "api", lastSyncedAt: new Date() } : {}),
      ...(platform === "snapchat" && followers != null ? { syncSource: "scraper" } : {}),
      followersPrecision: precision,
      ...(totalViews != null ? { totalViews: BigInt(totalViews) } : {}),
      ...(videoCount != null ? { videoCount } : {}),
      metricsError: null,
    };

    const account = existing
      ? await prisma.socialAccount.update({ where: { id: existing.id }, data })
      : await prisma.socialAccount.create({ data });

    return res.status(201).json({
      success: true,
      data: {
        id: account.id,
        handle: account.handle,
        displayName: account.displayName,
        profileUrl: account.profileUrl,
        followers,
        restored: Boolean(existing),
      },
    });
  }),
);

/**
 * PATCH /admin/channels/:id — remove from / restore to the board.
 *
 * ⚠️ ARCHIVED is a SOFT removal and is deliberately not a delete: `report_links.accountId`
 * references these rows, and the growth history is worth keeping so a restored channel
 * does not come back blank.
 */
router.patch(
  "/admin/channels/:id",
  ...adminGate,
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { active?: unknown };
    if (typeof body.active !== "boolean") {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "Provide active: boolean" },
      });
    }
    const account = await prisma.socialAccount.findUnique({
      where: { id: req.params.id },
      select: { id: true, platform: { select: { slug: true } } },
    });
    if (!account || !(CHANNEL_PLATFORMS as readonly string[]).includes(account.platform.slug)) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "No such channel on this board." },
      });
    }
    const updated = await prisma.socialAccount.update({
      where: { id: account.id },
      data: { status: body.active ? "ACTIVE" : "ARCHIVED" },
      select: { id: true, handle: true, status: true },
    });
    return res.json({ success: true, data: updated });
  }),
);

/** GET /admin/channels/removed?platform= — what a restore would offer. */
router.get(
  "/admin/channels/removed",
  ...adminGate,
  asyncHandler(async (req: Request, res: Response) => {
    const platform = req.query.platform;
    if (!isPlatform(platform)) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_PLATFORM", message: `platform must be one of ${CHANNEL_PLATFORMS.join(", ")}` },
      });
    }
    const rows = await prisma.socialAccount.findMany({
      where: { platform: { slug: platform }, status: "ARCHIVED" },
      select: { id: true, handle: true, displayName: true, followerCount: true },
      orderBy: { followerCount: "desc" },
      take: 200,
    });
    return res.json({ success: true, data: { rows } });
  }),
);

export default router;
