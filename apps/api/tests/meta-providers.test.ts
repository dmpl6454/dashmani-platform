import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractInstagramShortcode, extractFacebookPostId } from "@dashmani/shared";
import type { InsightTarget } from "../src/services/social-insights/types";
import {
  instagramProvider,
  __setGraphFetchForTesting as setIgGraphFetch,
  __resetIgRateLimitedForTesting,
  __resetIgMapForTesting,
  igRateLimited,
} from "../src/services/social-insights/instagram.provider";
import {
  facebookProvider,
  resolveOpaqueFacebookUrl,
  resolveFacebookShareUrl,
  __setGraphFetchForTesting as setFbGraphFetch,
  __resetFbRateLimitedForTesting,
  __resetFbMapForTesting,
} from "../src/services/social-insights/facebook.provider";
import type { GraphFetchResult, GraphFetchFn } from "../src/services/social-insights/meta-graph";

// ── Helpers ──────────────────────────────────────────────────────────────────

function target(linkId: string, url: string, targetId: string): InsightTarget {
  return {
    linkId,
    url,
    urlNormalized: url.toLowerCase(),
    targetId,
    employeeId: "emp-1",
    reportDate: new Date(),
  };
}

function ok<T>(data: T): GraphFetchResult<T> {
  return { ok: true, rateLimited: false, status: 200, data };
}

const FAKE_TOKEN = "FAKE_META_TOKEN_FOR_TESTS";

beforeEach(() => {
  __resetIgRateLimitedForTesting();
  __resetIgMapForTesting();
  __resetFbRateLimitedForTesting();
  __resetFbMapForTesting();
  setIgGraphFetch(null);
  setFbGraphFetch(null);
  delete process.env.META_SYSTEM_USER_TOKEN;
});

afterEach(() => {
  setIgGraphFetch(null);
  setFbGraphFetch(null);
  delete process.env.META_SYSTEM_USER_TOKEN;
});

// ── Extractor unit tests ───────────────────────────────────────────────────

describe("extractInstagramShortcode", () => {
  it("extracts the shortcode from /reel, /reels, /p, /tv forms", () => {
    expect(extractInstagramShortcode("https://www.instagram.com/reel/DZJyjhBKN5-/")).toBe("DZJyjhBKN5-");
    expect(extractInstagramShortcode("https://instagram.com/reels/ABC123/")).toBe("ABC123");
    expect(extractInstagramShortcode("https://instagram.com/p/XYZ789/")).toBe("XYZ789");
    expect(extractInstagramShortcode("https://instagram.com/tv/QWE456/")).toBe("QWE456");
  });

  it("strips the rotating ?igsh share token (same shortcode regardless)", () => {
    const a = extractInstagramShortcode("https://www.instagram.com/reel/DZJyjhBKN5-/?igsh=MXE4YTh0b2Y4ajR2ZQ==");
    const b = extractInstagramShortcode("https://www.instagram.com/reel/DZJyjhBKN5-/?igsh=SOMETHING_ELSE_999");
    expect(a).toBe("DZJyjhBKN5-");
    expect(b).toBe("DZJyjhBKN5-");
  });

  it("preserves shortcode case (IG codes are case-sensitive)", () => {
    expect(extractInstagramShortcode("https://instagram.com/reel/AbCdEf/")).toBe("AbCdEf");
    expect(extractInstagramShortcode("https://instagram.com/reel/AbCdEf/")).not.toBe(
      extractInstagramShortcode("https://instagram.com/reel/abcdef/"),
    );
  });

  it("handles the /<username>/reel/CODE form", () => {
    expect(extractInstagramShortcode("https://www.instagram.com/digitalsukoon/reel/DZJyjhBKN5-/")).toBe("DZJyjhBKN5-");
  });

  it("normalizes www. and m. hosts", () => {
    expect(extractInstagramShortcode("https://m.instagram.com/reel/ABC123/")).toBe("ABC123");
  });

  it("returns null for non-Instagram hosts and non-URLs", () => {
    expect(extractInstagramShortcode("https://www.facebook.com/reel/123/")).toBeNull();
    expect(extractInstagramShortcode("not a url")).toBeNull();
    expect(extractInstagramShortcode("")).toBeNull();
    expect(extractInstagramShortcode(null)).toBeNull();
    expect(extractInstagramShortcode(undefined)).toBeNull();
  });

  it("returns null for an instagram URL with no recognizable post path", () => {
    expect(extractInstagramShortcode("https://www.instagram.com/digitalsukoon/")).toBeNull();
    expect(extractInstagramShortcode("https://www.instagram.com/")).toBeNull();
  });
});

