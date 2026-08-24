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
import { runMetaChannelSync, resolveContestedOwners, CHANNEL_WINDOWS, type ChannelWindow } from "../services/meta-oauth/meta-channels.service";
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
      // ⚠️ MUST exclude `pending`, or the two counts conflate two different facts.
      // A pending post has views=NULL because we HAVE NOT ASKED YET — reporting it as
      // "Meta publishes no view count" is a false statement about Meta. Only a post we
      // actually measured and got nothing for belongs in that sentence. (Observed live:
      // both numbers rendered as an identical 2,533 and the copy claimed Meta published
      // nothing for all of them, when in truth none had been polled.)
      prisma.metaPost.count({
        where: { asset: { disconnectedAt: null }, views: null, metricsStatus: { not: "pending" } },
      }),
      prisma.metaPost.count({
        where: { asset: { disconnectedAt: null }, likes: null, metricsStatus: { not: "pending" } },
      }),
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
    // Channels FIRST — they are the headline data and cost ~1 call each, so they
    // must never be starved by the far more expensive per-post pass behind them.
    void runMetaChannelSync({ assetId: body.assetId })
      .then(() =>
        runMetaPostsSync({
          assetId: body.assetId,
          connectionId: body.connectionId,
          budgetMax: body.assetId ? metaTuning.refreshCallBudget() : undefined,
        }),
      )
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

/**
 * GET /admin/meta/channels — THE primary Account Growth view.
 *
 * One row per connected Page / IG account with its WHOLE-CHANNEL metrics. This is
 * what an admin monitors; individual posts are a drill-down, not the headline.
 * BigInt columns are serialised to Number for JSON (values are far below 2^53).
 */
