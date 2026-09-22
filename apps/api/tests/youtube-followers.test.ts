import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchYouTubeSubscriberCounts,
  type YtAccountRef,
} from "../src/services/social-insights/youtube-followers";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a channels.list API response */
function channelsResponse(
  items: Array<{
    id: string;
    subscriberCount?: string;
    hiddenSubscriberCount?: boolean;
    /** Both arrive in the SAME part=statistics response we already request. */
    viewCount?: string;
    videoCount?: string;
  }>,
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      items: items.map(({ id, subscriberCount, hiddenSubscriberCount, viewCount, videoCount }) => ({
        id,
        statistics: {
          ...(hiddenSubscriberCount ? { hiddenSubscriberCount: true } : {}),
          ...(subscriberCount != null ? { subscriberCount } : {}),
          ...(viewCount != null ? { viewCount } : {}),
          ...(videoCount != null ? { videoCount } : {}),
        },
      })),
    }),
  };
}

/** Build a search.list API response */
function searchResponse(channelId: string | null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      items: channelId ? [{ snippet: { channelId } }] : [],
    }),
  };
}

/** Empty channels.list (deleted/terminated channel) */
function emptyChannelsResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ items: [] }),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.YOUTUBE_API_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.YOUTUBE_API_KEY;
});

// ── No API key ───────────────────────────────────────────────────────────────

describe("no API key", () => {
  it("returns [] and makes zero fetch calls", async () => {
    delete process.env.YOUTUBE_API_KEY;
    const fetchSpy = vi.spyOn(global, "fetch");

    const accounts: YtAccountRef[] = [
      { id: "acc1", handle: "UCabc12345678901234567890", profileUrl: "https://www.youtube.com/@Test" },
    ];
    const result = await fetchYouTubeSubscriberCounts(accounts);

    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Channel ID in handle (UC…) ────────────────────────────────────────────────

describe("channel ID present in handle", () => {
  it("batches channels.list?id= and parses subscriberCount from string", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";

    const CHANNEL_ID = "UCabc12345678901234567890";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      channelsResponse([{ id: CHANNEL_ID, subscriberCount: "10500000" }]) as unknown as Response,
    );

    const accounts: YtAccountRef[] = [
      { id: "acc1", handle: CHANNEL_ID, profileUrl: "https://www.youtube.com/@Test" },
    ];
    const result = await fetchYouTubeSubscriberCounts(accounts);

    expect(result).toMatchObject([{ accountId: "acc1", subscribers: 10_500_000 }]);

    // Should call channels.list with id= param (not forHandle or search)
    const url = (fetchSpy.mock.calls[0][0] as string);
    expect(url).toContain("/channels");
    expect(url).toContain(`id=${CHANNEL_ID}`);
    expect(url).not.toContain("forHandle");
    expect(url).not.toContain("/search");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("batches multiple UC… channel IDs in a single channels.list call", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";

    const ID1 = "UCabc12345678901234567890";
    const ID2 = "UCxyz12345678901234567890";

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      channelsResponse([
        { id: ID1, subscriberCount: "1000000" },
        { id: ID2, subscriberCount: "2000000" },
      ]) as unknown as Response,
    );

    const accounts: YtAccountRef[] = [
      { id: "acc1", handle: ID1, profileUrl: "https://www.youtube.com/@One" },
      { id: "acc2", handle: ID2, profileUrl: "https://www.youtube.com/@Two" },
    ];
    const result = await fetchYouTubeSubscriberCounts(accounts);

    // Both resolved in ONE batch call
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain(ID1);
    expect(url).toContain(ID2);

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.accountId === "acc1")).toMatchObject({ subscribers: 1_000_000 });
    expect(result.find((r) => r.accountId === "acc2")).toMatchObject({ subscribers: 2_000_000 });
  });
});

// ── The statistics that ride along in the SAME response ──────────────────────

