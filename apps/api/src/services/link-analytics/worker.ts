// Link Analytics — background worker (docs/link-analytics/SPEC.md §5).
//
// ⚠️ ALL queue state is in link_posts (fetch_state / next_attempt_at / lease_until), so a pm2
// restart loses nothing: a claimed post carries a 3-minute lease and is simply claimed again once
// it lapses. Only posts with an item in a RUNNING, non-archived batch are claimed — that is how
// pause works. One tick at a time (overlap guard claimed before the first await).
//
// Budget: ≤ LINK_ANALYTICS_MAX_CALLS_PER_HOUR Graph calls per rolling hour (default 900), ≤ 30 posts
// per tick. A Meta usage header ≥ 75 % or a rate-limit error pauses the worker for
// max(10 min, Meta's regain estimate). One api_usage row per tick (posting-watch pattern), never
// one per call — api_usage is a known disk hog.

import { Prisma, prisma } from "@dashmani/db";
import { oauthGraphFetch, makeBudget } from "../meta-oauth/oauth-graph";
import { resolveOpaqueFacebookUrl } from "../social-insights/facebook.provider";
import { recordApiUsage } from "../api-usage.service";
import { metaAdapter } from "./adapters/meta.adapter";
import { enqueueBatchPosts } from "./batches.service";
import type { AdapterContext, FetchOutcome, FetchTarget, GraphFn, LinkMetricsAdapter } from "./types";

const ADAPTERS: LinkMetricsAdapter[] = [metaAdapter];

const MAX_CALLS_PER_HOUR = () => Math.max(10, Number(process.env.LINK_ANALYTICS_MAX_CALLS_PER_HOUR) || 900);
const POSTS_PER_TICK = () => Math.max(1, Math.min(100, Number(process.env.LINK_ANALYTICS_POSTS_PER_TICK) || 30));
/** Retry delays for transient failures; a post fails after the last one. */
export const RETRY_DELAYS_MIN = [1, 4, 16];
const LEASE_MINUTES = 3;
const THROTTLE_PCT = 75;
const MIN_PAUSE_MS = 10 * 60_000;

interface WorkerState {
  running: boolean;
  pausedUntil: number;
  pauseReason: string | null;
  calls: Array<{ at: number; n: number }>;
  lastTickAt: number | null;
  lastError: string | null;
}
const state: WorkerState = { running: false, pausedUntil: 0, pauseReason: null, calls: [], lastTickAt: null, lastError: null };

export function workerStatus(now = Date.now()) {
  const hour = state.calls.filter((c) => c.at > now - 3600_000).reduce((s, c) => s + c.n, 0);
  return {
    enabled: workerEnabled(),
    throttledUntil: state.pausedUntil > now ? new Date(state.pausedUntil) : null,
    throttleReason: state.pausedUntil > now ? state.pauseReason : null,
    callsLastHour: hour,
    maxCallsPerHour: MAX_CALLS_PER_HOUR(),
    lastTickAt: state.lastTickAt ? new Date(state.lastTickAt) : null,
  };
}

export function workerEnabled() {
  return process.env.LINK_ANALYTICS_WORKER !== "0";
}

export function __resetWorkerForTesting() {
  state.running = false;
  state.pausedUntil = 0;
  state.pauseReason = null;
  state.calls = [];
  state.lastTickAt = null;
}

const defaultGraph: GraphFn = (path, params, token, label) =>
  oauthGraphFetch(path, params, token, { label, recordUsage: false, timeoutMs: 15_000 });

export interface TickDeps {
  graph?: GraphFn;
  resolveOpaqueFacebook?: (url: string) => Promise<string | null>;
  now?: () => Date;
}

type Claimed = { id: string; post_key: string; platform: string; post_type: string; canonical_url: string; attempts: number };

