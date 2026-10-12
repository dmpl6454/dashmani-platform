/**
 * Creator portal — discover the Facebook Pages and Instagram professional accounts a creator's
 * grant reaches, and whether we could publish to each.
 *
 * Same Graph shapes as services/meta-oauth/meta-discovery.service.ts (read it for the incident
 * history behind the page sizes and the BARE instagram_business_account field), but:
 *  • rows go to creator_assets, never meta_assets — this file WRITES NO meta_* TABLE and never
 *    links to the channel registry (linkToChannel). meta_assets is only READ, to flag a page that
 *    is or ever was on our own network (networkDuplicateOf) so it can never be sold twice; the
 *    flag is re-checked daily (syncNetworkDuplicates) and before staff switch a page on;
 *  • a page another creator LIVE-claims is never taken over — it is skipped and the creator is
 *    told why. A claim stops counting once it can no longer be used (page disconnected, its
 *    connection revoked or lapsed, its creator closed); and a claimant who can PUBLISH there
 *    takes over from a holder who cannot, or whose account is rejected or suspended (an
 *    analyst/moderator role, or an account we turned down, must never lock the owner out);
 *  • canPublish is a real probe, not a guess: Facebook needs pages_manage_posts AND a
 *    CREATE_CONTENT/MANAGE task on the Page; Instagram needs instagram_content_publish AND a
 *    content_publishing_limit answer.
 * Budgeted, never throws; discovery_state pending → running → done | failed.
 */

import { prisma } from "@dashmani/db";
import { oauthGraphFetch, makeBudget, type CallBudget, type OauthGraphResult } from "../meta-oauth/oauth-graph";
import { decryptToken, encryptToken, scrubSecrets } from "../../utils/token-crypto";
import { creatorMetaAppSecret } from "./creator-meta-config";
import { CREATOR_REQUIRED_SCOPES, LIVE_CONNECTION_STATUSES } from "./creator-view";

/** Creators have a handful of pages; this is a runaway backstop, not a tuning knob. */
const DISCOVERY_CALL_BUDGET = 300;
const PAGE_LIMIT = 100;
/** ⚠️ 50 and the BARE field — see meta-discovery.service.ts (the nested form 500s silently). */
const IG_PAGE_LIMIT = 50;
const MAX_PAGES = 20;
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
    picture?: { data?: { url?: string } };
  }>;
  paging?: { next?: string };
}

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

export interface CreatorDiscoveryOutcome {
  connectionId: string;
  pagesFound: number;
  igFound: number;
  /** Pages skipped because another creator already claimed them. */
  claimedElsewhere: number;
  disconnected: number;
  callsUsed: number;
  state: "done" | "failed";
  rateLimited: boolean;
  authInvalid: boolean;
  error?: string;
}

const PUBLISH_TASKS = new Set(["CREATE_CONTENT", "MANAGE"]);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const intOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";

/** One GET with a single smaller-page retry on a non-rate-limit, non-auth failure. */
async function pagedFetch<T>(
  url: string,
  params: Record<string, string | number | undefined> | undefined,
  retryParams: Record<string, string | number | undefined>,
  token: string,
  label: string,
  budget: CallBudget,
): Promise<OauthGraphResult<T>> {
  let res: OauthGraphResult<T> = await oauthGraphFetch<T>(url, params ?? {}, token, { label, budget, timeoutMs: DISCOVERY_TIMEOUT_MS, appSecret: creatorMetaAppSecret() });
  if (!res.ok && !res.rateLimited && !res.authInvalid && res.error !== "call budget exhausted") {
    res = await oauthGraphFetch<T>(url, { ...(params ?? {}), ...retryParams, limit: 5 }, token, {
      label: `${label}-retry`,
      budget,
      timeoutMs: DISCOVERY_TIMEOUT_MS, appSecret: creatorMetaAppSecret(),
    });
  }
  return res;
}

type Claim = "ours" | "free" | "taken";

