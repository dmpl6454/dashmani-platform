import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchInstagramFollowerMap,
  fetchFacebookFollowerMap,
  fetchPublicInstagramFollowerMap,
  fbLookupKeys,
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
  it("maps administered page by id/username/name → { followers }, with fan_count fallback, skipping pages with no tasks", async () => {
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
    // Multi-keyed by page id + username + name (all lowercased) — so display-name
    // stored SocialAccount rows can be matched against administered pages.
    expect(map.get("100")).toEqual({ followers: 5000 });
    expect(map.get("mypage")).toEqual({ followers: 5000 });
    expect(map.get("my page")).toEqual({ followers: 5000 }); // name IS now a key
    expect(map.get("200")).toEqual({ followers: 999 }); // fan_count fallback (no name/username)
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

  it("keys by name (lowercased) so a SocialAccount stored under its display name can match", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (path: string) => {
      if (path === "me/accounts") {
        return ok({
          data: [
            {
              id: "123",
              access_token: "T",
              tasks: ["MANAGE"],
              name: "Bollywood Society",
              followers_count: 12_000_000,
            },
          ],
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchFacebookFollowerMap();
    // id key always present
    expect(map.get("123")).toEqual({ followers: 12_000_000 });
    // name key (lowercased) — NEW: allows display-name match
    expect(map.get("bollywood society")).toEqual({ followers: 12_000_000 });
    // no username → username key absent
    expect(map.has("undefined")).toBe(false);
  });

  it("does not add an empty name key when page name is absent", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (path: string) => {
      if (path === "me/accounts") {
        return ok({
          data: [
            { id: "555", access_token: "T", tasks: ["ANALYZE"], followers_count: 100 },
          ],
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchFacebookFollowerMap();
    expect(map.get("555")).toEqual({ followers: 100 });
    expect(map.has("")).toBe(false);
  });
});

// ── fbLookupKeys ─────────────────────────────────────────────────────────────

describe("fbLookupKeys", () => {
  it("profile.php?id=<numeric> → extracts the numeric id + handle", () => {
    const keys = fbLookupKeys("Some Page", "https://www.facebook.com/profile.php?id=100086");
    expect(keys).toContain("100086");
    expect(keys).toContain("some page"); // handle lowercased
  });

  it("facebook.com/<username> → extracts the username (lowercased), deduped with matching handle", () => {
    // URL segment "HellooBollywood" lowercases to "helloobollywood" (double-o).
    // Handle "HellooBollywood" also lowercases to "helloobollywood" → deduped to one key.
    const keys = fbLookupKeys("HellooBollywood", "https://www.facebook.com/HellooBollywood");
    expect(keys).toContain("helloobollywood");
    // Should NOT contain the literal share token or raw mixed-case
    expect(keys.some(k => k.startsWith("share"))).toBe(false);
    expect(keys).not.toContain("HellooBollywood");
  });

  it("facebook.com/<username> is lowercased", () => {
    const keys = fbLookupKeys("MyHandle", "https://www.facebook.com/UpperCasePage");
    expect(keys).toContain("uppercasepage");
  });

  it("/share/ URL → only handle key, no share token key", () => {
    const keys = fbLookupKeys("Bollywood News", "https://www.facebook.com/share/r/abc123XYZ/");
    // No share token — opaque, can't resolve to a page id
    expect(keys.some(k => k.includes("abc123") || k.includes("share"))).toBe(false);
    // Handle is the only candidate
    expect(keys).toContain("bollywood news");
  });

  it("display-name handle with empty profileUrl → only the lowercased handle", () => {
    const keys = fbLookupKeys("Bollywood Society", "");
    expect(keys).toEqual(["bollywood society"]);
  });

  it("skips reserved path segments (pages, people, profile.php without id) from profileUrl", () => {
    const keys = fbLookupKeys("some page", "https://www.facebook.com/pages/MyBrand/123456789");
    // "pages" is a reserved segment — should not be added as a key
    expect(keys).not.toContain("pages");
    expect(keys).toContain("some page"); // handle is always included
  });

  it("deduplicates keys: handle matches the extracted username → only one entry", () => {
    // When the stored handle IS the username from the URL, it shouldn't appear twice
    const keys = fbLookupKeys("mypage", "https://www.facebook.com/mypage");
    expect(keys).toEqual(["mypage"]); // deduped: url-extracted "mypage" == handle "mypage"
  });

  it("drops empty strings from output", () => {
    const keys = fbLookupKeys("  ", "https://www.facebook.com/");
    // The root path "/" has no meaningful segment; empty handle trims to ""
    expect(keys.every(k => k.length > 0)).toBe(true);
  });
});

// ── fetchPublicInstagramFollowerMap ───────────────────────────────────────────

describe("fetchPublicInstagramFollowerMap", () => {
  // The OUR_IG_ID returned from me/accounts discovery — used as the requesting node.
  const OUR_IG_ID = "17841473204180170";

  // me/accounts discovery response (one administered account → ourIgId).
  const DISCOVERY_RESPONSE = ok({
    data: [{ instagram_business_account: { id: OUR_IG_ID } }],
  });

  it("happy path: resolves two handles and returns correct followers/mediaCount keyed by lowercased handle", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (path: string) => {
      // STEP 1: me/accounts discovery
      if (path.startsWith("me/accounts")) return DISCOVERY_RESPONSE;
      // STEP 2: business_discovery per handle
      if (path === OUR_IG_ID) {
        // The fn receives path + params; extract the handle from the params.
        // We let the mock delegate by inspecting the second argument in the real call,
        // but vi.fn captures args — we'll check via call args below.
        // Return based on invocation order instead: first call is discovery, rest are per-handle.
      }
      return ok({});
    });

    // More precise mock: inspect params for handle identity.
    const preciseGraph = vi.fn(async (path: string, params?: Record<string, string | number | undefined>) => {
      if (path.startsWith("me/accounts")) return DISCOVERY_RESPONSE;
      // business_discovery field contains the handle; parse it.
      const fields = params?.fields as string | undefined;
      const handleMatch = fields?.match(/business_discovery\.username\(([^)]+)\)/);
      const handle = handleMatch?.[1];
      if (path === OUR_IG_ID && handle === "salmankhanofficial") {
        return ok({
          business_discovery: {
            username: "salmankhanofficial",
            followers_count: 4621284,
            media_count: 65037,
            id: "111222333",
          },
        });
      }
      if (path === OUR_IG_ID && handle === "kritisanon") {
        return ok({
          business_discovery: {
            username: "kritisanon",
            followers_count: 38000000,
            media_count: 1200,
            id: "444555666",
          },
        });
      }
      throw new Error(`unexpected path=${path} handle=${handle}`);
    });
    setFollowersGraphFetch(preciseGraph as unknown as GraphFetchFn);

    const map = await fetchPublicInstagramFollowerMap(["salmankhanofficial", "kritisanon"]);

    // Both handles resolved and keyed lowercased.
    expect(map.get("salmankhanofficial")).toEqual({ followers: 4621284, mediaCount: 65037 });
    expect(map.get("kritisanon")).toEqual({ followers: 38000000, mediaCount: 1200 });
    expect(map.size).toBe(2);
    // discovery (1) + 2 per-handle calls = 3 total
    expect(preciseGraph).toHaveBeenCalledTimes(3);
  });

  it("HTTP 400 code 110 (Invalid user id / private account) → handle absent from map, no throw, other handles still resolved", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (path: string, params?: Record<string, string | number | undefined>) => {
      if (path.startsWith("me/accounts")) return DISCOVERY_RESPONSE;
      const fields = params?.fields as string | undefined;
      const handleMatch = fields?.match(/business_discovery\.username\(([^)]+)\)/);
      const handle = handleMatch?.[1];
      if (handle === "private_or_gone") {
        // HTTP 400 with error code 110 — the expected "skip" case.
        return {
          ok: false,
          rateLimited: false,
          status: 400,
          error: "Invalid user id",
          data: { error: { code: 110, error_subcode: 2207013, message: "Invalid user id" } },
        } satisfies GraphFetchResult;
      }
      if (handle === "publichandle") {
        return ok({
          business_discovery: {
            username: "publichandle",
            followers_count: 10000,
            media_count: 50,
            id: "777888999",
          },
        });
      }
      throw new Error(`unexpected handle=${handle}`);
    });
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchPublicInstagramFollowerMap(["private_or_gone", "publichandle"]);

    // private_or_gone is absent (silently skipped), publichandle resolved.
    expect(map.has("private_or_gone")).toBe(false);
    expect(map.get("publichandle")).toEqual({ followers: 10000, mediaCount: 50 });
    expect(map.size).toBe(1);
  });

  it("returns empty map with NO network call when no token is configured (dark switch)", async () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    const spy = vi.fn();
    setFollowersGraphFetch(spy as unknown as GraphFetchFn);

    const map = await fetchPublicInstagramFollowerMap(["anyhandle"]);
    expect(spy).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it("strips leading @ and deduplicates/lowercases input handles before calling the API", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (path: string, params?: Record<string, string | number | undefined>) => {
      if (path.startsWith("me/accounts")) return DISCOVERY_RESPONSE;
      const fields = params?.fields as string | undefined;
      const handleMatch = fields?.match(/business_discovery\.username\(([^)]+)\)/);
      const handle = handleMatch?.[1];
      if (handle === "testuser") {
        return ok({
          business_discovery: {
            username: "testuser",
            followers_count: 500,
            media_count: 10,
            id: "123",
          },
        });
      }
      throw new Error(`unexpected handle=${handle}`);
    });
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    // "@TestUser", "TestUser", "testuser" are all the same after stripping + lowercasing + dedup.
    const map = await fetchPublicInstagramFollowerMap(["@TestUser", "TestUser", "testuser"]);

    // Exactly ONE API call for the deduplicated handle "testuser".
    // Total calls: 1 (discovery) + 1 (testuser) = 2
    expect(graph).toHaveBeenCalledTimes(2);
    expect(map.get("testuser")).toEqual({ followers: 500, mediaCount: 10 });
    expect(map.size).toBe(1);
  });

  it("returns partial map on rate-limit mid-run (stops early, no throw)", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    let callCount = 0;
    const graph = vi.fn(async (path: string, params?: Record<string, string | number | undefined>) => {
      if (path.startsWith("me/accounts")) return DISCOVERY_RESPONSE;
      callCount++;
      const fields = params?.fields as string | undefined;
      const handleMatch = fields?.match(/business_discovery\.username\(([^)]+)\)/);
      const handle = handleMatch?.[1];
      if (callCount === 1 && handle === "first") {
        return ok({
          business_discovery: {
            username: "first",
            followers_count: 1000,
            media_count: 5,
            id: "aaa",
          },
        });
      }
      // Second handle → rate-limited → stop.
      return { ok: false, rateLimited: true, status: 429, error: "rate limit" } satisfies GraphFetchResult;
    });
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchPublicInstagramFollowerMap(["first", "second"]);
    // "first" resolved before rate-limit; "second" absent.
    expect(map.get("first")).toEqual({ followers: 1000, mediaCount: 5 });
    expect(map.has("second")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("returns empty map if me/accounts discovery finds no IG node (fail-open)", async () => {
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    const graph = vi.fn(async (path: string) => {
      if (path.startsWith("me/accounts")) {
        // No instagram_business_account on any page.
        return ok({ data: [{ instagram_business_account: undefined }] });
      }
      throw new Error("should not be called");
    });
    setFollowersGraphFetch(graph as unknown as GraphFetchFn);

    const map = await fetchPublicInstagramFollowerMap(["anyhandle"]);
    expect(map.size).toBe(0);
    // Only discovery call was made; no per-handle calls.
    expect(graph).toHaveBeenCalledTimes(1);
  });
});
