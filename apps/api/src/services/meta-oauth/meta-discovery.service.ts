/**
 * Asset discovery — turn a connection into the Pages / IG accounts it can read.
 *
 * Runs in the BACKGROUND, never in the OAuth request: a first pass over an 87-Page
 * estate costs ~60 Graph calls, and an earlier design that discovered inline consumed
 * the one-time state row and THEN spent 150s+, so a slow Meta produced a 504 with the
 * state already burned and no recoverable path.
 *
 * Budgeted and RESUMABLE: discoveryState advances pending → pages → ig_nodes → done,
 * and budget exhaustion parks the cursor so the next run continues instead of restarting.
 */

import { prisma } from "@dashmani/db";
import { oauthGraphFetch, makeBudget, type CallBudget, type OauthGraphResult } from "./oauth-graph";
import { decryptToken, encryptToken, scrubSecrets } from "../../utils/token-crypto";
import { metaTuning } from "./meta-config";

/** Pages per discovery page. Small on purpose — see the IG note below. */
/**
 * ⚠️ THESE FOUR CONSTANTS SILENTLY TRUNCATED A REAL ESTATE. Sized when an admin
 * had ~90 Pages, they became hard ceilings the moment someone connected with more:
 *
 *   MAX_PAGE_PAGES(10) x PAGE_LIMIT(25) = 250 Facebook Pages — and an admin with
 *   369 stored EXACTLY 250. Not a coincidence: the ceiling was the answer.
 *   MAX_IG_PAGES(25) x IG_PAGE_LIMIT(5)  = only the first 125 Pages scanned for a
 *   linked Instagram account, so 14 of 104 were found.
 *
 * Nothing errored. Discovery reported success and the page showed a confident,
 * incomplete number. Page sizes are now the largest Meta answers comfortably
 * within DISCOVERY_TIMEOUT_MS (measured on 369 real Pages: FB fields at limit=100
 * = 9.5s, IG nodes at limit=50 = 4.4s, against a 25s timeout), and the page guards
 * are high enough to be a runaway backstop rather than a limit anyone reaches.
 */
const PAGE_LIMIT = 100;
/**
 * ⚠️ IG node discovery MUST use limit=5.
 * Measured live: asking Meta to resolve instagram_business_account for 100 Pages in
 * one page returns HTTP 500 after ~30s; limit=5 returns 200 in ~2.6s. 18 paged calls
 * beats 87 per-Page calls. Do not raise this.
 */
/**
 * ⚠️ 50, not 100, and deliberately conservative. This repo has a documented
 * incident where `me/accounts?fields=instagram_business_account&limit=100` HTTP
 * 500'd after ~25-30s on the OLD app's token. That was a different app and token,
 * and limit=100 measured 200 OK in 8.4s here — but a metric that fails only on
 * large accounts is exactly the shape that hides until it matters, so this takes
 * the measured-safe middle (4.4s) and retries smaller on failure.
 */
const IG_PAGE_LIMIT = 50;
// Runaway backstops, not limits. At the page sizes above these cover 10,000
// Facebook Pages and 5,000 Instagram lookups — far past any real admin.
const MAX_PAGE_PAGES = 100;
const MAX_IG_PAGES = 100;
/** Discovery needs longer than the 10s default — this is an explicit per-call value. */
const DISCOVERY_TIMEOUT_MS = 25_000;

interface FbAccountsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    username?: string;
    access_token?: string;
    tasks?: string[];
    followers_count?: number;
    fan_count?: number;
  }>;
  paging?: { next?: string };
}

/**
 * ⚠️ BARE `instagram_business_account`. NEVER `instagram_business_account{id}` — the
 * nested sub-selection intermittently HTTP-500s and discovery then silently returns
 * an empty list. And never `{username,followers_count}`: that returns only {id} and
 * mangles the field name in the paging cursor. Both are recorded prod incidents.
 */
interface IgNodesResponse {
  data?: Array<{ id?: string; instagram_business_account?: { id?: string } }>;
  paging?: { next?: string };
}

