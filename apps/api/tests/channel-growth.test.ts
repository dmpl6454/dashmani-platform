import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import { prisma } from "@dashmani/db";
import { getChannelBoard, invalidateChannelGrowthCache } from "../src/services/channel-growth.service";
import "./setup";

/** Date-only N days ago, matching how @db.Date rows are stored. */
function dayAgo(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - days * 86_400_000);
}

async function platform(slug: string) {
  return prisma.platform.upsert({
    where: { slug },
    create: { slug, name: slug },
    update: {},
    select: { id: true },
  });
}

async function channel(
  slug: string,
  handle: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const p = await platform(slug);
  const a = await prisma.socialAccount.create({
    data: { handle, displayName: handle, platformId: p.id, ...over },
  });
  return a.id;
}

async function snapshot(accountId: string, days: number, followerCount: number, totalViews?: number) {
  await prisma.accountGrowthSnapshot.create({
    data: {
      accountId,
      date: dayAgo(days),
      followerCount,
      source: "api",
      ...(totalViews != null ? { totalViews: BigInt(totalViews) } : {}),
    },
  });
}

beforeEach(() => {
  // ⚠️ MANDATORY. A module-level memo is the documented cross-test pollution class in this
  // repo — a cached board from a previous test's fixtures would silently satisfy the next.
  invalidateChannelGrowthCache();
});

describe("channel board — an absent metric is NEVER a zero", () => {
  it("reports followers as null, not 0, for a channel whose count was never measured", async () => {
    // This is the real state of the 7 Snapchat profiles that withhold their count:
    // followerCount stays at its non-nullable 0 default because persistFollowerCount
    // refuses to write anything <= 0.
    await channel("snapchat", "withholder", { followerCount: 0, syncSource: null });
    const board = await getChannelBoard("snapchat", 30);
    const row = board.rows.find((r) => r.handle === "withholder")!;
    expect(row.followers).toBeNull();
    expect(board.totals.followersWithheld).toBe(1);
  });

  it("reports a totals figure of null, not 0, when no channel published a count", async () => {
    await channel("snapchat", "a", { followerCount: 0 });
    await channel("snapchat", "b", { followerCount: 0 });
    const board = await getChannelBoard("snapchat", 30);
    expect(board.totals.followers).toBeNull();
    expect(board.totals.totalViews).toBeNull();
    expect(board.totals.followersReported).toBe(0);
  });

  it("sums only the channels that actually published a count, and says how many that is", async () => {
    await channel("snapchat", "pub1", { followerCount: 100 });
    await channel("snapchat", "pub2", { followerCount: 250 });
    await channel("snapchat", "withheld", { followerCount: 0 });
    const board = await getChannelBoard("snapchat", 30);
    expect(board.totals.followers).toBe(350);
    expect(board.totals.followersReported).toBe(2);
    expect(board.totals.followersWithheld).toBe(1);
  });
});