const LIVE = [...LIVE_CONNECTION_STATUSES] as string[];
/** Holder statuses that yield to a claimant who can PUBLISH there (a rejected creator may
 *  resubmit, so a non-publisher cannot take their pages; a closed one is released outright). */
const YIELDING_CREATOR_STATUSES = ["rejected", "suspended"];

/**
 * Who holds (kind, metaId) today, from the point of view of `creatorId`:
 *  • released to anyone — the page is disconnected, the holder's connection is revoked or
 *    lapsed (NEEDS_REAUTH: its token no longer works), or the holder's account is closed;
 *  • released to a claimant who can PUBLISH there — the holder cannot, or the holder's account
 *    is rejected or suspended;
 *  • otherwise taken.
 * Mirrored by the WHERE in upsertAsset's take-over step; keep the two in step.
 */
async function claimOf(kind: string, metaId: string, creatorId: string, iCanPublish: boolean): Promise<Claim> {
  const row = await prisma.creatorAsset.findUnique({
    where: { kind_metaId: { kind, metaId } },
    select: {
      creatorId: true,
      disconnectedAt: true,
      canPublish: true,
      creator: { select: { status: true } },
      connection: { select: { revokedAt: true, status: true } },
    },
  });
  if (!row) return "free";
  if (row.creatorId === creatorId) return "ours";
  const holderLive =
    !row.disconnectedAt && !row.connection.revokedAt && LIVE.includes(row.connection.status) && row.creator.status !== "closed";
  if (!holderLive) return "free";
  if (iCanPublish && (!row.canPublish || YIELDING_CREATOR_STATUSES.includes(row.creator.status))) return "free";
  return "taken";
}

/**
 * Upsert one asset under this creator + connection; false when another creator holds it.
 * Our own row is updated in place (the staff switch is kept). A row whose holder lost the claim
 * (see claimOf) is TAKEN OVER with the staff switch reset — staff must turn it on again for the
 * new owner. Otherwise a new row; a unique-index loss is re-read so our own concurrent pass is
 * not reported as "claimed by another creator".
 */
async function upsertAsset(
  kind: "facebook_page" | "instagram_account",
  metaId: string,
  creatorId: string,
  connectionId: string,
  fields: Record<string, unknown>,
  iCanPublish: boolean,
): Promise<boolean> {
  const data = { ...fields, creatorId, connectionId, disconnectedAt: null };
  // A page that is (now) on our network is never left switched on — also on our own row.
  const offIfDuplicate = fields.networkDuplicateOf ? { enabled: false, enabledById: null, enabledAt: null } : {};
  try {
    const own = await prisma.creatorAsset.updateMany({ where: { kind, metaId, creatorId }, data: { ...data, ...offIfDuplicate } as never });
    if (own.count > 0) return true;

    const took = await prisma.creatorAsset.updateMany({
      where: {
        kind,
        metaId,
        creatorId: { not: creatorId },
        OR: [
          { disconnectedAt: { not: null } },
          { connection: { revokedAt: { not: null } } },
          { connection: { status: { notIn: LIVE } } },
          { creator: { status: "closed" } },
          ...(iCanPublish ? [{ canPublish: false }, { creator: { status: { in: YIELDING_CREATOR_STATUSES } } }] : []),
        ],
      },
      data: { ...data, enabled: false, enabledById: null, enabledAt: null } as never,
    });
    if (took.count > 0) {
      console.log(`[creator-discovery] ${kind} ${metaId} taken over by creator=${creatorId} (the previous claim could no longer be used)`);
      return true;
    }

    await prisma.creatorAsset.create({ data: { kind, metaId, ...data } as never });
    return true;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const row = await prisma.creatorAsset.findUnique({ where: { kind_metaId: { kind, metaId } }, select: { creatorId: true } });
    return row?.creatorId === creatorId;
  }
}

