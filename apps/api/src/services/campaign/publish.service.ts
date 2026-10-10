import { prisma } from "@dashmani/db";
import { decryptToken } from "../../utils/token-crypto";
import { oauthGraphFetch, oauthGraphPost, type OauthGraphResult } from "../meta-oauth/oauth-graph";
import { metaGraphVersion } from "../meta-oauth/meta-config";
import { campaignConfig } from "./config";
import { signedMediaPath } from "./media-url";
import { logBookingEvent, settleBooking, type Actor } from "./booking.service";
import { sendDeliveryEmail, sendItemLiveEmail } from "./delivery.service";

// Phase 2 — publish approved campaign items on our connected Instagram accounts and Facebook
// Pages through the Meta API. Switched OFF unless CAMPAIGN_PUBLISH_ENABLED=1.
//
// ⚠️ THE RULES THIS FILE EXISTS TO KEEP:
//  • Never post twice. A create/publish call that times out (status 0) may have succeeded, so
//    it is NEVER blindly repeated: Instagram is re-checked through its container status, and a
//    Facebook post that Meta didn't confirm goes to staff ("check the Page first").
//  • Never fail a paid item silently. Anything the API can't do — a missing permission, a token
//    that needs reconnecting, song audio (the API cannot add a song), five failed attempts —
//    hands the item to staff as `manual_pending` with the reason. Only staff mark an item
//    failed / refunded.
//  • Never publish before the launch day: an item is due from launch day CAMPAIGN_PUBLISH_HOUR_IST
//    (IST), or immediately when staff press "Publish now".
//  • A container id is saved the moment it exists, so a retry reuses it instead of creating a
//    second one.

const SYSTEM: Actor = { type: "system" };
const IG_SCOPE = "instagram_content_publish";
const FB_SCOPE = "pages_manage_posts";
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [2, 10, 30, 120, 360].map((m) => m * 60_000);
const LOCK_MS = 10 * 60_000;
/** Instagram containers come back IN_PROGRESS while Meta fetches and processes a video. */
const CONTAINER_POLL_MS = 60_000;
/** After a publish call went unanswered, wait before re-checking so Meta can settle. */
const AMBIGUOUS_RECHECK_MS = 2 * 60_000;
/** A container still processing after this long is treated as stuck. */
const CONTAINER_STUCK_MS = 6 * 3600_000;

// ── Eligibility ─────────────────────────────────────────────────────────────────

export interface PublishTarget {
  platform: "instagram" | "facebook";
  metaId: string;
  token: string;
}

type Eligibility = { ok: true; target: PublishTarget } | { ok: false; reason: string };

interface ItemLike {
  targetType: string;
  targetId: string;
  platform: string;
  format: string;
}
interface BookingLike {
  audioIntegration: boolean;
  media: Array<{ kind: string }>;
}

