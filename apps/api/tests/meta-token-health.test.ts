/**
 * Token health watches BOTH Meta clocks: the login token's own expiry (~60 days — Instagram
 * reads and publishing use it) and data access (~90 days). Whichever runs out first decides.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "@dashmani/db";
import "./setup";
import { runMetaTokenHealth } from "../src/cron/meta-token-health.cron";

const KEYS = ["META_OAUTH_APP_ID", "META_OAUTH_APP_SECRET", "META_OAUTH_REDIRECT_URI", "META_OAUTH_RETURN_ORIGIN"] as const;
const saved: Record<string, string | undefined> = {};
const DAY = 86_400_000;

describe("meta token health", () => {
  let staffId: string;
  beforeEach(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.META_OAUTH_APP_ID = "298449321694397";
    process.env.META_OAUTH_APP_SECRET = "test-secret";
    process.env.META_OAUTH_REDIRECT_URI = "https://api.digitalsukoon.com/v1/meta/oauth/callback";
    process.env.META_OAUTH_RETURN_ORIGIN = "https://portal.digitalsukoon.com";
    staffId = (await prisma.user.create({ data: { name: "S", email: "health@ds.test", passwordHash: "x", status: "ACTIVE" } })).id;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // No stored user token → no debug_token call: the check is DB-only.
  const conn = (metaUserId: string, data: { tokenExpiresAt?: Date | null; dataAccessExpiresAt?: Date | null }) =>
    prisma.metaConnection.create({ data: { metaUserId, connectedById: staffId, status: "ACTIVE", ...data } });

  it("warns on the login token when it runs out before data access", async () => {
    const c = await conn("mu-h1", { tokenExpiresAt: new Date(Date.now() + 5 * DAY - 3_600_000), dataAccessExpiresAt: new Date(Date.now() + 60 * DAY) });
    const out = await runMetaTokenHealth();
    expect(out.warned).toBe(1);
    const row = await prisma.metaConnection.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.status).toBe("NEEDS_REAUTH_SOON");
    expect(row.lastError).toMatch(/login token expires in 5 day/);
  });

  it("an expired login token needs reconnecting even while data access is fine", async () => {
    const c = await conn("mu-h2", { tokenExpiresAt: new Date(Date.now() - DAY), dataAccessExpiresAt: new Date(Date.now() + 60 * DAY) });
    await runMetaTokenHealth();
    const row = await prisma.metaConnection.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.status).toBe("NEEDS_REAUTH");
    expect(row.lastError).toMatch(/login token has expired/);
  });

  it("still watches data access when the login token never expires", async () => {
    const c = await conn("mu-h3", { tokenExpiresAt: null, dataAccessExpiresAt: new Date(Date.now() + 3 * DAY - 3_600_000) });
    await runMetaTokenHealth();
    const row = await prisma.metaConnection.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.status).toBe("NEEDS_REAUTH_SOON");
    expect(row.lastError).toMatch(/data access expires in 3 day/);
  });

  it("a login token with hours left is 'expires in 1 day', never expired early", async () => {
    const c = await conn("mu-h5", { tokenExpiresAt: new Date(Date.now() + 20 * 3_600_000), dataAccessExpiresAt: new Date(Date.now() + 60 * DAY) });
    await runMetaTokenHealth();
    const row = await prisma.metaConnection.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.status).toBe("NEEDS_REAUTH_SOON");
    expect(row.lastError).toMatch(/expires in 1 day/);
  });

  it("leaves a healthy connection alone", async () => {
    const c = await conn("mu-h4", { tokenExpiresAt: new Date(Date.now() + 50 * DAY), dataAccessExpiresAt: new Date(Date.now() + 80 * DAY) });
    const out = await runMetaTokenHealth();
    expect(out.warned).toBe(0);
    expect((await prisma.metaConnection.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("ACTIVE");
  });
});
