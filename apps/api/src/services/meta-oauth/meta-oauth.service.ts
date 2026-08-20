/**
 * Meta OAuth — authorize-URL construction, token exchange, and state lifecycle.
 *
 * The in-request cost of a full connect is exactly THREE Graph calls (exchange →
 * long-lived → debug_token), ~30s worst case. Asset discovery is ~61 calls and is
 * deliberately NOT here: it runs behind the redirect. An earlier design consumed the
 * one-time state row and then spent 150s+ discovering, so a slow Meta produced a 504
 * with the state already burned and no recoverable path for the admin.
 */

import { randomBytes } from "crypto";
import { prisma } from "@dashmani/db";
import { oauthGraphFetch, makeBudget, type OauthGraphResult } from "./oauth-graph";
import {
  META_OAUTH_SCOPES,
  META_REQUIRED_SCOPES,
  metaDialogBase,
  metaGraphVersion,
  metaOauthAppId,
  metaOauthAppSecret,
  metaOauthRedirectUri,
} from "./meta-config";
import { encryptToken, scrubSecrets } from "../../utils/token-crypto";

/** How long a pending authorization may sit before its state row is dead. */
const STATE_TTL_MS = 10 * 60 * 1000;

export interface StartResult {
  authorizeUrl: string;
  state: string;
  expiresAt: Date;
}

/**
 * Create a one-time state row and return the consent URL.
 *
 * The URL is built SERVER-SIDE and the client never composes it — so the scope
 * list, the redirect_uri and the app id cannot be tampered with from the browser.
 */
export async function startMetaOauth(input: {
  userId: string;
  mode?: "connect" | "reconnect";
  connectionId?: string;
  /** auth_type=rerequest — needed to re-ask for a scope the user previously declined.
   *  Without it Meta silently re-returns the same partial grant. */
  rerequest?: boolean;
}): Promise<StartResult> {
  const state = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);

  await prisma.metaOAuthState.create({
    data: {
      state,
      userId: input.userId,
      mode: input.mode ?? "connect",
      connectionId: input.connectionId ?? null,
      expiresAt,
    },
  });

  const url = new URL(`${metaDialogBase()}/dialog/oauth`);
  url.searchParams.set("client_id", metaOauthAppId());
  url.searchParams.set("redirect_uri", metaOauthRedirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", META_OAUTH_SCOPES.join(","));
  if (input.rerequest || input.mode === "reconnect") {
    url.searchParams.set("auth_type", "rerequest");
  }

  return { authorizeUrl: url.toString(), state, expiresAt };
}

export interface ConsumedState {
  userId: string;
  mode: string;
  connectionId: string | null;
}

/**
 * Atomically consume a state row.
 *
 * ⚠️ updateMany({ usedAt: null }) + a COUNT CHECK — never a bare update()/delete().
 * That is the one-time-consume rule; a bare delete() on a concurrent double-callback
 * throws P2025 and 500s the loser. This exact class bit all three auth services
 * (PR #101) and the admin accept-invite flow (PR #108). Returns null when the state
 * is unknown, already used, or expired — all of which are the same "don't trust it".
 */
