/**
 * Multi-connection safety — what happens when a SECOND admin connects Meta.
 *
 * Connecting another admin is additive, not a replacement: MetaConnection is unique
 * on metaUserId, so the same person reconnecting updates their row while a different
 * person creates a second live connection. That is deliberate — a Facebook user token
 * expires (~90 days) and dies on a password change, so one grant makes a single
 * person's password a single point of failure for the whole Account Growth page.
 *
 * The cost of that redundancy is that a Page BOTH admins administer exists once per
 * connection, because MetaAsset is unique on (connectionId, kind, metaId). Left alone
 * it would be double-counted in every total AND polled twice out of one call budget —
 * and the budget truncates silently, so the duplicate does not cost itself, it costs
 * OTHER channels their data.
 *
 * These tests exist because that whole failure mode is invisible: nothing errors, the
 * page just quietly reports inflated numbers and starves real channels. They fail if
 * anyone removes the guard.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import {
  resolveDuplicateAssetIds,
  resolveContestedOwners,
} from "../src/services/meta-oauth/meta-channels.service";
import "./setup";

async function makeUser(email: string) {
  return prisma.user.create({
    data: { name: "T", email, passwordHash: "x", status: "ACTIVE" },
  });
}

async function makeConnection(metaUserId: string, connectedById: string, createdAt: Date) {
  return prisma.metaConnection.create({
    data: { metaUserId, connectedById, status: "ACTIVE", createdAt },
  });
}

async function makeAsset(connectionId: string, metaId: string, followerCount: number, name = "Shared Page") {
  return prisma.metaAsset.create({
    data: { connectionId, kind: "FACEBOOK_PAGE", metaId, name, followerCount },
  });
}

describe("multi-connection safety", () => {
  let connA: { id: string };
  let connB: { id: string };

  beforeEach(async () => {
    const a = await makeUser("admin-a@zz.test");
    const b = await makeUser("admin-b@zz.test");
    connA = await makeConnection("meta-user-a", a.id, new Date("2026-01-01T00:00:00Z"));
    connB = await makeConnection("meta-user-b", b.id, new Date("2026-06-01T00:00:00Z"));
  });

  it("suppresses nothing when each Page is reachable through only one connection", async () => {
    await makeAsset(connA.id, "page-1", 100);
    await makeAsset(connB.id, "page-2", 200);
    expect((await resolveDuplicateAssetIds()).size).toBe(0);
  });

  it("suppresses the duplicate when two connections reach the SAME Page", async () => {
    const bigger = await makeAsset(connA.id, "page-shared", 5_000_000);
    const smaller = await makeAsset(connB.id, "page-shared", 131_000);

    const suppressed = await resolveDuplicateAssetIds();

    expect(suppressed.size).toBe(1);
    // The Page with the real audience survives; the lesser copy is hidden.
    expect(suppressed.has(smaller.id)).toBe(true);
    expect(suppressed.has(bigger.id)).toBe(false);
  });

  it("picks the same winner every time — the choice must never flip between runs", async () => {
    await makeAsset(connA.id, "page-shared", 5_000_000);
    await makeAsset(connB.id, "page-shared", 131_000);

    const runs = await Promise.all([
      resolveDuplicateAssetIds(), resolveDuplicateAssetIds(), resolveDuplicateAssetIds(),
    ]);
    const serialised = runs.map((r) => [...r].sort().join(","));
    expect(new Set(serialised).size).toBe(1);
  });

  it("breaks a follower-count tie by the EARLIEST connection, so a newcomer cannot displace the incumbent", async () => {
    const incumbent = await makeAsset(connA.id, "page-shared", 1000); // connA created Jan
    const newcomer = await makeAsset(connB.id, "page-shared", 1000);  // connB created Jun

    const suppressed = await resolveDuplicateAssetIds();
    expect(suppressed.has(newcomer.id)).toBe(true);
    expect(suppressed.has(incumbent.id)).toBe(false);
  });

  it("ignores a disconnected asset, so revoking one connection hands the Page to the other", async () => {
    const kept = await makeAsset(connA.id, "page-shared", 500);
    const gone = await makeAsset(connB.id, "page-shared", 9_000_000);
    // The bigger one would normally win — but it is disconnected, so it is out of scope.
    await prisma.metaAsset.update({ where: { id: gone.id }, data: { disconnectedAt: new Date() } });

    const suppressed = await resolveDuplicateAssetIds();
    expect(suppressed.size).toBe(0);
    expect(suppressed.has(kept.id)).toBe(false);
  });

  it("does not confuse an Instagram account with a Facebook Page that shares its id", async () => {
    await makeAsset(connA.id, "same-id", 100);
    await prisma.metaAsset.create({
      data: { connectionId: connA.id, kind: "INSTAGRAM_ACCOUNT", metaId: "same-id", name: "IG", followerCount: 100 },
    });
    // Different kinds are different objects even under one id.
    expect((await resolveDuplicateAssetIds()).size).toBe(0);
  });

  it("gives a channel row claimed by two assets exactly one owner, so the follower write-back cannot flip", async () => {
    const platform = await prisma.platform.create({ data: { name: "Facebook", slug: "facebook" } });
    const account = await prisma.socialAccount.create({
      data: { handle: "@shared", displayName: "Shared", platformId: platform.id, status: "ACTIVE", followerCount: 0 },
    });
    const big = await prisma.metaAsset.create({
      data: { connectionId: connA.id, kind: "FACEBOOK_PAGE", metaId: "p-big", name: "Big",
              followerCount: 5_000_000, socialAccountId: account.id },
    });
    await prisma.metaAsset.create({
      data: { connectionId: connA.id, kind: "FACEBOOK_PAGE", metaId: "p-small", name: "Small",
              followerCount: 131_000, socialAccountId: account.id },
    });

    const owners = await resolveContestedOwners();
    expect(owners.get(account.id)).toBe(big.id);
  });

  it("leaves an uncontested channel row out of the owners map entirely", async () => {
    const platform = await prisma.platform.create({ data: { name: "Facebook", slug: "facebook" } });
    const account = await prisma.socialAccount.create({
      data: { handle: "@solo", displayName: "Solo", platformId: platform.id, status: "ACTIVE", followerCount: 0 },
    });
    await prisma.metaAsset.create({
      data: { connectionId: connA.id, kind: "FACEBOOK_PAGE", metaId: "p-solo", name: "Solo",
              followerCount: 10, socialAccountId: account.id },
    });
    expect((await resolveContestedOwners()).has(account.id)).toBe(false);
  });
});