describe("channel statistics beyond the subscriber count", () => {
  it("carries viewCount/videoCount/channelId without making an extra call", async () => {
    // These arrive in the part=statistics response the resolver already requested, so
    // persisting them costs ZERO additional quota. They were previously parsed and thrown
    // away, which is why YouTube had no exact growth basis at all.
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    const CHANNEL_ID = "UCstats1234567890123456ab";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      channelsResponse([
        { id: CHANNEL_ID, subscriberCount: "10500000", viewCount: "238418824", videoCount: "6240" },
      ]) as unknown as Response,
    );

    const result = await fetchYouTubeSubscriberCounts([
      { id: "acc1", handle: CHANNEL_ID, profileUrl: "" },
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1); // no second call for the extras
    expect(result[0]).toMatchObject({
      accountId: "acc1",
      subscribers: 10_500_000,
      channelId: CHANNEL_ID,
      totalViews: 238_418_824,
      videoCount: 6240,
    });
  });

  it("reports the rounding step YouTube applied, so a sub-step delta can be suppressed", async () => {
    // ⚠️ YouTube publishes 3 significant figures. 10,500,000 moves in steps of 100,000, so
    // a channel can gain 90,000 real subscribers and show no change at all. Storing the
    // step is what lets the UI render "—" instead of asserting "did not grow".
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      channelsResponse([
        { id: "UCbig12345678901234567890", subscriberCount: "10500000" },
      ]) as unknown as Response,
    );
    const big = await fetchYouTubeSubscriberCounts([
      { id: "a", handle: "UCbig12345678901234567890", profileUrl: "" },
    ]);
    expect(big[0].subscriberPrecision).toBe(100_000);

    vi.restoreAllMocks();
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      channelsResponse([{ id: "UCsml12345678901234567890", subscriberCount: "25" }]) as unknown as Response,
    );
    const small = await fetchYouTubeSubscriberCounts([
      { id: "b", handle: "UCsml12345678901234567890", profileUrl: "" },
    ]);
    // Under 1,000 YouTube does not round — the figure is exact, so nothing is suppressed.
    expect(small[0].subscriberPrecision).toBeNull();
  });
});

// ── Channel ID only in profile_url ────────────────────────────────────────────

describe("channel ID only in profile_url (handle is a display name)", () => {
  it("parses UC… channel ID from profile_url and uses channels.list?id=", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";

    const CHANNEL_ID = "UCdef12345678901234567890";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      channelsResponse([{ id: CHANNEL_ID, subscriberCount: "5000000" }]) as unknown as Response,
    );

    const accounts: YtAccountRef[] = [
      {
        id: "acc1",
        handle: "IndieNewsOfficial", // display name, NOT a UC… id
        profileUrl: `https://www.youtube.com/channel/${CHANNEL_ID}`,
      },
    ];
    const result = await fetchYouTubeSubscriberCounts(accounts);

    expect(result).toMatchObject([{ accountId: "acc1", subscribers: 5_000_000 }]);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain(`id=${CHANNEL_ID}`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Deleted / terminated channel ──────────────────────────────────────────────

describe("channels.list returns empty items (deleted channel)", () => {
  it("omits the account from results without throwing", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";

    const CHANNEL_ID = "UCdeleted1234567890123456";
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      emptyChannelsResponse() as unknown as Response,
    );

    const accounts: YtAccountRef[] = [
      { id: "acc1", handle: CHANNEL_ID, profileUrl: "https://www.youtube.com/channel/UCdeleted1234567890123456" },
    ];
    const result = await fetchYouTubeSubscriberCounts(accounts);

    expect(result).toEqual([]);
  });
});

// ── hiddenSubscriberCount ────────────────────────────────────────────────────

describe("hiddenSubscriberCount", () => {
  it("omits accounts with hiddenSubscriberCount:true — does NOT return 0", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";

    const CHANNEL_ID = "UChidden12345678901234567";
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      channelsResponse([{ id: CHANNEL_ID, hiddenSubscriberCount: true }]) as unknown as Response,
    );

    const accounts: YtAccountRef[] = [
      { id: "acc1", handle: CHANNEL_ID, profileUrl: "https://www.youtube.com/channel/UChidden12345678901234567" },
    ];
    const result = await fetchYouTubeSubscriberCounts(accounts);

    expect(result).toEqual([]);
    // Confirm no entry with subscribers=0
    expect(result.some((r) => r.subscribers === 0)).toBe(false);
  });
});

