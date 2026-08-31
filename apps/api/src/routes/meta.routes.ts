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
import { runMetaChannelSync, resolveContestedOwners, resolveDuplicateAssetIds, CHANNEL_WINDOWS, type ChannelWindow } from "../services/meta-oauth/meta-channels.service";
import { getRangeTotals, getRangeFollowerDeltas, previousRange, rangeDayCount } from "../services/meta-oauth/meta-range.service";
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

/**
 * PATCH /admin/meta/assets/bulk — remove (or restore) MANY channels at once.
 *
 * "Remove" is selected=false, deliberately NOT a delete: the sync already skips
 * unselected assets (channel metrics, posts, demographics all filter
 * selected:true), the channels view hides them, and their history is preserved
 * so restoring is one click. A hard delete would destroy stored metrics for a
 * decision that is often exploratory.
 *
 * ⚠️ DECLARED BEFORE /admin/meta/assets/:id — Express matches in order, and
 * declaring it after would route "bulk" into :id (the documented route-ordering
 * trap that once ate the insight routes).
 */
router.patch(
  "/admin/meta/assets/bulk",
  ...adminGate,
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { ids?: unknown; selected?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x): x is string => typeof x === "string").slice(0, 1000)
      : [];
    if (ids.length === 0 || typeof body.selected !== "boolean") {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "Provide ids: string[] and selected: boolean" },
      });
    }
    const result = await prisma.metaAsset.updateMany({
      where: { id: { in: ids }, disconnectedAt: null },
      data: { selected: body.selected },
    });
    return res.json({ success: true, data: { updated: result.count, selected: body.selected } });
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
 * GET /admin/meta/channels/:assetId/demographics — WHO one channel's audience is.
 *
 * Instagram only; a Facebook page returns an empty set with a reason rather than
 * a 404, so the UI can say why instead of looking broken. Meta also withholds
 * these entirely for accounts below its privacy threshold, which is likewise an
 * empty set and not an error.
 */