/** Run one tick. Returns how many posts it processed (0 = nothing to do). */
export async function runLinkAnalyticsTick(deps: TickDeps = {}): Promise<number> {
  if (state.running) return 0;
  state.running = true;
  try {
    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    state.lastTickAt = nowMs;
    await runSchedules();
    if (state.pausedUntil > nowMs) return 0;
    state.calls = state.calls.filter((c) => c.at > nowMs - 3600_000);
    const usedHour = state.calls.reduce((s, c) => s + c.n, 0);
    const callsLeft = MAX_CALLS_PER_HOUR() - usedHour;
    if (callsLeft < 3) return 0;

    const limit = Math.min(POSTS_PER_TICK(), Math.max(1, Math.floor(callsLeft / 2)));
    const claimed = await prisma.$queryRaw<Claimed[]>`
      UPDATE link_posts p SET lease_until = (now() AT TIME ZONE 'UTC') + make_interval(mins => ${LEASE_MINUTES}::int)
       WHERE p.id IN (
         SELECT p2.id FROM link_posts p2
          WHERE p2.fetch_state = 'queued'
            AND (p2.next_attempt_at IS NULL OR p2.next_attempt_at <= (now() AT TIME ZONE 'UTC'))
            AND (p2.lease_until IS NULL OR p2.lease_until < (now() AT TIME ZONE 'UTC'))
            AND EXISTS (SELECT 1 FROM link_batch_items i JOIN link_batches b ON b.id = i.batch_id
                         WHERE i.post_id = p2.id AND b.state = 'running' AND b.archived_at IS NULL)
          ORDER BY p2.queued_at ASC NULLS FIRST
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
      RETURNING p.id, p.post_key, p.platform, p.post_type, p.canonical_url, p.attempts`;
    if (!claimed.length) {
      await finishBatches();
      return 0;
    }

    const hints = await prisma.$queryRaw<Array<{ post_id: string; username_hint: string }>>`
      SELECT DISTINCT ON (post_id) post_id, username_hint FROM link_batch_items
       WHERE post_id IN (${Prisma.join(claimed.map((c) => c.id))}) AND username_hint IS NOT NULL
       ORDER BY post_id, created_at DESC`;
    const hintOf = new Map(hints.map((h) => [h.post_id, h.username_hint]));
    const targets: FetchTarget[] = claimed.map((c) => ({
      id: c.id, postKey: c.post_key, platform: c.platform as FetchTarget["platform"], postType: c.post_type, canonicalUrl: c.canonical_url,
      accountHint: hintOf.get(c.id) ?? null,
    }));

    const budget = makeBudget(callsLeft);
    const graph = deps.graph ?? defaultGraph;
    const ctx: AdapterContext = {
      graph: (path, params, token, label) => {
        if (budget.used >= budget.max) return Promise.resolve({ ok: false, rateLimited: false, authInvalid: false, status: 0, usage: null, error: "call budget exhausted" });
        budget.used++;
        return graph(path, params, token, label);
      },
      budget,
      now: deps.now ?? (() => new Date()),
      resolveOpaqueFacebook: deps.resolveOpaqueFacebook ?? ((u) => resolveOpaqueFacebookUrl(u)),
      usage: { maxPct: 0, regainMinutes: null, rateLimited: false },
    };

    const outcomes = new Map<string, FetchOutcome>();
    for (const adapter of ADAPTERS) {
      const mine = targets.filter((t) => adapter.handles(t) && !outcomes.has(t.id));
      if (!mine.length) continue;
      try {
        for (const [k, v] of await adapter.fetch(mine, ctx)) outcomes.set(k, v);
      } catch (e) {
        state.lastError = String(e).slice(0, 300);
        for (const t of mine) if (!outcomes.has(t.id)) outcomes.set(t.id, { kind: "transient", message: "Internal error while fetching; will retry" });
      }
    }

    const attemptsOf = new Map(claimed.map((c) => [c.id, c.attempts]));
    for (const t of targets) {
      const o = outcomes.get(t.id) ?? { kind: "failed" as const, message: "No data source handles this link" };
      // A throttle or an exhausted hourly budget is our limit, not the post's: it never uses up a retry.
      const free = o.kind === "transient" && (ctx.usage.rateLimited || budget.used >= budget.max);
      await applyOutcome(t, o, attemptsOf.get(t.id) ?? 0, ctx.now(), free);
    }

    if (budget.used) {
      state.calls.push({ at: nowMs, n: budget.used });
      recordApiUsage({ provider: "meta", operation: "meta-oauth:links", calls: budget.used, units: budget.used });
    }
    if (ctx.usage.rateLimited || ctx.usage.maxPct >= THROTTLE_PCT) {
      const ms = Math.max(MIN_PAUSE_MS, (ctx.usage.regainMinutes ?? 0) * 60_000);
      state.pausedUntil = nowMs + Math.min(ms, 6 * 3600_000);
      state.pauseReason = ctx.usage.rateLimited ? "Meta asked us to slow down" : `Meta usage at ${Math.round(ctx.usage.maxPct)}%`;
    }
    await finishBatches();
    return claimed.length;
  } finally {
    state.running = false;
  }
}

