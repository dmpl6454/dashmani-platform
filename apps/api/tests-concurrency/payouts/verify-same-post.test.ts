/**
 * RACE 4: two verifications of two DIFFERENT bookings that name the SAME post.
 *
 * Verifying a creator's link is what makes a post live AND what lets the creator's payout be released. One Instagram
 * post must never be verified for two bookings: two clients would each get a "live" post and two creators would each be
 * paid for it. The booking row lock does not help (the two verifies are on different bookings, so on different rows). What
 * stops it is, in order:
 *
 *   1. a transaction-scoped ADVISORY LOCK on the post's canonical key, taken inside verifyCreatorItem before the duplicate
 *      count, so the second verify waits for the first's commit, reads a fresh snapshot and is refused;
 *   2. the database's own PARTIAL UNIQUE INDEX creator_offers_verified_link_key_idx (scripts/creator-payouts-ddl.sql: a
 *      unique key on link_canonical_key WHERE link_verified_at IS NOT NULL) behind it: a second stamp is refused by Postgres
 *      (P2002) and surfaces as the same 409, never a 500.
 *
 * Under READ COMMITTED, without either, both transactions count 0 verified rows (the other has not committed) and both
 * stamp: that is the bug these tests exist to catch.
 *
 * ⚠️ THE INDEX IS NOT BUILT BY `db push` (Prisma cannot express a partial index). The two describes below therefore set the
 * database up explicitly, and say which layer each one proves:
 *   • "lock AND index" = production. Both layers present. Removing the advisory lock alone leaves this describe GREEN (the
 *     index catches the second stamp): the lock is not the only line of defence, which is the point of having two.
 *   • "lock alone" = the index dropped for this describe. The advisory lock is then the only thing standing: removing it
 *     makes THIS describe red. So the pair of describes shows each layer independently, and removing BOTH is red in both.
 *
 * What is asserted: of each pair exactly one verify succeeds, the other fails with 409 LINK_ALREADY_USED (not a 500, not a
 * timeout); exactly one offer carries link_verified_at for the key; the loser's transaction rolled back whole (its item still
 * waits in manual_pending, its offer is still accepted); and the winner's item is the one that went live.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@dashmani/db";

vi.mock("../../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import { verifyCreatorItem } from "../../src/services/creator/creator-offer.service";
import { openOffer } from "../../tests/payout-fixtures";
import { FakeRazorpay, SEED, expectLegalHistories, heldWorld, itemStatus, payoutIdsOf, rngFor, together, useMoneyHarness, type World } from "./cc-helpers";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const fake = new FakeRazorpay();
const INDEX = "creator_offers_verified_link_key_idx";
const DDL = fs.readFileSync(path.join(__dirname, "../../../../scripts/creator-payouts-ddl.sql"), "utf8");
const CREATE_INDEX = /CREATE UNIQUE INDEX IF NOT EXISTS "creator_offers_verified_link_key_idx"[^;]+;/.exec(DDL)?.[0];

const indexPresent = async () => (await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = '${INDEX}'`))[0].n === 1;
const setIndex = async (on: boolean) => {
  if (on) await prisma.$executeRawUnsafe(CREATE_INDEX!);
  else await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${INDEX}"`);
};

/** A creator item whose offer is accepted, its link submitted and auto-checked as the creator's own post: ready for staff to verify. */
async function readyToVerify(w: World, code: string): Promise<{ bookingId: string; itemId: string; offerId: string }> {
  const item = w.creators[0];
  const offer = await openOffer(w, item.id, { status: "accepted", linkSubmitted: true });
  await prisma.creatorOffer.update({ where: { id: offer.id }, data: { linkUrl: `https://www.instagram.com/p/${code}/`, linkCanonicalKey: `ig:${code}`, ownershipCheck: "auto_ok" } });
  return { bookingId: w.booking.id, itemId: item.id, offerId: offer.id };
}

interface Pair {
  key: string;
  a: { bookingId: string; itemId: string; offerId: string; world: World };
  b: { bookingId: string; itemId: string; offerId: string; world: World };
}