describe("channel board — the YouTube quantisation guard", () => {
  it("SUPPRESSES a subscriber delta smaller than YouTube's rounding step", async () => {
    // 10,500,000 is rounded to 3 significant figures, so the step is 100,000. A stored
    // movement of 50,000 is below one step: it cannot be distinguished from noise, and
    // rendering 0 would assert "did not grow", which we do not know.
    const id = await channel("youtube", "bigchannel", { followerCount: 10_550_000, followersPrecision: 100_000 });
    await snapshot(id, 20, 10_500_000);
    await snapshot(id, 1, 10_550_000);
    const board = await getChannelBoard("youtube", 30);
    const row = board.rows.find((r) => r.handle === "bigchannel")!;
    expect(row.followerDelta).toBeNull(); // NOT 50000, and NOT 0
    expect(board.totals.withHistory).toBe(0);
  });

  it("REPORTS a subscriber delta at or above the rounding step", async () => {
    const id = await channel("youtube", "mover", { followerCount: 10_600_000, followersPrecision: 100_000 });
    await snapshot(id, 20, 10_500_000);
    await snapshot(id, 1, 10_600_000);
    const board = await getChannelBoard("youtube", 30);
    const row = board.rows.find((r) => r.handle === "mover")!;
    expect(row.followerDelta).toBe(100_000);
    expect(board.totals.withHistory).toBe(1);
  });

  it("does NOT suppress anything when the count is exact (precision null)", async () => {
    const id = await channel("youtube", "small", { followerCount: 130, followersPrecision: null });
    await snapshot(id, 5, 100);
    await snapshot(id, 1, 130);
    const board = await getChannelBoard("youtube", 30);
    expect(board.rows.find((r) => r.handle === "small")!.followerDelta).toBe(30);
  });

  it("reports the EXACT lifetime-view delta even when the subscriber delta is suppressed", async () => {
    // The whole point of storing totalViews: it is the truthful growth column for YouTube.
    const id = await channel("youtube", "viewsmover", { followerCount: 10_500_000, followersPrecision: 100_000 });
    await snapshot(id, 20, 10_500_000, 1_000_000);
    await snapshot(id, 1, 10_500_000, 1_250_000);
    const board = await getChannelBoard("youtube", 30);
    const row = board.rows.find((r) => r.handle === "viewsmover")!;
    expect(row.followerDelta).toBeNull();
    expect(row.viewsDelta).toBe(250_000);
  });
});

describe("channel board — a delta needs two distinct days", () => {
  it("returns null rather than 0 when only one day of history exists", async () => {
    const id = await channel("youtube", "fresh", { followerCount: 500 });
    await snapshot(id, 1, 500);
    const board = await getChannelBoard("youtube", 30);
    const row = board.rows.find((r) => r.handle === "fresh")!;
    expect(row.followerDelta).toBeNull(); // a same-day comparison is 0 by construction
    expect(row.followerDeltaDays).toBeNull();
  });

  it("exposes the span the delta actually covers, which is often shorter than the window", async () => {
    const id = await channel("youtube", "partial", { followerCount: 900 });
    await snapshot(id, 5, 800); // history only reaches back 5 days …
    await snapshot(id, 1, 900);
    const board = await getChannelBoard("youtube", 90); // … though a 90-day window was asked for
    const row = board.rows.find((r) => r.handle === "partial")!;
    expect(row.followerDelta).toBe(100);
    expect(row.followerDeltaDays).toBe(4);
  });
});

describe("channel board — scope", () => {
  it("excludes ARCHIVED channels (the soft-removal state) but keeps their history", async () => {
    const id = await channel("youtube", "removed", { followerCount: 100, status: "ARCHIVED" });
    await snapshot(id, 2, 90);
    await channel("youtube", "kept", { followerCount: 200 });
    const board = await getChannelBoard("youtube", 30);
    expect(board.rows.map((r) => r.handle)).toEqual(["kept"]);
    // history survives, so restoring does not come back blank
    expect(await prisma.accountGrowthSnapshot.count({ where: { accountId: id } })).toBe(1);
  });

  it("keeps the two platforms' boards separate", async () => {
    await channel("youtube", "yt1", { followerCount: 10 });
    await channel("snapchat", "sc1", { followerCount: 20 });
    expect((await getChannelBoard("youtube", 30)).rows.map((r) => r.handle)).toEqual(["yt1"]);
    invalidateChannelGrowthCache();
    expect((await getChannelBoard("snapchat", 30)).rows.map((r) => r.handle)).toEqual(["sc1"]);
  });
});

