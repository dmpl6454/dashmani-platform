/**
 * follower-sync.service.ts — unit tests for the three-tier sync logic.
 *
 * Tier 1 (administered Graph map + scrapers) is tested implicitly; these
 * tests focus on Tier 3 (public-API fallback) and the fail-open contract.
 *
 * Mocking strategy:
 *   - prisma: vi.mock via helpers.ts pattern (same as other service tests)
 *   - meta-followers module: vi.mock to control map contents per test
 *   - youtube-followers module: vi.mock to control results per test
 *   - Legacy scrapers (fetchInstagramFollowers etc.) are internal; we mock the
 *     map so accounts that ARE in the map never hit the scraper path.
 */

// FOLLOWER_SYNC_DELAY_MS=0 is set in vitest.config.ts so the sleep() calls in
// the scraper fallback paths of follower-sync.service.ts resolve immediately.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock prisma before importing the service ────────────────────────────────

vi.mock("@dashmani/db", () => ({
  prisma: {
    socialAccount: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    accountGrowthSnapshot: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@dashmani/shared", () => ({
  todayIST: vi.fn(() => new Date("2026-06-25T00:00:00+05:30")),
  istMidnight: vi.fn((d: Date) => d),
}));

// ── Mock ALL three resolver modules ────────────────────────────────────────

vi.mock("../src/services/social-insights/meta-followers", () => ({
  fetchInstagramFollowerMap: vi.fn(async () => new Map()),
  fetchFacebookFollowerMap: vi.fn(async () => new Map()),
  fetchPublicInstagramFollowerMap: vi.fn(async () => new Map()),
  fbLookupKeys: vi.fn((_handle: string, _profileUrl: string) => [] as string[]),
}));

vi.mock("../src/services/social-insights/youtube-followers", () => ({
  fetchYouTubeSubscriberCounts: vi.fn(async () => []),
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import { prisma } from "@dashmani/db";
import {
  fetchInstagramFollowerMap,
  fetchFacebookFollowerMap,
  fetchPublicInstagramFollowerMap,
  fbLookupKeys,
} from "../src/services/social-insights/meta-followers";
import { fetchYouTubeSubscriberCounts } from "../src/services/social-insights/youtube-followers";
import {
  syncAllFollowerCounts,
  syncSingleAccountFollowers,
} from "../src/services/follower-sync.service";

// ── Typed mock helpers ───────────────────────────────────────────────────────

const mockFindMany = prisma.socialAccount.findMany as ReturnType<typeof vi.fn>;
const mockFindUnique = prisma.socialAccount.findUnique as ReturnType<typeof vi.fn>;
const mockAccountUpdate = prisma.socialAccount.update as ReturnType<typeof vi.fn>;
const mockSnapshotFindUnique = prisma.accountGrowthSnapshot.findUnique as ReturnType<typeof vi.fn>;
const mockSnapshotCreate = prisma.accountGrowthSnapshot.create as ReturnType<typeof vi.fn>;
const mockSnapshotUpdate = prisma.accountGrowthSnapshot.update as ReturnType<typeof vi.fn>;

const mockFetchIgMap = fetchInstagramFollowerMap as ReturnType<typeof vi.fn>;
const mockFetchFbMap = fetchFacebookFollowerMap as ReturnType<typeof vi.fn>;
const mockFetchPublicIg = fetchPublicInstagramFollowerMap as ReturnType<typeof vi.fn>;
const mockFbLookupKeys = fbLookupKeys as ReturnType<typeof vi.fn>;
const mockFetchYt = fetchYouTubeSubscriberCounts as ReturnType<typeof vi.fn>;

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeAccount(overrides: {
  id: string;
  handle: string;
  profileUrl: string;
  platformSlug: string;
  followerCount?: number;
}) {
  return {
    id: overrides.id,
    handle: overrides.handle,
    profileUrl: overrides.profileUrl,
    followerCount: overrides.followerCount ?? 0,
    lastSyncedAt: null,
    platform: { slug: overrides.platformSlug },
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Stub global.fetch so the inline scrapers (fetchInstagramFollowers,
  // fetchFacebookFollowers) return quickly. A 503 triggers the `if (!res.ok)
  // return null` branch immediately — no 30s retry wait.
  // DELAY_MS is 0 in tests (set via vitest.config.ts FOLLOWER_SYNC_DELAY_MS=0)
  // so the sleep() calls after scraper invocations are no-ops.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "",
    }),
  );

  // Default: administered maps are EMPTY (so all accounts start unresolved)
  mockFetchIgMap.mockResolvedValue(new Map());
  mockFetchFbMap.mockResolvedValue(new Map());

  // Default: public resolvers return nothing
  mockFetchPublicIg.mockResolvedValue(new Map());
  mockFetchYt.mockResolvedValue([]);
  mockFbLookupKeys.mockReturnValue([]);

  // Default: snapshot does NOT exist yet → create path
  mockSnapshotFindUnique.mockResolvedValue(null);
  mockSnapshotCreate.mockResolvedValue({});
  mockSnapshotUpdate.mockResolvedValue({});
  mockAccountUpdate.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("syncAllFollowerCounts — Tier 3: public-API fallback", () => {
  // ── Instagram: public business_discovery hit ───────────────────────────────

  it("resolves IG account NOT in administered map via public-discovery and writes the count", async () => {
    const account = makeAccount({
      id: "acc-ig-1",
      handle: "bollywoodsocietyy",
      profileUrl: "https://www.instagram.com/bollywoodsocietyy/",
      platformSlug: "instagram",
    });
    mockFindMany.mockResolvedValue([account]);

    // Tier 1 map is NON-EMPTY (Meta is reachable → Tier-3 is allowed) but does
    // NOT contain our account → unresolved after first pass.
    mockFetchIgMap.mockResolvedValue(
      new Map([["othaccount", { followers: 1, following: 1, posts: 1 }]]),
    );
    // Tier 3: public-discovery map has the real count.
    const publicMap = new Map([
      ["bollywoodsocietyy", { followers: 4600000, mediaCount: 12000 }],
    ]);
    mockFetchPublicIg.mockResolvedValue(publicMap);

    const result = await syncAllFollowerCounts();

    // Should have called the public resolver with the handle
    expect(mockFetchPublicIg).toHaveBeenCalledOnce();
    const igHandlesArg: string[] = mockFetchPublicIg.mock.calls[0][0];
    expect(igHandlesArg).toContain("bollywoodsocietyy");

    // Should have written 4,600,000 to the DB
    expect(mockAccountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "acc-ig-1" },
        data: expect.objectContaining({ followerCount: 4600000 }),
      }),
    );
    expect(mockSnapshotCreate).toHaveBeenCalledOnce();

    expect(result.updated).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("does NOT call public-IG resolver when all IG accounts are already in the administered map", async () => {
    const account = makeAccount({
      id: "acc-ig-2",
      handle: "@somehandle",
      profileUrl: "https://www.instagram.com/somehandle/",
      platformSlug: "instagram",
    });
    mockFindMany.mockResolvedValue([account]);

    // Tier 1 map has the account → resolved in first pass
    const igMap = new Map([["somehandle", { followers: 50000, following: 100, posts: 200 }]]);
    mockFetchIgMap.mockResolvedValue(igMap);

    await syncAllFollowerCounts();

    // No unresolved IG accounts → public resolver not called
    expect(mockFetchPublicIg).not.toHaveBeenCalled();
    expect(mockAccountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ followerCount: 50000 }) }),
    );
  });

  // ── Facebook: fbLookupKeys name-key match ──────────────────────────────────

  it("resolves FB account via fbLookupKeys display-name match and writes the count", async () => {
    const account = makeAccount({
      id: "acc-fb-1",
      handle: "Bollywood Society",
      profileUrl: "https://www.facebook.com/BollywoodSociety",
      platformSlug: "facebook",
    });
    mockFindMany.mockResolvedValue([account]);

    // FB map is keyed by display name (lowercased). The old slug-only lookup
    // misses this; fbLookupKeys now includes the handle as a candidate key.
    const fbMap = new Map([["bollywood society", { followers: 14163052 }]]);
    mockFetchFbMap.mockResolvedValue(fbMap);

    // fbLookupKeys returns the display-name as one of the candidate keys
    mockFbLookupKeys.mockReturnValue(["bollywoodsociety", "bollywood society"]);

    const result = await syncAllFollowerCounts();

    expect(mockFbLookupKeys).toHaveBeenCalledWith("Bollywood Society", "https://www.facebook.com/BollywoodSociety");

    expect(mockAccountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "acc-fb-1" },
        data: expect.objectContaining({ followerCount: 14163052 }),
      }),
    );
    expect(result.updated).toBe(1);
  });

  it("does NOT call fetchFacebookFollowerMap a second time for the FB Tier 3 pass (reuses existing map)", async () => {
    const account = makeAccount({
      id: "acc-fb-2",
      handle: "UnmatchedPage",
      profileUrl: "https://www.facebook.com/UnmatchedPage",
      platformSlug: "facebook",
    });
    mockFindMany.mockResolvedValue([account]);

    // fbLookupKeys returns no keys → account stays unresolved
    mockFbLookupKeys.mockReturnValue([]);

    await syncAllFollowerCounts();

    // fetchFacebookFollowerMap must only be called ONCE (at the top of the sync,
    // not again in the Tier 3 pass — we reuse the same map)
    expect(mockFetchFbMap).toHaveBeenCalledOnce();
  });

  // ── YouTube: public-API resolver ──────────────────────────────────────────

  it("resolves YouTube account via fetchYouTubeSubscriberCounts and writes the count", async () => {
    const account = makeAccount({
      id: "acc-yt-1",
      handle: "@SomeYouTubeChannel",
      profileUrl: "https://www.youtube.com/@SomeYouTubeChannel",
      platformSlug: "youtube",
    });
    mockFindMany.mockResolvedValue([account]);

    // Tier 3 YouTube resolver returns subscriber count
    mockFetchYt.mockResolvedValue([{ accountId: "acc-yt-1", subscribers: 553000 }]);

    const result = await syncAllFollowerCounts();

    expect(mockFetchYt).toHaveBeenCalledOnce();
    const ytAccountsArg = mockFetchYt.mock.calls[0][0];
    expect(ytAccountsArg).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "acc-yt-1" }),
      ]),
    );

    expect(mockAccountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "acc-yt-1" },
        data: expect.objectContaining({ followerCount: 553000 }),
      }),
    );
    expect(mockSnapshotCreate).toHaveBeenCalledOnce();
    expect(result.updated).toBe(1);
    expect(result.failed).toBe(0);
  });

  // ── Fully unresolved account: no write, counts tracked ────────────────────

  it("does NOT write a zero or null follower count when all tiers miss an IG account", async () => {
    const account = makeAccount({
      id: "acc-ig-miss",
      handle: "ghost_account_xyz",
      profileUrl: "https://www.instagram.com/ghost_account_xyz/",
      platformSlug: "instagram",
      followerCount: 5000, // prior stored value
    });
    mockFindMany.mockResolvedValue([account]);

    // Tier-1 map is NON-EMPTY (so Tier-3 IG is actually invoked — see the
    // igFollowerMap.size>0 guard) but does NOT contain our ghost account.
    mockFetchIgMap.mockResolvedValue(
      new Map([["someoneelse", { followers: 999, following: 1, posts: 1 }]]),
    );
    // Public-discovery (Tier-3) also misses → attempted-and-missed → failed.
    mockFetchPublicIg.mockResolvedValue(new Map());

    const result = await syncAllFollowerCounts();

    // Tier-3 IG WAS invoked (Tier-1 worked) and missed this account.
    expect(mockFetchPublicIg).toHaveBeenCalledOnce();

    // DB must NOT be updated (keeps prior value of 5000)
    expect(mockAccountUpdate).not.toHaveBeenCalled();
    expect(mockSnapshotCreate).not.toHaveBeenCalled();
    expect(mockSnapshotUpdate).not.toHaveBeenCalled();

    // Counted as failed (attempted-and-missed, not skipped)
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.updated).toBe(0);
  });

  it("does NOT write when YouTube resolver returns no result for an account", async () => {
    const account = makeAccount({
      id: "acc-yt-miss",
      handle: "@NoCountChannel",
      profileUrl: "https://www.youtube.com/@NoCountChannel",
      platformSlug: "youtube",
      followerCount: 10000,
    });
    mockFindMany.mockResolvedValue([account]);

    // Resolver returns empty array (account absent = unresolvable)
    mockFetchYt.mockResolvedValue([]);

    const result = await syncAllFollowerCounts();

    expect(mockAccountUpdate).not.toHaveBeenCalled();
    expect(result.updated).toBe(0);
    expect(result.failed).toBeGreaterThanOrEqual(1);
  });

  // ── Fail-open: public resolver throws ─────────────────────────────────────

  it("continues sync and does not abort when the public IG resolver throws", async () => {
    const ig = makeAccount({
      id: "acc-ig-throw",
      handle: "some_handle",
      profileUrl: "https://www.instagram.com/some_handle/",
      platformSlug: "instagram",
    });
    const yt = makeAccount({
      id: "acc-yt-ok",
      handle: "@WorkingChannel",
      profileUrl: "https://www.youtube.com/@WorkingChannel",
      platformSlug: "youtube",
    });
    mockFindMany.mockResolvedValue([ig, yt]);

    // Tier-1 map non-empty (Meta reachable) so Tier-3 IG is actually invoked.
    mockFetchIgMap.mockResolvedValue(
      new Map([["other", { followers: 1, following: 1, posts: 1 }]]),
    );
    // Public IG resolver throws; YouTube resolver works fine
    mockFetchPublicIg.mockRejectedValue(new Error("Meta is down"));
    mockFetchYt.mockResolvedValue([{ accountId: "acc-yt-ok", subscribers: 200000 }]);

    // Should NOT throw
    const result = await syncAllFollowerCounts();

    // Tier-3 IG WAS attempted (and threw — fail-open caught it)
    expect(mockFetchPublicIg).toHaveBeenCalledOnce();

    // YouTube account still resolved
    expect(mockAccountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "acc-yt-ok" },
        data: expect.objectContaining({ followerCount: 200000 }),
      }),
    );
    expect(result.updated).toBe(1);
  });

  it("continues sync and does not abort when the YouTube resolver throws", async () => {
    const yt = makeAccount({
      id: "acc-yt-throw",
      handle: "@ThrowingChannel",
      profileUrl: "https://www.youtube.com/@ThrowingChannel",
      platformSlug: "youtube",
    });
    const ig = makeAccount({
      id: "acc-ig-ok",
      handle: "working_ig",
      profileUrl: "https://www.instagram.com/working_ig/",
      platformSlug: "instagram",
    });
    mockFindMany.mockResolvedValue([yt, ig]);

    // Tier-1 map non-empty (Meta reachable) so Tier-3 IG is actually invoked.
    mockFetchIgMap.mockResolvedValue(
      new Map([["other", { followers: 1, following: 1, posts: 1 }]]),
    );
    // YouTube resolver throws; IG public resolver works fine
    mockFetchYt.mockRejectedValue(new Error("YouTube quota exceeded"));
    const publicMap = new Map([["working_ig", { followers: 123456, mediaCount: 500 }]]);
    mockFetchPublicIg.mockResolvedValue(publicMap);

    const result = await syncAllFollowerCounts();

    expect(mockAccountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "acc-ig-ok" },
        data: expect.objectContaining({ followerCount: 123456 }),
      }),
    );
    expect(result.updated).toBe(1);
  });

  // ── Snapshot: update vs create path ──────────────────────────────────────

  it("updates an existing snapshot instead of creating a new one when one exists for today", async () => {
    const account = makeAccount({
      id: "acc-yt-snap",
      handle: "@SnapChannel",
      profileUrl: "https://www.youtube.com/@SnapChannel",
      platformSlug: "youtube",
    });
    mockFindMany.mockResolvedValue([account]);
    mockFetchYt.mockResolvedValue([{ accountId: "acc-yt-snap", subscribers: 777000 }]);

    // Simulate an existing snapshot for today
    mockSnapshotFindUnique.mockResolvedValue({ id: "snap-existing-1" });

    await syncAllFollowerCounts();

    expect(mockSnapshotUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "snap-existing-1" },
        data: { followerCount: 777000 },
      }),
    );
    expect(mockSnapshotCreate).not.toHaveBeenCalled();
  });

  // ── Counter: skipped for manual-only platforms ────────────────────────────

  it("skips and counts manual-only platform accounts (tiktok, linkedin, etc.) without calling resolvers", async () => {
    const tiktok = makeAccount({
      id: "acc-tt-1",
      handle: "@someuser",
      profileUrl: "https://www.tiktok.com/@someuser",
      platformSlug: "tiktok",
    });
    mockFindMany.mockResolvedValue([tiktok]);

    const result = await syncAllFollowerCounts();

    expect(mockAccountUpdate).not.toHaveBeenCalled();
    expect(mockFetchPublicIg).not.toHaveBeenCalled();
    expect(mockFetchYt).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
  });

  // ── Mixed: Tier 1 hit + Tier 3 hit in same run ────────────────────────────

  it("writes Tier 1 resolved accounts immediately and Tier 3 resolved accounts after the batch call", async () => {
    const ig1 = makeAccount({
      id: "acc-ig-t1",
      handle: "administeredAccount",
      profileUrl: "https://www.instagram.com/administeredAccount/",
      platformSlug: "instagram",
    });
    const ig2 = makeAccount({
      id: "acc-ig-t3",
      handle: "publicOnlyAccount",
      profileUrl: "https://www.instagram.com/publicOnlyAccount/",
      platformSlug: "instagram",
    });
    mockFindMany.mockResolvedValue([ig1, ig2]);

    // Tier 1: ig1 is in the administered map
    const igMap = new Map([["administeredaccount", { followers: 200000, following: 50, posts: 300 }]]);
    mockFetchIgMap.mockResolvedValue(igMap);

    // Tier 3: ig2 is in the public-discovery map
    const publicMap = new Map([["publiconlyaccount", { followers: 50000, mediaCount: 100 }]]);
    mockFetchPublicIg.mockResolvedValue(publicMap);

    const result = await syncAllFollowerCounts();

    expect(result.updated).toBe(2);
    expect(result.failed).toBe(0);

    // Both accounts written
    const updateCalls = (mockAccountUpdate as ReturnType<typeof vi.fn>).mock.calls;
    const updatedIds = updateCalls.map((c: unknown[]) => (c[0] as { where: { id: string } }).where.id);
    expect(updatedIds).toContain("acc-ig-t1");
    expect(updatedIds).toContain("acc-ig-t3");

    // Public resolver was called (ig2 was unresolved after first pass)
    expect(mockFetchPublicIg).toHaveBeenCalledOnce();
  });

  // ── Rate-budget guard: empty Tier-1 map → skip Tier-3 IG entirely ─────────

  it("does NOT invoke the public-IG resolver when the Tier-1 administered map is EMPTY (Meta unavailable)", async () => {
    // Many IG accounts, all unresolved by Tier-1 (empty map = Meta down/limited).
    const accounts = Array.from({ length: 5 }, (_, i) =>
      makeAccount({
        id: `acc-ig-empty-${i}`,
        handle: `acct${i}`,
        profileUrl: `https://www.instagram.com/acct${i}/`,
        platformSlug: "instagram",
        followerCount: 1000 + i,
      }),
    );
    mockFindMany.mockResolvedValue(accounts);

    // Tier-1 map is EMPTY → signal that Meta is unavailable this run.
    mockFetchIgMap.mockResolvedValue(new Map());

    const result = await syncAllFollowerCounts();

    // Tier-3 must be skipped — do NOT pile ~N business_discovery calls onto an
    // already-rate-limited token (would starve the shared harvest budget).
    expect(mockFetchPublicIg).not.toHaveBeenCalled();

    // Skipped accounts stay as-is (fail-open) and are NOT counted as failed.
    expect(result.failed).toBe(0);
    expect(result.updated).toBe(0);
    expect(mockAccountUpdate).not.toHaveBeenCalled();
  });

  // ── Rate-budget guard: handles slice cap (30) ─────────────────────────────

  it("caps the number of IG handles sent to the public resolver at 30 even with a larger unresolved tail", async () => {
    // 50 unresolved IG accounts.
    const accounts = Array.from({ length: 50 }, (_, i) =>
      makeAccount({
        id: `acc-ig-cap-${i}`,
        handle: `capacct${i}`,
        profileUrl: `https://www.instagram.com/capacct${i}/`,
        platformSlug: "instagram",
      }),
    );
    mockFindMany.mockResolvedValue(accounts);

    // Tier-1 map non-empty (Meta reachable) but contains none of these accounts.
    mockFetchIgMap.mockResolvedValue(
      new Map([["someoneelse", { followers: 1, following: 1, posts: 1 }]]),
    );
    // Public resolver returns nothing (we only care about the input cap here).
    mockFetchPublicIg.mockResolvedValue(new Map());

    const result = await syncAllFollowerCounts();

    expect(mockFetchPublicIg).toHaveBeenCalledOnce();
    const handlesArg: string[] = mockFetchPublicIg.mock.calls[0][0];
    // No more than 30 handles attempted this run.
    expect(handlesArg.length).toBe(30);

    // Only the 30 ATTEMPTED-and-missed accounts count as failed; the deferred
    // 20 beyond the cap are NOT failed (not attempted this run).
    expect(result.failed).toBe(30);
    expect(result.updated).toBe(0);
  });
});

