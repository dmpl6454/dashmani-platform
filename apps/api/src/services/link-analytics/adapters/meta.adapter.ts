// Link Analytics — Meta adapter. OFFICIAL GRAPH API ONLY (docs/link-analytics/SPEC.md §2).
//
// Per post it decides WHO OWNS IT, then reads what Meta allows for that owner:
//   1. Our own connected IG account / FB Page (meta_assets) → full read with our token:
//      IG  GET /{media}?fields=…,insights.metric(reach,views,saved,shares)   (user token)
//      FB  GET /{page}_{post}?fields=…,likes.summary,comments.summary,shares,insights.metric(…)  (Page token)
//      → Verified, access "full", source meta_graph.
//   2. Someone else's IG business/creator account, when we know its username → business discovery
//      (likes, comments, reel views, followers; NO reach/shares/saves — private to the owner)
//      → Restricted, access "public", source meta_business_discovery.
//   3. Anything else → Restricted with the reason. NEVER zeros.
//
// Owner lookup costs nothing for posts the platform's Meta sync already holds: meta_posts.match_id
// is the IG shortcode / FB numeric id (the same lookup campaign delivery uses). Only a post the
// sync hasn't seen costs a lookup call.
//
// ⚠️ Metric names are version-sensitive; these are the live-probed ones from meta-posts.service.ts
// (IG `views` not `impressions`/`plays`; FB `post_media_view` / `post_total_media_view_unique`, not
// `post_impressions*` / `post_video_views`). One invalid metric 400s the whole call, so a metric
// error retries with fewer metrics instead of failing the post.

import { prisma } from "@dashmani/db";
import { decryptToken, scrubSecrets } from "../../../utils/token-crypto";
import { isTransientGraphFailure, type OauthGraphResult } from "../../meta-oauth/oauth-graph";
import {
  NO_VALUES,
  type AdapterContext,
  type FetchOutcome,
  type FetchTarget,
  type LinkMetricsAdapter,
  type MetricValues,
} from "../types";

const LIVE_STATUSES = ["ACTIVE", "PARTIAL_SCOPE", "NEEDS_REAUTH_SOON", "RATE_LIMITED"] as const;

/** Pages of an account's media that business discovery walks per username per tick (×50). */
const BD_MAX_PAGES = () => Math.max(1, Math.min(20, Number(process.env.LINK_ANALYTICS_BD_MAX_PAGES) || 4));
/** Pages of OUR OWN IG feed walked to find a post the sync hasn't stored yet (×100). */
const OWN_FEED_MAX_PAGES = 3;

const IG_BASE_FIELDS =
  "id,shortcode,permalink,caption,like_count,comments_count,media_type,media_product_type,timestamp,thumbnail_url,media_url,username";
const IG_METRIC_SETS = ["reach,views,saved,shares", "views", ""];
const FB_POST_BASE_FIELDS =
  "id,message,permalink_url,created_time,full_picture,from{id,name},likes.summary(true).limit(0),comments.summary(true).limit(0),shares";
const FB_METRIC_SETS = ["post_media_view,post_total_media_view_unique", ""];
const FB_VIDEO_FIELDS = "id,description,permalink_url,created_time,picture,from{id,name},likes.summary(true).limit(0),comments.summary(true).limit(0)";
// ⚠️ NO `shortcode`: business_discovery rejects it with "(#100) Please read documentation for supported
// fields" (live-probed 2026-11-25), which failed every third-party IG post. codeOf() reads the permalink.
const BD_MEDIA_FIELDS = "id,permalink,caption,like_count,comments_count,view_count,media_type,media_product_type,timestamp,thumbnail_url";
const BD_MEDIA_FIELDS_NO_VIEWS = BD_MEDIA_FIELDS.replace(",view_count", "");

