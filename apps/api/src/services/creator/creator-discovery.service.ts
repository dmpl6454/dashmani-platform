/**
 * Creator portal — discover the Facebook Pages and Instagram professional accounts a creator's
 * grant reaches, and whether we could publish to each.
 *
 * Same Graph shapes as services/meta-oauth/meta-discovery.service.ts (read it for the incident
 * history behind the page sizes and the BARE instagram_business_account field), but:
 *  • rows go to creator_assets, never meta_assets — this file WRITES NO meta_* TABLE and never
 *    links to the channel registry (linkToChannel). meta_assets is only READ, to flag a page that
 *    is already on our own network (networkDuplicateOf) so it can never be sold twice;
 *  • a page another LIVE creator has claimed is never taken over — it is skipped and the
 *    creator is told why;
 *  • canPublish is a real probe, not a guess: Facebook needs pages_manage_posts AND a
 *    CREATE_CONTENT/MANAGE task on the Page; Instagram needs instagram_content_publish AND a
 *    content_publishing_limit answer.
 * Budgeted, never throws; discovery_state pending → running → done | failed.
 */

import { prisma } from "@dashmani/db";
import { oauthGraphFetch, makeBudget, type CallBudget, type OauthGraphResult } from "../meta-oauth/oauth-graph";
import { decryptToken, encryptToken, scrubSecrets } from "../../utils/token-crypto";

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
  let res: OauthGraphResult<T> = await oauthGraphFetch<T>(url, params ?? {}, token, { label, budget, timeoutMs: DISCOVERY_TIMEOUT_MS });
  if (!res.ok && !res.rateLimited && !res.authInvalid && res.error !== "call budget exhausted") {
    res = await oauthGraphFetch<T>(url, { ...(params ?? {}), ...retryParams, limit: 5 }, token, {
      label: `${label}-retry`,
      budget,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
  }
  return res;
}

type Claim = "ours" | "free" | "taken";

/**
 * Who holds (kind, metaId) today. A row held by a CLOSED creator account is free — that account
 * can never use it again, and keeping the claim would lock the page out of the portal forever.
 */
async function claimOf(kind: string, metaId: string, creatorId: string): Promise<Claim> {
  const row = await prisma.creatorAsset.findUnique({
    where: { kind_metaId: { kind, metaId } },
    select: { creatorId: true, creator: { select: { status: true } } },
  });
  if (!row) return "free";
  if (row.creatorId === creatorId) return "ours";
  return row.creator.status === "closed" ? "free" : "taken";
}

/** Upsert one asset under this creator + connection; false when another creator won a race. */
async function upsertAsset(
  kind: "facebook_page" | "instagram_account",
  metaId: string,
  creatorId: string,
  connectionId: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const data = { ...fields, creatorId, connectionId, disconnectedAt: null };
  try {
    // The WHERE pins either our own row or a closed account's; a live creator's row never matches.
    const updated = await prisma.creatorAsset.updateMany({
      where: {
        kind,
        metaId,
        OR: [{ creatorId }, { creator: { status: "closed" } }],
      },
      data: data as never,
    });
    if (updated.count > 0) return true;
    await prisma.creatorAsset.create({ data: { kind, metaId, ...data } as never });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

/**
 * meta_assets ids of OUR live channels with these metaIds (READ ONLY). Keyed by metaId.
 * kind mapping: facebook_page ↔ FACEBOOK_PAGE, instagram_account ↔ INSTAGRAM_ACCOUNT.
 */
async function networkDuplicates(kind: "FACEBOOK_PAGE" | "INSTAGRAM_ACCOUNT", metaIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (metaIds.length === 0) return out;
  const rows = await prisma.metaAsset.findMany({
    where: { kind, metaId: { in: metaIds }, disconnectedAt: null },
    select: { id: true, metaId: true },
    orderBy: { createdAt: "asc" },
  });
  for (const r of rows) if (!out.has(r.metaId)) out.set(r.metaId, r.id);
  return out;
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
      timeoutMs: DISCOVERY_TIMEOUT_MS,
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
      if ((await claimOf("facebook_page", pg.id, creatorId)) === "taken") { out.claimedElsewhere++; continue; }
      const publish = canFbPublish && pg.tasks.some((t) => PUBLISH_TASKS.has(t));
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
      });
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
        { label: "creator-discover-ig-profile", budget: b, timeoutMs: DISCOVERY_TIMEOUT_MS },
      );
      if (prof.rateLimited) { out.rateLimited = true; complete = false; break; }
      if (prof.authInvalid) { out.authInvalid = true; complete = false; break; }
      if (!prof.ok || !prof.data) { complete = false; continue; }
      seen.add(`instagram_account:${igId}`);
      if ((await claimOf("instagram_account", igId, creatorId)) === "taken") { out.claimedElsewhere++; continue; }

      let canPublish = false;
      let probeError: string | null = "Permission to publish to Instagram was not granted — reconnect and allow it.";
      if (canIgPublishScope) {
        const probe = await oauthGraphFetch<{ data?: unknown[] }>(
          `${igId}/content_publishing_limit`,
          { fields: "quota_usage,config" },
          token,
          { label: "creator-discover-ig-probe", budget: b, timeoutMs: DISCOVERY_TIMEOUT_MS },
        );
        if (probe.rateLimited) { out.rateLimited = true; complete = false; }
        canPublish = probe.ok;
        probeError = probe.ok ? null : clip(scrubSecrets(probe.error ?? "Instagram did not confirm publishing access."), 300);
      }

      const p = prof.data;
      const ok = await upsertAsset("instagram_account", igId, creatorId, connectionId, {
        name: clip(p.name || p.username || igId, 300),
        username: p.username ?? null,
        parentPageId: parentOf.get(igId) ?? null,
        // IG rows carry NO token: they are read with the user token (or the parent Page's).
        pageTokenEnc: null,
        tasks: [],
        canPublish,
        publishProbeError: probeError,
        followerCount: intOrNull(p.followers_count),
        mediaCount: intOrNull(p.media_count),
        pictureUrl: p.profile_picture_url ?? null,
        networkDuplicateOf: igDupes.get(igId) ?? null,
      });
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
        ...(out.authInvalid ? { status: "NEEDS_REAUTH" } : {}),
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