router.get(
  "/admin/meta/channels/:assetId/demographics",
  ...adminGate,
  asyncHandler(async (req: Request, res: Response) => {
    const asset = await prisma.metaAsset.findFirst({
      where: { id: req.params.assetId, disconnectedAt: null },
      select: { id: true, kind: true, name: true },
    });
    if (!asset) return res.status(404).json({ success: false, error: { message: "Channel not found" } });

    if (asset.kind !== MetaAssetKind.INSTAGRAM_ACCOUNT) {
      return res.json({
        success: true,
        data: {
          supported: false,
          reason: "Facebook retired its audience-demographics metrics; Meta publishes them for Instagram only.",
          audiences: {}, fetchedAt: null,
        },
      });
    }

    const rows = await prisma.metaAssetDemographic.findMany({
      where: { assetId: asset.id },
      orderBy: [{ audience: "asc" }, { dimension: "asc" }, { value: "desc" }],
      select: { audience: true, dimension: true, bucket: true, value: true, fetchedAt: true },
    });

    // audience -> dimension -> [{bucket, value}], already value-desc from SQL.
    const audiences: Record<string, Record<string, Array<{ bucket: string; value: number }>>> = {};
    let fetchedAt: string | null = null;
    for (const r of rows) {
      (audiences[r.audience] ??= {})[r.dimension] ??= [];
      audiences[r.audience][r.dimension].push({ bucket: r.bucket, value: r.value });
      const iso = r.fetchedAt.toISOString();
      if (fetchedAt === null || iso > fetchedAt) fetchedAt = iso;
    }

    return res.json({
      success: true,
      data: {
        supported: true,
        // Distinguishes "not collected yet" from "Meta withholds it for this
        // account" — both are empty, and conflating them hides a real gap.
        pending: rows.length === 0,
        audiences,
        fetchedAt,
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

    // ── Custom range (?start=YYYY-MM-DD&end=YYYY-MM-DD) ───────────────────
    //
    // Serves calendar months and arbitrary spans from meta_asset_daily instead
    // of live Graph windows — see meta-range.service.ts for why Meta cannot
    // answer these live. Invalid dates are a clean 400, never a Prisma 500
    // (the documented mid-typed "0002" date-param class).
    const qStart = typeof req.query.start === "string" ? req.query.start : "";
    const qEnd = typeof req.query.end === "string" ? req.query.end : "";
    const isRange = qStart !== "" || qEnd !== "";
    const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
    if (isRange) {
      const todayIso = new Date().toISOString().slice(0, 10);
      const bad =
        !ISO_DAY.test(qStart) || !ISO_DAY.test(qEnd) ||
        Number.isNaN(Date.parse(`${qStart}T00:00:00Z`)) || Number.isNaN(Date.parse(`${qEnd}T00:00:00Z`)) ||
        qStart > qEnd || qEnd > todayIso || rangeDayCount(qStart, qEnd) > 731;
      if (bad) {
        return res.status(400).json({
          success: false,
          error: { code: "BAD_RANGE", message: "start/end must be YYYY-MM-DD, start <= end <= today, span <= 731 days" },
        });
      }
    }

    // Removed channels (?hidden=1) are managed in their own view; the default
    // view shows ONLY monitored channels, so their figures also drop out of
    // every total the moment they are removed.
    const showHidden = req.query.hidden === "1";

    const where: Prisma.MetaAssetWhereInput = {
      disconnectedAt: null,
      selected: showHidden ? false : true,
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

    // A Page reachable through two admin connections is stored once per
    // connection. Show it once, or the table lists it twice and every total
    // double-counts it. See resolveDuplicateAssetIds.
    const duplicateAssetIds = await resolveDuplicateAssetIds();

    // ⚠️ NO `take` HERE — DELIBERATELY UNBOUNDED, AND SAFE ON THIS TABLE.
    //
    // It used to cap at 200: a defensive bound written when the estate was 120
    // channels. It was never reached, so it read as harmless — until an admin
    // connected with 264 Pages and the page silently showed 200 of them while the
    // footer confidently reported "200 channel(s)". Nothing errored. A bound that
    // is only correct while the data stays small is a bug waiting for growth.
    //
    // Unbounded is safe HERE specifically, which is the distinction the repo's
    // "never an unbounded findMany" rule turns on: meta_assets holds one row per
    // Page/account a human administers — hundreds — not an append-only event log.
    // That rule exists for link_metrics, which reached 3.99M rows / 1266MB by
    // appending per poll. Different shapes, different treatment.
    const allRows = await prisma.metaAsset.findMany({
      where,
      orderBy,
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

    const rows = duplicateAssetIds.size > 0
      ? allRows.filter((r) => !duplicateAssetIds.has(r.id))
      : allRows;

    // Not a cap — a tripwire. If this fires, add pagination deliberately rather
    // than rediscovering a truncation from a screenshot.
    if (rows.length > 2000) {
      console.warn(
        `[meta] /admin/meta/channels returned ${rows.length} channels in one response — ` +
          `large enough to be worth paginating.`,
      );
    }

    // ── RANGE MODE — calendar months / custom spans, from stored daily rows ──
    //
    // Everything here is a SUM of per-day flows, which is exact. reach and
    // accountsEngaged are null BY DESIGN (unique people cannot be summed), and
    // coveredDays/rangeDays disclose partial history instead of presenting a
    // partial sum as the whole. metricsError is null here: the warning mark
    // describes live-window refresh health, which stored history does not have.
    if (isRange) {
      const span = rangeDayCount(qStart, qEnd);
      const prev = previousRange(qStart, qEnd);
      const [sums, prevSums, fDeltas] = await Promise.all([
        getRangeTotals(qStart, qEnd),
        getRangeTotals(prev.start, prev.end),
        getRangeFollowerDeltas(qStart, qEnd),
      ]);

      const totals = { followers: 0, views: 0, engagements: 0, reach: 0, earningsCents: 0 };
      const contributing = { views: 0, engagements: 0, reach: 0, earnings: 0 };
      let dataThrough: string | null = null;
      for (const r of rows) {
        totals.followers += r.followerCount ?? 0;
        const t = sums.get(r.id);
        if (t?.views != null) { totals.views += t.views; contributing.views++; }
        if (t?.engagements != null) { totals.engagements += t.engagements; contributing.engagements++; }
        if (t?.earningsCents != null) {
          totals.earningsCents += t.earningsCents;
          if (t.earningsCents > 0) contributing.earnings++;
        }
        if (t?.latestDay && (dataThrough === null || t.latestDay > dataThrough)) dataThrough = t.latestDay;
      }

      // Trend baseline: the equal-length span immediately before. coverageShare
      // tells the UI how complete that baseline is — a chip computed against a
      // half-covered baseline would fabricate growth, so the UI hides it below
      // ~95% coverage rather than showing a confident wrong percentage.
      let prevViews = 0, prevEng = 0, prevEarn = 0, prevRowDays = 0, prevAssets = 0;
      for (const t of prevSums.values()) {
        if (t.views != null) prevViews += t.views;
        if (t.engagements != null) prevEng += t.engagements;
        if (t.earningsCents != null) prevEarn += t.earningsCents;
        prevRowDays += t.coveredDays;
        prevAssets++;
      }
      // ⚠️ `assets` is part of the honesty contract: coverageShare only says the
      // baseline's OWN days are complete — it cannot see that the baseline might
      // cover 2 channels while the current range covers 400 (exactly the state a
      // partial backfill produces). The client hides the chip unless the
      // baseline's asset count is ~the current range's contributing count.
      const previousTotals = prevAssets > 0
        ? { views: prevViews, engagements: prevEng, earningsCents: prevEarn,
            coverageShare: Math.min(1, prevRowDays / (prevAssets * span)),
            assets: prevAssets,
            start: prev.start, end: prev.end }
        : null;

      if (sort === "views" || sort === "engagements") {
        const key = sort === "views" ? ("views" as const) : ("engagements" as const);
        rows.sort((a, b) => {
          const av = sums.get(a.id)?.[key];
          const bv = sums.get(b.id)?.[key];
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return bv - av;
        });
      }

      return res.json({
        success: true,
        data: {
          window: "custom",
          windows: CHANNEL_WINDOWS,
          range: { start: qStart, end: qEnd, days: span },
          dataThrough: dataThrough ? `${dataThrough}T00:00:00.000Z` : null,
          items: rows.map((r) => {
            const t = sums.get(r.id);
            const fd = fDeltas.get(r.id);
            return {
              id: r.id,
              platform: r.kind === "FACEBOOK_PAGE" ? "facebook" : "instagram",
              metaId: r.metaId,
              name: r.name,
              username: r.username,
              pictureUrl: r.pictureUrl,
              followers: r.followerCount,
              followerDelta: fd?.delta ?? null,
              followerDeltaDays: fd?.days ?? null,
              earningsCents: t?.earningsCents ?? null,
              follows: t?.follows ?? null,
              unfollows: t?.unfollows ?? null,
              videoViewTimeMs: t?.videoViewTimeMs ?? null,
              accountsEngaged: null,
              saves: t?.saves ?? null,
              shares: t?.shares ?? null,
              posts: r.postCount ?? r._count.posts ?? null,
              views28d: t?.views ?? null,
              engagements28d: t?.engagements ?? null,
              profileViews28d: t?.profileViews ?? null,
              reach28d: null,
              reactions28d: t?.reactions ?? null,
              metricsFetchedAt: null,
              metricsError: null,
              selected: r.selected,
              linkedToChannel: r.socialAccountId !== null,
              storedPosts: r._count.posts,
              coveredDays: t?.coveredDays ?? 0,
              rangeDays: span,
            };
          }),
          channelCount: rows.length,
          totals,
          contributing,
          previousTotals,
        },
      });
    }

    // ── Follower change over the selected period ──────────────────────────
    //
    // ⚠️ API-SOURCED SNAPSHOTS ONLY. Account Growth is a verified-data-only
    // surface (owner decision 2026-08-24), and a delta measured against a
    // scraped baseline would put unverifiable numbers back on the page through
    // the back door — including the display-string staircases where the scraper
    // was reading Facebook's rounded "14M" text.
    //
    // ⚠️ AND IT RETURNS NULL, NEVER 0, WHEN THERE IS NO USABLE BASELINE. API
    // follower history begins 2026-08-24 for most channels, so at first the only
    // snapshot was today's — and "current minus current" is 0. Rendering that 0
    // would assert "this channel did not grow in 28 days", which we do not know.
    // The baseline must be from a date strictly BEFORE today for a delta to
    // exist; otherwise it is absent and shows as a dash.
    //
    // ⚠️ THE BASELINE STILL NEED NOT REACH THE WINDOW START, AND THAT USED TO BE
    // REPORTED AS IF IT DID. An earlier version of this comment promised the
    // delta would "activate on its own — 24h tomorrow, 7d in a week, 28d in four
    // weeks", implying a figure appears only once history spans the window. The
    // code never enforced that: it takes the earliest snapshot INSIDE the window
    // and requires only that it precede today, so a channel with 5 days of
    // history produced a 5-day change that the UI labelled "· 28d". Rather than
    // suppress those (71% of the 28-day column on prod), the real span is now
    // reported as followerDeltaDays and the UI labels each row with it.
    const windowDays = window === "day" ? 1 : window === "week" ? 7 : 28;
    const followerDelta = new Map<string, number>();
    /**
     * How many days the delta above ACTUALLY covers.
     *
     * ⚠️ IT IS OFTEN NOT `windowDays`, AND LABELLING IT AS SUCH IS A LIE THE PAGE
     * WAS TELLING. The baseline is the earliest snapshot inside the window, and the
     * only guard is "it must precede today" — nothing requires it to sit at the
     * window START. API follower history began 2026-08-24 for most channels (only
     * the 53 backfilled Facebook Pages reach further), so measured on prod
     * 2026-08-31: at the 28-day window 105 of 148 channels had a baseline spanning
     * as little as 5 days, every one of them rendered "· 28d". That systematically
     * UNDERSTATES growth while looking authoritative.
     *
     * Reporting the true span lets the UI label it honestly and keeps the figure,
     * which is better than the documented alternative of suppressing it (that would
     * blank 71% of the 28-day column until history accrues). Where the platform's
     * own accounting figure is used instead, the span IS exactly the window.
     */
    const followerDeltaDays = new Map<string, number>();
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
      // ⚠️⚠️ A CONTESTED CHANNEL ROW GETS NO SNAPSHOT-MEASURED DELTA AT ALL —
      // NOT EVEN FOR THE OWNING ASSET. This is stricter than it used to be, and
      // the extra strictness is load-bearing.
      //
      // Two different Pages can share a name, so discovery links both to ONE
      // social_accounts row (16 such rows on prod as of 2026-08-31, up from the
      // 3 first recorded). resolveContestedOwners() picks one owner so only it
      // writes the follower count back — but the SNAPSHOT SERIES IS KEYED ON THE
      // CHANNEL ROW, is shared by both Pages, and predates that rule. It also has
      // a second writer that never respected it: follower-sync's Facebook map is
      // keyed by page NAME, so for two same-named Pages it resolves to whichever
      // one won the map build and writes that number under source:"api".
      //
      // The result is a series that SWITCHES PAGES MID-HISTORY. Measured on prod
      // for "The Candid Couch": 5,235,935 … 5,234,930 through 2026-08-26, then
      // 131,886 … 131,830 from 2026-08-27 on.
      //
      // The delta then subtracts one Page's history from the OTHER Page's current
      // count — r.followerCount is per-ASSET (5,233,880, the owner) while the
      // baseline is per-CHANNEL-ROW (131,842) — and reports
      // +5,102,038 as 24h growth. That is the single largest "gain" on the page
      // and it never happened.
      //
      // ⚠️ THIS IS INVISIBLE TO A QUERY THAT ONLY DIFFS THE SNAPSHOT SERIES: those
      // rows move by ~12/day. The fabrication is created by MIXING the two
      // sources, so you only see it by computing the delta the way this route
      // does. Measured split at 24h: 16 contested rows contributed +5,100,699
      // while the 148 clean rows moved +11,269 in total.
      //
      // A shared history cannot be attributed, so no number derived from it is
      // trustworthy for EITHER Page. Suppressing it falls through to the
      // platform's own per-ASSET accounting below (win(r).followerDelta), which
      // is immune because it is not keyed on the channel row — and where that is
      // absent the row renders an em-dash. An honest blank beats a confident
      // 5.1m fiction.
      const owners = await resolveContestedOwners();
      for (const r of rows) {
        if (!r.socialAccountId || r.followerCount === null) continue;
        // owners only contains accounts claimed by >=2 live assets, so .has()
        // IS the "this channel row is contested" test.
        if (owners.has(r.socialAccountId)) continue;
        const b = baseline.get(r.socialAccountId);
        // Same-day baseline ⇒ no span ⇒ no delta (see the note above).
        if (!b || b.date.getTime() >= todayKey.getTime()) continue;
        followerDelta.set(r.id, r.followerCount - b.followers);
        followerDeltaDays.set(
          r.id,
          Math.max(1, Math.round((todayKey.getTime() - b.date.getTime()) / 86_400_000)),
        );
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
    const win = (r: { windowMetrics: Array<{ views: bigint | null; reach: bigint | null; engagements: bigint | null; profileViews: bigint | null; reactions: bigint | null; followerDelta: number | null; earningsCents: number | null; follows: number | null; unfollows: number | null; videoViewTimeMs: bigint | null; saves: number | null; shares: number | null; accountsEngaged: number | null; fetchedAt: Date | null; periodEnd: Date | null; error: string | null }> }) =>
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

    // Trend baseline for the tiles: the equal-length span immediately BEFORE
    // this native window, summed from stored daily history. Pure decoration —
    // a failure here must never fail the page, and null simply hides the chips.
    // The UI additionally hides them below ~95% baseline coverage, because a
    // percentage computed against a half-covered baseline fabricates growth.
    let previousTotals:
      | { views: number; engagements: number; earningsCents: number; coverageShare: number; assets: number; start: string; end: string }
      | null = null;
    try {
      const todayMs = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
      const curEnd = new Date(todayMs - 86_400_000).toISOString().slice(0, 10);
      const curStart = new Date(todayMs - windowDays * 86_400_000).toISOString().slice(0, 10);
      const prev = previousRange(curStart, curEnd);
      const prevSums = await getRangeTotals(prev.start, prev.end);
      let v = 0, e = 0, c = 0, rowDays = 0, assets = 0;
      for (const t of prevSums.values()) {
        if (t.views != null) v += t.views;
        if (t.engagements != null) e += t.engagements;
        if (t.earningsCents != null) c += t.earningsCents;
        rowDays += t.coveredDays;
        assets++;
      }
      if (assets > 0) {
        previousTotals = {
          views: v, engagements: e, earningsCents: c,
          coverageShare: Math.min(1, rowDays / (assets * windowDays)),
          assets,
          start: prev.start, end: prev.end,
        };
      }
    } catch {
      previousTotals = null;
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
        // ⚠️ periodEnd, NOT fetchedAt. The fetch time says when we asked; only
        // Meta's own end_time says what the numbers describe.
        //
        // ⚠️ And the EARLIEST boundary, not the latest. Facebook closes at the
        // Page's local midnight (2026-08-23T07:00Z) while Instagram is asked for
        // an explicit midnight-UTC until (2026-08-24T00:00Z). Taking the max would
        // advertise Instagram's freshness for a table that is mostly Facebook —
        // claiming currency the figures do not have, which is the exact failure
        // this line was added to prevent. The earliest boundary is the point
        // through which EVERY figure shown is complete.
        dataThrough: rows.reduce<string | null>((acc, r) => {
          const f = win(r)?.periodEnd;
          if (!f) return acc;
          const iso = f.toISOString();
          return acc === null || iso < acc ? iso : acc;
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
          /**
           * The span the delta above really covers, in days — so the UI can label
           * it truthfully instead of asserting the selected window. Null whenever
           * followerDelta is null. The accounting fallback is exactly windowed.
           */
          followerDeltaDays: followerDelta.has(r.id)
            ? (followerDeltaDays.get(r.id) ?? null)
            : (win(r)?.followerDelta != null ? windowDays : null),
          /** Approximate earnings for the window, in cents. Facebook only. */
          earningsCents: win(r)?.earningsCents ?? null,
          /** Gross churn behind the net follower change. Both platforms. */
          follows: win(r)?.follows ?? null,
          unfollows: win(r)?.unfollows ?? null,
          /** Facebook only. */
          videoViewTimeMs: n(win(r)?.videoViewTimeMs),
          /** Instagram only — no Facebook page-level equivalent. */
          saves: win(r)?.saves ?? null,
          shares: win(r)?.shares ?? null,
          accountsEngaged: win(r)?.accountsEngaged ?? null,
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
          // ⚠️ Ternary, NOT `??`. A HEALTHY window row has error: null, and `??`
          // falls through null — so the asset-level error (stamped when the
          // days_28 fetch failed) used to paint a warning on the 7d/24h views
          // whose own rows were fine. The asset-level error is a fallback for
          // "no row for this window at all", nothing more.
          metricsError: win(r) ? win(r).error : r.metricsError,
          selected: r.selected,
          linkedToChannel: r.socialAccountId !== null,
          storedPosts: r._count.posts,
        })),
        channelCount: rows.length,
        totals,
        contributing,
        previousTotals,
      },
    });
  }),
);

export default router;