describe("GET /admin/channels — gate and validation", () => {
  async function adminToken() {
    await createTestRole("Admin", [
      { resource: "reports", action: "manage", scope: "global" },
      { resource: "reports", action: "view", scope: "global" },
    ]);
    const u = await createTestUser({ roleNames: ["Admin"], email: "chan-admin@zz.test" });
    return generateToken(u.id, u.email, ["Admin"]);
  }

  it("401s without a token", async () => {
    await request(app).get("/v1/admin/channels?platform=youtube").expect(401);
  });

  it("403s for a plain employee — this board must not be easier to reach than the Meta one", async () => {
    await createTestRole("Employee", [{ resource: "reports", action: "view", scope: "own" }]);
    const u = await createTestUser({ roleNames: ["Employee"], email: "chan-emp@zz.test" });
    const token = generateToken(u.id, u.email, ["Employee"]);
    await request(app).get("/v1/admin/channels?platform=youtube").set("Authorization", `Bearer ${token}`).expect(403);
  });

  it("400s on an unknown platform rather than guessing", async () => {
    const token = await adminToken();
    const res = await request(app)
      .get("/v1/admin/channels?platform=tiktok")
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
    expect(res.body.error.code).toBe("BAD_PLATFORM");
  });

  it("falls back to the default period on a junk days value instead of erroring", async () => {
    const token = await adminToken();
    const res = await request(app)
      .get("/v1/admin/channels?platform=youtube&days=notanumber")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.data.days).toBe(30);
  });
});

// ── Regressions found by adversarial review of the first cut ──────────────────

describe("the quantisation guard must not FAIL OPEN", () => {
  it("suppresses a flat rounded YouTube delta even when followersPrecision is NULL", async () => {
    // ⚠️ THE BUG THIS LOCKS. `step = followersPrecision ?? 0` made `Math.abs(raw) < 0`
    // impossible to satisfy, so a channel sitting on flat rounded snapshots rendered a
    // confident "0". followersPrecision is NULL on EVERY existing row until a sync writes
    // it — i.e. the state of the whole estate the moment this ships — and permanently for
    // any channel whose resolution keeps failing (no API key, quota out, terminated).
    const id = await channel("youtube", "nullprec", { followerCount: 10_500_000, followersPrecision: null });
    await snapshot(id, 30, 10_500_000);
    await snapshot(id, 1, 10_500_000);
    const board = await getChannelBoard("youtube", 30);
    const row = board.rows.find((r) => r.handle === "nullprec")!;
    expect(row.followerDelta).toBeNull(); // NOT 0 — the channel may well have grown
  });

  it("still reports a real YouTube move that clears the derived step", async () => {
    const id = await channel("youtube", "realmove", { followerCount: 10_600_000, followersPrecision: null });
    await snapshot(id, 30, 10_500_000);
    await snapshot(id, 1, 10_600_000);
    const board = await getChannelBoard("youtube", 30);
    expect(board.rows.find((r) => r.handle === "realmove")!.followerDelta).toBe(100_000);
  });

  it("does NOT apply YouTube's 3-significant-figure rule to Snapchat", async () => {
    // ⚠️ The name of this test used to claim Snapchat counts are "exact, not rounded".
    // That was wrong and is now measured: Snapchat publishes on a FLAT x100 grid (all 30
    // live counts and all 341 stored snapshots are multiples of 100; the smallest non-zero
    // move ever recorded is exactly 100). What must NOT happen is applying YouTube's
    // significant-figures rule, which would derive a 1,000 step here and swallow a real
    // one-step move on a 152,500 account. The assertion is unchanged; only the reasoning is.
    const id = await channel("snapchat", "scexact", { followerCount: 152_500, followersPrecision: null });
    await snapshot(id, 10, 152_400);
    await snapshot(id, 1, 152_500);
    const board = await getChannelBoard("snapchat", 30);
    expect(board.rows.find((r) => r.handle === "scexact")!.followerDelta).toBe(100);
  });

  it("suppresses a FLAT Snapchat reading rather than reporting a confident 0", async () => {
    // Below Snapchat's own 100 grid the only representable difference is 0, and rendering
    // that as "0" asserts "did not grow" — which the grid cannot tell us.
    const id = await channel("snapchat", "scflat", { followerCount: 39_300, followersPrecision: null });
    await snapshot(id, 10, 39_300);
    await snapshot(id, 1, 39_300);
    const board = await getChannelBoard("snapchat", 30);
    expect(board.rows.find((r) => r.handle === "scflat")!.followerDelta).toBeNull();
  });
});