interface IgProfileResponse {
  id?: string;
  username?: string;
  name?: string;
  followers_count?: number;
  media_count?: number;
  profile_picture_url?: string;
}

export interface DiscoveryOutcome {
  connectionId: string;
  pagesFound: number;
  igFound: number;
  linkedToChannels: number;
  callsUsed: number;
  state: string;
  rateLimited: boolean;
  authInvalid: boolean;
  error?: string;
}

/** Normalise a handle/name for soft-matching against the channel registry. */
function normKey(s: string | null | undefined): string {
  return (s ?? "").replace(/^@/, "").split("?")[0].trim().toLowerCase();
}

/**
 * Best-effort link an asset to an existing SocialAccount row so the two systems agree
 * on which channel this is. An UNMATCHED asset is perfectly valid — it simply shows
 * "not linked to a channel" — so this never throws and never guesses across platforms.
 */
async function linkToChannel(
  assetId: string,
  platformSlug: "facebook" | "instagram",
  candidates: string[],
): Promise<boolean> {
  const keys = candidates.map(normKey).filter(Boolean);
  if (keys.length === 0) return false;
  try {
    const rows = await prisma.socialAccount.findMany({
      where: { platform: { slug: platformSlug }, status: "ACTIVE" },
      select: { id: true, handle: true, displayName: true },
    });
    const hit = rows.find(
      (r) => keys.includes(normKey(r.handle)) || keys.includes(normKey(r.displayName)),
    );
    if (!hit) return false;
    await prisma.metaAsset.update({ where: { id: assetId }, data: { socialAccountId: hit.id } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover (or resume discovering) a connection's assets.
 * Never throws — every failure is reported in the outcome and recorded on the row.
 */
export async function discoverConnectionAssets(
  connectionId: string,
  budget?: CallBudget,
): Promise<DiscoveryOutcome> {
  const out: DiscoveryOutcome = {
    connectionId,
    pagesFound: 0,
    igFound: 0,
    linkedToChannels: 0,
    callsUsed: 0,
    state: "pending",
    rateLimited: false,
    authInvalid: false,
  };

  const conn = await prisma.metaConnection.findUnique({ where: { id: connectionId } });
  if (!conn || !conn.userTokenEnc || conn.revokedAt) {
    out.error = "connection missing, revoked, or has no token";
    return out;
  }

  let token: string;
  try {
    token = decryptToken(conn.userTokenEnc);
  } catch (e) {
    // A SecretFormatError here means the encryption key changed (or the row predates
    // encryption). Recovery is one Reconnect click — say so rather than dying silently.
    out.error = `token could not be decrypted (re-authorise required): ${scrubSecrets(String(e))}`;
    await prisma.metaConnection.update({
      where: { id: connectionId },
      data: { status: "NEEDS_REAUTH", lastError: out.error },
    });
    return out;
  }

  const b = budget ?? makeBudget(metaTuning.discoveryCallBudget());
  const startUsed = b.used;

  // ── B1: who granted this ──────────────────────────────────────────────────
  const me = await oauthGraphFetch<{ id?: string; name?: string }>(
    "me",
    { fields: "id,name" },
    token,
    { label: "discover-me", budget: b, timeoutMs: DISCOVERY_TIMEOUT_MS },
  );
  if (me.authInvalid) {
    out.authInvalid = true;
    out.error = me.error ?? "token invalid";
    await prisma.metaConnection.update({
      where: { id: connectionId },
      data: { status: "NEEDS_REAUTH", lastError: scrubSecrets(out.error) },
    });
    out.callsUsed = b.used - startUsed;
    return out;
  }
  if (me.ok && me.data?.name) {
    await prisma.metaConnection.update({
      where: { id: connectionId },
      data: { metaUserName: me.data.name },
    });
  }

  // ── B2: administered Pages (Page tokens arrive INLINE — no mint call needed) ──
  //
  // ⚠️ facebook.provider.ts's header comment says to mint a Page token via
  // GET /{page-id}?fields=access_token. That is STALE: /me/accounts already returns
  // access_token, and following the comment costs one wasted call per Page.
  let pageUrl: string | null = "me/accounts";
  let pageParams: Record<string, string | number | undefined> | undefined = {
    fields: "id,name,username,access_token,tasks,followers_count,fan_count",
    limit: PAGE_LIMIT,
  };
  let guard = 0;

  while (pageUrl && guard < MAX_PAGE_PAGES) {
    guard++;
    // Explicit annotation: without it TS7022 fires, because `res` is reassigned from
    // an expression that references itself in the retry branch below.
    let res: OauthGraphResult<FbAccountsResponse> = await oauthGraphFetch<FbAccountsResponse>(
      pageUrl,
      pageParams ?? {},
      token,
      { label: "discover-pages", budget: b, timeoutMs: DISCOVERY_TIMEOUT_MS },
    );

    // Retry once at a smaller page size. status 0 (abort) is the MORE likely failure
    // and is indistinguishable from a network blip, so it must be retried too.
    if (!res.ok && !res.rateLimited && !res.authInvalid) {
      res = await oauthGraphFetch<FbAccountsResponse>(
        pageUrl,
        { ...(pageParams ?? {}), limit: 5 },
        token,
        { label: "discover-pages-retry", budget: b, timeoutMs: DISCOVERY_TIMEOUT_MS },
      );
    }

    if (res.rateLimited) {
      out.rateLimited = true;
      break;
    }
    if (res.authInvalid) {
      out.authInvalid = true;
      break;
    }
    if (!res.ok || !res.data) {
      out.error = res.error ?? "page discovery failed";
      break;
    }

    for (const pg of res.data.data ?? []) {
      // Only administered Pages expose readable insights, and only ones that actually
      // handed us a token are usable.
      if (!pg.id || !Array.isArray(pg.tasks) || pg.tasks.length === 0 || !pg.access_token) continue;
      const followers =
        typeof pg.followers_count === "number"
          ? pg.followers_count
          : typeof pg.fan_count === "number"
            ? pg.fan_count
            : null;

      const asset = await prisma.metaAsset.upsert({
        where: {
          connectionId_kind_metaId: {
            connectionId,
            kind: "FACEBOOK_PAGE",
            metaId: pg.id,
          },
        },
        create: {
          connectionId,
          kind: "FACEBOOK_PAGE",
          metaId: pg.id,
          name: pg.name ?? pg.id,
          username: pg.username ?? null,
          pageTokenEnc: encryptToken(pg.access_token),
          tasks: pg.tasks,
          followerCount: followers,
          disconnectedAt: null,
        },
        update: {
          name: pg.name ?? pg.id,
          username: pg.username ?? null,
          pageTokenEnc: encryptToken(pg.access_token),
          tasks: pg.tasks,
          followerCount: followers,
          disconnectedAt: null,
        },
      });
      out.pagesFound++;
      if (
        !asset.socialAccountId &&
        (await linkToChannel(asset.id, "facebook", [pg.username ?? "", pg.name ?? "", pg.id]))
      ) {
        out.linkedToChannels++;
      }
    }

    pageUrl = res.data.paging?.next ?? null;
    pageParams = undefined; // an absolute cursor carries its own params
    if (b.used >= b.max) break;
  }

  await prisma.metaConnection.update({
    where: { id: connectionId },
    data: { discoveryState: "pages" },
  });

  // ── B3/B4: IG business accounts hanging off those Pages ───────────────────
  if (!out.rateLimited && !out.authInvalid && b.used < b.max) {
    const igIds: string[] = [];
    let igUrl: string | null = "me/accounts";
    let igParams: Record<string, string | number | undefined> | undefined = {
      fields: "instagram_business_account", // BARE — see the interface note
      limit: IG_PAGE_LIMIT,
    };
    let igGuard = 0;

    while (igUrl && igGuard < MAX_IG_PAGES && b.used < b.max) {
      igGuard++;
      // Annotated for the same TS7022 reason as the Pages loop above: igUrl is
      // reassigned from res.data.paging.next, so inference would be circular.
      let res: OauthGraphResult<IgNodesResponse> = await oauthGraphFetch<IgNodesResponse>(
        igUrl,
        igParams ?? {},
        token,
        { label: "discover-ig-nodes", budget: b, timeoutMs: DISCOVERY_TIMEOUT_MS },
      );

      // Retry once at a small page size. Mirrors the Pages loop: a large page can
      // fail on size alone (the documented limit=100 HTTP 500), and giving up would
      // silently drop every Instagram account past this point.
      if (!res.ok && !res.rateLimited && !res.authInvalid) {
        res = await oauthGraphFetch<IgNodesResponse>(
          igUrl,
          { ...(igParams ?? { fields: "instagram_business_account" }), limit: 5 },
          token,
          { label: "discover-ig-nodes-retry", budget: b, timeoutMs: DISCOVERY_TIMEOUT_MS },
        );
      }
      if (res.rateLimited) {
        out.rateLimited = true;
        break;
      }
      if (!res.ok || !res.data) break;
      for (const row of res.data.data ?? []) {
        const id = row.instagram_business_account?.id;
        if (id) igIds.push(id);
      }
      igUrl = res.data.paging?.next ?? null;
      igParams = undefined;
    }

    for (const igId of igIds) {
      if (b.used >= b.max) break;
      // Flat fields ARE honoured on the per-account node (unlike the nested form).
      const prof = await oauthGraphFetch<IgProfileResponse>(
        igId,
        { fields: "username,name,followers_count,media_count,profile_picture_url" },
        token,
        { label: "discover-ig-profile", budget: b, timeoutMs: DISCOVERY_TIMEOUT_MS },
      );
      if (prof.rateLimited) {
        out.rateLimited = true;
        break;
      }
      if (!prof.ok || !prof.data?.username) continue;

      const asset = await prisma.metaAsset.upsert({
        where: {
          connectionId_kind_metaId: { connectionId, kind: "INSTAGRAM_ACCOUNT", metaId: igId },
        },
        create: {
          connectionId,
          kind: "INSTAGRAM_ACCOUNT",
          metaId: igId,
          name: prof.data.name ?? prof.data.username,
          username: prof.data.username,
          followerCount: prof.data.followers_count ?? null,
          postCount: prof.data.media_count ?? null,
          pictureUrl: prof.data.profile_picture_url ?? null,
          // IG assets deliberately carry NO token: they are read with the user token,
          // so the same Page secret is never written into two rows.
          disconnectedAt: null,
        },
        update: {
          name: prof.data.name ?? prof.data.username,
          username: prof.data.username,
          followerCount: prof.data.followers_count ?? null,
          postCount: prof.data.media_count ?? null,
          pictureUrl: prof.data.profile_picture_url ?? null,
          disconnectedAt: null,
        },
      });
      out.igFound++;
      if (
        !asset.socialAccountId &&
        (await linkToChannel(asset.id, "instagram", [prof.data.username, prof.data.name ?? ""]))
      ) {
        out.linkedToChannels++;
      }
    }
  }

  // Budget exhaustion parks progress; a clean pass marks done.
  const finished = !out.rateLimited && !out.authInvalid && b.used < b.max;
  out.state = finished ? "done" : out.rateLimited ? "pages" : "ig_nodes";
  out.callsUsed = b.used - startUsed;

  await prisma.metaConnection.update({
    where: { id: connectionId },
    data: {
      discoveryState: out.state,
      lastSyncedAt: new Date(),
      lastError: out.error ? scrubSecrets(out.error) : null,
      status: out.authInvalid
        ? "NEEDS_REAUTH"
        : out.rateLimited
          ? "RATE_LIMITED"
          : conn.status === "PARTIAL_SCOPE"
            ? "PARTIAL_SCOPE"
            : "ACTIVE",
    },
  });

  console.log(
    `[meta-discovery] connection=${connectionId} pages=${out.pagesFound} ig=${out.igFound} ` +
      `linked=${out.linkedToChannels} calls=${out.callsUsed} state=${out.state}` +
      (out.rateLimited ? " RATE_LIMITED" : "") +
      (out.authInvalid ? " AUTH_INVALID" : ""),
  );

  return out;
}
