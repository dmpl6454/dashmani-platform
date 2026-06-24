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
  it("maps lowercased username → { followers, following, posts } from me/accounts", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (path: string) => {
      if (path === "me/accounts") {
        return ok({
          data: [
            {
              instagram_business_account: {
                id: "1",
                username: "DigitalSukoon",
                followers_count: 14163052,
                media_count: 320,
                follows_count: 12,
              },
            },
          ],
        });
      }
      throw new Error(`unexpected graph path: ${path}`);
    });
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchInstagramFollowerMap();
    const expected = { followers: 14163052, following: 12, posts: 320 };
    // Multi-keyed: findable by lowercased username AND by IG business account id.
    expect(map.get("digitalsukoon")).toEqual(expected);
    expect(map.get("1")).toEqual(expected);
  });

  it("returns an empty map with NO network call when no token is configured (dark switch)", async () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    const spy = vi.fn();
    setFollowersGraphFetch(spy as unknown as GraphFetchFn);

    const map = await fetchInstagramFollowerMap();
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

    const map = await fetchInstagramFollowerMap();
    expect(map.size).toBe(0);
  });

  it("skips an account whose follower count is missing/non-numeric", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async () =>
      ok({ data: [{ instagram_business_account: { id: "1", username: "NoCountAccount" } }] }),
    );
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchInstagramFollowerMap();
    expect(map.has("nocountaccount")).toBe(false);
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
