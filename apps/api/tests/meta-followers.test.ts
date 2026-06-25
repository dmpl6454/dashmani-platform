import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchInstagramFollowerMap,
  fetchFacebookFollowerMap,
  __setGraphFetchForTesting as setFollowersGraphFetch,
} from "../src/services/social-insights/meta-followers";
import type { GraphFetchResult, GraphFetchFn } from "../src/services/social-insights/meta-graph";

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok<T>(data: T): GraphFetchResult<T> {
  return { ok: true, rateLimited: false, status: 200, data };
}

const FAKE_TOKEN = "FAKE_META_TOKEN_FOR_TESTS";

beforeEach(() => {
  setFollowersGraphFetch(null);
  delete process.env.META_SYSTEM_USER_TOKEN;
});

afterEach(() => {
  setFollowersGraphFetch(null);
  delete process.env.META_SYSTEM_USER_TOKEN;
});

// ── fetchInstagramFollowerMap ────────────────────────────────────────────────

describe("fetchInstagramFollowerMap", () => {
  it("two-step: me/accounts → ig ids, then GET /{ig-id} → { followers, following, posts }", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    // The live me/accounts call returns ONLY the nested {id} (deep sub-field
    // expansion is NOT honored), so STEP 2 must fetch the flat fields per id.
    const graph = vi.fn(async (path: string) => {
      if (path.startsWith("me/accounts")) {
        return ok({ data: [{ instagram_business_account: { id: "17841473204180170" } }] });
      }
      if (path === "17841473204180170") {
        return ok({
          id: "17841473204180170",
          username: "DigitalSukoon",
          followers_count: 14163052,
          media_count: 320,
          follows_count: 12,
        });
      }
      throw new Error(`unexpected graph path: ${path}`);
    });
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchInstagramFollowerMap();
    const expected = { followers: 14163052, following: 12, posts: 320 };
    // Multi-keyed: findable by lowercased username AND by IG business account id.
    expect(map.get("digitalsukoon")).toEqual(expected);
    expect(map.get("17841473204180170")).toEqual(expected);
    // Step 1 (me/accounts) + step 2 (per-id) = 2 calls.
    expect(graph).toHaveBeenCalledTimes(2);
  });

  it("returns an empty map with NO network call when no token is configured (dark switch)", async () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    const spy = vi.fn();
    setFollowersGraphFetch(spy as unknown as GraphFetchFn);

    const map = await fetchInstagramFollowerMap();
    expect(spy).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it("returns an empty map (no throw) when STEP 1 (me/accounts) is rate-limited", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (): Promise<GraphFetchResult> => ({
      ok: false,
      rateLimited: true,
      status: 429,
      error: "rate limit",
    }));
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchInstagramFollowerMap();
    expect(map.size).toBe(0);
  });

  it("returns a partial/empty map (no throw) when STEP 2 (per-id) is rate-limited", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (path: string): Promise<GraphFetchResult> => {
      if (path.startsWith("me/accounts")) {
        return ok({ data: [{ instagram_business_account: { id: "17841473204180170" } }] });
      }
      // STEP 2 throttled → stop, partial (here empty) map, never throw.
      return { ok: false, rateLimited: true, status: 429, error: "rate limit" };
    });
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchInstagramFollowerMap();
    expect(map.size).toBe(0);
  });

  it("skips an id whose STEP 2 response has a username but no numeric follower count", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (path: string) => {
      if (path.startsWith("me/accounts")) {
        return ok({ data: [{ instagram_business_account: { id: "1" } }] });
      }
      // Username present but no followers_count → skipped.
      return ok({ id: "1", username: "NoCountAccount" });
    });
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchInstagramFollowerMap();
    expect(map.has("nocountaccount")).toBe(false);
    expect(map.has("1")).toBe(false);
    expect(map.size).toBe(0);
  });
});

// ── fetchFacebookFollowerMap ─────────────────────────────────────────────────

describe("fetchFacebookFollowerMap", () => {
  it("maps administered page by id/username → { followers }, with fan_count fallback, skipping pages with no tasks and NOT keying by name", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (path: string) => {
      if (path === "me/accounts") {
        return ok({
          data: [
            { id: "100", access_token: "PT", tasks: ["MANAGE"], username: "mypage", name: "My Page", followers_count: 5000 },
            { id: "200", access_token: "PT2", tasks: ["ANALYZE"], fan_count: 999 },
            { id: "300", access_token: "PT3", tasks: [] }, // no tasks → not administered
          ],
        });
      }
      throw new Error(`unexpected graph path: ${path}`);
    });
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchFacebookFollowerMap();
    // Multi-keyed by page id + username (lowercased) — both stable identifiers,
    // same value. The display name is deliberately NOT a key (non-unique
    // free-text, collision risk; the reader never matches on it).
    expect(map.get("100")).toEqual({ followers: 5000 });
    expect(map.get("mypage")).toEqual({ followers: 5000 });
    expect(map.has("my page")).toBe(false); // name is NOT a key
    expect(map.get("200")).toEqual({ followers: 999 }); // fan_count fallback
    expect(map.has("300")).toBe(false); // no tasks → absent
  });

  it("returns an empty map with NO network call when no token is configured (dark switch)", async () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    const spy = vi.fn();
    setFollowersGraphFetch(spy as unknown as GraphFetchFn);

    const map = await fetchFacebookFollowerMap();
    expect(spy).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it("returns an empty map (no throw) when the first page is rate-limited", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (): Promise<GraphFetchResult> => ({
      ok: false,
      rateLimited: true,
      status: 429,
      error: "rate limit",
    }));
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchFacebookFollowerMap();
    expect(map.size).toBe(0);
  });

  it("skips an administered page whose follower count is missing/non-numeric", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async () =>
      ok({ data: [{ id: "400", access_token: "PT", tasks: ["MANAGE"] }] }),
    );
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchFacebookFollowerMap();
    expect(map.has("400")).toBe(false);
    expect(map.size).toBe(0);
  });
});
