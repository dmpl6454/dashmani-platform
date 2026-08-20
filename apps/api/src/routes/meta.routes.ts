/**
 * Meta read/write endpoints for the revamped Account Growth page.
 *
 * ⚠️ EVERY route here is gated on reports.manage + requireAdminRole, NOT reports.view.
 * seed.ts grants the Employee role reports.view AND accounts.view, and rbac.ts computes
 * hasPermission from {resource, action} IGNORING scope — so a view-gate would expose the
 * connected Facebook account, the granted scope list, both token expiry timestamps and
 * org-wide post engagement to every employee. reports.manage is Admin/Super-Admin-only
 * per the seed, so this needs no new role_permissions rows.
 */

import { Router, type Request, type Response } from "express";
import { prisma, type Prisma, MetaAssetKind } from "@dashmani/db";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { requireAdminRole } from "../middleware/require-admin-role";
import { asyncHandler } from "../utils/async-handler";
import { metaOauthConfigured, metaOauthMissingEnv, metaTuning } from "../services/meta-oauth/meta-config";
import { discoverConnectionAssets } from "../services/meta-oauth/meta-discovery.service";
import { runMetaPostsSync } from "../services/meta-oauth/meta-posts.service";
import { scrubSecrets } from "../utils/token-crypto";

const router = Router();

const adminGate = [authenticate, requirePermission("reports", "manage"), requireAdminRole] as const;

/** Clamp a query integer into [min,max]. An unclamped NaN would bind into SQL LIMIT. */
function clampInt(raw: unknown, dflt: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** In-memory single-flight so a double-click cannot start two syncs. */
const inFlight = new Set<string>();

/**
 * GET /admin/meta/assets — the connected Pages / IG accounts.
 * Explicit select: no *TokenEnc column can ever be serialised.
 */
router.get(
  "/admin/meta/assets",
  ...adminGate,
  asyncHandler(async (req: Request, res: Response) => {
    const limit = clampInt(req.query.limit, 50, 1, 100);
    const page = clampInt(req.query.page, 1, 1, 10_000);
    const kind: MetaAssetKind | undefined =
      req.query.kind === "facebook" ? MetaAssetKind.FACEBOOK_PAGE
      : req.query.kind === "instagram" ? MetaAssetKind.INSTAGRAM_ACCOUNT
      : undefined;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const where: Prisma.MetaAssetWhereInput = {
      disconnectedAt: null,
      ...(kind ? { kind } : {}),
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { username: { contains: q, mode: "insensitive" as const } }] } : {}),
      ...(typeof req.query.connectionId === "string" ? { connectionId: req.query.connectionId } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.metaAsset.findMany({
        where,
        orderBy: [{ kind: "asc" }, { followerCount: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, kind: true, metaId: true, name: true, username: true,
          followerCount: true, postCount: true, pictureUrl: true, selected: true,
          socialAccountId: true, lastPostSyncAt: true, lastPostSyncStatus: true,
          lastPostSyncError: true, connectionId: true,
          _count: { select: { posts: true } },
        } satisfies Prisma.MetaAssetSelect,
      }),
      prisma.metaAsset.count({ where }),
    ]);

    return res.json({
      success: true,
      data: {
        items: items.map((a) => ({
          ...a,
          postCountStored: a._count.posts,
          platform: a.kind === "FACEBOOK_PAGE" ? "facebook" : "instagram",
        })),
        page, limit, total, hasMore: page * limit < total,
      },
    });
  }),
);

/** PATCH /admin/meta/assets/:id — select/deselect (stops spending Graph calls on it). */
router.patch(
  "/admin/meta/assets/:id",
  ...adminGate,
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { selected?: boolean; socialAccountId?: string | null };
    const data: Record<string, unknown> = {};
    if (typeof body.selected === "boolean") data.selected = body.selected;
    if (body.socialAccountId !== undefined) data.socialAccountId = body.socialAccountId;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, error: { code: "NO_FIELDS", message: "Nothing to update" } });
    }
    const updated = await prisma.metaAsset.update({
      where: { id: req.params.id },
      data,
      select: { id: true, selected: true, socialAccountId: true },
    });
    return res.json({ success: true, data: updated });
  }),
);

/**
 * GET /admin/meta/posts — KEYSET paginated on (postedAt DESC, id).
 * Never `skip`: an offset scan degrades as the table grows.
 */