describe("extractFacebookPostId", () => {
  it("extracts numeric ids from /reel, /videos, /video and watch?v=", () => {
    expect(extractFacebookPostId("https://www.facebook.com/reel/123456789")).toBe("123456789");
    expect(extractFacebookPostId("https://www.facebook.com/videos/123456789")).toBe("123456789");
    expect(extractFacebookPostId("https://www.facebook.com/video/123456789")).toBe("123456789");
    expect(extractFacebookPostId("https://www.facebook.com/watch?v=123456789")).toBe("123456789");
    expect(extractFacebookPostId("https://m.facebook.com/reel/123456789/")).toBe("123456789");
  });

  it("returns null for opaque /share/r/, /posts/, story.php and pfbid permalinks", () => {
    expect(extractFacebookPostId("https://www.facebook.com/share/r/16abcXYZ/")).toBeNull();
    expect(extractFacebookPostId("https://www.facebook.com/somepage/posts/pfbid0xyz")).toBeNull();
    expect(extractFacebookPostId("https://www.facebook.com/story.php?story_fbid=123&id=456")).toBeNull();
    expect(extractFacebookPostId("https://www.facebook.com/permalink.php?story_fbid=pfbid0abcDEF&id=100")).toBeNull();
  });

  it("returns null for non-Facebook hosts and non-URLs", () => {
    expect(extractFacebookPostId("https://www.instagram.com/reel/ABC/")).toBeNull();
    expect(extractFacebookPostId("not a url")).toBeNull();
    expect(extractFacebookPostId("")).toBeNull();
    expect(extractFacebookPostId(null)).toBeNull();
    expect(extractFacebookPostId(undefined)).toBeNull();
  });
});

// ── Instagram provider tests (mocked graphFetch, no real token/network) ──────

