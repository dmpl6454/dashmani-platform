// Link Analytics — batches, intake and controls (docs/link-analytics/SPEC.md §4-§5).
// The worker (worker.ts) does the fetching; everything here is DB-only and never calls Meta.

import { Prisma, prisma } from "@dashmani/db";
import { linkAnalytics } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";

const { intake, splitEntries, LINK_LIMITS } = linkAnalytics;

export const FRESH_MINUTES = () => Math.max(0, Number(process.env.LINK_ANALYTICS_FRESH_MINUTES ?? 10));
export const SCHEDULE_HOURS = [6, 12, 24] as const;
export const SCHEDULE_MAX_DAYS = 60;

export type IntakeMode = "paste" | "csv";

function notFound(): never {
  throw new AppError(404, "NOT_FOUND", "Batch not found");
}

async function loadBatch(id: string) {
  const b = await prisma.linkBatch.findUnique({ where: { id } });
  if (!b) notFound();
  return b;
}

// ── Enqueue ─────────────────────────────────────────────────────────────────────────────

/**
 * Queue a batch's posts for a fetch. Without `force`, a post checked within FRESH_MINUTES is left
 * alone (no double fetching); a post already queued stays queued. Returns how many were queued.
 */
export async function enqueueBatchPosts(batchId: string, opts: { force?: boolean; onlyStatus?: string } = {}): Promise<number> {
  const fresh = opts.force ? 0 : FRESH_MINUTES();
  const status = opts.onlyStatus ?? null;
  return prisma.$executeRaw`
    UPDATE link_posts SET fetch_state = 'queued', queued_at = (now() AT TIME ZONE 'UTC'),
           next_attempt_at = (now() AT TIME ZONE 'UTC'), attempts = 0, updated_at = (now() AT TIME ZONE 'UTC')
     WHERE id IN (SELECT post_id FROM link_batch_items WHERE batch_id = ${batchId} AND post_id IS NOT NULL)
       AND fetch_state = 'idle'
       AND (${status}::text IS NULL OR status = ${status})
       AND (last_checked_at IS NULL OR last_checked_at < (now() AT TIME ZONE 'UTC') - make_interval(mins => ${fresh}::int))`;
}

// ── Intake ──────────────────────────────────────────────────────────────────────────────

export interface AddLinksInput {
  text: string;
  mode?: IntakeMode;
  keepDuplicates?: boolean;
}