type Asset = {
  id: string;
  kind: "FACEBOOK_PAGE" | "INSTAGRAM_ACCOUNT";
  metaId: string;
  name: string;
  username: string | null;
  followerCount: number | null;
  followersAt: Date;
  pageTokenEnc: string | null;
  userTokenEnc: string | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const date = (v: unknown): Date | null => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const clip = (s: unknown, n = 2200): string | null => (typeof s === "string" && s ? s.slice(0, n) : null);

function insightMap(raw: unknown): Map<string, number | null> {
  const m = new Map<string, number | null>();
  const data = (raw as { data?: Array<{ name?: string; values?: Array<{ value?: unknown }> }> } | undefined)?.data;
  for (const d of data ?? []) if (d?.name) m.set(d.name, num(d.values?.[0]?.value));
  return m;
}

/** Map a Graph failure on a post we SHOULD be able to read. */
function graphFailure(res: OauthGraphResult, ctx: AdapterContext): FetchOutcome {
  if (res.rateLimited) {
    ctx.usage.rateLimited = true;
    return { kind: "transient", message: "Meta is rate-limiting us; will retry" };
  }
  if (res.authInvalid) return { kind: "failed", message: "The Meta connection needs reconnecting (staff portal → Account Growth)" };
  if (res.status === 0) return { kind: "transient", message: res.error === "call budget exhausted" ? "Hourly call budget used; will continue" : "Network error reaching Meta; will retry" };
  if (res.status >= 500 || isTransientGraphFailure(res)) return { kind: "transient", message: `Meta error (${res.status}); will retry` };
  if (res.errorCode === 100 && (res.errorSubcode === 33 || /does not exist|cannot be loaded/i.test(res.error ?? ""))) {
    return { kind: "failed", message: "Meta says this post no longer exists or isn't visible (deleted, archived or hidden)" };
  }
  return { kind: "failed", message: scrubSecrets(res.error ?? `Meta error ${res.status}`).slice(0, 300) };
}

function noteUsage(res: OauthGraphResult, ctx: AdapterContext) {
  if (res.usage) {
    ctx.usage.maxPct = Math.max(ctx.usage.maxPct, res.usage.usagePct);
    if (res.usage.regainMinutes) ctx.usage.regainMinutes = Math.max(ctx.usage.regainMinutes ?? 0, res.usage.regainMinutes);
  }
  if (res.rateLimited) ctx.usage.rateLimited = true;
}

const isMetricError = (res: OauthGraphResult) =>
  !res.ok && res.status === 400 && (res.errorCode === 100 || res.errorCode === 10) && /metric|insights|view_count|valid/i.test(res.error ?? "");

async function loadAssets(): Promise<Asset[]> {
  const rows = await prisma.metaAsset.findMany({
    where: { disconnectedAt: null, connection: { revokedAt: null, status: { in: [...LIVE_STATUSES] } } },
    select: {
      id: true, kind: true, metaId: true, name: true, username: true, followerCount: true, metricsFetchedAt: true, updatedAt: true, pageTokenEnc: true,
      connection: { select: { userTokenEnc: true } },
    },
    orderBy: [{ selected: "desc" }, { updatedAt: "desc" }],
  });
  const seen = new Set<string>();
  const out: Asset[] = [];
  for (const r of rows) {
    const k = `${r.kind}:${r.metaId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      id: r.id, kind: r.kind as Asset["kind"], metaId: r.metaId, name: r.name, username: r.username?.toLowerCase() ?? null,
      followerCount: r.followerCount, followersAt: r.metricsFetchedAt ?? r.updatedAt, pageTokenEnc: r.pageTokenEnc, userTokenEnc: r.connection.userTokenEnc,
    });
  }
  return out;
}

function tokenOf(a: Asset): string | null {
  try {
    if (a.kind === "INSTAGRAM_ACCOUNT") return a.userTokenEnc ? decryptToken(a.userTokenEnc) : null;
    return a.pageTokenEnc ? decryptToken(a.pageTokenEnc) : null;
  } catch {
    return null;
  }
}

const accountOf = (a: Asset) => ({ metaAssetId: a.id, accountName: a.name, username: a.username, followers: a.followerCount, followersAt: a.followersAt });

// ── Our own Instagram media ──────────────────────────────────────────────────────────────
async function fetchOwnIg(mediaId: string, a: Asset, ctx: AdapterContext): Promise<FetchOutcome> {
  const token = tokenOf(a);
  if (!token) return { kind: "failed", message: "The Meta connection's token can't be read — reconnect it (staff portal → Account Growth)" };
  let res: OauthGraphResult<Record<string, unknown>> | null = null;
  for (const metrics of IG_METRIC_SETS) {
    const fields = metrics ? `${IG_BASE_FIELDS},insights.metric(${metrics})` : IG_BASE_FIELDS;
    res = await ctx.graph<Record<string, unknown>>(mediaId, { fields }, token, "links-ig-media");
    noteUsage(res, ctx);
    if (res.ok || !isMetricError(res)) break;
  }
  if (!res || !res.ok || !res.data) return graphFailure(res!, ctx);
  const d = res.data;
  const ins = insightMap(d.insights);
  const productType = String(d.media_product_type ?? "").toUpperCase();
  const values: MetricValues = {
    views: ins.get("views") ?? null,
    reach: ins.get("reach") ?? null,
    likes: num(d.like_count),
    comments: num(d.comments_count),
    shares: ins.get("shares") ?? null,
    saves: ins.get("saved") ?? null,
  };
  return {
    kind: "ok", status: "verified", access: "full", dataSource: "meta_graph", metricsAt: ctx.now(), values,
    account: accountOf(a),
    post: {
      externalId: String(d.id ?? mediaId), caption: clip(d.caption), publishedAt: date(d.timestamp),
      thumbnailUrl: (d.thumbnail_url as string) || (d.media_type === "IMAGE" ? (d.media_url as string) : null) || null,
      postType: productType === "REELS" ? "reel" : undefined,
    },
  };
}

// ── Our own Facebook post / video ─────────────────────────────────────────────────────────
async function fetchOwnFb(objectId: string, isVideoNode: boolean, a: Asset, ctx: AdapterContext): Promise<FetchOutcome> {
  const token = tokenOf(a);
  if (!token) return { kind: "failed", message: "This Page's token can't be read — reconnect Meta (staff portal → Account Growth)" };
  let res: OauthGraphResult<Record<string, unknown>> | null = null;
  if (isVideoNode) {
    res = await ctx.graph<Record<string, unknown>>(objectId, { fields: FB_VIDEO_FIELDS }, token, "links-fb-video");
    noteUsage(res, ctx);
  } else {
    for (const metrics of FB_METRIC_SETS) {
      const fields = metrics ? `${FB_POST_BASE_FIELDS},insights.metric(${metrics})` : FB_POST_BASE_FIELDS;
      res = await ctx.graph<Record<string, unknown>>(objectId, { fields }, token, "links-fb-post");
      noteUsage(res, ctx);
      if (res.ok || !isMetricError(res)) break;
    }
  }
  if (!res || !res.ok || !res.data) return graphFailure(res!, ctx);
  const d = res.data;
  const ins = insightMap(d.insights);
  const summary = (k: string) => num((d[k] as { summary?: { total_count?: unknown } } | undefined)?.summary?.total_count);
  const values: MetricValues = {
    // FB video nodes: views need a live probe on prod before we trust a field (SPEC §8) — "—" until then.
    views: isVideoNode ? null : ins.get("post_media_view") ?? null,
    // Meta answers post_total_media_view_unique = 0 for reels even with millions of views (live, 2026-11-25:
    // 11/11 Page reels, and every FB row the posts sync stored). A post seen by people with 0 reach is
    // "not published", so it is null ("—"), never a zero. A 0 with 0 views stays 0.
    reach: isVideoNode ? null : fbReach(ins.get("post_total_media_view_unique") ?? null, ins.get("post_media_view") ?? null),
    likes: summary("likes"),
    comments: summary("comments"),
    // ⚠️ `shares` is ABSENT when a post has none — null, never an invented 0.
    shares: isVideoNode ? null : num((d.shares as { count?: unknown } | undefined)?.count),
    saves: null, // Facebook publishes no saves metric.
  };
  return {
    kind: "ok", status: "verified", access: "full", dataSource: "meta_graph", metricsAt: ctx.now(), values,
    account: accountOf(a),
    post: {
      externalId: String(d.id ?? objectId), caption: clip(d.message ?? d.description), publishedAt: date(d.created_time),
      thumbnailUrl: ((d.full_picture ?? d.picture) as string) || null,
    },
  };
}

const fbReach = (reach: number | null, views: number | null): number | null =>
  reach === 0 && (views ?? 0) > 0 ? null : reach;

// ── Business discovery (someone else's IG business/creator account) ───────────────────────
type BdMedia = { id?: string; shortcode?: string; permalink?: string; caption?: string; like_count?: number; comments_count?: number; view_count?: number; media_type?: string; media_product_type?: string; timestamp?: string; thumbnail_url?: string };
type BdResponse = { business_discovery?: { id?: string; username?: string; name?: string; followers_count?: number; media?: { data?: BdMedia[]; paging?: { cursors?: { after?: string } } } } };

const codeOf = (m: BdMedia): string | null => m.shortcode ?? m.permalink?.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([^/?#]+)/i)?.[1] ?? null;

async function businessDiscovery(
  username: string,
  wanted: Map<string, FetchTarget[]>, // shortcode → targets
  caller: { igId: string; token: string },
  ctx: AdapterContext,
  out: Map<string, FetchOutcome>,
): Promise<void> {
  let after: string | undefined;
  let withViews = true;
  const remaining = new Set(wanted.keys());
  let profile: BdResponse["business_discovery"] | undefined;
  for (let page = 0; page < BD_MAX_PAGES() && remaining.size; page++) {
    const media = `media.limit(50)${after ? `.after(${after})` : ""}{${withViews ? BD_MEDIA_FIELDS : BD_MEDIA_FIELDS_NO_VIEWS}}`;
    const fields = `business_discovery.username(${username}){id,username,name,followers_count,${media}}`;
    const res = await ctx.graph<BdResponse>(caller.igId, { fields }, caller.token, "links-ig-discovery");
    noteUsage(res, ctx);
    if (!res.ok && withViews && isMetricError(res) && /view_count/i.test(res.error ?? "")) {
      withViews = false;
      page--;
      continue;
    }
    if (!res.ok) {
      // 110 / "Cannot find User" / subcode 2207013: personal, private or unknown account.
      const notPublic = res.errorCode === 110 || res.errorSubcode === 2207013 || /cannot find user|invalid user id|not.*business/i.test(res.error ?? "");
      for (const code of remaining) {
        for (const t of wanted.get(code)!) out.set(t.id, notPublic ? { kind: "restricted", reason: "ig_account_not_public" } : graphFailure(res, ctx));
      }
      return;
    }
    profile = res.data?.business_discovery ?? profile;
    const items = res.data?.business_discovery?.media?.data ?? [];
    for (const m of items) {
      const code = codeOf(m);
      if (!code || !remaining.has(code)) continue;
      remaining.delete(code);
      const isReel = String(m.media_product_type ?? "").toUpperCase() === "REELS";
      for (const t of wanted.get(code)!) {
        out.set(t.id, {
          kind: "ok", status: "restricted", access: "public", dataSource: "meta_business_discovery", metricsAt: ctx.now(),
          values: {
            ...NO_VALUES,
            likes: num(m.like_count), // absent when the owner hides like counts → null
            comments: num(m.comments_count),
            views: isReel ? num(m.view_count) : null, // view_count is documented for reels only
          },
          account: { metaAssetId: null, accountName: profile?.name ?? null, username: profile?.username ?? username, followers: num(profile?.followers_count), followersAt: ctx.now() },
          post: { externalId: m.id ?? null, caption: clip(m.caption), publishedAt: date(m.timestamp), thumbnailUrl: m.thumbnail_url ?? null, postType: isReel ? "reel" : undefined },
        });
      }
    }
    after = res.data?.business_discovery?.media?.paging?.cursors?.after;
    if (!after || !items.length) break;
  }
  for (const code of remaining) for (const t of wanted.get(code)!) out.set(t.id, { kind: "restricted", reason: "ig_post_not_in_recent_media" });
}

/** Walk our own IG feed for shortcodes the sync hasn't stored. Returns shortcode → media id. */
async function findInOwnFeed(a: Asset, codes: Set<string>, ctx: AdapterContext): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const token = tokenOf(a);
  if (!token) return found;
  let path = `${a.metaId}/media`;
  let params: Record<string, string | number | undefined> = { fields: "id,shortcode,permalink", limit: 100 };
  for (let p = 0; p < OWN_FEED_MAX_PAGES && found.size < codes.size; p++) {
    const res = await ctx.graph<{ data?: BdMedia[]; paging?: { next?: string } }>(path, params, token, "links-ig-own-feed");
    noteUsage(res, ctx);
    if (!res.ok) break;
    for (const m of res.data?.data ?? []) {
      const c = codeOf(m);
      if (c && codes.has(c) && m.id) found.set(c, m.id);
    }
    const next = res.data?.paging?.next;
    if (!next) break;
    path = next;
    params = {};
  }
  return found;
}

export const metaAdapter: LinkMetricsAdapter = {
  name: "meta",
  handles: (t) => t.platform === "instagram" || t.platform === "facebook",

  async fetch(targets, ctx) {
    const out = new Map<string, FetchOutcome>();
    const assets = await loadAssets();
    if (!assets.length) {
      for (const t of targets) out.set(t.id, { kind: "restricted", reason: "no_meta_connection" });
      return out;
    }
    const byId = new Map(assets.map((a) => [a.id, a]));
    const igByUser = new Map(assets.filter((a) => a.kind === "INSTAGRAM_ACCOUNT" && a.username).map((a) => [a.username!, a]));
    const fbByMetaId = new Map(assets.filter((a) => a.kind === "FACEBOOK_PAGE").map((a) => [a.metaId, a]));
    const fbBySlug = new Map(assets.filter((a) => a.kind === "FACEBOOK_PAGE" && a.username).map((a) => [a.username!, a]));
    const anyUserToken = (() => {
      for (const a of assets) if (a.userTokenEnc) { try { return decryptToken(a.userTokenEnc); } catch { /* next */ } }
      return null;
    })();

    // ── Opaque FB links → numeric ids (one redirect read each; never HTML, never a login). ──
    const fbIds = new Map<string, string>(); // target id → numeric id
    const newKeys = new Map<string, string>();
    for (const t of targets.filter((x) => x.platform === "facebook")) {
      if (t.postKey.startsWith("fb:")) fbIds.set(t.id, t.postKey.slice(3));
      else {
        const id = await ctx.resolveOpaqueFacebook(t.canonicalUrl).catch(() => null);
        if (id) {
          fbIds.set(t.id, id);
          newKeys.set(t.id, `fb:${id}`);
        } else out.set(t.id, { kind: "restricted", reason: "fb_unresolvable_link" });
      }
    }

    // ── Owner lookup from the platform's own sync (free) ──
    const igTargets = targets.filter((t) => t.platform === "instagram");
    const codes = igTargets.map((t) => t.postKey.slice(3));
    const ids = [...new Set(fbIds.values())];
    const known = codes.length || ids.length
      ? await prisma.metaPost.findMany({
          where: {
            OR: [
              ...(codes.length ? [{ matchId: { in: codes } }] : []),
              ...(ids.length ? [{ matchId: { in: ids } }, { metaPostId: { in: ids } }, ...ids.map((id) => ({ metaPostId: { endsWith: `_${id}` } }))] : []),
            ],
          },
          select: { matchId: true, metaPostId: true, assetId: true },
        })
      : [];
    const ownIg = new Map<string, { mediaId: string; asset: Asset }>();
    const ownFb = new Map<string, { objectId: string; asset: Asset }>();
    for (const k of known) {
      const a = byId.get(k.assetId);
      if (!a) continue;
      if (a.kind === "INSTAGRAM_ACCOUNT" && k.matchId) ownIg.set(k.matchId, { mediaId: k.metaPostId, asset: a });
      if (a.kind === "FACEBOOK_PAGE") {
        const tail = k.metaPostId.includes("_") ? k.metaPostId.split("_").pop()! : k.metaPostId;
        for (const id of [k.matchId, k.metaPostId, tail]) if (id) ownFb.set(id, { objectId: k.metaPostId, asset: a });
      }
    }

    // ── Instagram ──
    const bdGroups = new Map<string, Map<string, FetchTarget[]>>(); // username → shortcode → targets
    const feedSearch = new Map<string, { asset: Asset; codes: Set<string>; targets: FetchTarget[] }>();
    for (const t of igTargets) {
      const code = t.postKey.slice(3);
      if (ownIg.has(code)) continue;
      const hint = t.accountHint?.toLowerCase().replace(/^@/, "") ?? null;
      const ours = hint ? igByUser.get(hint) : undefined;
      if (ours) {
        const g = feedSearch.get(ours.id) ?? { asset: ours, codes: new Set<string>(), targets: [] };
        g.codes.add(code);
        g.targets.push(t);
        feedSearch.set(ours.id, g);
      } else if (hint && /^[a-z0-9._]{1,30}$/.test(hint)) {
        const g = bdGroups.get(hint) ?? new Map<string, FetchTarget[]>();
        g.set(code, [...(g.get(code) ?? []), t]);
        bdGroups.set(hint, g);
      } else out.set(t.id, { kind: "restricted", reason: "ig_no_username" });
    }
    for (const g of feedSearch.values()) {
      const found = await findInOwnFeed(g.asset, g.codes, ctx);
      for (const [c, mediaId] of found) ownIg.set(c, { mediaId, asset: g.asset });
      for (const t of g.targets) {
        if (!found.has(t.postKey.slice(3))) out.set(t.id, { kind: "failed", message: `Not found in the newest ${OWN_FEED_MAX_PAGES * 100} posts of @${g.asset.username}, our connected account (deleted, or older)` });
      }
    }
    for (const t of igTargets) {
      if (out.has(t.id)) continue;
      const own = ownIg.get(t.postKey.slice(3));
      if (own) out.set(t.id, await fetchOwnIg(own.mediaId, own.asset, ctx));
    }
    if (bdGroups.size) {
      const caller = (() => {
        for (const a of assets) {
          if (a.kind !== "INSTAGRAM_ACCOUNT") continue;
          const token = tokenOf(a);
          if (token) return { igId: a.metaId, token };
        }
        return null;
      })();
      for (const [username, wanted] of bdGroups) {
        if (!caller) {
          for (const ts of wanted.values()) for (const t of ts) out.set(t.id, { kind: "restricted", reason: "no_meta_connection" });
          continue;
        }
        await businessDiscovery(username, wanted, caller, ctx, out);
      }
    }

    // ── Facebook ──
    for (const t of targets.filter((x) => x.platform === "facebook")) {
      if (out.has(t.id)) continue;
      const id = fbIds.get(t.id)!;
      const own = ownFb.get(id);
      if (own) {
        out.set(t.id, await fetchOwnFb(own.objectId, !own.objectId.includes("_") && (t.postType === "video" || t.postType === "reel"), own.asset, ctx));
        continue;
      }
      const slugPage = t.accountHint ? fbBySlug.get(t.accountHint.toLowerCase()) ?? fbByMetaId.get(t.accountHint) : undefined;
      if (slugPage && (t.postType === "post" || t.postType === "photo")) {
        out.set(t.id, await fetchOwnFb(`${slugPage.metaId}_${id}`, false, slugPage, ctx));
        continue;
      }
      // Who posted it? One call. Meta answers only for objects we may read; anything else is not ours.
      if (!anyUserToken) {
        out.set(t.id, { kind: "restricted", reason: "fb_not_our_page" });
        continue;
      }
      const probe = await ctx.graph<{ from?: { id?: string } }>(id, { fields: "from{id}" }, anyUserToken, "links-fb-owner");
      noteUsage(probe, ctx);
      const page = probe.ok && probe.data?.from?.id ? fbByMetaId.get(probe.data.from.id) : undefined;
      if (page) {
        const isVideo = t.postType === "video" || t.postType === "reel";
        out.set(t.id, await fetchOwnFb(isVideo ? id : `${page.metaId}_${id}`, isVideo, page, ctx));
      } else if (!probe.ok && (probe.rateLimited || probe.status === 0 || probe.status >= 500)) {
        out.set(t.id, graphFailure(probe, ctx));
      } else out.set(t.id, { kind: "restricted", reason: "fb_not_our_page" });
    }

    for (const [tid, key] of newKeys) {
      const o = out.get(tid);
      if (o) out.set(tid, { ...o, newPostKey: key });
    }
    return out;
  },
};