describe("instagramProvider", () => {
  it("isSupported() reflects META_SYSTEM_USER_TOKEN presence (dark switch)", () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    expect(instagramProvider.isSupported()).toBe(false);
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    expect(instagramProvider.isSupported()).toBe(true);
  });

  it("extractTargetId returns the shortcode", () => {
    expect(instagramProvider.extractTargetId("https://www.instagram.com/reel/DZJyjhBKN5-/?igsh=x")).toBe("DZJyjhBKN5-");
  });

  it("returns an all-error map with NO network call when no token is configured", async () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    const spy = vi.fn();
    setIgGraphFetch(spy as unknown as GraphFetchFn);

    const targets = [target("l1", "https://instagram.com/reel/ABC/", "ABC")];
    const res = await instagramProvider.fetchBatch(targets);

    expect(spy).not.toHaveBeenCalled(); // proves no network attempt
    expect(res.get("l1")).toMatchObject({ ok: false, status: "error" });
  });

  it("builds the shortcode→media map once and resolves a target's caption + counts", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;

    const graph = vi.fn(async (path: string) => {
      if (path === "me/accounts") {
        return ok({ data: [{ instagram_business_account: { id: "ig-100" } }] });
      }
      if (path === "ig-100/media") {
        return ok({
          data: [
            {
              id: "media-1",
              shortcode: "ABC123",
              caption: "Sunset reel about Bandra",
              like_count: 42,
              comments_count: 7,
              media_type: "VIDEO",
              timestamp: new Date().toISOString(),
            },
          ],
        });
      }
      throw new Error(`unexpected graph path: ${path}`);
    });
    setIgGraphFetch(graph as unknown as GraphFetchFn);

    const targets = [target("l1", "https://instagram.com/reel/ABC123/", "ABC123")];
    const res = await instagramProvider.fetchBatch(targets);

    expect(res.get("l1")).toMatchObject({
      ok: true,
      status: "ok",
      likes: 42,
      comments: 7,
      caption: "Sunset reel about Bandra",
      views: null,
      shares: null,
    });
    // Map built once: exactly 1 accounts call + 1 media call.
    expect(graph).toHaveBeenCalledTimes(2);
  });

  it("harvestContent() exposes EVERY captioned post in the run's feed map, keyed by canonicalKey", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const now = new Date().toISOString();
    const graph = vi.fn(async (path: string) => {
      if (path === "me/accounts") return ok({ data: [{ instagram_business_account: { id: "ig-1" } }] });
      if (path === "ig-1/media")
        return ok({
          data: [
            { id: "m1", shortcode: "SUBMITTED1", caption: "post about Salman Khan", like_count: 10, comments_count: 2, timestamp: now },
            { id: "m2", shortcode: "NOTSUBMITTED", caption: "post about Kriti Sanon", like_count: 5, comments_count: 1, timestamp: now },
            { id: "m3", shortcode: "NOCAPTION", timestamp: now }, // no caption → excluded from harvest
          ],
        });
      throw new Error(`unexpected path ${path}`);
    });
    setIgGraphFetch(graph as unknown as GraphFetchFn);

    // fetchBatch only asked about ONE submitted link…
    await instagramProvider.fetchBatch([target("l1", "https://instagram.com/reel/SUBMITTED1/", "SUBMITTED1")]);

    // …but harvestContent exposes ALL captioned posts the map saw (incl. the
    // never-submitted one), keyed by ig:<shortcode>, excluding the caption-less post.
    const harvested = instagramProvider.harvestContent!();
    const keys = harvested.map((h) => h.canonicalKey).sort();
    expect(keys).toEqual(["ig:NOTSUBMITTED", "ig:SUBMITTED1"]);
    expect(harvested.find((h) => h.canonicalKey === "ig:NOTSUBMITTED")?.caption).toBe("post about Kriti Sanon");
  });

  it("harvestContent() returns [] after a dark (no-token) run — never stale", async () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    await instagramProvider.fetchBatch([target("l1", "https://instagram.com/reel/ABC/", "ABC")]);
    expect(instagramProvider.harvestContent!()).toEqual([]);
  });

  it("returns not_found for a shortcode not in any managed account's media", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (path: string) => {
      if (path === "me/accounts") return ok({ data: [{ instagram_business_account: { id: "ig-100" } }] });
      if (path === "ig-100/media") return ok({ data: [{ id: "m", shortcode: "OTHER", timestamp: new Date().toISOString() }] });
      throw new Error(`unexpected path ${path}`);
    });
    setIgGraphFetch(graph as unknown as GraphFetchFn);

    const res = await instagramProvider.fetchBatch([target("l1", "https://instagram.com/reel/ABSENT/", "ABSENT")]);
    expect(res.get("l1")).toMatchObject({ ok: false, status: "not_found" });
  });

  it("short-circuits the whole run to rate_limited when the Graph API throttles", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (): Promise<GraphFetchResult> => {
      return { ok: false, rateLimited: true, status: 429, error: "rate limit" };
    });
    setIgGraphFetch(graph as unknown as GraphFetchFn);

    const res = await instagramProvider.fetchBatch([target("l1", "https://instagram.com/reel/ABC/", "ABC")]);
    expect(res.get("l1")).toMatchObject({ ok: false, status: "rate_limited" });
    expect(igRateLimited).toBe(true);
  });

  it("emits a console.warn and returns not_found (no throw) when me/accounts returns zero IG accounts", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const graph = vi.fn(async (path: string) => {
      if (path === "me/accounts") {
        // Empty data array: no IG Business accounts linked to any Page.
        return ok({ data: [] });
      }
      throw new Error(`unexpected graph path: ${path}`);
    });
    setIgGraphFetch(graph as unknown as GraphFetchFn);

    const targets = [target("l1", "https://instagram.com/reel/ABC/", "ABC")];
    const res = await instagramProvider.fetchBatch(targets);

    // All targets come back not_found (empty map, no throw).
    expect(res.get("l1")).toMatchObject({ ok: false, status: "not_found" });

    // A loud warning must have been emitted so the silent failure is observable.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("discovery returned 0 IG accounts"),
    );

    warnSpy.mockRestore();
  });
});