// ── syncSingleAccountFollowers — on-demand single refresh ──────────────────

describe("syncSingleAccountFollowers", () => {
  it("attempts the network even if a prior batch run left igRateLimited=true (refresh button must never silently no-op)", async () => {
    // 1) Force the module-level igRateLimited=true via a batch run that hits a
    //    429 mid-run. We stub fetch to return 429 twice (attempt 0 waits then
    //    retries, attempt 1 still limited → igRateLimited=true), with DELAY 0.
    const igAccount = makeAccount({
      id: "acc-ig-limit",
      handle: "limit_trigger",
      profileUrl: "https://www.instagram.com/limit_trigger/",
      platformSlug: "instagram",
    });
    mockFindMany.mockResolvedValue([igAccount]);
    // Empty Tier-1 map → goes to scraper. Scraper sees 429 → sets igRateLimited.
    mockFetchIgMap.mockResolvedValue(new Map());

    // fetch returns 429 on every call (the IG scraper: attempt0 429 → sleep(0) →
    // attempt1 429 → igRateLimited=true → returns null).
    const fetch429 = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetch429);

    await syncAllFollowerCounts();
    // After this run igRateLimited is true (the batch tripped it).

    // 2) Now a user clicks "refresh" on a single IG account. The success-path
    //    fetch returns a valid follower count. If the stale igRateLimited flag
    //    were honoured, fetchInstagramFollowers would bail to null WITHOUT a
    //    network call and the refresh would silently no-op.
    const successFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { user: { edge_followed_by: { count: 88888 } } } }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", successFetch);

    mockFindUnique.mockResolvedValue(
      makeAccount({
        id: "acc-refresh-1",
        handle: "refresh_me",
        profileUrl: "https://www.instagram.com/refresh_me/",
        platformSlug: "instagram",
      }),
    );

    const result = await syncSingleAccountFollowers("acc-refresh-1");

    // The IG profile-info endpoint MUST have been called (network attempted).
    expect(successFetch).toHaveBeenCalled();
    const calledUrl = successFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("web_profile_info");

    // And the resolved count is written.
    expect(result).toEqual(
      expect.objectContaining({ accountId: "acc-refresh-1", followers: 88888, updated: true }),
    );
    expect(mockAccountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "acc-refresh-1" },
        data: expect.objectContaining({ followerCount: 88888 }),
      }),
    );
  });
});