export async function addLinks(batchId: string, input: AddLinksInput) {
  const batch = await loadBatch(batchId);
  if (batch.archivedAt) throw new AppError(409, "ARCHIVED", "Restore this batch before adding links");
  const raw = splitEntries(input.text ?? "", input.mode ?? "paste");
  if (!raw.length) throw new AppError(400, "NO_LINKS", "No links found in what you pasted");
  if (raw.length > LINK_LIMITS.maxEntriesPerAdd) {
    throw new AppError(400, "TOO_MANY_LINKS", `At most ${LINK_LIMITS.maxEntriesPerAdd.toLocaleString("en-IN")} links at a time — you sent ${raw.length.toLocaleString("en-IN")}`);
  }
  const existing = await prisma.linkBatchItem.count({ where: { batchId } });
  if (existing + raw.length > LINK_LIMITS.maxItemsPerBatch) {
    throw new AppError(400, "BATCH_FULL", `A batch holds at most ${LINK_LIMITS.maxItemsPerBatch.toLocaleString("en-IN")} links; start a new batch`);
  }
  const keepDuplicates = input.keepDuplicates ?? batch.keepDuplicates;
  const knownRows = await prisma.linkBatchItem.findMany({ where: { batchId, validity: "valid" }, select: { postKey: true }, distinct: ["postKey"] });
  const { entries, counts } = intake(raw, { keepDuplicates, knownKeys: knownRows.map((r) => r.postKey!).filter(Boolean) });

  // One link_posts row per post across ALL batches: create what's new, reuse what exists.
  const byKey = new Map<string, (typeof entries)[number]>();
  for (const e of entries) if (e.postKey && !byKey.has(e.postKey)) byKey.set(e.postKey, e);
  const keys = [...byKey.keys()];
  const now = new Date();
  for (let i = 0; i < keys.length; i += 1000) {
    await prisma.linkPost.createMany({
      data: keys.slice(i, i + 1000).map((k) => {
        const e = byKey.get(k)!;
        return { postKey: k, platform: e.platform!, postType: e.postType!, canonicalUrl: e.normalizedUrl!, fetchState: "queued", queuedAt: now, nextAttemptAt: now };
      }),
      skipDuplicates: true,
    });
  }
  const posts = keys.length ? await prisma.linkPost.findMany({ where: { postKey: { in: keys } }, select: { id: true, postKey: true } }) : [];
  const postId = new Map(posts.map((p) => [p.postKey, p.id]));

  const firstIdByIndex = new Map<number, string>();
  const rows = entries.map((e, i) => {
    const id = crypto.randomUUID();
    firstIdByIndex.set(i, id);
    return {
      id,
      batchId,
      position: existing + i,
      rawUrl: e.raw.slice(0, LINK_LIMITS.maxRawLength),
      normalizedUrl: e.normalizedUrl,
      platform: e.platform,
      postType: e.postType,
      postKey: e.postKey,
      validity: e.validity,
      invalidReason: e.reason,
      duplicateOfId: e.duplicateOfIndex != null ? firstIdByIndex.get(e.duplicateOfIndex) ?? null : null,
      usernameHint: e.accountHint,
      postId: e.postKey ? postId.get(e.postKey) ?? null : null,
    };
  });
  for (let i = 0; i < rows.length; i += 1000) await prisma.linkBatchItem.createMany({ data: rows.slice(i, i + 1000) });

  // Posts that already existed (another batch) are refreshed only if stale.
  const queued = await enqueueBatchPosts(batchId);
  if (batch.state !== "paused") {
    await prisma.linkBatch.update({
      where: { id: batchId },
      data: batch.state === "running" ? {} : { state: "running", runStartedAt: new Date(), runFinishedAt: null },
    });
  }
  return { counts, queued };
}

export interface CreateBatchInput extends AddLinksInput {
  name: string;
  notes?: string | null;
}