// ── Instagram paging depth (env-overridable; mocked graphFetch) ──────────────
//
// The provider is imported once at module load, so MAX_PAGES_PER_ACCOUNT /
// POLL_WINDOW_DAYS are read from process.env at import time. We can't flip the
// constants after import, but we CAN prove the two contracts that matter without
// the network:
//   1. With NO env set (the cron's world), the default page cap is generous
//      enough to walk a multi-page feed AND it self-limits — it does not page
//      forever — and it stops early once a page contains media older than the
//      90-day window.
//   2. A shortcode absent from the (bounded) mocked feed → not_found.

describe("instagramProvider — paging depth & window (env-overridable defaults)", () => {
  it("pages a multi-paged feed and resolves a shortcode found on a later page", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const recent = new Date().toISOString();
    // 3 media pages, all within the window; the target lives on page 3.
    const graph = vi.fn(async (path: string) => {
      if (path === "me/accounts") return ok({ data: [{ instagram_business_account: { id: "ig-1" } }] });
      if (path === "ig-1/media")
        return ok({
          data: [{ id: "m1", shortcode: "P1", timestamp: recent }],
          paging: { next: "https://graph.facebook.com/v21.0/ig-1/media?after=cur1" },
        });
      if (path.includes("after=cur1"))
        return ok({
          data: [{ id: "m2", shortcode: "P2", timestamp: recent }],
          paging: { next: "https://graph.facebook.com/v21.0/ig-1/media?after=cur2" },
        });
      if (path.includes("after=cur2"))
        return ok({
          data: [{ id: "m3", shortcode: "TARGET", caption: "found deep", like_count: 5, comments_count: 1, timestamp: recent }],
          // No further paging cursor → natural stop.
        });
      throw new Error(`unexpected path ${path}`);
    });
    setIgGraphFetch(graph as unknown as GraphFetchFn);

    const res = await instagramProvider.fetchBatch([target("l1", "https://instagram.com/reel/TARGET/", "TARGET")]);
    expect(res.get("l1")).toMatchObject({ ok: true, status: "ok", caption: "found deep", likes: 5 });
  });

  it("stops paging once a page contains media older than the poll window", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString(); // > 90d old
    const graph = vi.fn(async (path: string) => {
      if (path === "me/accounts") return ok({ data: [{ instagram_business_account: { id: "ig-1" } }] });
      if (path === "ig-1/media")
        return ok({
          // This first page already contains an out-of-window item → stop after it.
          data: [{ id: "m1", shortcode: "OLD", timestamp: old }],
          paging: { next: "https://graph.facebook.com/v21.0/ig-1/media?after=cur1" },
        });
      // If the provider followed the cursor it would hit this and fail the test.
      throw new Error("should not page past the window boundary");
    });
    setIgGraphFetch(graph as unknown as GraphFetchFn);

    const res = await instagramProvider.fetchBatch([target("l1", "https://instagram.com/reel/ABSENT/", "ABSENT")]);
    expect(res.get("l1")).toMatchObject({ ok: false, status: "not_found" });
    // Exactly 1 accounts call + 1 media page (the window early-stop fired).
    expect(graph).toHaveBeenCalledTimes(2);
  });
});

// ── Facebook provider tests (mocked graphFetch, no real token/network) ───────

