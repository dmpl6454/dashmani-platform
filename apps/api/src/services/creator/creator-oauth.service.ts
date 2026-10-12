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
 *  • nothing here ever writes a meta_* table. If a staff grantor uses the creator flow we only
 *    alert staff — the two systems stay separate.
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

/**
 * Atomic one-time consume: updateMany({usedAt:null, not expired}) + a count check, never a bare
 * update/delete (a double callback would 500 the loser). Unknown / used / expired → null.
 */
export async function consumeCreatorOauthState(state: string): Promise<{ creatorId: string } | null> {
  if (!state || state.length > 200) return null;
  const now = new Date();
  const claimed = await prisma.creatorOauthState.updateMany({
    where: { state, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claimed.count === 0) return null;
  const row = await prisma.creatorOauthState.findUnique({ where: { state }, select: { creatorId: true } });
  return row ? { creatorId: row.creatorId } : null;
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

export type ConnectError = "already_linked" | "app_mismatch" | "exchange_failed" | "disabled";
export type ConnectResult = { ok: true; connectionId: string } | { ok: false; error: ConnectError };

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";

/**
 * Exchange the code and store the creator's connection. Never throws for an expected outcome;
 * the route maps `error` straight onto the ?error= of its redirect.
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

  // One Facebook identity ↔ one creator. A CLOSED account's old claim is released (its token is
  // already gone and it can never be used again); a live account's claim is never touched.
  const existing = await prisma.creatorConnection.findUnique({
    where: { metaUserId },
    select: { id: true, creatorId: true, creator: { select: { status: true } } },
  });
  if (existing && existing.creatorId !== creatorId) {
    if (existing.creator.status !== "closed") {
      console.warn(`[creator-meta] identity already linked to another creator (creator=${creatorId})`);
      return { ok: false, error: "already_linked" };
    }
    // Cascade removes the closed account's asset rows too, so its pages can be claimed again.
    await prisma.creatorConnection.deleteMany({ where: { id: existing.id, creatorId: existing.creatorId } });
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

  // A staff grantor (meta_connections) using the creator flow is legal but worth a human look:
  // their pages are likely already on our network. READ ONLY — meta_* is never written here.
  const staff = await prisma.metaConnection.findFirst({ where: { metaUserId }, select: { id: true } });
  if (staff) {
    void adminAlert(
      "A staff Facebook account connected through the creator portal",
      [
        { label: "Creator", value: `${creator.name} <${creator.email}>` },
        { label: "Note", value: "This Facebook identity also holds a staff Meta connection. Its pages are flagged as duplicates of our network and cannot be offered." },
      ],
      `/creators/${creator.id}`,
    ).catch(() => undefined);
  }

  // Discovery is FIRE AND FORGET: the one-time state is already consumed, so a slow Meta must
  // never turn the redirect into a 504.
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