router.get(
  "/admin/meta/channels",
  ...adminGate,
  asyncHandler(async (req: Request, res: Response) => {
    const kind: MetaAssetKind | undefined =
      req.query.platform === "facebook" ? MetaAssetKind.FACEBOOK_PAGE
      : req.query.platform === "instagram" ? MetaAssetKind.INSTAGRAM_ACCOUNT
      : undefined;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const sort = typeof req.query.sort === "string" ? req.query.sort : "followers";

    // Time window. Only what Meta measures natively — see CHANNEL_WINDOWS. An
    // unknown value falls back to the default rather than 400ing, so a stale
    // bookmark degrades to the normal view instead of an error page.
    const requested = typeof req.query.window === "string" ? req.query.window : "";
    const window: ChannelWindow =
      (CHANNEL_WINDOWS as readonly string[]).includes(requested)
        ? (requested as ChannelWindow)
        : "days_28";

    const where: Prisma.MetaAssetWhereInput = {
      disconnectedAt: null,
      ...(kind ? { kind } : {}),
      ...(q
        ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { username: { contains: q, mode: "insensitive" as const } }] }
        : {}),
    };

    // ⚠️ Only followers/name can be ordered in SQL. views and engagements now live
    // on a per-window relation, and Prisma cannot ORDER BY a filtered to-many
    // relation's column — so those two are sorted in JS below, over the same
    // bounded 200-row page. Ordering here by the fixed *_28d columns would be
    // worse than useless: it would silently sort a 1-day view by 28-day numbers.
    const orderBy: Prisma.MetaAssetOrderByWithRelationInput =
      sort === "name" ? { name: "asc" } : { followerCount: { sort: "desc", nulls: "last" } };

    const rows = await prisma.metaAsset.findMany({
      where,
      orderBy,
      take: 200,
      select: {
        id: true, kind: true, metaId: true, name: true, username: true,
        followerCount: true, postCount: true, pictureUrl: true, selected: true,
        socialAccountId: true,
        views28d: true, engagements28d: true, profileViews28d: true,
        reach28d: true, reactions28d: true,
        metricsFetchedAt: true, metricsError: true,
        lastPostSyncAt: true,
        windowMetrics: { where: { window }, take: 1 },
        _count: { select: { posts: true } },
      },
    });

    // ── Follower change over the selected period ──────────────────────────
    //
    // ⚠️ API-SOURCED SNAPSHOTS ONLY. Account Growth is a verified-data-only
    // surface (owner decision 2026-08-24), and a delta measured against a
    // scraped baseline would put unverifiable numbers back on the page through
    // the back door — including the display-string staircases where the scraper
    // was reading Facebook's rounded "14M" text.
    //
    // ⚠️ AND IT RETURNS NULL, NEVER 0, WHEN THERE IS NO HISTORY SPANNING THE
    // WINDOW. API follower history begins 2026-08-24, so today the only snapshot
    // is today's — and "current minus current" is 0. Rendering that 0 would
    // assert "this channel did not grow in 28 days", which we do not know. The
    // baseline must be from a date strictly BEFORE today for a delta to exist;
    // otherwise it is absent and shows as a dash. This activates on its own:
    // 24h tomorrow, 7d in a week, 28d in four weeks.
    const windowDays = window === "day" ? 1 : window === "week" ? 7 : 28;
    const followerDelta = new Map<string, number>();
    const accountIds = rows.map((r) => r.socialAccountId).filter((x): x is string => x !== null);
    if (accountIds.length > 0) {
      const since = new Date(Date.now() - windowDays * 86_400_000);
      since.setUTCHours(0, 0, 0, 0);
      const todayKey = new Date();
      todayKey.setUTCHours(0, 0, 0, 0);

      const snaps = await prisma.accountGrowthSnapshot.findMany({
        where: { accountId: { in: accountIds }, source: "api", date: { gte: since } },
        orderBy: { date: "asc" },
        select: { accountId: true, date: true, followerCount: true },
      });
      // Earliest in-window point per account (rows arrive date-ascending).
      const baseline = new Map<string, { date: Date; followers: number }>();
      for (const sn of snaps) {
        if (!baseline.has(sn.accountId)) {
          baseline.set(sn.accountId, { date: sn.date, followers: sn.followerCount });
        }
      }
      // ⚠️ A channel row can be claimed by two different Pages that share a name
      // (three such collisions on prod). Its follower history belongs to ONE of
      // them, so only that one gets a delta — otherwise the 5.2m "The Candid
      // Couch" Page would display a change computed from the 132k Page's history.
      const owners = await resolveContestedOwners();
      for (const r of rows) {
        if (!r.socialAccountId || r.followerCount === null) continue;
        const owner = owners.get(r.socialAccountId);
        if (owner !== undefined && owner !== r.id) continue;
        const b = baseline.get(r.socialAccountId);
        // Same-day baseline ⇒ no span ⇒ no delta (see the note above).
        if (!b || b.date.getTime() >= todayKey.getTime()) continue;
        followerDelta.set(r.id, r.followerCount - b.followers);
      }
    }

    const n = (v: bigint | null | undefined) => (v === null || v === undefined ? null : Number(v));

    /**
     * Figures for the requested window.
     *
     * ⚠️ NO FALLBACK TO ANOTHER WINDOW. If the selected window has no row yet
     * (a channel connected since the last sync, or a window that errored), every
     * metric is null and renders as an em-dash. Substituting the 28-day numbers
     * would label 28 days of activity as "today" — a wrong number presented
     * confidently, which is worse than an honest blank.
     */
    const win = (r: { windowMetrics: Array<{ views: bigint | null; reach: bigint | null; engagements: bigint | null; profileViews: bigint | null; reactions: bigint | null; followerDelta: number | null; earningsCents: number | null; fetchedAt: Date | null; periodEnd: Date | null; error: string | null }> }) =>
      r.windowMetrics[0];

    // Totals sum ONLY non-null values, and we report how many channels actually
    // contributed — otherwise a total looks like it covers all 120 when it may
    // cover 40, which is the "confident but wrong" failure this page must avoid.
    const totals = { followers: 0, views: 0, engagements: 0, reach: 0, earningsCents: 0 };
    const contributing = { views: 0, engagements: 0, reach: 0, earnings: 0 };
    for (const r of rows) {
      const w = win(r);
      totals.followers += r.followerCount ?? 0;
      if (w?.views != null) { totals.views += Number(w.views); contributing.views++; }
      if (w?.engagements != null) { totals.engagements += Number(w.engagements); contributing.engagements++; }
      if (w?.reach != null) { totals.reach += Number(w.reach); contributing.reach++; }
      // Only Pages that actually earn count towards "reporting" — 39 of 72 are at
      // a true zero, and counting them would imply coverage we do not have.
      if (w?.earningsCents != null) {
        totals.earningsCents += w.earningsCents;
        if (w.earningsCents > 0) contributing.earnings++;
      }
    }

    // Sort by a windowed metric in JS (see the orderBy note). Nulls last, so a
    // channel Meta has not measured never outranks one it has.
    if (sort === "views" || sort === "engagements") {
      const key = sort === "views" ? ("views" as const) : ("engagements" as const);
      rows.sort((a, b) => {
        const av = win(a)?.[key], bv = win(b)?.[key];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return Number(bv) - Number(av);
      });
    }

    return res.json({
      success: true,
      data: {
        window,
        windows: CHANNEL_WINDOWS,
        /**
         * The newest moment Meta has published for this window.
         *
         * ⚠️ Facebook only publishes CLOSED periods: the newest point is stamped at
         * the Page's local midnight, so a figure fetched this afternoon still
         * describes a window that ended yesterday. Meta's own app adds today so
         * far, which is why its numbers run slightly ahead of ours and read as a
         * mismatch. Exposing the boundary turns that into something explicable
         * rather than something that looks wrong.
         */
        dataThrough: rows.reduce<string | null>((acc, r) => {
          // ⚠️ periodEnd, NOT fetchedAt. The fetch time says when we asked; only
          // Meta's own end_time says what the numbers describe.
          const f = win(r)?.periodEnd;
          if (!f) return acc;
          const iso = f.toISOString();
          return acc === null || iso > acc ? iso : acc;
        }, null),
        items: rows.map((r) => ({
          id: r.id,
          platform: r.kind === "FACEBOOK_PAGE" ? "facebook" : "instagram",
          metaId: r.metaId,
          name: r.name,
          username: r.username,
          pictureUrl: r.pictureUrl,
          followers: r.followerCount,
          /** Change in followers across the selected period; null when no API history spans it. */
          // Snapshot-measured first (exact: we watched the number change), then
          // the platform's own accounting for the period.
          //
          // ⚠️ Only Instagram ever needs the fallback. Facebook's page_follows
          // gives true daily totals, which the backfill turned into real
          // snapshots; Instagram publishes no total-over-time metric at all, so
          // its change comes from follows_and_unfollows (follows − unfollows).
          // That is Meta's own accounting rather than a measured difference, and
          // it is close but not identical to the profile count — so as soon as our
          // own snapshots span the window (7d in a week, 28d in four), the exact
          // figure above wins automatically and this fallback stops being used.
          followerDelta: followerDelta.has(r.id)
            ? followerDelta.get(r.id)!
            : (win(r)?.followerDelta ?? null),
          /** Approximate earnings for the window, in cents. Facebook only. */
          earningsCents: win(r)?.earningsCents ?? null,
          posts: r.postCount ?? r._count.posts ?? null,
          // Field names kept as *28d for wire compatibility; the VALUES follow the
          // requested window. `window` below says which one, so a client can never
          // mistake a 1-day figure for a 28-day one.
          views28d: n(win(r)?.views),
          engagements28d: n(win(r)?.engagements),
          profileViews28d: n(win(r)?.profileViews),
          reach28d: n(win(r)?.reach),
          reactions28d: n(win(r)?.reactions),
          metricsFetchedAt: win(r)?.fetchedAt
            ? win(r)!.fetchedAt!.toISOString()
            : r.metricsFetchedAt ? r.metricsFetchedAt.toISOString() : null,
          metricsError: win(r)?.error ?? r.metricsError,
          selected: r.selected,
          linkedToChannel: r.socialAccountId !== null,
          storedPosts: r._count.posts,
        })),
        channelCount: rows.length,
        totals,
        contributing,
      },
    });
  }),
);

export default router;