describe("facebookProvider", () => {
  it("isSupported() reflects META_SYSTEM_USER_TOKEN presence (dark switch)", () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    expect(facebookProvider.isSupported()).toBe(false);
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    expect(facebookProvider.isSupported()).toBe(true);
  });

  it("extractTargetId returns the numeric id (null for opaque)", () => {
    expect(facebookProvider.extractTargetId("https://www.facebook.com/reel/123456789")).toBe("123456789");
    expect(facebookProvider.extractTargetId("https://www.facebook.com/share/r/abc/")).toBeNull();
  });

  it("returns an all-error map with NO network call when no token is configured", async () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    const spy = vi.fn();
    setFbGraphFetch(spy as unknown as GraphFetchFn);

    const res = await facebookProvider.fetchBatch([target("l1", "https://facebook.com/reel/123", "123")]);
    expect(spy).not.toHaveBeenCalled();
    expect(res.get("l1")).toMatchObject({ ok: false, status: "error" });
  });

  // Owned-Page model mock: me/accounts → one ADMIN page (has tasks + token) + one
  // NON-admin page (no tasks); the admin page's /published_posts carries a post whose
  // numeric id matches our target; /insights returns views + reactions + activity.
  function ownedPageGraph(opts?: { withComments?: boolean }) {
    const recent = new Date().toISOString();
    return vi.fn(async (path: string, params?: Record<string, unknown>) => {
      if (path === "me/accounts")
        return ok({
          data: [
            { id: "pg-admin", access_token: "PAGE_TOKEN_A", tasks: ["ANALYZE", "CREATE_CONTENT"] },
            { id: "pg-none", access_token: "PAGE_TOKEN_B" }, // no tasks → skipped
          ],
        });
      if (path === "pg-admin/published_posts") {
        // must be called WITH the page token
        expect(params?.access_token).toBe("PAGE_TOKEN_A");
        // A FB reel has two ids: the /reel/<permalinkId> (matches submitted links)
        // and the {pageId}_{postId} composite (the only id /insights accepts).
        return ok({
          data: [
            { id: "pg-admin_990888777", permalink_url: "https://www.facebook.com/reel/555000111", message: "Bhumi Pednekar at the event", created_time: recent },
          ],
        });
      }
      // /insights MUST be hit with the COMPOSITE id, never the permalink reel id.
      if (path === "555000111/insights") throw new Error("insights must use the composite id, not the permalink reel id");
      if (path === "pg-admin_990888777/insights") {
        const metric = String(params?.metric ?? "");
        if (metric.includes("post_video_views")) {
          return ok({ data: [{ name: "post_video_views", values: [{ value: 107 }] }] });
        }
        // reactions + activity batch
        const activity: Record<string, number> = { like: 9, share: 1 };
        if (opts?.withComments) activity.comment = 4;
        return ok({
          data: [
            { name: "post_reactions_by_type_total", values: [{ value: { like: 9 } }] },
            { name: "post_activity_by_action_type", values: [{ value: activity }] },
          ],
        });
      }
      throw new Error(`unexpected fb path ${path}`);
    });
  }

  it("resolves a numeric id via owned-Page feed + /insights (caption, views, likes)", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    setFbGraphFetch(ownedPageGraph() as unknown as GraphFetchFn);

    const res = await facebookProvider.fetchBatch([target("l1", "https://facebook.com/reel/555000111", "555000111")]);
    expect(res.get("l1")).toMatchObject({
      ok: true,
      status: "ok",
      caption: "Bhumi Pednekar at the event",
      views: 107,
      likes: 9, // summed from post_reactions_by_type_total
      shares: 1, // from post_activity_by_action_type
    });
  });

  it("reads comments from post_activity_by_action_type when present", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    setFbGraphFetch(ownedPageGraph({ withComments: true }) as unknown as GraphFetchFn);

    const res = await facebookProvider.fetchBatch([target("l1", "https://facebook.com/reel/555000111", "555000111")]);
    expect(res.get("l1")).toMatchObject({ ok: true, status: "ok", comments: 4 });
  });

  it("returns not_found for a post not on any ADMINISTERED Page's feed", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    setFbGraphFetch(ownedPageGraph() as unknown as GraphFetchFn);

    const res = await facebookProvider.fetchBatch([target("l1", "https://facebook.com/reel/999999", "999999")]);
    expect(res.get("l1")).toMatchObject({ ok: false, status: "not_found" });
  });

  it("skips non-administered Pages (no tasks → never paged)", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (path: string) => {
      if (path === "me/accounts") return ok({ data: [{ id: "pg-none", access_token: "T", /* no tasks */ }] });
      if (path === "pg-none/published_posts") throw new Error("must NOT page a non-admin page");
      throw new Error(`unexpected ${path}`);
    });
    setFbGraphFetch(graph as unknown as GraphFetchFn);

    const res = await facebookProvider.fetchBatch([target("l1", "https://facebook.com/reel/1", "1")]);
    expect(res.get("l1")).toMatchObject({ ok: false, status: "not_found" });
  });

  it("short-circuits the whole run to rate_limited when discovery is throttled", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (): Promise<GraphFetchResult> => ({ ok: false, rateLimited: true, status: 429, error: "rate limit" }));
    setFbGraphFetch(graph as unknown as GraphFetchFn);

    const res = await facebookProvider.fetchBatch([target("l1", "https://facebook.com/reel/1", "1")]);
    expect(res.get("l1")).toMatchObject({ ok: false, status: "rate_limited" });
  });

  it("harvestContent() exposes every captioned post from administered Pages (fb:<numericId>)", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    setFbGraphFetch(ownedPageGraph() as unknown as GraphFetchFn);

    await facebookProvider.fetchBatch([target("l1", "https://facebook.com/reel/555000111", "555000111")]);
    const harvested = facebookProvider.harvestContent!();
    expect(harvested).toEqual([
      { canonicalKey: "fb:555000111", caption: "Bhumi Pednekar at the event", title: null },
    ]);
  });

  it("harvestContent() returns [] after a dark (no-token) run — never stale", async () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    await facebookProvider.fetchBatch([target("l1", "https://facebook.com/reel/1", "1")]);
    expect(facebookProvider.harvestContent!()).toEqual([]);
  });
});