describe("a channel with an exact views delta HAS history", () => {
  it("counts a views-only delta, so the board does not blame collection lag for rounding", async () => {
    // Counting only follower deltas made the YouTube board print "no channel has N days of
    // history yet, we are still collecting" while every Views change cell held a real
    // number — contradicting the note directly beneath it.
    const id = await channel("youtube", "viewsonly", { followerCount: 10_500_000, followersPrecision: 100_000 });
    await snapshot(id, 20, 10_500_000, 1_000_000);
    await snapshot(id, 1, 10_500_000, 1_400_000);
    const board = await getChannelBoard("youtube", 30);
    const row = board.rows.find((r) => r.handle === "viewsonly")!;
    expect(row.followerDelta).toBeNull();
    expect(row.viewsDelta).toBe(400_000);
    expect(board.totals.withHistory).toBe(1);
  });
});

describe("historyFrom is the true start of collection, not the window edge", () => {
  it("names a date older than the selected period", async () => {
    const id = await channel("youtube", "oldhistory", { followerCount: 1000 });
    await snapshot(id, 60, 900);
    await snapshot(id, 1, 1000);
    const board = await getChannelBoard("youtube", 7); // a 7-day window …
    const sixtyDaysAgo = dayAgo(60).toISOString().slice(0, 10);
    // … must still report that we have been collecting since day 60.
    expect(board.historyFrom).toBe(sixtyDaysAgo);
  });
});