// ── forHandle → falls through to search.list ─────────────────────────────────

describe("handle with no channel ID: forHandle empty → search.list fallback", () => {
  it("resolves channelId via search.list when forHandle returns empty, then fetches stats", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";

    const RESOLVED_ID = "UCsearch1234567890123456";
    const fetchSpy = vi.spyOn(global, "fetch")
      // Step 1: forHandle → empty
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      } as unknown as Response)
      // Step 2: search.list → channelId
      .mockResolvedValueOnce(
        searchResponse(RESOLVED_ID) as unknown as Response,
      )
      // Step 3: channels.list with resolved id → stats
      .mockResolvedValueOnce(
        channelsResponse([{ id: RESOLVED_ID, subscriberCount: "10500000" }]) as unknown as Response,
      );

    const accounts: YtAccountRef[] = [
      { id: "acc1", handle: "@IndeNewsOfficial", profileUrl: "https://www.youtube.com/@IndeNewsOfficial" },
    ];
    const result = await fetchYouTubeSubscriberCounts(accounts);

    expect(result).toMatchObject([{ accountId: "acc1", subscribers: 10_500_000 }]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Step 1 uses forHandle
    const step1Url = fetchSpy.mock.calls[0][0] as string;
    expect(step1Url).toContain("forHandle");
    // Step 2 uses search
    const step2Url = fetchSpy.mock.calls[1][0] as string;
    expect(step2Url).toContain("/search");
    // Step 3 uses channels?id=
    const step3Url = fetchSpy.mock.calls[2][0] as string;
    expect(step3Url).toContain(`id=${RESOLVED_ID}`);
  });
});

// ── maxSearchLookups cap ──────────────────────────────────────────────────────

describe("maxSearchLookups cap", () => {
  it("with cap=1 and 2 search-needing accounts, only 1 search.list call is made; the 2nd is absent", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";

    const RESOLVED_ID = "UCsearchCapped12345678901";

    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = input as string;
      if (url.includes("forHandle")) {
        // Both forHandle calls return empty → search fallback needed
        return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
      }
      if (url.includes("/search")) {
        // First (and only) search.list allowed by cap
        return searchResponse(RESOLVED_ID) as unknown as Response;
      }
      if (url.includes("/channels") && url.includes("id=")) {
        // channels.list for the resolved id
        return channelsResponse([{ id: RESOLVED_ID, subscriberCount: "3000000" }]) as unknown as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const accounts: YtAccountRef[] = [
      { id: "acc1", handle: "@NeedsSearch1", profileUrl: "https://www.youtube.com/@NeedsSearch1" },
      { id: "acc2", handle: "@NeedsSearch2", profileUrl: "https://www.youtube.com/@NeedsSearch2" },
    ];

    const result = await fetchYouTubeSubscriberCounts(accounts, { maxSearchLookups: 1 });

    // Only one account resolved (the one that got the search.list call)
    expect(result).toHaveLength(1);
    expect(result[0].subscribers).toBe(3_000_000);

    // Exactly 1 search.list call was made
    const searchCalls = fetchSpy.mock.calls.filter(([url]) =>
      (url as string).includes("/search"),
    );
    expect(searchCalls).toHaveLength(1);

    // acc2 absent — no entry at all
    const resolvedIds = result.map((r) => r.accountId);
    expect(resolvedIds).not.toContain("acc2");
  });
});