// ── resolveOpaqueFacebookUrl (opt-in helper) ──────────────────────────────────

describe("resolveOpaqueFacebookUrl", () => {
  function mockFetch(location: string | null) {
    return vi.fn(async () => {
      return {
        headers: { get: (h: string) => (h.toLowerCase() === "location" ? location : null) },
      } as unknown as Response;
    });
  }

  it("returns the numeric id when the opaque URL redirects to a clean /reel/<n>", async () => {
    const f = mockFetch("https://www.facebook.com/reel/123456789");
    const id = await resolveOpaqueFacebookUrl("https://www.facebook.com/share/r/abcXYZ/", f as unknown as typeof fetch);
    expect(id).toBe("123456789");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("returns null when the redirect lands on a pfbid / opaque URL (gives up)", async () => {
    const f = mockFetch("https://www.facebook.com/permalink.php?story_fbid=pfbid0abcDEF&id=100");
    const id = await resolveOpaqueFacebookUrl("https://www.facebook.com/share/r/abcXYZ/", f as unknown as typeof fetch);
    expect(id).toBeNull();
  });

  it("returns null when there is no Location header", async () => {
    const f = mockFetch(null);
    const id = await resolveOpaqueFacebookUrl("https://www.facebook.com/share/r/abcXYZ/", f as unknown as typeof fetch);
    expect(id).toBeNull();
  });

  it("returns null (never throws) when the fetch rejects", async () => {
    const f = vi.fn(async () => {
      throw new Error("network down");
    });
    const id = await resolveOpaqueFacebookUrl("https://www.facebook.com/share/r/abcXYZ/", f as unknown as typeof fetch);
    expect(id).toBeNull();
  });
});

// ── resolveFacebookShareUrl (submit-time clean-url-or-null wrapper) ────────────

describe("resolveFacebookShareUrl", () => {
  function mockFetch(location: string | null) {
    return vi.fn(async () => {
      return {
        headers: { get: (h: string) => (h.toLowerCase() === "location" ? location : null) },
      } as unknown as Response;
    });
  }

  it("returns a CLEAN canonical /reel url when the opaque link redirects to a clean /reel/<n>", async () => {
    const f = mockFetch("https://www.facebook.com/reel/841188021963723");
    const clean = await resolveFacebookShareUrl("https://www.facebook.com/share/r/abcXYZ/", f as unknown as typeof fetch);
    expect(clean).toBe("https://www.facebook.com/reel/841188021963723");
  });

  it("normalizes a clean /videos/<n> redirect target to the canonical /reel/<id> form (canonicalKey only cares about fb:<id>)", async () => {
    // extractFacebookPostId matches a top-level /videos/<n>; resolveFacebookShareUrl
    // always re-emits the canonical /reel/<id> shape — the id is what dedupe keys on.
    const f = mockFetch("https://www.facebook.com/videos/555000111");
    const clean = await resolveFacebookShareUrl("https://www.facebook.com/share/v/zzz/", f as unknown as typeof fetch);
    expect(clean).toBe("https://www.facebook.com/reel/555000111");
  });

  it("returns null when the redirect lands on a pfbid / opaque permalink (gives up)", async () => {
    const f = mockFetch("https://www.facebook.com/permalink.php?story_fbid=pfbid0abcDEF&id=100");
    const clean = await resolveFacebookShareUrl("https://www.facebook.com/share/r/abcXYZ/", f as unknown as typeof fetch);
    expect(clean).toBeNull();
  });

  it("returns null (never throws) when the fetch rejects — FAIL-OPEN", async () => {
    const f = vi.fn(async () => {
      throw new Error("network down");
    });
    const clean = await resolveFacebookShareUrl("https://www.facebook.com/share/r/abcXYZ/", f as unknown as typeof fetch);
    expect(clean).toBeNull();
  });

  it("forwards an external AbortSignal so a caller's budget can CANCEL the in-flight probe", async () => {
    // The fetch impl observes the signal it was handed and rejects when that signal
    // is/becomes aborted — proving the budget guard actually cancels work rather than
    // just stopping the await. We abort the external signal AFTER the fetch starts.
    const external = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const f = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      observedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (!sig) return; // would hang, but we always pass one here
        const onAbort = () => reject(new Error("aborted"));
        if (sig.aborted) onAbort();
        else sig.addEventListener("abort", onAbort, { once: true });
      });
    });

    const promise = resolveFacebookShareUrl(
      "https://www.facebook.com/share/r/abcXYZ/",
      f as unknown as typeof fetch,
      external.signal,
    );
    // Abort the caller's signal mid-flight; the chained controller must abort our
    // fetch's signal too, rejecting the pending fetch.
    external.abort();
    const clean = await promise;

    // Fail-open: aborted probe → null, never throws.
    expect(clean).toBeNull();
    // The fetch received a signal that ended up aborted (chained from external).
    expect(observedSignal).toBeDefined();
    expect(observedSignal!.aborted).toBe(true);
  });

  it("aborts immediately when the external signal is already aborted before the call", async () => {
    const pre = new AbortController();
    pre.abort();
    let observedAborted: boolean | undefined;
    const f = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      observedAborted = init?.signal?.aborted;
      return new Promise<Response>((_r, reject) => {
        if (init?.signal?.aborted) reject(new Error("already aborted"));
      });
    });
    const clean = await resolveFacebookShareUrl(
      "https://www.facebook.com/share/r/abcXYZ/",
      f as unknown as typeof fetch,
      pre.signal,
    );
    expect(clean).toBeNull();
    expect(observedAborted).toBe(true);
  });
});
