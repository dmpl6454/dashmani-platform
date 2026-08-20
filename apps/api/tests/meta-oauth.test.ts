/**
 * Meta OAuth — authorize-URL construction, state lifecycle, and the config gate.
 *
 * The properties locked here are the ones whose failure would be either a security
 * hole (a replayable state, a write scope we never intended to request) or a silent
 * outage (the dark switch not actually being dark).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "@dashmani/db";
import {
  startMetaOauth,
  consumeMetaOauthState,
  missingRequiredScopes,
  epochToDateOrNull,
  pruneExpiredOauthStates,
} from "../src/services/meta-oauth/meta-oauth.service";
import {
  META_FORBIDDEN_SCOPES,
  META_OAUTH_SCOPES,
  metaOauthConfigured,
  metaOauthMissingEnv,
  metaOauthReturnUrl,
} from "../src/services/meta-oauth/meta-config";

const ENV_KEYS = [
  "META_OAUTH_APP_ID",
  "META_OAUTH_APP_SECRET",
  "META_OAUTH_REDIRECT_URI",
  "META_OAUTH_RETURN_ORIGIN",
] as const;

const saved: Record<string, string | undefined> = {};

function configureMeta() {
  process.env.META_OAUTH_APP_ID = "298449321694397";
  process.env.META_OAUTH_APP_SECRET = "test-secret";
  process.env.META_OAUTH_REDIRECT_URI = "https://api.digitalsukoon.com/v1/meta/oauth/callback";
  process.env.META_OAUTH_RETURN_ORIGIN = "https://portal.digitalsukoon.com";
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function seedAdmin(email = "zzmeta-admin@example.com") {
  const role = await prisma.role.create({
    data: { name: `zz-meta-role-${Math.abs(email.length)}-${email}`, description: "t" },
  });
  const user = await prisma.user.create({
    data: {
      name: "Meta Admin",
      email,
      passwordHash: "x",
      status: "ACTIVE",
      roles: { create: [{ roleId: role.id }] },
    },
  });
  return user;
}

describe("meta-config — the dark switch", () => {
  it("is NOT configured when env vars are absent, and names exactly what is missing", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(metaOauthConfigured()).toBe(false);
    const missing = metaOauthMissingEnv();
    expect(missing).toContain("META_OAUTH_APP_ID");
    expect(missing).toContain("META_OAUTH_APP_SECRET");
    expect(missing).toContain("META_OAUTH_REDIRECT_URI");
    expect(missing).toContain("META_OAUTH_RETURN_ORIGIN");
    // META_TOKEN_ENC_KEY is supplied by vitest.config.ts, so it must NOT be missing.
    expect(missing).not.toContain("META_TOKEN_ENC_KEY");
  });

  it("is configured once all vars are present", () => {
    configureMeta();
    expect(metaOauthMissingEnv()).toEqual([]);
    expect(metaOauthConfigured()).toBe(true);
  });

  it("treats the encryption key as required — no fallback", () => {
    configureMeta();
    const k = process.env.META_TOKEN_ENC_KEY;
    delete process.env.META_TOKEN_ENC_KEY;
    try {
      expect(metaOauthMissingEnv()).toContain("META_TOKEN_ENC_KEY");
      expect(metaOauthConfigured()).toBe(false);
    } finally {
      process.env.META_TOKEN_ENC_KEY = k;
    }
  });
});

describe("metaOauthReturnUrl — no open redirect", () => {
  it("builds a fixed /accounts/growth path on the configured origin", () => {
    configureMeta();
    expect(metaOauthReturnUrl("?meta=connected")).toBe(
      "https://portal.digitalsukoon.com/accounts/growth?meta=connected",
    );
  });

  it("throws on a malformed origin rather than emitting `undefined/...`", () => {
    process.env.META_OAUTH_RETURN_ORIGIN = "not-a-url";
    expect(() => metaOauthReturnUrl("?x=1")).toThrow();
  });

  it("rejects a non-http(s) origin", () => {
    process.env.META_OAUTH_RETURN_ORIGIN = "javascript:alert(1)";
    expect(() => metaOauthReturnUrl("")).toThrow();
  });
});

describe("startMetaOauth — authorize URL", () => {
  it("requests exactly the read-only scope set and NEVER a write scope", async () => {
    configureMeta();
    const user = await seedAdmin("zzmeta-scopes@example.com");
    const { authorizeUrl } = await startMetaOauth({ userId: user.id });

    const url = new URL(authorizeUrl);
    const scopes = (url.searchParams.get("scope") ?? "").split(",");

    for (const s of META_OAUTH_SCOPES) expect(scopes).toContain(s);

    // ⚠️ The app HAS these approved; we must never ask for them. Asking for write
    // access we never use is a consent-screen liability and a review risk.
    for (const forbidden of META_FORBIDDEN_SCOPES) {
      expect(authorizeUrl).not.toContain(forbidden);
    }
  });

  it("points at the configured redirect_uri and app id, server-side", async () => {
    configureMeta();
    const user = await seedAdmin("zzmeta-redirect@example.com");
    const { authorizeUrl } = await startMetaOauth({ userId: user.id });
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v21.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("298449321694397");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.digitalsukoon.com/v1/meta/oauth/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("sets auth_type=rerequest on reconnect (without it Meta re-returns the same partial grant)", async () => {
    configureMeta();
    const user = await seedAdmin("zzmeta-rereq@example.com");
    const a = await startMetaOauth({ userId: user.id });
    expect(new URL(a.authorizeUrl).searchParams.get("auth_type")).toBeNull();

    const b = await startMetaOauth({ userId: user.id, mode: "reconnect" });
    expect(new URL(b.authorizeUrl).searchParams.get("auth_type")).toBe("rerequest");
  });

  it("persists a state row bound to the initiating admin", async () => {
    configureMeta();
    const user = await seedAdmin("zzmeta-state@example.com");
    const { state } = await startMetaOauth({ userId: user.id });
    const row = await prisma.metaOAuthState.findUnique({ where: { state } });
    expect(row?.userId).toBe(user.id);
    expect(row?.usedAt).toBeNull();
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("generates unguessable, unique states", async () => {
    configureMeta();
    const user = await seedAdmin("zzmeta-uniq@example.com");
    const a = await startMetaOauth({ userId: user.id });
    const b = await startMetaOauth({ userId: user.id });
    expect(a.state).not.toBe(b.state);
    // 32 random bytes base64url ⇒ >= 43 chars.
    expect(a.state.length).toBeGreaterThanOrEqual(43);
  });
});

describe("consumeMetaOauthState — one-time, atomic", () => {
  it("returns the binding on first use", async () => {
    configureMeta();
    const user = await seedAdmin("zzmeta-consume@example.com");
    const { state } = await startMetaOauth({ userId: user.id });
    const consumed = await consumeMetaOauthState(state);
    expect(consumed?.userId).toBe(user.id);
    expect(consumed?.mode).toBe("connect");
  });

  it("REFUSES a replay of the same state", async () => {
    configureMeta();
    const user = await seedAdmin("zzmeta-replay@example.com");
    const { state } = await startMetaOauth({ userId: user.id });
    expect(await consumeMetaOauthState(state)).not.toBeNull();
    // A replayed callback must not produce a second connection.
    expect(await consumeMetaOauthState(state)).toBeNull();
  });

  it("only ONE of two concurrent consumes wins, and the loser does not throw", async () => {
    // ⚠️ The one-time-consume rule: updateMany({usedAt:null}) + count, never a bare
    // delete(). A bare delete() makes the loser throw P2025 and 500. This exact class
    // bit all three auth services (PR #101) and the admin invite flow (PR #108).
    configureMeta();
    const user = await seedAdmin("zzmeta-race@example.com");
    const { state } = await startMetaOauth({ userId: user.id });

    const results = await Promise.all([
      consumeMetaOauthState(state),
      consumeMetaOauthState(state),
      consumeMetaOauthState(state),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(2);
  });

  it("refuses an expired state", async () => {
    configureMeta();
    const user = await seedAdmin("zzmeta-expired@example.com");
    const { state } = await startMetaOauth({ userId: user.id });
    await prisma.metaOAuthState.update({
      where: { state },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await consumeMetaOauthState(state)).toBeNull();
  });

  it("refuses an unknown or empty state", async () => {
    expect(await consumeMetaOauthState("does-not-exist")).toBeNull();
    expect(await consumeMetaOauthState("")).toBeNull();
  });

  it("prunes only long-expired rows", async () => {
    configureMeta();
    const user = await seedAdmin("zzmeta-prune@example.com");
    const fresh = await startMetaOauth({ userId: user.id });
    const stale = await startMetaOauth({ userId: user.id });
    await prisma.metaOAuthState.update({
      where: { state: stale.state },
      data: { expiresAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });

    await pruneExpiredOauthStates();

    expect(await prisma.metaOAuthState.findUnique({ where: { state: fresh.state } })).not.toBeNull();
    expect(await prisma.metaOAuthState.findUnique({ where: { state: stale.state } })).toBeNull();
  });
});

describe("token metadata interpretation", () => {
  it("treats expires_at = 0 as NULL, never epoch 1970", () => {
    // 0 means "never expires". Storing new Date(0) would render as 1970 and make
    // every health check believe the grant is decades expired.
    expect(epochToDateOrNull(0)).toBeNull();
    expect(epochToDateOrNull(undefined)).toBeNull();
    expect(epochToDateOrNull(-5)).toBeNull();
  });

  it("converts a real epoch to a Date", () => {
    const d = epochToDateOrNull(1_800_000_000);
    expect(d).toBeInstanceOf(Date);
    expect(d!.getTime()).toBe(1_800_000_000_000);
  });

  it("flags missing required scopes (⇒ PARTIAL_SCOPE)", () => {
    expect(missingRequiredScopes([...META_OAUTH_SCOPES])).toEqual([]);
    const partial = missingRequiredScopes(["pages_show_list", "public_profile"]);
    expect(partial).toContain("pages_read_engagement");
    expect(partial).toContain("read_insights");
    expect(partial).toContain("instagram_basic");
  });
});
