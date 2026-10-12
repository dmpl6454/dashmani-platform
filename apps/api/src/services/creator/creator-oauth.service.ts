/**
 * Creator portal — Facebook Login: start, one-time state consume, and the connect itself.
 *
 * Mirrors the admin flow (services/meta-oauth/meta-oauth.service.ts) and REUSES its token
 * exchange, but writes only creator_* tables. The in-request cost is the same three Graph calls
 * (code → short-lived → long-lived → debug_token); discovery runs behind the redirect.
 *
 * ⚠️ Rules that make this safe on a public, worldwide sign-up:
 *  • the grant must be for OUR app (debug_token app_id) — a token minted for someone else's app
 *    and replayed here is refused;
 *  • one Facebook identity belongs to at most one creator: a second creator connecting the same
 *    identity is refused and NOTHING is stored (the first creator's token is never overwritten);
 *  • ⚠️ the browser that FINISHES the flow must be the creator who started it. Meta redirects
 *    to our public callback, which only hands `state` + `code` back to the creators app in a URL
 *    fragment; the signed-in creator's own browser then POSTs them to /oauth/complete, and the
 *    state is consumed only when its creatorId is that bearer's. Before this, anyone could start a
 *    connect on their own account and send the facebook.com link to a page owner: the owner's
 *    approval would have stored their Page tokens under the attacker's account (review SEC-1);
 *  • a Facebook identity that holds one of OUR staff Meta connections is refused and nothing is
 *    stored: its Page tokens are our network's, and the creator flow shares the staff app;
 *  • nothing here ever writes a meta_* table — the two systems stay separate.
 */

import { randomBytes } from "crypto";
import { prisma } from "@dashmani/db";
import {
  exchangeCodeForLongLivedToken,
  epochToDateOrNull,
} from "../meta-oauth/meta-oauth.service";
import { metaDialogBase, metaGraphVersion } from "../meta-oauth/meta-config";
import { encryptToken, scrubSecrets } from "../../utils/token-crypto";
import { CREATOR_REQUIRED_SCOPES } from "./creator-view";
import { adminAlert } from "./creator-email";
import {
  CREATOR_META_SCOPES,
  creatorMetaAppId,
  creatorMetaAppSecret,
  creatorMetaRedirectUri,
} from "./creator-meta-config";
import { discoverCreatorAssets } from "./creator-discovery.service";

/** Same 60-minute window as the admin flow: it covers a human doing a Facebook login + picker. */
const STATE_TTL_MS = 60 * 60 * 1000;

