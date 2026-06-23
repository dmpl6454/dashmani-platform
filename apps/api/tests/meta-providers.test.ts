import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractInstagramShortcode, extractFacebookPostId } from "@dashmani/shared";
import type { InsightTarget } from "../src/services/social-insights/types";
import {
  instagramProvider,
  __setGraphFetchForTesting as setIgGraphFetch,
  __resetIgRateLimitedForTesting,
  igRateLimited,
} from "../src/services/social-insights/instagram.provider";
import {
  facebookProvider,
  resolveOpaqueFacebookUrl,
  resolveFacebookShareUrl,
  __setGraphFetchForTesting as setFbGraphFetch,
  __resetFbRateLimitedForTesting,
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
  __resetFbRateLimitedForTesting();
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

  it("resolves a clean numeric id to its caption + counts", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (path: string) => {
      expect(path).toBe("123456789");
      return ok({
        id: "123456789",
        message: "Diwali sale announcement",
        likes: { summary: { total_count: 88 } },
        comments: { summary: { total_count: 12 } },
      });
    });
    setFbGraphFetch(graph as unknown as GraphFetchFn);

    const res = await facebookProvider.fetchBatch([target("l1", "https://facebook.com/reel/123456789", "123456789")]);
    expect(res.get("l1")).toMatchObject({
      ok: true,
      status: "ok",
      caption: "Diwali sale announcement",
      likes: 88,
      comments: 12,
      views: null,
      shares: null,
    });
  });

  it("returns not_found for an unknown / deleted id", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (): Promise<GraphFetchResult> => {
      return { ok: false, rateLimited: false, status: 400, error: "Unsupported get request" };
    });
    setFbGraphFetch(graph as unknown as GraphFetchFn);

    const res = await facebookProvider.fetchBatch([target("l1", "https://facebook.com/reel/999", "999")]);
    expect(res.get("l1")).toMatchObject({ ok: false, status: "not_found" });
  });

  it("short-circuits remaining targets to rate_limited once throttled", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    let call = 0;
    const graph = vi.fn(async (): Promise<GraphFetchResult> => {
      call++;
      if (call === 1) return { ok: false, rateLimited: true, status: 429, error: "rate limit" };
      throw new Error("should not be called after rate limit");
    });
    setFbGraphFetch(graph as unknown as GraphFetchFn);

    const res = await facebookProvider.fetchBatch([
      target("l1", "https://facebook.com/reel/1", "1"),
      target("l2", "https://facebook.com/reel/2", "2"),
    ]);
    expect(res.get("l1")).toMatchObject({ ok: false, status: "rate_limited" });
    expect(res.get("l2")).toMatchObject({ ok: false, status: "rate_limited" });
    expect(graph).toHaveBeenCalledTimes(1); // l2 never hit the network
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
});