export async function createBatch(input: CreateBatchInput, userId: string) {
  const name = input.name.trim().slice(0, 160);
  if (!name) throw new AppError(400, "NAME_REQUIRED", "Give the batch a name");
  // Validate before creating anything, so a bad paste never leaves an empty batch behind.
  const raw = splitEntries(input.text ?? "", input.mode ?? "paste");
  if (!raw.length) throw new AppError(400, "NO_LINKS", "No links found in what you pasted");
  if (raw.length > LINK_LIMITS.maxEntriesPerAdd) {
    throw new AppError(400, "TOO_MANY_LINKS", `At most ${LINK_LIMITS.maxEntriesPerAdd.toLocaleString("en-IN")} links at a time — you sent ${raw.length.toLocaleString("en-IN")}`);
  }
  const batch = await prisma.linkBatch.create({
    data: { name, notes: input.notes?.trim() || null, keepDuplicates: Boolean(input.keepDuplicates), createdById: userId, state: "running", runStartedAt: new Date() },
  });
  const result = await addLinks(batch.id, input);
  return { id: batch.id, ...result };
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────

export interface BatchCounts {
  total: number;
  valid: number;
  invalid: number;
  unique: number;
  duplicate: number;
  pending: number;
  verified: number;
  restricted: number;
  failed: number;
}

export async function batchCounts(batchIds: string[]): Promise<Map<string, BatchCounts>> {
  const out = new Map<string, BatchCounts>();
  if (!batchIds.length) return out;
  for (const id of batchIds) out.set(id, { total: 0, valid: 0, invalid: 0, unique: 0, duplicate: 0, pending: 0, verified: 0, restricted: 0, failed: 0 });
  const items = await prisma.$queryRaw<Array<{ batch_id: string; validity: string; n: bigint; uniq: bigint }>>`
    SELECT batch_id, validity, count(*) AS n, count(DISTINCT post_key) AS uniq
      FROM link_batch_items WHERE batch_id IN (${Prisma.join(batchIds)}) GROUP BY batch_id, validity`;
  for (const r of items) {
    const c = out.get(r.batch_id)!;
    const n = Number(r.n);
    c.total += n;
    if (r.validity === "valid") {
      c.valid += n;
      c.unique += Number(r.uniq);
    } else if (r.validity === "invalid") c.invalid += n;
    else c.duplicate += n;
  }
  const posts = await prisma.$queryRaw<Array<{ batch_id: string; status: string; queued: boolean; n: bigint }>>`
    SELECT x.batch_id, p.status, (p.fetch_state = 'queued') AS queued, count(*) AS n
      FROM (SELECT DISTINCT batch_id, post_id FROM link_batch_items
             WHERE batch_id IN (${Prisma.join(batchIds)}) AND validity = 'valid' AND post_id IS NOT NULL) x
      JOIN link_posts p ON p.id = x.post_id
     GROUP BY x.batch_id, p.status, (p.fetch_state = 'queued')`;
  for (const r of posts) {
    const c = out.get(r.batch_id)!;
    const n = Number(r.n);
    if (r.queued || r.status === "pending") c.pending += n;
    else if (r.status === "verified") c.verified += n;
    else if (r.status === "restricted") c.restricted += n;
    else if (r.status === "failed") c.failed += n;
  }
  return out;
}

export async function listBatches(opts: { archived?: boolean } = {}) {
  const batches = await prisma.linkBatch.findMany({
    where: { archivedAt: opts.archived ? { not: null } : null },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const counts = await batchCounts(batches.map((b) => b.id));
  const creators = await prisma.user.findMany({ where: { id: { in: [...new Set(batches.map((b) => b.createdById))] } }, select: { id: true, name: true } });
  const nameOf = new Map(creators.map((u) => [u.id, u.name]));
  return batches.map((b) => ({ ...batchShape(b), createdBy: nameOf.get(b.createdById) || null, counts: counts.get(b.id)! }));
}

function batchShape(b: Awaited<ReturnType<typeof loadBatch>>) {
  return {
    id: b.id, name: b.name, notes: b.notes, keepDuplicates: b.keepDuplicates, state: b.state,
    runStartedAt: b.runStartedAt, runFinishedAt: b.runFinishedAt,
    refreshEveryHours: b.refreshEveryHours, scheduleEndsAt: b.scheduleEndsAt, nextRefreshAt: b.nextRefreshAt,
    archivedAt: b.archivedAt, createdAt: b.createdAt, updatedAt: b.updatedAt,
  };
}

export interface RunProgress {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  pending: number;
  /** Posts finished per minute in this run (null until one finishes). */
  perMinute: number | null;
  etaSeconds: number | null;
}

export async function runProgress(batchId: string, runStartedAt: Date | null): Promise<RunProgress> {
  const since = runStartedAt ?? new Date(0);
  const rows = await prisma.$queryRaw<Array<{ total: bigint; pending: bigint; done_run: bigint; failed: bigint; ok: bigint }>>`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE p.fetch_state = 'queued') AS pending,
           count(*) FILTER (WHERE p.fetch_state = 'idle' AND p.last_checked_at >= ${since}) AS done_run,
           count(*) FILTER (WHERE p.fetch_state = 'idle' AND p.status = 'failed') AS failed,
           count(*) FILTER (WHERE p.fetch_state = 'idle' AND p.status IN ('verified','restricted')) AS ok
      FROM (SELECT DISTINCT post_id FROM link_batch_items WHERE batch_id = ${batchId} AND validity = 'valid' AND post_id IS NOT NULL) x
      JOIN link_posts p ON p.id = x.post_id`;
  const r = rows[0];
  const total = Number(r?.total ?? 0);
  const pending = Number(r?.pending ?? 0);
  const doneRun = Number(r?.done_run ?? 0);
  const minutes = runStartedAt ? Math.max(0.5, (Date.now() - runStartedAt.getTime()) / 60000) : null;
  const perMinute = minutes && doneRun ? Math.round((doneRun / minutes) * 10) / 10 : null;
  return {
    total,
    processed: total - pending,
    succeeded: Number(r?.ok ?? 0),
    failed: Number(r?.failed ?? 0),
    pending,
    perMinute,
    etaSeconds: perMinute && pending ? Math.round((pending / perMinute) * 60) : null,
  };
}

export async function getBatch(id: string) {
  const b = await loadBatch(id);
  const [counts, progress] = await Promise.all([batchCounts([id]), runProgress(id, b.runStartedAt)]);
  return { ...batchShape(b), counts: counts.get(id)!, progress };
}

export type ItemView = "posts" | "invalid" | "duplicate";
export interface ItemQuery {
  view?: ItemView;
  q?: string;
  status?: string;
  platform?: string;
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

const SORTABLE: Record<string, (dir: "asc" | "desc") => Prisma.LinkBatchItemOrderByWithRelationInput> = {
  position: (dir) => ({ position: dir }),
  views: (dir) => ({ post: { views: { sort: dir, nulls: "last" } } }),
  likes: (dir) => ({ post: { likes: { sort: dir, nulls: "last" } } }),
  comments: (dir) => ({ post: { comments: { sort: dir, nulls: "last" } } }),
  shares: (dir) => ({ post: { shares: { sort: dir, nulls: "last" } } }),
  reach: (dir) => ({ post: { reach: { sort: dir, nulls: "last" } } }),
  saves: (dir) => ({ post: { saves: { sort: dir, nulls: "last" } } }),
  followers: (dir) => ({ post: { followers: { sort: dir, nulls: "last" } } }),
  publishedAt: (dir) => ({ post: { publishedAt: { sort: dir, nulls: "last" } } }),
  lastCheckedAt: (dir) => ({ post: { lastCheckedAt: { sort: dir, nulls: "last" } } }),
  account: (dir) => ({ post: { accountName: { sort: dir, nulls: "last" } } }),
  status: (dir) => ({ post: { status: dir } }),
};

export const POST_SELECT = {
  id: true, postKey: true, platform: true, postType: true, canonicalUrl: true, externalId: true, metaAssetId: true,
  accountName: true, username: true, followers: true, followersAt: true, caption: true, publishedAt: true, thumbnailUrl: true,
  views: true, reach: true, likes: true, comments: true, shares: true, saves: true,
  status: true, access: true, statusReason: true, errorMessage: true, dataSource: true, metricsAt: true, lastCheckedAt: true, checkCount: true,
  fetchState: true, nextAttemptAt: true, attempts: true,
} satisfies Prisma.LinkPostSelect;

export async function listItems(batchId: string, query: ItemQuery) {
  await loadBatch(batchId);
  const view = query.view ?? "posts";
  const pageSize = Math.min(200, Math.max(10, query.pageSize ?? 50));
  const page = Math.max(1, query.page ?? 1);
  const where: Prisma.LinkBatchItemWhereInput = { batchId, validity: view === "posts" ? "valid" : view };
  const postWhere: Prisma.LinkPostWhereInput = {};
  if (query.platform === "instagram" || query.platform === "facebook") where.platform = query.platform;
  if (view === "posts" && query.status) {
    if (query.status === "pending") postWhere.OR = [{ status: "pending" }, { fetchState: "queued" }];
    else if (["verified", "restricted", "failed"].includes(query.status)) Object.assign(postWhere, { status: query.status, fetchState: "idle" });
  }
  const q = query.q?.trim();
  if (q) {
    where.OR = [
      { rawUrl: { contains: q, mode: "insensitive" } },
      { post: { accountName: { contains: q, mode: "insensitive" } } },
      { post: { username: { contains: q.replace(/^@/, ""), mode: "insensitive" } } },
      { post: { caption: { contains: q, mode: "insensitive" } } },
    ];
  }
  if (Object.keys(postWhere).length) where.post = postWhere;
  const dir = query.dir === "asc" ? "asc" : "desc";
  const orderBy = [(SORTABLE[query.sort ?? ""] ?? SORTABLE.position)(query.sort ? dir : "asc"), { position: "asc" as const }];
  const [total, rows] = await Promise.all([
    prisma.linkBatchItem.count({ where }),
    prisma.linkBatchItem.findMany({
      where, orderBy, skip: (page - 1) * pageSize, take: pageSize,
      select: {
        id: true, position: true, rawUrl: true, normalizedUrl: true, platform: true, postType: true, validity: true, invalidReason: true,
        duplicateOfId: true, usernameHint: true, post: { select: POST_SELECT },
      },
    }),
  ]);
  return { total, page, pageSize, rows: rows.map((r) => ({ ...r, post: r.post ? postShape(r.post) : null })) };
}

type PostRow = Prisma.LinkPostGetPayload<{ select: typeof POST_SELECT }>;

/** Signed Meta CDN thumbnails expire (their `oe=` hex timestamp); never serve a dead one. */
export function thumbnailIfFresh(url: string | null, now = Date.now()): string | null {
  if (!url) return null;
  try {
    const oe = new URL(url).searchParams.get("oe");
    if (oe && /^[0-9a-f]+$/i.test(oe) && parseInt(oe, 16) * 1000 < now + 5 * 60_000) return null;
    return url;
  } catch {
    return null;
  }
}

/** The one shape every reader gets: values + where they came from + whether they are live. */
export function postShape(p: PostRow) {
  const live = p.dataSource === "meta_graph" || p.dataSource === "meta_business_discovery";
  return {
    ...p,
    thumbnailUrl: thumbnailIfFresh(p.thumbnailUrl),
    status: p.fetchState === "queued" && p.status === "pending" ? "pending" : p.status,
    refreshing: p.fetchState === "queued",
    /** "live" = read from Meta at metricsAt by this feature; "cached" = the platform's background sync. */
    freshness: p.metricsAt ? (live ? "live" : "cached") : null,
  };
}

export async function getPost(postId: string) {
  const p = await prisma.linkPost.findUnique({ where: { id: postId }, select: POST_SELECT });
  if (!p) throw new AppError(404, "NOT_FOUND", "Post not found");
  const snapshots = await prisma.linkPostSnapshot.findMany({
    where: { postId }, orderBy: { checkedAt: "asc" }, take: 500,
    select: { checkedAt: true, status: true, dataSource: true, metricsAt: true, views: true, reach: true, likes: true, comments: true, shares: true, saves: true, followers: true },
  });
  const withValues = snapshots.filter((s) => s.status === "verified" || s.status === "restricted");
  const first = withValues[0] ?? null;
  const last = withValues[withValues.length - 1] ?? null;
  const delta = (k: "views" | "reach" | "likes" | "comments" | "shares" | "saves") =>
    first && last && first[k] != null && last[k] != null ? last[k]! - first[k]! : null;
  const growth = first && last && first !== last
    ? { from: first.checkedAt, to: last.checkedAt, views: delta("views"), reach: delta("reach"), likes: delta("likes"), comments: delta("comments"), shares: delta("shares"), saves: delta("saves") }
    : null;
  const items = await prisma.linkBatchItem.findMany({ where: { postId }, select: { batchId: true, rawUrl: true, usernameHint: true, batch: { select: { name: true } } }, take: 50 });
  return { post: postShape(p), snapshots, growth, batches: items.map((i) => ({ id: i.batchId, name: i.batch.name, rawUrl: i.rawUrl, usernameHint: i.usernameHint })) };
}

// ── Controls ────────────────────────────────────────────────────────────────────────────

export async function refreshBatch(id: string) {
  const b = await loadBatch(id);
  if (b.archivedAt) throw new AppError(409, "ARCHIVED", "Restore this batch first");
  const queued = await enqueueBatchPosts(id);
  await prisma.linkBatch.update({ where: { id }, data: { state: "running", runStartedAt: new Date(), runFinishedAt: null } });
  return { queued, skippedFresh: FRESH_MINUTES() };
}

export async function pauseBatch(id: string) {
  const b = await loadBatch(id);
  if (b.state !== "running") throw new AppError(409, "NOT_RUNNING", "This batch isn't running");
  await prisma.linkBatch.update({ where: { id }, data: { state: "paused" } });
  return { state: "paused" };
}

export async function resumeBatch(id: string) {
  const b = await loadBatch(id);
  if (b.state !== "paused") throw new AppError(409, "NOT_PAUSED", "This batch isn't paused");
  await prisma.linkBatch.update({ where: { id }, data: { state: "running" } });
  return { state: "running" };
}

export async function retryFailed(id: string) {
  const b = await loadBatch(id);
  if (b.archivedAt) throw new AppError(409, "ARCHIVED", "Restore this batch first");
  const queued = await enqueueBatchPosts(id, { force: true, onlyStatus: "failed" });
  if (queued && b.state !== "paused") await prisma.linkBatch.update({ where: { id }, data: { state: "running", runStartedAt: b.state === "running" ? b.runStartedAt : new Date(), runFinishedAt: null } });
  return { queued };
}

/** Per-post refresh: always fetches (force), and runs even when its batches are idle. */
export async function refreshPost(postId: string, batchId: string) {
  const item = await prisma.linkBatchItem.findFirst({ where: { postId, batchId }, select: { id: true } });
  if (!item) throw new AppError(404, "NOT_FOUND", "Post not found in this batch");
  await prisma.linkPost.update({
    where: { id: postId },
    data: { fetchState: "queued", queuedAt: new Date(), nextAttemptAt: new Date(), attempts: 0 },
  });
  const b = await loadBatch(batchId);
  if (b.state === "idle") await prisma.linkBatch.update({ where: { id: batchId }, data: { state: "running", runStartedAt: new Date(), runFinishedAt: null } });
  return { queued: 1, paused: b.state === "paused" };
}

/** Staff type the @username for a bare IG /p/<code> link so business discovery can look it up. */
export async function setUsernameHint(batchId: string, itemId: string, username: string | null) {
  const item = await prisma.linkBatchItem.findFirst({ where: { id: itemId, batchId } });
  if (!item) throw new AppError(404, "NOT_FOUND", "Link not found");
  if (item.platform !== "instagram") throw new AppError(400, "NOT_INSTAGRAM", "Only Instagram links take a username");
  const u = username?.trim().replace(/^@/, "").toLowerCase() || null;
  if (u && !/^[a-z0-9._]{1,30}$/.test(u)) throw new AppError(400, "BAD_USERNAME", "That isn't a valid Instagram username");
  await prisma.linkBatchItem.updateMany({ where: { batchId, postId: item.postId }, data: { usernameHint: u } });
  if (item.postId) await refreshPost(item.postId, batchId);
  return { usernameHint: u };
}

export async function setSchedule(id: string, hours: number | null) {
  const b = await loadBatch(id);
  if (hours != null && !SCHEDULE_HOURS.includes(hours as (typeof SCHEDULE_HOURS)[number])) {
    throw new AppError(400, "BAD_SCHEDULE", "Refresh every 6, 12 or 24 hours");
  }
  if (hours != null && b.archivedAt) throw new AppError(409, "ARCHIVED", "Restore this batch first");
  const now = Date.now();
  const data = hours == null
    ? { refreshEveryHours: null, scheduleEndsAt: null, nextRefreshAt: null }
    : { refreshEveryHours: hours, scheduleEndsAt: new Date(now + SCHEDULE_MAX_DAYS * 86400_000), nextRefreshAt: new Date(now + hours * 3600_000) };
  const u = await prisma.linkBatch.update({ where: { id }, data });
  return batchShape(u);
}

export async function updateBatch(id: string, data: { name?: string; notes?: string | null; keepDuplicates?: boolean }) {
  await loadBatch(id);
  const patch: Prisma.LinkBatchUpdateInput = {};
  if (data.name !== undefined) {
    const n = data.name.trim().slice(0, 160);
    if (!n) throw new AppError(400, "NAME_REQUIRED", "Give the batch a name");
    patch.name = n;
  }
  if (data.notes !== undefined) patch.notes = data.notes?.trim() || null;
  if (data.keepDuplicates !== undefined) patch.keepDuplicates = data.keepDuplicates;
  return batchShape(await prisma.linkBatch.update({ where: { id }, data: patch }));
}

export async function archiveBatch(id: string, archived: boolean) {
  await loadBatch(id);
  const u = await prisma.linkBatch.update({
    where: { id },
    data: archived
      ? { archivedAt: new Date(), state: "idle", refreshEveryHours: null, scheduleEndsAt: null, nextRefreshAt: null }
      : { archivedAt: null },
  });
  return batchShape(u);
}