router.get(
  "/admin/meta/posts",
  ...adminGate,
  asyncHandler(async (req: Request, res: Response) => {
    const limit = clampInt(req.query.limit, 25, 1, 50);
    const assetId = typeof req.query.assetId === "string" ? req.query.assetId : undefined;
    const kind: MetaAssetKind | undefined =
      req.query.kind === "facebook" ? MetaAssetKind.FACEBOOK_PAGE
      : req.query.kind === "instagram" ? MetaAssetKind.INSTAGRAM_ACCOUNT
      : undefined;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    // Cursor is "<iso>|<id>" from the previous page's last row.
    let cursorWhere: Prisma.MetaPostWhereInput | undefined;
    if (typeof req.query.cursor === "string" && req.query.cursor.includes("|")) {
      const [iso, id] = req.query.cursor.split("|");
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) {
        cursorWhere = {
          OR: [{ postedAt: { lt: d } }, { AND: [{ postedAt: d }, { id: { lt: id } }] }],
        };
      }
    }

    const where: Prisma.MetaPostWhereInput = {
      asset: { disconnectedAt: null, ...(kind ? { kind } : {}), ...(assetId ? { id: assetId } : {}) },
      ...(q ? { caption: { contains: q, mode: "insensitive" as const } } : {}),
      ...(cursorWhere ?? {}),
    };

    const rows = await prisma.metaPost.findMany({
      where,
      orderBy: [{ postedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true, metaPostId: true, permalink: true, caption: true,
        mediaType: true, mediaProductType: true, postedAt: true,
        views: true, likes: true, comments: true, shares: true, saves: true, reach: true,
        metricsStatus: true, metricsFetchedAt: true,
        asset: { select: { id: true, name: true, username: true, kind: true } },
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    const pendingCount = await prisma.metaPost.count({
      where: { asset: { disconnectedAt: null }, metricsStatus: "pending" },
    });

    return res.json({
      success: true,
      data: {
        items: items.map((p) => ({
          ...p,
          platform: p.asset.kind === "FACEBOOK_PAGE" ? "facebook" : "instagram",
          postedAt: p.postedAt ? p.postedAt.toISOString() : null,
          metricsFetchedAt: p.metricsFetchedAt ? p.metricsFetchedAt.toISOString() : null,
        })),
        nextCursor: hasMore && last?.postedAt ? `${last.postedAt.toISOString()}|${last.id}` : null,
        pendingCount,
      },
    });
  }),
);

/** GET /admin/meta/posts/summary — SQL aggregate, plus honest null counts. */
router.get(
  "/admin/meta/posts/summary",
  ...adminGate,
  asyncHandler(async (_req: Request, res: Response) => {
    const [agg, total, pending, nullViews, nullLikes] = await Promise.all([
      prisma.metaPost.aggregate({
        where: { asset: { disconnectedAt: null } },
        _sum: { views: true, likes: true, comments: true, shares: true },
      }),
      prisma.metaPost.count({ where: { asset: { disconnectedAt: null } } }),
      prisma.metaPost.count({ where: { asset: { disconnectedAt: null }, metricsStatus: "pending" } }),
      prisma.metaPost.count({ where: { asset: { disconnectedAt: null }, views: null } }),
      prisma.metaPost.count({ where: { asset: { disconnectedAt: null }, likes: null } }),
    ]);
    return res.json({
      success: true,
      data: {
        postCount: total,
        totals: {
          views: agg._sum.views ?? 0,
          likes: agg._sum.likes ?? 0,
          comments: agg._sum.comments ?? 0,
          shares: agg._sum.shares ?? 0,
        },
        // Surfaced so the UI can say "N posts have no published view count" rather
        // than implying the sum covers every post.
        nullCounts: { views: nullViews, likes: nullLikes },
        pendingCount: pending,
      },
    });
  }),
);

/**
 * POST /admin/meta/connections/:id/discover — 202, fire-and-forget.
 * Discovery is ~60 Graph calls; awaiting it would risk the nginx/Cloudflare ceiling.
 */
router.post(
  "/admin/meta/connections/:id/discover",
  ...adminGate,
  asyncHandler(async (req: Request, res: Response) => {
    if (!metaOauthConfigured()) {
      return res.status(503).json({
        success: false,
        error: { code: "META_NOT_CONFIGURED", message: "Meta OAuth not configured", missing: metaOauthMissingEnv() },
      });
    }
    const id = req.params.id;
    const key = `discover:${id}`;
    if (inFlight.has(key)) {
      return res.status(202).json({ success: true, data: { accepted: false, reason: "already_running" } });
    }
    inFlight.add(key);
    void discoverConnectionAssets(id)
      .catch((e) => console.error("[meta-discovery] failed:", scrubSecrets(String(e))))
      .finally(() => inFlight.delete(key));
    return res.status(202).json({ success: true, data: { accepted: true } });
  }),
);

/**
 * POST /admin/meta/sync — 202, fire-and-forget bounded posts sync.
 * Bounded by its own call budget AND single-flight, because the removed "Refresh
 * enrichment" button once ran 59.5 minutes on an advisory bound.
 */
router.post(
  "/admin/meta/sync",
  ...adminGate,
  asyncHandler(async (req: Request, res: Response) => {
    if (!metaOauthConfigured()) {
      return res.status(503).json({
        success: false,
        error: { code: "META_NOT_CONFIGURED", message: "Meta OAuth not configured", missing: metaOauthMissingEnv() },
      });
    }
    const body = (req.body ?? {}) as { assetId?: string; connectionId?: string };
    const key = "posts-sync";
    if (inFlight.has(key)) {
      return res.status(202).json({ success: true, data: { accepted: false, reason: "already_running" } });
    }
    inFlight.add(key);
    void runMetaPostsSync({
      assetId: body.assetId,
      connectionId: body.connectionId,
      budgetMax: body.assetId ? metaTuning.refreshCallBudget() : undefined,
    })
      .catch((e) => console.error("[meta-posts] failed:", scrubSecrets(String(e))))
      .finally(() => inFlight.delete(key));
    return res.status(202).json({ success: true, data: { accepted: true } });
  }),
);

/** GET /admin/meta/status — what the ops strip renders. */
router.get(
  "/admin/meta/status",
  ...adminGate,
  asyncHandler(async (_req: Request, res: Response) => {
    const [connections, assets, selected, posts, pending] = await Promise.all([
      prisma.metaConnection.count({ where: { revokedAt: null } }),
      prisma.metaAsset.count({ where: { disconnectedAt: null } }),
      prisma.metaAsset.count({ where: { disconnectedAt: null, selected: true } }),
      prisma.metaPost.count({ where: { asset: { disconnectedAt: null } } }),
      prisma.metaPost.count({ where: { asset: { disconnectedAt: null }, metricsStatus: "pending" } }),
    ]);
    return res.json({
      success: true,
      data: {
        configured: metaOauthConfigured(),
        missingEnv: metaOauthMissingEnv(),
        running: inFlight.size > 0,
        connections, assets, selectedAssets: selected,
        posts, pendingMetrics: pending,
        intervalMs: metaTuning.postsIntervalMs(),
      },
    });
  }),
);

export default router;