/** Can this item be published by the API right now? Reason is shown to staff when not. */
export async function checkEligibility(item: ItemLike, booking: BookingLike): Promise<Eligibility> {
  if (!campaignConfig.publishEnabled()) return { ok: false, reason: "Auto-publishing is switched off." };
  if (item.targetType !== "meta_asset" || (item.platform !== "instagram" && item.platform !== "facebook")) {
    return { ok: false, reason: "This platform is posted by hand." };
  }
  if (booking.audioIntegration && item.format === "reel") {
    return { ok: false, reason: "Song audio integration has to be added in the app — the API cannot attach a song." };
  }
  if (item.format === "story") return { ok: false, reason: "Stories are posted by hand." };
  if (booking.media.length === 0) return { ok: false, reason: "No prepared media." };
  if (item.platform === "facebook" && item.format === "carousel" && booking.media.some((m) => m.kind === "video")) {
    return { ok: false, reason: "Facebook carousels can only hold images through the API." };
  }

  const asset = await prisma.metaAsset.findUnique({
    where: { id: item.targetId },
    select: {
      kind: true, metaId: true, pageTokenEnc: true, disconnectedAt: true, selected: true,
      connection: { select: { userTokenEnc: true, grantedScopes: true, status: true, revokedAt: true } },
    },
  });
  if (!asset || asset.disconnectedAt || !asset.selected) return { ok: false, reason: "The account is no longer connected." };
  const conn = asset.connection;
  if (!conn || conn.revokedAt || conn.status === "REVOKED" || conn.status === "NEEDS_REAUTH") {
    return { ok: false, reason: "The Meta connection for this account needs reconnecting." };
  }
  const scopes = new Set((conn.grantedScopes ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const needed = item.platform === "instagram" ? IG_SCOPE : FB_SCOPE;
  if (!scopes.has(needed)) return { ok: false, reason: `The connected account didn't grant publishing (${needed}).` };

  try {
    if (item.platform === "instagram") {
      if (asset.kind !== "INSTAGRAM_ACCOUNT" || !conn.userTokenEnc) return { ok: false, reason: "No Instagram token for this account." };
      return { ok: true, target: { platform: "instagram", metaId: asset.metaId, token: decryptToken(conn.userTokenEnc) } };
    }
    if (asset.kind !== "FACEBOOK_PAGE" || !asset.pageTokenEnc) return { ok: false, reason: "No Page token for this Page." };
    return { ok: true, target: { platform: "facebook", metaId: asset.metaId, token: decryptToken(asset.pageTokenEnc) } };
  } catch {
    return { ok: false, reason: "The stored token could not be read — reconnect the account." };
  }
}

/** When an item becomes due: launch day at CAMPAIGN_PUBLISH_HOUR_IST (IST), never in the past. */
export function launchAt(launchFrom: Date | null, now = new Date()): Date {
  if (!launchFrom) return now;
  // launchFrom is stored as the IST calendar day at 00:00 UTC.
  const at = new Date(launchFrom.getTime() + campaignConfig.publishHourIST() * 3600_000 - 5.5 * 3600_000);
  return at > now ? at : now;
}

/**
 * Decide, for every pending item of a booking being approved, whether it is auto-published
 * (queued) or posted by staff (manual_pending). Pure apart from the eligibility reads.
 */
export async function planPublishing(bookingId: string) {
  const b = await prisma.campaignBooking.findUnique({
    where: { id: bookingId },
    select: {
      launchFrom: true,
      audioIntegration: true,
      media: { where: { purgedAt: null }, select: { kind: true } },
      items: { where: { status: "pending" }, select: { id: true, targetType: true, targetId: true, platform: true, format: true, accountName: true } },
    },
  });
  if (!b) return [];
  const at = launchAt(b.launchFrom);
  const plan: Array<{ itemId: string; accountName: string; auto: boolean; reason?: string; at?: Date }> = [];
  for (const item of b.items) {
    const e = await checkEligibility(item, b);
    plan.push(e.ok ? { itemId: item.id, accountName: item.accountName, auto: true, at } : { itemId: item.id, accountName: item.accountName, auto: false, reason: e.reason });
  }
  return plan;
}

// ── One publish step ────────────────────────────────────────────────────────────

export type Outcome =
  | { kind: "published"; remotePostId: string; permalink: string | null }
  | { kind: "wait"; delayMs: number; containerId: string | null }
  | { kind: "retry"; error: string; containerId: string | null; delayMs?: number }
  | { kind: "manual"; reason: string };

interface PublishJob {
  itemId: string;
  format: string;
  containerId: string | null;
  caption: string;
  userTags: string[];
  collaborators: string[];
  media: Array<{ id: string; kind: string }>;
}

/** The caption we post: the client's caption, then any hashtags not already in it. */
export function buildCaption(caption: string, hashtags: string[]): string {
  const base = (caption ?? "").trim();
  const have = new Set((base.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.slice(1).toLowerCase()));
  const extra = hashtags.filter((h) => h && !have.has(h.toLowerCase())).map((h) => `#${h}`);
  return [base, extra.join(" ")].filter(Boolean).join("\n\n").slice(0, 2200);
}

function mediaUrl(mediaId: string): string {
  return `${campaignConfig.apiPublicUrl()}${signedMediaPath(mediaId, "preview", campaignConfig.publishMediaTtlSec())}`;
}

/** Map a failed Graph call to an outcome. `ambiguous` decides what a status-0 means. */
function failure(res: OauthGraphResult, what: string, containerId: string | null): Outcome {
  if (res.authInvalid) return { kind: "manual", reason: "The Meta connection needs reconnecting (token rejected)." };
  const code = res.errorCode ?? 0;
  if (code === 10 || (code >= 200 && code < 300)) return { kind: "manual", reason: `No permission to publish here: ${res.error ?? what}` };
  if (res.rateLimited) return { kind: "retry", error: `Meta rate limit (${what})`, containerId, delayMs: 30 * 60_000 };
  return { kind: "retry", error: `${what}: ${res.error ?? `HTTP ${res.status}`}`, containerId };
}

// ── Instagram ──

async function igPermalink(id: string, token: string): Promise<string | null> {
  for (let i = 0; i < 2; i++) {
    const r = await oauthGraphFetch<{ permalink?: string }>(id, { fields: "permalink" }, token, { label: "campaign-ig-permalink" });
    if (r.ok && r.data?.permalink) return r.data.permalink;
  }
  return null;
}

/** After an unanswered media_publish: find the post among the account's newest media. */
async function igFindRecent(target: PublishTarget, caption: string): Promise<{ id: string; permalink: string | null } | null> {
  const probe = caption.slice(0, 80).trim();
  if (!probe) return null;
  const r = await oauthGraphFetch<{ data?: Array<{ id: string; caption?: string; permalink?: string }> }>(
    `${target.metaId}/media`, { fields: "id,caption,permalink,timestamp", limit: 10 }, target.token, { label: "campaign-ig-recent" },
  );
  const hit = r.ok ? r.data?.data?.find((m) => (m.caption ?? "").trim().startsWith(probe)) : undefined;
  return hit ? { id: hit.id, permalink: hit.permalink ?? null } : null;
}

async function igCreate(target: PublishTarget, job: PublishJob): Promise<Outcome> {
  const quota = await oauthGraphFetch<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(
    `${target.metaId}/content_publishing_limit`, { fields: "quota_usage,config" }, target.token, { label: "campaign-ig-quota" },
  );
  const q = quota.ok ? quota.data?.data?.[0] : undefined;
  if (q?.quota_usage != null && q.config?.quota_total != null && q.quota_usage >= q.config.quota_total) {
    return { kind: "wait", delayMs: 60 * 60_000, containerId: null };
  }

  const caption = job.caption;
  const collaborators = job.collaborators.length ? JSON.stringify(job.collaborators.slice(0, 3)) : undefined;
  const path = `${target.metaId}/media`;

  if (job.format === "carousel") {
    // Children first. Their ids are kept (prefix "c:") until every child has processed, then
    // the parent is created from them.
    const ids: string[] = [];
    for (const m of job.media.slice(0, 10)) {
      const r = await oauthGraphPost<{ id?: string }>(
        path,
        m.kind === "video"
          ? { media_type: "VIDEO", is_carousel_item: true, video_url: mediaUrl(m.id) }
          : { is_carousel_item: true, image_url: mediaUrl(m.id) },
        target.token,
        { label: "campaign-ig-child", timeoutMs: 30_000 },
      );
      if (!r.ok || !r.data?.id) return failure(r, "carousel item", null);
      ids.push(r.data.id);
    }
    return { kind: "wait", delayMs: 15_000, containerId: `c:${ids.join(",")}` };
  }

  const m = job.media[0];
  const params: Record<string, string | number | boolean | undefined> =
    m.kind === "video"
      ? {
          media_type: "REELS",
          video_url: mediaUrl(m.id),
          caption,
          share_to_feed: true,
          collaborators,
          user_tags: job.userTags.length ? JSON.stringify(job.userTags.slice(0, 20).map((username) => ({ username }))) : undefined,
        }
      : {
          image_url: mediaUrl(m.id),
          caption,
          collaborators,
          user_tags: job.userTags.length ? JSON.stringify(job.userTags.slice(0, 20).map((username) => ({ username, x: 0.5, y: 0.5 }))) : undefined,
        };
  const r = await oauthGraphPost<{ id?: string }>(path, params, target.token, { label: "campaign-ig-container", timeoutMs: 30_000 });
  // A container is not a post: an unanswered create is safe to retry (the stray container expires).
  if (!r.ok || !r.data?.id) return failure(r, "container", null);
  return { kind: "wait", delayMs: m.kind === "video" ? CONTAINER_POLL_MS : 5_000, containerId: r.data.id };
}

async function igStep(target: PublishTarget, job: PublishJob): Promise<Outcome> {
  if (!job.containerId) return igCreate(target, job);

  // Carousel children still processing → wait; all finished → create the parent.
  if (job.containerId.startsWith("c:")) {
    const ids = job.containerId.slice(2).split(",").filter(Boolean);
    for (const id of ids) {
      const s = await oauthGraphFetch<{ status_code?: string }>(id, { fields: "status_code" }, target.token, { label: "campaign-ig-status" });
      if (!s.ok) return failure(s, "carousel item status", job.containerId);
      if (s.data?.status_code === "ERROR" || s.data?.status_code === "EXPIRED") {
        return { kind: "retry", error: `A carousel item could not be processed (${s.data.status_code}).`, containerId: null };
      }
      if (s.data?.status_code !== "FINISHED") return { kind: "wait", delayMs: CONTAINER_POLL_MS, containerId: job.containerId };
    }
    const parent = await oauthGraphPost<{ id?: string }>(
      `${target.metaId}/media`,
      {
        media_type: "CAROUSEL",
        children: ids.join(","),
        caption: job.caption,
        collaborators: job.collaborators.length ? JSON.stringify(job.collaborators.slice(0, 3)) : undefined,
      },
      target.token,
      { label: "campaign-ig-container", timeoutMs: 30_000 },
    );
    if (!parent.ok || !parent.data?.id) return failure(parent, "carousel", job.containerId);
    return { kind: "wait", delayMs: 5_000, containerId: parent.data.id };
  }

  const st = await oauthGraphFetch<{ status_code?: string; status?: string }>(
    job.containerId, { fields: "status_code,status" }, target.token, { label: "campaign-ig-status" },
  );
  if (!st.ok) return failure(st, "container status", job.containerId);
  switch (st.data?.status_code) {
    case "IN_PROGRESS":
      // Instagram expires an unfinished container after 24 h (→ EXPIRED → a fresh one).
      return { kind: "wait", delayMs: CONTAINER_POLL_MS, containerId: job.containerId };
    case "ERROR":
    case "EXPIRED":
      // Make a fresh container next time.
      return { kind: "retry", error: `Instagram could not process the media (${st.data.status_code}${st.data.status ? `: ${st.data.status}` : ""}).`, containerId: null };
    case "PUBLISHED": {
      // An earlier media_publish went through but its answer was lost. Find the post.
      const found = await igFindRecent(target, job.caption);
      if (found) return { kind: "published", remotePostId: found.id, permalink: found.permalink ?? (await igPermalink(found.id, target.token)) };
      return { kind: "manual", reason: "Instagram published the post but we couldn't read its link — open the profile and paste it." };
    }
    case "FINISHED":
      break;
    default:
      return { kind: "wait", delayMs: CONTAINER_POLL_MS, containerId: job.containerId };
  }

  const pub = await oauthGraphPost<{ id?: string }>(
    `${target.metaId}/media_publish`, { creation_id: job.containerId }, target.token, { label: "campaign-ig-publish", timeoutMs: 60_000 },
  );
  if (pub.ok && pub.data?.id) {
    return { kind: "published", remotePostId: pub.data.id, permalink: await igPermalink(pub.data.id, target.token) };
  }
  // ⚠️ Unanswered: it may have published. Re-check the container (→ PUBLISHED) before any retry.
  if (pub.status === 0) return { kind: "wait", delayMs: AMBIGUOUS_RECHECK_MS, containerId: job.containerId };
  if (pub.errorCode === 9007) return { kind: "wait", delayMs: CONTAINER_POLL_MS, containerId: job.containerId }; // media not ready
  return failure(pub, "publish", job.containerId);
}

// ── Facebook ──

async function fbPermalink(id: string, token: string): Promise<string | null> {
  for (let i = 0; i < 2; i++) {
    const r = await oauthGraphFetch<{ permalink_url?: string }>(id, { fields: "permalink_url" }, token, { label: "campaign-fb-permalink" });
    const p = r.ok ? r.data?.permalink_url : undefined;
    if (p) return p.startsWith("http") ? p : `https://www.facebook.com${p.startsWith("/") ? "" : "/"}${p}`;
  }
  return null;
}

const FB_UNCONFIRMED = "Meta didn't confirm the Facebook post — check the Page before posting again, then paste the link.";

async function fbStep(target: PublishTarget, job: PublishJob): Promise<Outcome> {
  const page = target.metaId;
  const message = job.caption;

  // Reels: start → upload (Meta fetches file_url) → finish, then wait until it is live.
  if (job.format === "reel") {
    const m = job.media[0];
    if (!job.containerId) {
      const start = await oauthGraphPost<{ video_id?: string }>(`${page}/video_reels`, { upload_phase: "start" }, target.token, { label: "campaign-fb-reel" });
      if (!start.ok || !start.data?.video_id) return failure(start, "reel start", null); // nothing posted yet
      const videoId = start.data.video_id;
      const up = await oauthGraphPost<{ success?: boolean }>(
        `https://rupload.facebook.com/video-upload/${metaGraphVersion()}/${videoId}`, {}, target.token,
        { label: "campaign-fb-reel-upload", tokenInHeader: true, headers: { file_url: mediaUrl(m.id) }, timeoutMs: 120_000 },
      );
      if (!up.ok) return failure(up, "reel upload", null); // an unfinished upload is never shown
      const fin = await oauthGraphPost<{ success?: boolean }>(
        `${page}/video_reels`, { upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description: message },
        target.token, { label: "campaign-fb-reel", timeoutMs: 60_000 },
      );
      if (fin.ok || fin.status === 0) {
        // Finished (or unanswered): from here only the video's own status decides.
        // The start time rides along so a reel stuck in processing can be handed to staff.
        return { kind: "wait", delayMs: CONTAINER_POLL_MS, containerId: `reel:${videoId}:${Date.now()}` };
      }
      return failure(fin, "reel finish", null);
    }
    const [, videoId, startedRaw] = job.containerId.split(":");
    const startedAt = Number(startedRaw) || Date.now();
    const st = await oauthGraphFetch<{ status?: { video_status?: string; publishing_phase?: { status?: string } } }>(
      videoId, { fields: "status" }, target.token, { label: "campaign-fb-reel-status" },
    );
    if (!st.ok) return failure(st, "reel status", job.containerId);
    const vs = st.data?.status?.video_status;
    const ps = st.data?.status?.publishing_phase?.status;
    if (vs === "error" || ps === "error") return { kind: "manual", reason: "Facebook could not process the reel — post it by hand." };
    if (ps === "complete") return { kind: "published", remotePostId: videoId, permalink: await fbPermalink(videoId, target.token) };
    if (Date.now() - startedAt > CONTAINER_STUCK_MS) {
      return { kind: "manual", reason: "Facebook is still processing the reel after hours — check the Page and paste the link." };
    }
    return { kind: "wait", delayMs: CONTAINER_POLL_MS, containerId: job.containerId };
  }

  if (job.format === "carousel") {
    // A multi-photo post: each photo uploaded unpublished, then one feed post.
    const fbids: string[] = [];
    for (const m of job.media.slice(0, 10)) {
      const r = await oauthGraphPost<{ id?: string }>(`${page}/photos`, { url: mediaUrl(m.id), published: false }, target.token, { label: "campaign-fb-photo", timeoutMs: 60_000 });
      if (!r.ok || !r.data?.id) return failure(r, "carousel photo", null); // unpublished photos are never shown
      fbids.push(r.data.id);
    }
    const params: Record<string, string> = { message };
    fbids.forEach((id, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
    const post = await oauthGraphPost<{ id?: string }>(`${page}/feed`, params, target.token, { label: "campaign-fb-feed", timeoutMs: 60_000 });
    if (post.ok && post.data?.id) return { kind: "published", remotePostId: post.data.id, permalink: await fbPermalink(post.data.id, target.token) };
    if (post.status === 0) return { kind: "manual", reason: FB_UNCONFIRMED };
    return failure(post, "post", null);
  }

  // A single post: photo or video.
  const m = job.media[0];
  const r =
    m.kind === "video"
      ? await oauthGraphPost<{ id?: string }>(`${page}/videos`, { file_url: mediaUrl(m.id), description: message }, target.token, { label: "campaign-fb-video", timeoutMs: 120_000 })
      : await oauthGraphPost<{ id?: string; post_id?: string }>(`${page}/photos`, { url: mediaUrl(m.id), caption: message }, target.token, { label: "campaign-fb-photo", timeoutMs: 60_000 });
  if (r.ok && r.data?.id) {
    const postId = (r.data as { post_id?: string }).post_id ?? r.data.id;
    return { kind: "published", remotePostId: postId, permalink: await fbPermalink(postId, target.token) };
  }
  if (r.status === 0) return { kind: "manual", reason: FB_UNCONFIRMED };
  return failure(r, "post", null);
}

// ── The worker ──────────────────────────────────────────────────────────────────

/** Run one step for one item and record the result. Exported for tests. */
export async function publishItem(itemId: string): Promise<Outcome | null> {
  const item = await prisma.campaignBookingItem.findUnique({
    where: { id: itemId },
    select: {
      id: true, bookingId: true, status: true, targetType: true, targetId: true, platform: true, format: true,
      accountName: true, attempts: true, containerId: true,
      booking: {
        select: {
          status: true, caption: true, hashtags: true, userTags: true, collaborators: true, audioIntegration: true,
          media: { where: { purgedAt: null, renderStatus: "done" }, orderBy: { position: "asc" }, select: { id: true, kind: true } },
        },
      },
    },
  });
  if (!item || item.status !== "queued") return null;
  if (!["approved", "publishing"].includes(item.booking.status)) return null;

  let outcome: Outcome;
  const e = await checkEligibility(item, item.booking);
  if (!e.ok) {
    outcome = { kind: "manual", reason: e.reason };
  } else {
    const job: PublishJob = {
      itemId: item.id,
      format: item.format,
      containerId: item.containerId,
      caption: buildCaption(item.booking.caption ?? "", item.booking.hashtags),
      userTags: item.booking.userTags,
      collaborators: item.booking.collaborators,
      media: item.booking.media,
    };
    try {
      outcome = e.target.platform === "instagram" ? await igStep(e.target, job) : await fbStep(e.target, job);
    } catch (err) {
      outcome = { kind: "retry", error: err instanceof Error ? err.message : String(err), containerId: item.containerId };
    }
  }
  await applyOutcome(item, outcome);
  return outcome;
}

async function applyOutcome(
  item: { id: string; bookingId: string; accountName: string; format: string; attempts: number },
  o: Outcome,
): Promise<void> {
  const now = new Date();
  const where = { id: item.id, status: "queued" };
  if (o.kind === "published") {
    const res = await prisma.campaignBookingItem.updateMany({
      where,
      data: {
        status: "published", remotePostId: o.remotePostId, permalink: o.permalink, postedAt: now,
        lastError: o.permalink ? null : "Published — the link could not be read yet. Paste it from the profile.",
        lockedUntil: null, nextAttemptAt: null,
      },
    });
    if (res.count !== 1) return;
    await logBookingEvent(item.bookingId, SYSTEM, `Auto-published on ${item.accountName} (${item.format})${o.permalink ? `: ${o.permalink}` : ""}`);
    if (o.permalink) void sendItemLiveEmail(item.id).catch((err) => console.error("[campaign-publish] live email failed", err));
    const finished = await settleBooking(item.bookingId, SYSTEM);
    if (finished) void sendDeliveryEmail(item.bookingId).catch((err) => console.error("[campaign-publish] delivery email failed", err));
    return;
  }
  if (o.kind === "wait") {
    await prisma.campaignBookingItem.updateMany({
      where,
      data: { containerId: o.containerId, nextAttemptAt: new Date(now.getTime() + o.delayMs), lockedUntil: null },
    });
    return;
  }
  if (o.kind === "retry") {
    const attempts = item.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      return applyOutcome(item, { kind: "manual", reason: `Auto-publish failed ${attempts} times — post by hand. Last error: ${o.error}` });
    }
    await prisma.campaignBookingItem.updateMany({
      where,
      data: {
        attempts, lastError: o.error.slice(0, 500), containerId: o.containerId,
        nextAttemptAt: new Date(now.getTime() + (o.delayMs ?? BACKOFF_MS[attempts - 1])), lockedUntil: null,
      },
    });
    return;
  }
  const res = await prisma.campaignBookingItem.updateMany({
    where,
    data: { status: "manual_pending", lastError: o.reason.slice(0, 500), lockedUntil: null, nextAttemptAt: null },
  });
  if (res.count === 1) await logBookingEvent(item.bookingId, SYSTEM, `Handed to staff for ${item.accountName}: ${o.reason}`);
}

let running = false;

/** One worker tick: claim up to N due items, run one step each. Never throws. */
export async function runPublishTick(): Promise<number> {
  if (running || !campaignConfig.publishEnabled()) return 0;
  running = true; // claimed before the first await — a concurrent tick skips
  try {
    const now = new Date();
    const due = await prisma.campaignBookingItem.findMany({
      where: {
        status: "queued",
        AND: [
          { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
        ],
        booking: { status: { in: ["approved", "publishing"] } },
      },
      orderBy: { nextAttemptAt: "asc" },
      take: campaignConfig.publishBatch(),
      select: { id: true },
    });
    let n = 0;
    for (const { id } of due) {
      const claim = await prisma.campaignBookingItem.updateMany({
        where: { id, status: "queued", OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
        data: { lockedUntil: new Date(Date.now() + LOCK_MS) },
      });
      if (claim.count !== 1) continue;
      try {
        await publishItem(id);
        n++;
      } catch (err) {
        console.error("[campaign-publish] item failed:", id, err);
        await prisma.campaignBookingItem.updateMany({ where: { id, status: "queued" }, data: { lockedUntil: null } }).catch(() => undefined);
      }
    }
    return n;
  } catch (err) {
    console.error("[campaign-publish] tick failed:", err);
    return 0;
  } finally {
    running = false;
  }
}