async function makePairs(n: number, tag: string): Promise<Pair[]> {
  const pairs: Pair[] = [];
  for (let i = 0; i < n; i++) {
    const code = `${tag}${String(i).padStart(3, "0")}`;
    const wa = await heldWorld(fake, { pages: [{}] });
    const wb = await heldWorld(fake, { pages: [{}] });
    pairs.push({ key: `ig:${code}`, a: { ...(await readyToVerify(wa, code)), world: wa }, b: { ...(await readyToVerify(wb, code)), world: wb } });
  }
  return pairs;
}

/** Start both verifies of every pair on one barrier (with a few ms of seeded jitter) and check what each pair ended as. */
async function raceAll(pairs: Pair[], staffId: string, why: string): Promise<void> {
  const rng = rngFor(`verify-same-post-${why}`);
  const out = await together(
    pairs.flatMap((p) => [
      { run: () => verifyCreatorItem(p.a.bookingId, p.a.itemId, { staffId }), delayMs: Math.floor(rng() * 4) },
      { run: () => verifyCreatorItem(p.b.bookingId, p.b.itemId, { staffId }), delayMs: Math.floor(rng() * 4) },
    ]),
  );
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const [ra, rb] = [out[2 * i], out[2 * i + 1]];
    const where = `${why}: pair ${p.key} a=${ra.ok ? "verified" : (ra.error as { code?: string })?.code} b=${rb.ok ? "verified" : (rb.error as { code?: string })?.code} seed=${SEED}`;
    const winners = [ra, rb].filter((r) => r.ok);
    expect(winners, `${where}: the same post was verified for ${winners.length} bookings`).toHaveLength(1);
    const loser = ra.ok ? rb : ra;
    expect(loser.error, where).toBeInstanceOf(Error);
    expect({ status: (loser.error as { statusCode?: number }).statusCode, code: (loser.error as { code?: string }).code }, `${where}: the loser must get a clean refusal, not a 500`).toEqual({ status: 409, code: "LINK_ALREADY_USED" });

    const verified = await prisma.creatorOffer.findMany({ where: { linkCanonicalKey: p.key, linkVerifiedAt: { not: null } }, select: { id: true, status: true } });
    expect(verified, where).toHaveLength(1);
    const won = ra.ok ? p.a : p.b;
    const lost = ra.ok ? p.b : p.a;
    expect(verified[0].id, where).toBe(won.offerId);
    expect(await itemStatus(won.itemId), where).toBe("posted_manual");
    // The loser rolled back WHOLE: its post still waits for a link nobody has verified.
    expect(await itemStatus(lost.itemId), where).toBe("manual_pending");
    expect(await prisma.creatorOffer.findUniqueOrThrow({ where: { id: lost.offerId }, select: { status: true, linkVerifiedAt: true } }), where).toMatchObject({ status: "accepted", linkVerifiedAt: null });
  }
}

describe("race 4: two bookings, one post", () => {
  const h = useMoneyHarness(fake);

  describe("lock AND index (production)", () => {
    beforeAll(async () => {
      expect(CREATE_INDEX, "the partial unique index must be in the DDL script").toBeDefined();
      await setIndex(true);
    });
    afterAll(async () => setIndex(false));

    it("6 pairs verified at the same moment: exactly one verification per post, the other a clean 409", async () => {
      expect(await indexPresent()).toBe(true);
      const pairs = await makePairs(6, "BOTH");
      await raceAll(pairs, h.staff().staffId, "lock+index");
      await expectLegalHistories(await Promise.all(pairs.flatMap((p) => [payoutIdsOf(p.a.world), payoutIdsOf(p.b.world)])).then((x) => x.flat()), "lock+index");
    });
  });

  describe("lock alone (the index is dropped for this describe)", () => {
    beforeAll(async () => setIndex(false));

    it("6 pairs verified at the same moment, with NO unique index behind it: the advisory lock alone gives exactly one verification per post", async () => {
      expect(await indexPresent(), "this describe is about the lock alone: the index must be absent").toBe(false);
      const pairs = await makePairs(6, "LOCK");
      await raceAll(pairs, h.staff().staffId, "lock-only");
    });
  });
});