/**
 * meta_assets ids of OUR channels with these metaIds (READ ONLY), keyed by metaId. ANY row
 * counts — also a disconnected or deselected one: a page that is or was on our network is never
 * sold as a creator page, and a staff connection briefly being revoked must not let one through.
 * kind mapping: facebook_page ↔ FACEBOOK_PAGE, instagram_account ↔ INSTAGRAM_ACCOUNT.
 */
async function networkDuplicates(kind: "FACEBOOK_PAGE" | "INSTAGRAM_ACCOUNT", metaIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (metaIds.length === 0) return out;
  const rows = await prisma.metaAsset.findMany({
    where: { kind, metaId: { in: metaIds } },
    select: { id: true, metaId: true },
    orderBy: { createdAt: "asc" },
  });
  for (const r of rows) if (!out.has(r.metaId)) out.set(r.metaId, r.id);
  return out;
}

const META_KIND = { facebook_page: "FACEBOOK_PAGE", instagram_account: "INSTAGRAM_ACCOUNT" } as const;

/**
 * Re-check networkDuplicateOf against meta_assets (no Graph calls) for these creator assets, or
 * for all of them. A page that has become a duplicate is flagged AND switched off; one whose
 * meta_assets row is gone is cleared (staff still have to turn it on). Run daily by the creator
 * cron and before staff switch a page on — the flag written at discovery goes stale as soon as
 * staff connect one of the same pages.
 */
export async function syncNetworkDuplicates(assetIds?: string[]): Promise<{ flagged: number; cleared: number; switchedOff: number }> {
  const res = { flagged: 0, cleared: 0, switchedOff: 0 };
  const assets = await prisma.creatorAsset.findMany({
    where: assetIds ? { id: { in: assetIds } } : {},
    select: { id: true, kind: true, metaId: true, networkDuplicateOf: true, enabled: true },
  });
  for (const kind of ["facebook_page", "instagram_account"] as const) {
    const ofKind = assets.filter((a) => a.kind === kind);
    for (let i = 0; i < ofKind.length; i += 500) {
      const chunk = ofKind.slice(i, i + 500);
      const dupes = await networkDuplicates(META_KIND[kind], chunk.map((a) => a.metaId));
      for (const a of chunk) {
        const dup = dupes.get(a.metaId) ?? null;
        // Unchanged — unless it is a duplicate that is somehow still switched on.
        if (dup === a.networkDuplicateOf && !(dup && a.enabled)) continue;
        if (dup) {
          await prisma.creatorAsset.updateMany({
            where: { id: a.id },
            data: { networkDuplicateOf: dup, enabled: false, enabledById: null, enabledAt: null },
          });
          res.flagged++;
          if (a.enabled) res.switchedOff++;
        } else {
          await prisma.creatorAsset.updateMany({ where: { id: a.id }, data: { networkDuplicateOf: null } });
          res.cleared++;
        }
      }
    }
  }
  return res;
}

