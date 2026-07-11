/**
 * twitter-followers.ts — unit tests for the X/Twitter guest-token GraphQL
 * follower resolver.
 *
 * Response shapes below are taken from a LIVE probe against the real X
 * endpoint on 2026-07-10/11 (elonmusk / NASA / a dead handle) — not guessed.
 * See apps/api/src/services/social-insights/twitter-followers.ts for the
 * ⚠️ rotation warning on the bearer token + GraphQL query id.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  parseTwitterFollowersResponse,
  fetchTwitterFollowerMap,
} from "../src/services/social-insights/twitter-followers";

// ── parseTwitterFollowersResponse: pure function, no network ────────────────

describe("parseTwitterFollowersResponse", () => {
  it("extracts followers_count from a real successful UserByScreenName response", () => {
    // Trimmed live shape (NASA, live-probed 2026-07-11) — full response has many
    // more sibling fields under legacy/result, only followers_count matters here.
    const json = {
      data: {
        user: {
          result: {
            __typename: "User",
            id: "VXNlcjoxMTM0ODI4Mg==",
            legacy: {
              created_at: "Wed Dec 19 20:20:32 +0000 2007",
              followers_count: 92162226,
              friends_count: 119,
              name: "NASA",
              screen_name: "NASA",
            },
          },
        },
      },
    };

    expect(parseTwitterFollowersResponse(json)).toBe(92162226);
  });

  it("returns null for the empty {\"data\":{}} shape (dead/renamed/suspended handle)", () => {
    const json = { data: {} };

    expect(parseTwitterFollowersResponse(json)).toBeNull();
  });

  it("extracts followers_count even when a DependencyError is present in errors[], as long as legacy is populated", () => {
    const json = {
      data: {
        user: {
          result: {
            __typename: "User",
            legacy: {
              followers_count: 12345,
            },
          },
        },
      },
      errors: [
        {
          message: "Dependency Error",
          code: 131,
          kind: "DependencyError",
        },
      ],
    };

    expect(parseTwitterFollowersResponse(json)).toBe(12345);
  });

  it("returns null when data.user is null", () => {
    const json = { data: { user: null } };

    expect(parseTwitterFollowersResponse(json)).toBeNull();
  });

  it("returns null for a malformed/garbage response instead of throwing", () => {
    expect(parseTwitterFollowersResponse(null)).toBeNull();
    expect(parseTwitterFollowersResponse(undefined)).toBeNull();
    expect(parseTwitterFollowersResponse("not even an object")).toBeNull();
    expect(parseTwitterFollowersResponse({})).toBeNull();
    expect(parseTwitterFollowersResponse({ data: { user: { result: {} } } })).toBeNull();
    expect(
      parseTwitterFollowersResponse({ data: { user: { result: { legacy: {} } } } }),
    ).toBeNull();
  });

  it("returns null for a non-positive followers_count (defensive — never seen live, but must not crash or report garbage)", () => {
    expect(
      parseTwitterFollowersResponse({
        data: { user: { result: { legacy: { followers_count: 0 } } } },
      }),
    ).toBeNull();
    expect(
      parseTwitterFollowersResponse({
        data: { user: { result: { legacy: { followers_count: -5 } } } },
      }),
    ).toBeNull();
  });
});

// ── fetchTwitterFollowerMap: network flow, fetch mocked ─────────────────────

describe("fetchTwitterFollowerMap", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TWITTER_FOLLOWER_SYNC_ENABLED;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("activates one guest token, resolves multiple handles, and returns a map keyed by lowercased handle", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("guest/activate")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ guest_token: "guest-token-abc" }),
        } as Response;
      }
      if (u.includes("NASA")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { user: { result: { legacy: { followers_count: 92162226 } } } },
          }),
        } as Response;
      }
      if (u.includes("elonmusk")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { user: { result: { legacy: { followers_count: 240783301 } } } },
          }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ data: {} }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const map = await fetchTwitterFollowerMap(["NASA", "elonmusk"]);

    expect(map.get("nasa")).toBe(92162226);
    expect(map.get("elonmusk")).toBe(240783301);
    expect(map.size).toBe(2);

    // Exactly one guest-token activation call for the whole batch.
    const activationCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("guest/activate"),
    );
    expect(activationCalls).toHaveLength(1);
  });

  it("omits a handle that resolves to the empty {\"data\":{}} shape (dead handle) without affecting other handles", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("guest/activate")) {
        return { ok: true, status: 200, json: async () => ({ guest_token: "t" }) } as Response;
      }
      if (u.includes("deadhandle")) {
        return { ok: true, status: 200, json: async () => ({ data: {} }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { user: { result: { legacy: { followers_count: 500 } } } },
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const map = await fetchTwitterFollowerMap(["deadhandle", "livehandle"]);

    expect(map.has("deadhandle")).toBe(false);
    expect(map.get("livehandle")).toBe(500);
  });

  it("does not abort the batch when one handle's request throws (per-handle fail-open)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("guest/activate")) {
        return { ok: true, status: 200, json: async () => ({ guest_token: "t" }) } as Response;
      }
      if (u.includes("throwshandle")) {
        throw new Error("network blip");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { user: { result: { legacy: { followers_count: 777 } } } },
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const map = await fetchTwitterFollowerMap(["throwshandle", "okhandle"]);

    expect(map.has("throwshandle")).toBe(false);
    expect(map.get("okhandle")).toBe(777);
  });

  it("returns an empty map and makes zero fetch calls when TWITTER_FOLLOWER_SYNC_ENABLED=0 (kill switch)", async () => {
    process.env.TWITTER_FOLLOWER_SYNC_ENABLED = "0";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const map = await fetchTwitterFollowerMap(["NASA"]);

    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an empty map (never throws) when guest-token activation fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("guest/activate")) {
        return { ok: false, status: 503, json: async () => ({}) } as Response;
      }
      throw new Error("should never reach a per-handle call without a guest token");
    });
    vi.stubGlobal("fetch", fetchMock);

    const map = await fetchTwitterFollowerMap(["NASA"]);

    expect(map.size).toBe(0);
  });

  it("returns an empty map (never throws) when guest-token activation itself throws", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("guest/activate")) {
        throw new Error("DNS blip");
      }
      throw new Error("should never reach a per-handle call without a guest token");
    });
    vi.stubGlobal("fetch", fetchMock);

    const map = await fetchTwitterFollowerMap(["NASA"]);

    expect(map.size).toBe(0);
  });

  it("returns an empty map immediately for an empty handles array without activating a guest token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const map = await fetchTwitterFollowerMap([]);

    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