describe("removal actually removes, and never reports a fabricated zero", () => {
  it("sends null, not 0, for a removed channel whose count was never measured", async () => {
    await createTestRole("Admin", [
      { resource: "reports", action: "manage", scope: "global" },
      { resource: "reports", action: "view", scope: "global" },
    ]);
    const u = await createTestUser({ roleNames: ["Admin"], email: "rm-admin@zz.test" });
    const token = generateToken(u.id, u.email, ["Admin"]);
    await channel("snapchat", "withheld-removed", { followerCount: 0, status: "ARCHIVED" });
    const res = await request(app)
      .get("/v1/admin/channels/removed?platform=snapchat")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const row = res.body.data.rows.find((r: { handle: string }) => r.handle === "withheld-removed");
    expect(row.followerCount).toBeNull(); // NOT 0 — "0 followers" would be a claim
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// The Views-change column, and the totals' period movement.
// ─────────────────────────────────────────────────────────────────────────────────────

describe("the views delta measures over snapshots that actually CARRY a view count", () => {
  it("does not let a pre-column snapshot become the baseline and kill the delta", async () => {
    // ⚠️ RED-GREEN. `total_views` shipped later than the snapshot table, so every row
    // written before it holds NULL. Picking the window's first snapshot regardless meant
    // the baseline was almost always one of those, and the delta was discarded: measured
    // on prod the day after launch, 20 of 22 channels' earliest 7-day snapshot had no view
    // count, so the column was a dash at EVERY period and would have stayed one until the
    // window stopped reaching past the cutover — 21 Dec at 90d. With the old selection
    // this expectation is null.
    const id = await channel("youtube", "ytmixed", { followerCount: 5000 });
    await snapshot(id, 40, 4900);                    // pre-column: no total_views
    await snapshot(id, 3, 5000, 1_000_000);          // first snapshot carrying one
    await snapshot(id, 1, 5000, 1_250_000);
    const board = await getChannelBoard("youtube", 90);
    const row = board.rows.find((r) => r.handle === "ytmixed")!;
    expect(row.viewsDelta).toBe(250_000);
    // …and labelled with the VIEW counter's own span (2 days), never the follower span (39).
    expect(row.viewsDeltaDays).toBe(2);
  });

  it("still reports nothing when only one snapshot carries a view count", async () => {
    const id = await channel("youtube", "ytonepoint", { followerCount: 5000 });
    await snapshot(id, 40, 4900);
    await snapshot(id, 1, 5000, 1_000_000);
    const board = await getChannelBoard("youtube", 90);
    expect(board.rows.find((r) => r.handle === "ytonepoint")!.viewsDelta).toBeNull();
  });
});

describe("totals movement — the sum must not inherit a corrupted series", () => {
  it("EXCLUDES a channel whose change exceeds its own baseline, and discloses the count", async () => {
    // ⚠️ RED-GREEN for the artifact guard. A row with no channel id pinned falls through to
    // search.list — a fuzzy NAME search whose items[0] is not stable — so its series jumps
    // between differently-sized channels sharing a name. Measured on prod, `Total filmi `
    // alternated 1,040,000 / 356,000 / 46,300 / 10,900 and contributed +684,000 of a
    // +685,500 seven-day total: 99.8% of the headline from one corrupted row. It passes the
    // full-span filter, so that filter is necessary but NOT sufficient.
    const good = await channel("youtube", "ytsteady", { followerCount: 500_000, followersPrecision: 1000 });
    await snapshot(good, 30, 490_000);
    await snapshot(good, 1, 500_000);
    const jumpy = await channel("youtube", "ytjumpy", { followerCount: 1_040_000, followersPrecision: 10_000 });
    await snapshot(jumpy, 30, 46_300);   // a different channel of the same name
    await snapshot(jumpy, 1, 1_040_000);
    const board = await getChannelBoard("youtube", 30);

    // The corrupted row still shows its OWN change — hiding it would hide the evidence.
    expect(board.rows.find((r) => r.handle === "ytjumpy")!.followerDelta).toBe(993_700);
    // …but it is kept out of the total, and the exclusion is disclosed.
    expect(board.totals.followerDelta).toBe(10_000);
    expect(board.totals.followerDeltaChannels).toBe(1);
    expect(board.totals.followerDeltaExcluded).toBe(1);
  });

  it("reports the uncertainty envelope so the tile can refuse to state an unresolvable figure", async () => {
    // Each rounded reading is within ±step/2, so a difference of two carries up to ±step.
    // Summed over the full-span channels this is the error bar on the total.
    const a = await channel("youtube", "ytbig", { followerCount: 10_500_000, followersPrecision: 100_000 });
    await snapshot(a, 30, 10_500_000);
    await snapshot(a, 1, 10_500_000);
    const b = await channel("youtube", "ytsmall", { followerCount: 72_600, followersPrecision: 100 });
    await snapshot(b, 30, 72_500);
    await snapshot(b, 1, 72_600);
    const board = await getChannelBoard("youtube", 30);
    // Both channels span the window, so both contribute their step to the envelope …
    expect(board.totals.followerDeltaUncertainty).toBe(100_100);
    // … even though only the small one produced a visible change.
    expect(board.totals.followerDelta).toBe(100);
    expect(board.totals.followerDeltaSuppressed).toBe(1);
  });

  it("sums the EXACT lifetime-view change, which needs no suppression", async () => {
    const a = await channel("youtube", "ytv1", { followerCount: 1000 });
    await snapshot(a, 30, 1000, 1_000_000);
    await snapshot(a, 1, 1000, 1_400_000);
    const b = await channel("youtube", "ytv2", { followerCount: 2000 });
    await snapshot(b, 30, 2000, 5_000_000);
    await snapshot(b, 1, 2000, 5_100_000);
    const board = await getChannelBoard("youtube", 30);
    expect(board.totals.viewsDelta).toBe(500_000);
    expect(board.totals.viewsDeltaChannels).toBe(2);
  });

  it("returns null, not 0, when no channel's history spans the window", async () => {
    // ⚠️ "No channel qualified" is not "the estate did not move".
    const id = await channel("youtube", "ytshort", { followerCount: 1000 });
    await snapshot(id, 2, 900, 10);
    await snapshot(id, 1, 1000, 20);
    const board = await getChannelBoard("youtube", 90); // 2-day span vs an 81-day requirement
    expect(board.totals.followerDelta).toBeNull();
    expect(board.totals.viewsDelta).toBeNull();
    expect(board.totals.followerDeltaChannels).toBe(0);
  });
});