/** Discover (or refresh) one creator connection's assets. Never throws. */
export async function discoverCreatorAssets(connectionId: string, budget?: CallBudget): Promise<CreatorDiscoveryOutcome> {
  const out: CreatorDiscoveryOutcome = {
    connectionId,
    pagesFound: 0,
    igFound: 0,
    claimedElsewhere: 0,
    disconnected: 0,
    callsUsed: 0,
    state: "failed",
    rateLimited: false,
    authInvalid: false,
  };

  try {
    const conn = await prisma.creatorConnection.findUnique({ where: { id: connectionId } });
    if (!conn || !conn.userTokenEnc || conn.revokedAt) {
      out.error = "connection missing, revoked, or has no token";
      return out;
    }
    const creatorId = conn.creatorId;

    let token: string;
    try {
      token = decryptToken(conn.userTokenEnc);
    } catch (e) {
      out.error = "Your Facebook connection could not be read — please reconnect.";
      console.warn(`[creator-discovery] ${connectionId}: decrypt failed: ${scrubSecrets(String(e))}`);
      await prisma.creatorConnection.update({
        where: { id: connectionId },
        data: { status: "NEEDS_REAUTH", discoveryState: "failed", lastError: out.error },
      });
      return out;
    }

    await prisma.creatorConnection.update({ where: { id: connectionId }, data: { discoveryState: "running" } });

    const b = budget ?? makeBudget(DISCOVERY_CALL_BUDGET);
    const startUsed = b.used;
    const granted = new Set(conn.grantedScopes.split(",").map((s) => s.trim()).filter(Boolean));
    const seen = new Set<string>(); // `${kind}:${metaId}` this pass actually saw
    let complete = true;

    // ── who granted this (the name shown on the connection card) ──
    const me = await oauthGraphFetch<{ id?: string; name?: string }>("me", { fields: "id,name" }, token, {
      label: "creator-discover-me",
      budget: b,
      timeoutMs: DISCOVERY_TIMEOUT_MS, appSecret: creatorMetaAppSecret(),
    });
    if (me.authInvalid) {
      out.authInvalid = true;
      complete = false;
    } else if (me.ok && me.data?.name) {
      await prisma.creatorConnection.update({ where: { id: connectionId }, data: { metaUserName: clip(me.data.name, 200) } });
    }

    // ── Facebook Pages (Page tokens arrive inline) ──
    const pages: NonNullable<FbAccountsResponse["data"]> = [];
    if (!out.authInvalid) {
      let url: string | null = "me/accounts";
      let params: Record<string, string | number | undefined> | undefined = {
        fields: "id,name,username,access_token,tasks,followers_count,fan_count,picture{url}",
        limit: PAGE_LIMIT,
      };
      for (let guard = 0; url && guard < MAX_PAGES; guard++) {
        const res: OauthGraphResult<FbAccountsResponse> = await pagedFetch<FbAccountsResponse>(
          url, params, params ?? {}, token, "creator-discover-pages", b,
        );
        if (res.rateLimited) { out.rateLimited = true; complete = false; break; }
        if (res.authInvalid) { out.authInvalid = true; complete = false; break; }
        if (!res.ok || !res.data) { out.error = res.error ?? "page discovery failed"; complete = false; break; }
        pages.push(...(res.data.data ?? []));
        url = res.data.paging?.next ?? null;
        params = undefined; // an absolute cursor carries its own params
      }
      if (url) complete = false; // guard hit: we did not see everything
    }

    const fbDupes = await networkDuplicates("FACEBOOK_PAGE", pages.map((p) => p.id ?? "").filter(Boolean));
    const canFbPublish = granted.has("pages_manage_posts");
    for (const pg of pages) {
      if (!pg.id || !pg.access_token || !Array.isArray(pg.tasks) || pg.tasks.length === 0) continue;
      seen.add(`facebook_page:${pg.id}`);
      const publish = canFbPublish && pg.tasks.some((t) => PUBLISH_TASKS.has(t));
      if ((await claimOf("facebook_page", pg.id, creatorId, publish)) === "taken") { out.claimedElsewhere++; continue; }
      const ok = await upsertAsset("facebook_page", pg.id, creatorId, connectionId, {
        name: clip(pg.name ?? pg.id, 300),
        username: pg.username ?? null,
        pageTokenEnc: encryptToken(pg.access_token),
        tasks: pg.tasks,
        canPublish: publish,
        publishProbeError: publish
          ? null
          : !canFbPublish
            ? "Permission to publish to Pages was not granted — reconnect and allow it."
            : "Your Facebook role on this Page cannot create content.",
        followerCount: intOrNull(pg.followers_count) ?? intOrNull(pg.fan_count),
        pictureUrl: pg.picture?.data?.url ?? null,
        networkDuplicateOf: fbDupes.get(pg.id) ?? null,
      }, publish);
      if (ok) out.pagesFound++;
      else out.claimedElsewhere++;
    }

    // ── Instagram professional accounts hanging off those Pages ──
    const igIds: string[] = [];
    const parentOf = new Map<string, string>();
    if (!out.authInvalid && !out.rateLimited) {
      let url: string | null = "me/accounts";
      let params: Record<string, string | number | undefined> | undefined = {
        fields: "instagram_business_account", // BARE — never the nested {…} form
        limit: IG_PAGE_LIMIT,
      };
      for (let guard = 0; url && guard < MAX_PAGES; guard++) {
        const res: OauthGraphResult<IgNodesResponse> = await pagedFetch<IgNodesResponse>(
          url, params, params ?? { fields: "instagram_business_account" }, token, "creator-discover-ig-nodes", b,
        );
        if (res.rateLimited) { out.rateLimited = true; complete = false; break; }
        if (res.authInvalid) { out.authInvalid = true; complete = false; break; }
        if (!res.ok || !res.data) { out.error = out.error ?? res.error ?? "Instagram discovery failed"; complete = false; break; }
        for (const row of res.data.data ?? []) {
          const id = row.instagram_business_account?.id;
          if (id && !parentOf.has(id)) {
            igIds.push(id);
            if (row.id) parentOf.set(id, row.id);
          }
        }
        url = res.data.paging?.next ?? null;
        params = undefined;
      }
      if (url) complete = false;
    }

    const igDupes = await networkDuplicates("INSTAGRAM_ACCOUNT", igIds);
    const canIgPublishScope = granted.has("instagram_content_publish");
    for (const igId of igIds) {
      if (out.rateLimited || out.authInvalid) break;
      const prof = await oauthGraphFetch<IgProfileResponse>(
        igId,
        { fields: "username,name,followers_count,media_count,profile_picture_url" },
        token,
        { label: "creator-discover-ig-profile", budget: b, timeoutMs: DISCOVERY_TIMEOUT_MS, appSecret: creatorMetaAppSecret() },
      );
      if (prof.rateLimited) { out.rateLimited = true; complete = false; break; }
      if (prof.authInvalid) { out.authInvalid = true; complete = false; break; }
      if (!prof.ok || !prof.data) { complete = false; continue; }
      seen.add(`instagram_account:${igId}`);

      let canPublish = false;
      let probeError: string | null = "Permission to publish to Instagram was not granted — reconnect and allow it.";
      // A probe that did not get a DEFINITIVE answer (throttled, timed out, Meta 5xx, budget)
      // must not flip a publishable account to "can't publish": the stored answer is kept.
      let probeInconclusive = false;
      if (canIgPublishScope) {
        const probe = await oauthGraphFetch<{ data?: unknown[] }>(
          `${igId}/content_publishing_limit`,
          { fields: "quota_usage,config" },
          token,
          { label: "creator-discover-ig-probe", budget: b, timeoutMs: DISCOVERY_TIMEOUT_MS, appSecret: creatorMetaAppSecret() },
        );
        if (probe.rateLimited) { out.rateLimited = true; complete = false; }
        if (probe.authInvalid) { out.authInvalid = true; complete = false; }
        probeInconclusive =
          !probe.ok &&
          (probe.rateLimited || probe.authInvalid || probe.status === 0 || probe.status >= 500 || probe.error === "call budget exhausted");
        canPublish = probe.ok;
        probeError = probe.ok
          ? null
          : probeInconclusive
            ? "Instagram didn't answer when we checked publishing access — press “Check pages again” in a few minutes."
            : clip(scrubSecrets(probe.error ?? "Instagram did not confirm publishing access."), 300);
      }
      const claim = await claimOf("instagram_account", igId, creatorId, canPublish);
      if (claim === "taken") { out.claimedElsewhere++; continue; }

      const p = prof.data;
      const ok = await upsertAsset("instagram_account", igId, creatorId, connectionId, {
        name: clip(p.name || p.username || igId, 300),
        username: p.username ?? null,
        parentPageId: parentOf.get(igId) ?? null,
        // IG rows carry NO token: they are read with the user token (or the parent Page's).
        pageTokenEnc: null,
        tasks: [],
        // An inconclusive probe keeps our own row's stored answer; a new row starts at false.
        ...(probeInconclusive && claim === "ours" ? {} : { canPublish, publishProbeError: probeError }),
        followerCount: intOrNull(p.followers_count),
        mediaCount: intOrNull(p.media_count),
        pictureUrl: p.profile_picture_url ?? null,
        networkDuplicateOf: igDupes.get(igId) ?? null,
      }, canPublish);
      if (ok) out.igFound++;
      else out.claimedElsewhere++;
    }

    if (b.used >= b.max) complete = false;

    // Only a COMPLETE pass may conclude that a page is gone: a rate-limited or truncated pass
    // simply did not look, and disconnecting on that basis would switch off live pages.
    if (complete) {
      const mine = await prisma.creatorAsset.findMany({
        where: { connectionId, disconnectedAt: null },
        select: { id: true, kind: true, metaId: true },
      });
      const gone = mine.filter((a) => !seen.has(`${a.kind}:${a.metaId}`)).map((a) => a.id);
      if (gone.length > 0) {
        const r = await prisma.creatorAsset.updateMany({
          where: { id: { in: gone } },
          data: { disconnectedAt: new Date(), enabled: false, pageTokenEnc: null },
        });
        out.disconnected = r.count;
      }
      // A page that stayed behind on a retired connection (the creator switched Facebook
      // accounts) is never left switched on.
      await prisma.creatorAsset.updateMany({
        where: { creatorId, disconnectedAt: { not: null }, enabled: true },
        data: { enabled: false },
      });
    }

    out.callsUsed = b.used - startUsed;
    out.state = complete ? "done" : "failed";

    const claimNote =
      out.claimedElsewhere > 0
        ? `${out.claimedElsewhere} ${out.claimedElsewhere === 1 ? "page is" : "pages are"} already connected to another creator account`
        : null;
    const failNote = out.authInvalid
      ? "Facebook no longer accepts this connection — please reconnect."
      : out.rateLimited
        ? "Facebook is rate-limiting us right now; we will finish loading your pages shortly."
        : !complete
          ? "We could not load all of your pages from Facebook — try Refresh in a few minutes."
          : null;
    const lastError = [failNote, claimNote].filter(Boolean).join(". ") || null;

    await prisma.creatorConnection.update({
      where: { id: connectionId },
      data: {
        discoveryState: out.state,
        lastError: lastError ? clip(lastError, 500) : null,
        lastVerifiedAt: new Date(),
        // A COMPLETE pass proves the token works again: a NEEDS_REAUTH set by the metrics job
        // (or an earlier failed pass) is lifted. Token health re-applies NEEDS_REAUTH_SOON.
        ...(out.authInvalid
          ? { status: "NEEDS_REAUTH" }
          : complete && conn.status === "NEEDS_REAUTH"
            ? { status: CREATOR_REQUIRED_SCOPES.every((s) => granted.has(s)) ? "ACTIVE" : "PARTIAL_SCOPE" }
            : {}),
      },
    });

    if (out.error) console.warn(`[creator-discovery] ${connectionId}: ${scrubSecrets(out.error)}`);
    console.log(
      `[creator-discovery] connection=${connectionId} pages=${out.pagesFound} ig=${out.igFound} ` +
        `claimedElsewhere=${out.claimedElsewhere} disconnected=${out.disconnected} calls=${out.callsUsed} state=${out.state}` +
        (out.rateLimited ? " RATE_LIMITED" : "") +
        (out.authInvalid ? " AUTH_INVALID" : ""),
    );
    return out;
  } catch (e) {
    out.error = scrubSecrets(String(e));
    console.error(`[creator-discovery] ${connectionId} failed:`, out.error);
    await prisma.creatorConnection
      .update({
        where: { id: connectionId },
        data: { discoveryState: "failed", lastError: "We could not load your pages from Facebook — try Refresh in a few minutes." },
      })
      .catch(() => undefined);
    return out;
  }
}