/** Values the platform's own Meta sync holds for this post (meta_posts), if any. */
async function cachedFromSync(postKey: string) {
  const id = postKey.slice(postKey.indexOf(":") + 1);
  if (!postKey.startsWith("ig:") && !postKey.startsWith("fb:")) return null;
  const row = await prisma.metaPost.findFirst({
    where: { OR: [{ matchId: id }, ...(postKey.startsWith("fb:") ? [{ metaPostId: { endsWith: `_${id}` } }] : [])], metricsFetchedAt: { not: null } },
    orderBy: { metricsFetchedAt: "desc" },
    select: { views: true, reach: true, likes: true, comments: true, shares: true, saves: true, metricsFetchedAt: true, caption: true, postedAt: true, metaPostId: true, asset: { select: { id: true, name: true, username: true, followerCount: true, updatedAt: true } } },
  });
  return row;
}

async function writeSnapshot(postId: string, status: string, o: { dataSource?: string | null; metricsAt?: Date | null; views?: number | null; reach?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; saves?: number | null; followers?: number | null }, at: Date) {
  await prisma.linkPostSnapshot.create({
    data: {
      postId, checkedAt: at, status, dataSource: o.dataSource ?? null, metricsAt: o.metricsAt ?? null,
      views: o.views ?? null, reach: o.reach ?? null, likes: o.likes ?? null, comments: o.comments ?? null, shares: o.shares ?? null, saves: o.saves ?? null, followers: o.followers ?? null,
    },
  });
}

/** An opaque FB link resolved to a numeric id that another row already holds: merge into it. */
async function rekey(t: FetchTarget, newKey: string): Promise<boolean> {
  const other = await prisma.linkPost.findUnique({ where: { postKey: newKey }, select: { id: true } });
  if (!other) {
    await prisma.linkPost.update({ where: { id: t.id }, data: { postKey: newKey } });
    t.postKey = newKey;
    return false;
  }
  await prisma.$transaction([
    prisma.linkBatchItem.updateMany({ where: { postId: t.id }, data: { postId: other.id, postKey: newKey } }),
    prisma.linkPost.update({ where: { id: other.id }, data: { fetchState: "queued", queuedAt: new Date(), nextAttemptAt: new Date(), attempts: 0 } }),
    prisma.linkPost.delete({ where: { id: t.id } }),
  ]);
  return true;
}

async function applyOutcome(t: FetchTarget, o: FetchOutcome, attempts: number, now: Date, freeRetry = false): Promise<void> {
  if ("newPostKey" in o && o.newPostKey && o.newPostKey !== t.postKey) {
    if (await rekey(t, o.newPostKey)) return;
  }
  const done = { fetchState: "idle", leaseUntil: null, attempts: 0, nextAttemptAt: null, lastCheckedAt: now, checkCount: { increment: 1 } } as const;
  const prev = await prisma.linkPost.findUnique({ where: { id: t.id }, select: { status: true, statusReason: true, access: true } });
  if (!prev) return;

  if (o.kind === "ok") {
    await prisma.linkPost.update({
      where: { id: t.id },
      data: {
        ...done, ...o.values, status: o.status, access: o.access, statusReason: o.reason ?? null, errorMessage: null,
        dataSource: o.dataSource, metricsAt: o.metricsAt,
        ...(o.account ? {
          ...(o.account.metaAssetId !== undefined ? { metaAssetId: o.account.metaAssetId } : {}),
          ...(o.account.accountName !== undefined ? { accountName: o.account.accountName?.slice(0, 255) ?? null } : {}),
          ...(o.account.username !== undefined ? { username: o.account.username?.slice(0, 64) ?? null } : {}),
          ...(o.account.followers !== undefined ? { followers: o.account.followers } : {}),
          ...(o.account.followersAt !== undefined ? { followersAt: o.account.followersAt } : {}),
        } : {}),
        ...(o.post ? {
          ...(o.post.externalId !== undefined ? { externalId: o.post.externalId?.slice(0, 128) ?? null } : {}),
          ...(o.post.caption !== undefined ? { caption: o.post.caption } : {}),
          ...(o.post.publishedAt !== undefined ? { publishedAt: o.post.publishedAt } : {}),
          ...(o.post.thumbnailUrl !== undefined ? { thumbnailUrl: o.post.thumbnailUrl } : {}),
          ...(o.post.postType ? { postType: o.post.postType } : {}),
        } : {}),
      },
    });
    await writeSnapshot(t.id, o.status, { ...o.values, dataSource: o.dataSource, metricsAt: o.metricsAt, followers: o.account?.followers ?? null }, now);
    return;
  }

  if (o.kind === "restricted") {
    // Nothing readable: clear values (a number we can't re-read is not shown as current).
    await prisma.linkPost.update({
      where: { id: t.id },
      data: {
        ...done, status: "restricted", access: "none", statusReason: o.reason, errorMessage: null, dataSource: "none", metricsAt: null,
        views: null, reach: null, likes: null, comments: null, shares: null, saves: null,
      },
    });
    // A repeat of the same "nothing readable" answer adds no information; don't grow the table with it.
    if (!(prev.status === "restricted" && prev.access === "none" && prev.statusReason === o.reason)) {
      await writeSnapshot(t.id, "restricted", { dataSource: "none" }, now);
    }
    return;
  }

  if (o.kind === "transient" && (freeRetry || attempts < RETRY_DELAYS_MIN.length)) {
    const delayMin = freeRetry ? 5 : RETRY_DELAYS_MIN[attempts];
    await prisma.linkPost.update({
      where: { id: t.id },
      data: { fetchState: "queued", leaseUntil: null, attempts: freeRetry ? attempts : attempts + 1, nextAttemptAt: new Date(now.getTime() + delayMin * 60_000), errorMessage: o.message },
    });
    return;
  }

  // Failed (or out of retries). Keep the last values, but say honestly where they came from: if the
  // platform's background sync has newer numbers, show those, labelled Cached ("platform_sync").
  const cached = await cachedFromSync(t.postKey);
  const cur = await prisma.linkPost.findUnique({ where: { id: t.id }, select: { metricsAt: true } });
  const useCache = cached?.metricsFetchedAt && (!cur?.metricsAt || cached.metricsFetchedAt > cur.metricsAt);
  await prisma.linkPost.update({
    where: { id: t.id },
    data: {
      ...done, status: "failed", errorMessage: o.message.slice(0, 500),
      ...(useCache && cached ? {
        dataSource: "platform_sync", metricsAt: cached.metricsFetchedAt,
        views: cached.views, reach: cached.reach, likes: cached.likes, comments: cached.comments, shares: cached.shares, saves: cached.saves,
        metaAssetId: cached.asset.id, accountName: cached.asset.name, username: cached.asset.username, followers: cached.asset.followerCount, followersAt: cached.asset.updatedAt,
        caption: cached.caption, publishedAt: cached.postedAt, externalId: cached.metaPostId,
      } : {}),
    },
  });
  await writeSnapshot(t.id, "failed", useCache && cached ? { dataSource: "platform_sync", metricsAt: cached.metricsFetchedAt, views: cached.views, reach: cached.reach, likes: cached.likes, comments: cached.comments, shares: cached.shares, saves: cached.saves } : {}, now);
}

