/**
 * Top Posts — the submitted-links leaderboard behind the /overview card.
 *
 * The contract under test is that a ranking never lies: a post is ranked on a metric
 * the platform actually publishes, several employees submitting the same link is ONE
 * row, and a preview image is only ever served while it still works.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import {
  getTopPosts,
  invalidateTopPostsCache,
  matchIdFromUrl,
  thumbnailIfFresh,
  TOP_POST_PERIODS,
} from "../src/services/top-posts.service";
import "./setup";

const NOW = Date.UTC(2026, 8, 19, 12, 0, 0); // 2026-09-19T12:00:00Z
const hexOe = (ms: number) => Math.floor(ms / 1000).toString(16);
const cdn = (expiresMs: number) =>
  `https://scontent.cdninstagram.com/v/t51.29350-15/abc.jpg?_nc_ohc=xyz&oe=${hexOe(expiresMs)}`;

beforeEach(() => {
  // ⚠️ Module-level memo = the documented cross-test pollution class.
  invalidateTopPostsCache();
});

describe("thumbnailIfFresh", () => {
  it("serves a URL whose oe= expiry is still in the future", () => {
    const url = cdn(NOW + 4 * 86_400_000);
    expect(thumbnailIfFresh(url, NOW)).toBe(url);
  });

  it("refuses a URL whose oe= expiry has passed — a rotted URL is a broken image", () => {
    expect(thumbnailIfFresh(cdn(NOW - 1000), NOW)).toBeNull();
  });

  it("refuses a URL at the exact expiry instant", () => {
    expect(thumbnailIfFresh(cdn(NOW), NOW)).toBeNull();
  });

  it("refuses a URL with no oe= at all rather than gambling on it", () => {
    expect(thumbnailIfFresh("https://scontent.cdninstagram.com/v/t51/abc.jpg", NOW)).toBeNull();
  });

  it("refuses null/empty without throwing", () => {
    expect(thumbnailIfFresh(null, NOW)).toBeNull();
    expect(thumbnailIfFresh(undefined, NOW)).toBeNull();
    expect(thumbnailIfFresh("", NOW)).toBeNull();
  });

  it("refuses an unparseable oe= rather than treating it as far-future", () => {
    expect(thumbnailIfFresh("https://x.test/a.jpg?oe=ZZZZ", NOW)).toBeNull();
  });
});

describe("matchIdFromUrl", () => {
  it("pulls the Instagram shortcode from p/ reel/ and tv/ permalinks", () => {
    expect(matchIdFromUrl("instagram", "https://www.instagram.com/reel/DddgZw6hW2i/")).toBe("DddgZw6hW2i");
    expect(matchIdFromUrl("instagram", "https://instagram.com/p/ABC123/?igsh=tok")).toBe("ABC123");
    expect(matchIdFromUrl("instagram", "https://www.instagram.com/tv/XYZ/")).toBe("XYZ");
  });

  it("keeps Instagram shortcodes CASE-SENSITIVE — lowercasing would merge distinct posts", () => {
    expect(matchIdFromUrl("instagram", "https://www.instagram.com/reel/AbCdE/")).toBe("AbCdE");
  });

  it("pulls the numeric id from Facebook reel/video/post permalinks", () => {
    expect(matchIdFromUrl("facebook", "https://www.facebook.com/reel/1234567890")).toBe("1234567890");
    expect(matchIdFromUrl("facebook", "https://www.facebook.com/page/videos/998877665/")).toBe("998877665");
  });

  it("returns null for shapes it does not recognise — a miss costs a thumbnail, never a number", () => {
    expect(matchIdFromUrl("facebook", "https://www.facebook.com/share/r/abc123/")).toBeNull();
    expect(matchIdFromUrl("youtube", "https://youtu.be/dQw4w9WgXcQ")).toBeNull();
    expect(matchIdFromUrl("snapchat", "https://snapchat.com/spotlight/123")).toBeNull();
  });
});

describe("TOP_POST_PERIODS", () => {
  it("offers 24h, which the GLOBAL overview period set deliberately does not", async () => {
    expect(TOP_POST_PERIODS).toContain(1);
    const { OVERVIEW_PERIODS } = await import("../src/services/overview.service");
    expect(OVERVIEW_PERIODS as readonly number[]).not.toContain(1);
  });
});

describe("getTopPosts", () => {
  async function seed() {
    const role = await prisma.role.create({ data: { name: `R${Date.now()}`, description: "t" } });
    const mk = async (name: string) =>
      prisma.user.create({
        data: {
          name, email: `${name}@t.test`, passwordHash: "x", status: "ACTIVE",
          roles: { create: { roleId: role.id } },
        },
      });
    const a = await mk("alpha");
    const b = await mk("bravo");
    const day = (n: number) => new Date(Date.UTC(2026, 8, 19 - n));

    const row = (employeeId: string, url: string, platform: string, views: number | null, likes: number | null, daysAgo: number) =>
      prisma.linkMetricLatest.create({
        data: {
          employeeId, urlNormalized: url, url, platform,
          reportDate: day(daysAgo), fetchedAt: day(daysAgo),
          views, likes, comments: 5,
        },
      });

    // Same post submitted by TWO employees -> must collapse to one ranked row.
    await row(a.id, "https://www.facebook.com/reel/111", "facebook", 900_000, 100, 2);
    await row(b.id, "https://www.facebook.com/reel/111", "facebook", 900_000, 100, 2);
    // A bigger one, single submitter.
    await row(a.id, "https://www.facebook.com/reel/222", "facebook", 5_000_000, 50, 3);
    // Instagram, with real views (post-2026-09-19 provider fix).
    await row(a.id, "https://www.instagram.com/reel/IGAAA/", "instagram", 2_000_000, 900, 2);
    // Instagram polled BEFORE the fix: views null. Must be excluded, not ranked as 0.
    await row(b.id, "https://www.instagram.com/reel/IGOLD/", "instagram", null, 9_999_999, 2);
    // Outside a 7-day window.
    await row(a.id, "https://www.facebook.com/reel/333", "facebook", 9_000_000, 10, 40);
    return { a, b };
  }

  it("collapses URL VARIANTS of one post — a trailing slash or a fresh ?igsh= is the same post", async () => {
    const role = await prisma.role.create({ data: { name: `RV${Date.now()}`, description: "t" } });
    const mk = async (n: string) => prisma.user.create({
      data: { name: n, email: `${n}@v.test`, passwordHash: "x", status: "ACTIVE", roles: { create: { roleId: role.id } } },
    });
    const a = await mk("vara"); const b = await mk("varb"); const c = await mk("varc");
    const day = new Date(Date.UTC(2026, 8, 18));
    const row = (employeeId: string, url: string, views: number | null) =>
      prisma.linkMetricLatest.create({
        data: { employeeId, urlNormalized: url.toLowerCase(), url, platform: "instagram",
          reportDate: day, fetchedAt: day, views, likes: 10, comments: 2 },
      });
    // Same reel, three employees, three DIFFERENT raw urls — which is what Instagram's
    // per-copy ?igsh= token and a trailing slash actually produce in prod (measured:
    // 174 of 181 shared posts were split this way).
    await row(a.id, "https://www.instagram.com/reel/SAMEREEL/?igsh=aaa", 500_000);
    await row(b.id, "https://www.instagram.com/reel/SAMEREEL/?igsh=bbb", 500_000);
    // ⚠️ This third employee's row has NOT been re-polled yet, so it carries no views.
    // It must still COUNT as a submitter — a row filter would silently drop them.
    await row(c.id, "https://www.instagram.com/reel/SAMEREEL", null);

    const r = await getTopPosts({ platform: "instagram", days: 7, now: new Date(NOW) });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].submitters).toBe(3);
  });

  it("collapses one post submitted by several employees into ONE row and counts the submitters", async () => {
    await seed();
    const r = await getTopPosts({ platform: "facebook", days: 7, now: new Date(NOW) });
    const shared = r.posts.find((p) => p.url.endsWith("/111"));
    expect(r.posts.filter((p) => p.url.endsWith("/111"))).toHaveLength(1);
    expect(shared!.submitters).toBe(2);
    expect(r.posts.find((p) => p.url.endsWith("/222"))!.submitters).toBe(1);
  });

  it("ranks by views, descending", async () => {
    await seed();
    const r = await getTopPosts({ platform: "facebook", days: 7, now: new Date(NOW) });
    expect(r.posts.map((p) => p.views)).toEqual([5_000_000, 900_000]);
  });

  it("EXCLUDES a row with no view count instead of ranking it as zero", async () => {
    await seed();
    const r = await getTopPosts({ platform: "instagram", days: 7, now: new Date(NOW) });
    // IGOLD has 9,999,999 likes but null views — it must not appear in a views ranking,
    // and must not be coerced to 0 and sorted last either.
    expect(r.posts.map((p) => p.url)).toEqual(["https://www.instagram.com/reel/IGAAA/"]);
    expect(r.posts.every((p) => p.views !== null)).toBe(true);
    // ...but the card can still say how much of the window it could rank.
    expect(r.ranked).toBe(1);
    expect(r.total).toBe(2);
  });

  it("honours the window — a post outside it is absent", async () => {
    await seed();
    const week = await getTopPosts({ platform: "facebook", days: 7, now: new Date(NOW) });
    expect(week.posts.some((p) => p.url.endsWith("/333"))).toBe(false);
    invalidateTopPostsCache();
    const quarter = await getTopPosts({ platform: "facebook", days: 90, now: new Date(NOW) });
    expect(quarter.posts[0].url).toContain("/333");
  });

  it("platform=all mixes platforms; a platform filter restricts to it", async () => {
    await seed();
    const all = await getTopPosts({ platform: "all", days: 7, now: new Date(NOW) });
    expect(new Set(all.posts.map((p) => p.platform))).toEqual(new Set(["facebook", "instagram"]));
    invalidateTopPostsCache();
    const ig = await getTopPosts({ platform: "instagram", days: 7, now: new Date(NOW) });
    expect(ig.posts.every((p) => p.platform === "instagram")).toBe(true);
  });

  it("attaches a preview only while it is still valid, and never a rotted one", async () => {
    const { a } = await seed();
    const conn = await prisma.metaConnection.create({
      data: { metaUserId: `u${Date.now()}`, connectedById: a.id },
    });
    const asset = await prisma.metaAsset.create({
      data: {
        connectionId: conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: `ig${Date.now()}`,
        name: "Chronicle", username: "chronicle", selected: true,
      },
    });
    await prisma.metaPost.create({
      data: {
        assetId: asset.id, metaPostId: `m${Date.now()}`, matchId: "IGAAA",
        caption: "Line one\nLine two", postedAt: new Date(NOW - 86_400_000),
        thumbnailUrl: cdn(NOW + 3 * 86_400_000),
      },
    });
    const r = await getTopPosts({ platform: "instagram", days: 7, now: new Date(NOW) });
    expect(r.posts[0].thumbnailUrl).toContain("scontent");
    expect(r.posts[0].title).toBe("Line one");
    expect(r.posts[0].channel).toBe("@chronicle");
    expect(r.withPreview).toBe(1);

    // Rot it: same row, expiry in the past.
    await prisma.metaPost.updateMany({ where: { matchId: "IGAAA" }, data: { thumbnailUrl: cdn(NOW - 1000) } });
    invalidateTopPostsCache();
    const after = await getTopPosts({ platform: "instagram", days: 7, now: new Date(NOW) });
    expect(after.posts[0].thumbnailUrl).toBeNull();
    expect(after.withPreview).toBe(0);
    // The row itself survives — only the picture is withheld.
    expect(after.posts[0].views).toBe(2_000_000);
    expect(after.posts[0].title).toBe("Line one");
  });

  it("returns an empty board rather than throwing when nothing is in the window", async () => {
    const r = await getTopPosts({ platform: "all", days: 1, now: new Date(NOW) });
    expect(r.posts).toEqual([]);
    expect(r.ranked).toBe(0);
    expect(r.total).toBe(0);
  });
});