export async function startCreatorMetaOauth(input: { creatorId: string; rerequest?: boolean }) {
  const state = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  await prisma.creatorOauthState.create({
    data: { state, creatorId: input.creatorId, mode: input.rerequest ? "rerequest" : "connect", expiresAt },
  });

  // Built server-side: the browser cannot change the scopes, the redirect or the app id.
  const url = new URL(`${metaDialogBase()}/dialog/oauth`);
  url.searchParams.set("client_id", creatorMetaAppId());
  url.searchParams.set("redirect_uri", creatorMetaRedirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", CREATOR_META_SCOPES.join(","));
  // Without rerequest Meta silently re-returns a previously declined partial grant.
  if (input.rerequest) url.searchParams.set("auth_type", "rerequest");
  return { authorizeUrl: url.toString(), expiresAt };
}

/** Is this a live (unused, unexpired) state? Read-only — the public callback uses it to send a
 *  stale link straight to "expired" instead of handing it on. */
export async function creatorOauthStateIsLive(state: string): Promise<boolean> {
  if (!state || state.length > 200) return false;
  const row = await prisma.creatorOauthState.findUnique({ where: { state }, select: { usedAt: true, expiresAt: true } });
  return !!row && !row.usedAt && row.expiresAt > new Date();
}

export type ConsumeResult = { ok: true } | { ok: false; error: "expired" | "wrong_account" };

/**
 * Atomic one-time consume, bound to the creator who STARTED the flow: updateMany({state,
 * creatorId, usedAt:null, not expired}) + a count check, never a bare update/delete (a double
 * submit would 500 the loser). A state started by ANOTHER creator is never consumed — that is
 * the account-linking attack this binding exists to stop.
 */
export async function consumeCreatorOauthState(state: string, creatorId: string): Promise<ConsumeResult> {
  if (!state || state.length > 200) return { ok: false, error: "expired" };
  const now = new Date();
  const claimed = await prisma.creatorOauthState.updateMany({
    where: { state, creatorId, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claimed.count === 1) return { ok: true };
  const row = await prisma.creatorOauthState.findUnique({ where: { state }, select: { creatorId: true } });
  if (row && row.creatorId !== creatorId) {
    console.warn(`[creator-meta] a connect started by another creator was completed by creator=${creatorId} — refused`);
    return { ok: false, error: "wrong_account" };
  }
  return { ok: false, error: "expired" };
}

/** Expired states older than a day. Fail-open housekeeping (cron + start). */
export async function pruneCreatorOauthStates(): Promise<number> {
  try {
    const res = await prisma.creatorOauthState.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
    return res.count;
  } catch {
    return 0;
  }
}

export type ConnectError = "already_linked" | "app_mismatch" | "exchange_failed" | "disabled" | "staff_account";
export type ConnectResult = { ok: true; connectionId: string } | { ok: false; error: ConnectError };

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";

/**
 * Exchange the code and store the creator's connection. Never throws for an expected outcome;
 * the route maps `error` onto its error code. Call it only after consumeCreatorOauthState
 * succeeded for THIS creator.
 */
export async function completeCreatorConnect(creatorId: string, code: string): Promise<ConnectResult> {
  const creator = await prisma.creator.findUnique({ where: { id: creatorId }, select: { id: true, status: true, email: true, name: true } });
  if (!creator || creator.status === "closed" || creator.status === "suspended") return { ok: false, error: "disabled" };

  const appId = creatorMetaAppId();
  const outcome = await exchangeCodeForLongLivedToken(code, {
    redirectUri: creatorMetaRedirectUri(),
    appId,
    appSecret: creatorMetaAppSecret(),
  });
  if (!outcome.ok || !outcome.longLivedToken || !outcome.debug?.user_id) {
    console.warn("[creator-meta] token exchange failed:", scrubSecrets(outcome.error ?? outcome.reason ?? "unknown"));
    return { ok: false, error: "exchange_failed" };
  }
  const debug = outcome.debug;
  // ⚠️ REQUIRED, not advisory: debug_token answers for any token our app token can inspect, so
  // without this a grant issued to another app would be stored as if the creator gave it to us.
  if (String(debug.app_id ?? "") !== appId) {
    console.warn(`[creator-meta] refused a grant for another app (creator=${creatorId})`);
    return { ok: false, error: "app_mismatch" };
  }
  const metaUserId = String(debug.user_id);

  // ⚠️ A staff grantor is refused and NOTHING is stored. Their Page tokens belong to our own
  // network, and the creator flow shares the staff Meta app — so the Page picker they just went
  // through may also have narrowed the staff grant. Staff are told to check it. READ ONLY.
  const staff = await prisma.metaConnection.findFirst({ where: { metaUserId, revokedAt: null }, select: { id: true } });
  if (staff) {
    console.warn(`[creator-meta] refused a staff Facebook identity on the creator flow (creator=${creatorId})`);
    void adminAlert(
      "A staff Facebook account tried to connect through the creator portal",
      [
        { label: "Creator account", value: `${creator.name} <${creator.email}>` },
        { label: "What happened", value: "The connection was refused and nothing was stored." },
        {
          label: "Check",
          value:
            "The creator portal uses the same Meta app as Account Growth. If this person chose only some Pages in Facebook's Page picker, the staff connection may now reach fewer Pages. Reconnect from Account Growth and select all Pages if the channel count dropped.",
        },
      ],
      `/creators/${creator.id}`,
    ).catch(() => undefined);
    return { ok: false, error: "staff_account" };
  }

  // One Facebook identity ↔ one creator. The previous holder's claim is released when it can
  // never be used again: the account is closed, OR that connection was revoked (disconnected in
  // the portal, superseded by another identity, or the app was removed on Facebook). A LIVE
  // claim by another creator is never touched.
  const existing = await prisma.creatorConnection.findUnique({
    where: { metaUserId },
    select: { id: true, creatorId: true, revokedAt: true, creator: { select: { status: true } } },
  });
  if (existing && existing.creatorId !== creatorId) {
    if (existing.creator.status !== "closed" && !existing.revokedAt) {
      console.warn(`[creator-meta] identity already linked to another creator (creator=${creatorId})`);
      return { ok: false, error: "already_linked" };
    }
    // Guarded on the same facts, so a holder who reconnects in between keeps it. Cascade removes
    // that connection's asset rows too, so its pages can be claimed again.
    await prisma.creatorConnection.deleteMany({
      where: {
        id: existing.id,
        creatorId: existing.creatorId,
        OR: [{ revokedAt: { not: null } }, { creator: { status: "closed" } }],
      },
    });
  }

  const granted = (debug.scopes ?? []).map(String);
  const missing = CREATOR_REQUIRED_SCOPES.filter((s) => !granted.includes(s));
  const data = {
    userTokenEnc: encryptToken(outcome.longLivedToken),
    grantedScopes: granted.join(","),
    granularScopes: (debug.granular_scopes ?? null) as never,
    tokenExpiresAt: epochToDateOrNull(debug.expires_at),
    dataAccessExpiresAt: epochToDateOrNull(debug.data_access_expires_at),
    graphVersion: metaGraphVersion(),
    status: missing.length > 0 ? "PARTIAL_SCOPE" : "ACTIVE",
    discoveryState: "pending",
    lastError: null,
    revokedAt: null,
    lastVerifiedAt: new Date(),
    // New expiry dates ⇒ the 14- and 3-day reminders may be due again.
    expiryWarnedDays: null,
  };

  // Update only OUR row (creatorId in the WHERE), else create. A concurrent claim by another
  // creator loses on the metaUserId UNIQUE and is refused — it can never overwrite their token.
  let connectionId: string;
  const updated = await prisma.creatorConnection.updateMany({ where: { metaUserId, creatorId }, data });
  if (updated.count > 0) {
    const row = await prisma.creatorConnection.findUnique({ where: { metaUserId }, select: { id: true } });
    connectionId = row!.id;
  } else {
    try {
      const row = await prisma.creatorConnection.create({ data: { creatorId, metaUserId, ...data }, select: { id: true } });
      connectionId = row.id;
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: false, error: "already_linked" };
      throw e;
    }
  }

  // A creator has ONE live Facebook identity. Connecting a different one retires the previous
  // grant locally (token dropped); its pages that the new identity also manages are re-attached
  // by discovery, the rest stay visible as disconnected.
  const superseded = await prisma.creatorConnection.findMany({
    where: { creatorId, id: { not: connectionId }, revokedAt: null },
    select: { id: true },
  });
  if (superseded.length > 0) {
    const ids = superseded.map((c) => c.id);
    const now = new Date();
    await prisma.creatorConnection.updateMany({
      where: { id: { in: ids } },
      data: { userTokenEnc: null, status: "REVOKED", revokedAt: now },
    });
    await prisma.creatorAsset.updateMany({
      where: { connectionId: { in: ids }, disconnectedAt: null },
      data: { disconnectedAt: now, pageTokenEnc: null },
    });
  }

  // Discovery is FIRE AND FORGET: the one-time state is already consumed, so a slow Meta must
  // never turn the request into a 504. A restart mid-run leaves discovery_state "running";
  // creator-view.ts reads a stale "running" as interrupted.
  void discoverCreatorAssets(connectionId).catch((e) =>
    console.error("[creator-meta] post-connect discovery failed:", scrubSecrets(String(e))),
  );

  return { ok: true, connectionId };
}

/**
 * Local revoke (DELETE /creator/meta/connection, account close). Tokens dropped, assets
 * disconnected and switched off. ⚠️ Never calls Meta's DELETE /{user}/permissions: the creator
 * removes the app on Facebook themselves, and our deauthorize callback handles that side.
 */
export async function revokeCreatorConnections(creatorId: string): Promise<number> {
  const now = new Date();
  const conns = await prisma.creatorConnection.findMany({ where: { creatorId, revokedAt: null }, select: { id: true } });
  const ids = conns.map((c) => c.id);
  if (ids.length === 0) return 0;
  await prisma.creatorConnection.updateMany({
    where: { id: { in: ids } },
    data: { userTokenEnc: null, status: "REVOKED", revokedAt: now },
  });
  await prisma.creatorAsset.updateMany({
    where: { connectionId: { in: ids } },
    data: { disconnectedAt: now, enabled: false, pageTokenEnc: null },
  });
  return ids.length;
}