export async function consumeMetaOauthState(state: string): Promise<ConsumedState | null> {
  if (!state) return null;
  const now = new Date();

  const claimed = await prisma.metaOAuthState.updateMany({
    where: { state, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claimed.count === 0) return null;

  const row = await prisma.metaOAuthState.findUnique({ where: { state } });
  if (!row) return null;
  return { userId: row.userId, mode: row.mode, connectionId: row.connectionId };
}

/** Best-effort cleanup of expired state rows. Fail-open; never blocks a flow. */
export async function pruneExpiredOauthStates(): Promise<number> {
  try {
    const res = await prisma.metaOAuthState.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    return res.count;
  } catch {
    return 0;
  }
}

// ── Token exchange ───────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

export interface DebugTokenData {
  app_id?: string;
  user_id?: string;
  is_valid?: boolean;
  scopes?: string[];
  granular_scopes?: unknown;
  /** 0 means "never expires" — stored as NULL, never as epoch 1970. */
  expires_at?: number;
  /** The REAL ~90-day clock. Never computed as now()+90d. */
  data_access_expires_at?: number;
}

export interface ExchangeOutcome {
  ok: boolean;
  /** Machine reason for the ?meta=error&reason= redirect. */
  reason?: "exchange" | "invalid_token" | "config";
  longLivedToken?: string;
  debug?: DebugTokenData;
  error?: string;
}

/**
 * code → short-lived token → long-lived token → debug_token.
 *
 * The redirect_uri here must be BYTE-IDENTICAL to the one used in the authorize
 * URL or Meta rejects the exchange; both read the same env var, never a derived value.
 */
export async function exchangeCodeForLongLivedToken(code: string): Promise<ExchangeOutcome> {
  const appId = metaOauthAppId();
  const appSecret = metaOauthAppSecret();
  if (!appId || !appSecret) return { ok: false, reason: "config" };

  // A2 — short-lived user token. A dedicated budget so a pathological retry can
  // never spend an unbounded number of calls inside one HTTP request.
  const budget = makeBudget(4);

  const short = await oauthGraphFetch<TokenResponse>(
    "oauth/access_token",
    {
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: metaOauthRedirectUri(),
      code,
    },
    // This call authenticates with the client_secret, not a bearer token.
    "",
    { label: "oauth-exchange", timeoutMs: 10_000, budget },
  );
  const shortToken = short.data?.access_token;
  if (!short.ok || !shortToken) {
    return { ok: false, reason: "exchange", error: scrubSecrets(short.error ?? "exchange failed") };
  }

  // A3 — long-lived user token (~60d).
  const long = await oauthGraphFetch<TokenResponse>(
    "oauth/access_token",
    {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    },
    "",
    { label: "oauth-longlived", timeoutMs: 10_000, budget },
  );
  const longToken = long.data?.access_token;
  if (!long.ok || !longToken) {
    return { ok: false, reason: "exchange", error: scrubSecrets(long.error ?? "long-lived exchange failed") };
  }

  // A4 — debug_token is the AUTHORITATIVE source for identity, scopes and both
  // expiry clocks. Authenticated with the app token "<appId>|<appSecret>".
  const dbg = await oauthGraphFetch<{ data?: DebugTokenData }>(
    "debug_token",
    { input_token: longToken },
    `${appId}|${appSecret}`,
    { label: "oauth-debug-token", timeoutMs: 10_000, budget },
  );
  const data = dbg.data?.data;
  if (!dbg.ok || !data || data.is_valid !== true || !data.user_id) {
    return {
      ok: false,
      reason: "invalid_token",
      error: scrubSecrets(dbg.error ?? "debug_token reported the grant invalid"),
    };
  }

  return { ok: true, longLivedToken: longToken, debug: data };
}

/** Epoch-seconds → Date, treating 0 / absent as "no expiry" (NULL). */
export function epochToDateOrNull(v: number | undefined): Date | null {
  if (typeof v !== "number" || v <= 0) return null;
  return new Date(v * 1000);
}

/** Scopes we asked for but were not granted. */
export function missingRequiredScopes(granted: string[]): string[] {
  const set = new Set(granted.map((s) => s.trim()).filter(Boolean));
  return META_REQUIRED_SCOPES.filter((s) => !set.has(s));
}

/**
 * Persist (or update, on reconnect) the connection.
 *
 * Upsert on metaUserId so reconnecting the SAME Facebook account updates in place
 * rather than accumulating duplicate connections for one grantor.
 */
export async function persistConnection(input: {
  connectedById: string;
  longLivedToken: string;
  debug: DebugTokenData;
}): Promise<{ id: string; partialScope: boolean; missingScopes: string[] }> {
  const granted = (input.debug.scopes ?? []).map(String);
  const missing = missingRequiredScopes(granted);
  const status = missing.length > 0 ? "PARTIAL_SCOPE" : "ACTIVE";

  const shared = {
    metaUserName: null as string | null,
    userTokenEnc: encryptToken(input.longLivedToken),
    grantedScopes: granted.join(","),
    granularScopes: (input.debug.granular_scopes ?? null) as never,
    tokenExpiresAt: epochToDateOrNull(input.debug.expires_at),
    dataAccessExpiresAt: epochToDateOrNull(input.debug.data_access_expires_at),
    graphVersion: metaGraphVersion(),
    status: status as never,
    discoveryState: "pending",
    discoveryCursor: null,
    lastError: null,
    revokedAt: null,
    lastVerifiedAt: new Date(),
  };

  const row = await prisma.metaConnection.upsert({
    where: { metaUserId: String(input.debug.user_id) },
    create: {
      metaUserId: String(input.debug.user_id),
      connectedById: input.connectedById,
      ...shared,
    },
    // connectedById is intentionally NOT overwritten on reconnect: the original
    // grantor stays recorded even if another admin performs the repair.
    update: shared,
  });

  return { id: row.id, partialScope: missing.length > 0, missingScopes: missing };
}

/** Shape returned to the admin UI. Contains NO token field at any nesting level. */
export function serializeConnection(row: {
  id: string;
  metaUserId: string;
  metaUserName: string | null;
  status: string;
  grantedScopes: string;
  tokenExpiresAt: Date | null;
  dataAccessExpiresAt: Date | null;
  graphVersion: string;
  discoveryState: string;
  capabilities: unknown;
  lastVerifiedAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  connectedBy?: { id: string; name: string } | null;
}) {
  const granted = row.grantedScopes ? row.grantedScopes.split(",").filter(Boolean) : [];
  const daysLeft =
    row.dataAccessExpiresAt == null
      ? null
      : Math.floor((row.dataAccessExpiresAt.getTime() - Date.now()) / 86_400_000);
  return {
    id: row.id,
    metaUserId: row.metaUserId,
    metaUserName: row.metaUserName,
    connectedBy: row.connectedBy ? { id: row.connectedBy.id, name: row.connectedBy.name } : null,
    status: row.status,
    grantedScopes: granted,
    missingScopes: missingRequiredScopes(granted),
    tokenExpiresAt: row.tokenExpiresAt ? row.tokenExpiresAt.toISOString() : null,
    dataAccessExpiresAt: row.dataAccessExpiresAt ? row.dataAccessExpiresAt.toISOString() : null,
    dataAccessDaysLeft: daysLeft,
    graphVersion: row.graphVersion,
    discoveryState: row.discoveryState,
    capabilities: row.capabilities ?? null,
    lastVerifiedAt: row.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Re-exported for the routes layer's error branches. */
export type { OauthGraphResult };