/** A running batch with nothing left queued is finished. */
export async function finishBatches(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE link_batches b SET state = 'idle', run_finished_at = (now() AT TIME ZONE 'UTC'), updated_at = (now() AT TIME ZONE 'UTC')
     WHERE b.state = 'running'
       AND NOT EXISTS (SELECT 1 FROM link_batch_items i JOIN link_posts p ON p.id = i.post_id
                        WHERE i.batch_id = b.id AND p.fetch_state = 'queued')`;
}

/** Scheduled refreshes that are due. A schedule lasts at most 60 days (re-enable to extend). */
export async function runSchedules(now = new Date()): Promise<number> {
  const due = await prisma.linkBatch.findMany({
    where: { archivedAt: null, refreshEveryHours: { not: null }, nextRefreshAt: { lte: now } },
    select: { id: true, state: true, refreshEveryHours: true, scheduleEndsAt: true },
    take: 20,
  });
  for (const b of due) {
    if (b.scheduleEndsAt && b.scheduleEndsAt <= now) {
      await prisma.linkBatch.update({ where: { id: b.id }, data: { refreshEveryHours: null, scheduleEndsAt: null, nextRefreshAt: null } });
      continue;
    }
    const next = new Date(now.getTime() + b.refreshEveryHours! * 3600_000);
    if (b.state === "paused") {
      await prisma.linkBatch.update({ where: { id: b.id }, data: { nextRefreshAt: next } });
      continue;
    }
    await enqueueBatchPosts(b.id);
    await prisma.linkBatch.update({
      where: { id: b.id },
      data: { nextRefreshAt: next, state: "running", ...(b.state === "idle" ? { runStartedAt: now, runFinishedAt: null } : {}) },
    });
  }
  return due.length;
}

let timer: NodeJS.Timeout | null = null;

/** Started from index.ts. Ticks every 10 s while there is work, every 60 s when idle. */
export function startLinkAnalyticsWorker(): void {
  if (!workerEnabled() || timer) return;
  const loop = async (): Promise<void> => {
    let n = 0;
    try {
      n = await runLinkAnalyticsTick();
    } catch (e) {
      state.lastError = String(e).slice(0, 300);
      console.error("[link-analytics] tick failed:", state.lastError);
    }
    timer = setTimeout(loop, n > 0 ? 10_000 : 60_000);
    timer.unref?.();
  };
  timer = setTimeout(loop, 90_000);
  timer.unref?.();
  console.log("[link-analytics] worker scheduled (first tick in 90s)");
}
