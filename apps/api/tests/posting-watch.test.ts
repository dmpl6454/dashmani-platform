/**
 * Posting watch — the poller tick and the dashboard payload against a real database, with
 * only the Meta fetcher mocked (oauthGraphFetch). Every instant is an explicit IST time
 * passed as `now`, so nothing depends on when the suite runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@dashmani/db";

vi.mock("../src/services/meta-oauth/oauth-graph", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/services/meta-oauth/oauth-graph")>();
  return { ...orig, oauthGraphFetch: vi.fn() };
});

import { oauthGraphFetch, type OauthGraphResult } from "../src/services/meta-oauth/oauth-graph";
import { encryptToken } from "../src/utils/token-crypto";
import {
  POSTING_WATCH_MODE_KEY,
  getPostingWatch,
  invalidatePostingWatchCache,
  loadMonitoredSet,
  resetPostingWatchStateForTests,
  runPostingWatchTick,
} from "../src/services/meta-oauth/posting-watch.service";
import "./setup";

const mockedFetch = vi.mocked(oauthGraphFetch);
const ist = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00.000+05:30`);
const D = "2026-10-05";
const graphTime = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "+0000");
const USAGE_OP = "meta-oauth:posting-watch";

function okFeed(posts: Array<{ id: string; at: Date; url?: string }>, usage: OauthGraphResult["usage"] = null): OauthGraphResult {
  return {
    ok: true,
    rateLimited: false,
    authInvalid: false,
    status: 200,
    usage,
    data: { data: posts.map((p) => ({ id: p.id, created_time: graphTime(p.at), timestamp: graphTime(p.at), permalink_url: p.url, permalink: p.url })) },
  };
}

function fail(over: Partial<OauthGraphResult>): OauthGraphResult {
  return { ok: false, rateLimited: false, authInvalid: false, status: 400, usage: null, error: "boom", ...over };
}

/** path → response factory. */
let feeds: Map<string, () => OauthGraphResult>;
/** Graph paths nobody set a feed for. The service swallows a failing check by design, so
 *  a stray call could not fail a test by throwing — afterEach asserts this stays empty. */
let unexpected: string[];

const tick = (at: Date) => runPostingWatchTick({ now: at, skipConfigCheck: true });
const read = (at: Date) => getPostingWatch({ now: at });

interface Estate {
  admin: { id: string };
  asha: { id: string };
  ravi: { id: string };
  conn: { id: string };
  fb: { id: string; metaId: string };
  ig: { id: string; metaId: string };
  igAccountId: string;
  fbAccountId: string;
  platforms: { facebook: string; instagram: string };
}

let n = 0;
async function makeUser(name: string) {
  return prisma.user.create({ data: { name, email: `pw-${++n}-${name.toLowerCase()}@zz.test`, passwordHash: "x", status: "ACTIVE" } });
}

async function makeAccount(platformId: string, displayName: string, handle = displayName) {
  return prisma.socialAccount.create({ data: { handle, displayName, platformId, status: "ACTIVE" } });
}

async function assign(accountId: string, employeeId: string, assignedBy: string) {
  return prisma.accountAssignment.create({ data: { accountId, employeeId, assignedBy } });
}

/** Bollywood Chronicle on Facebook (assigned to Asha) and Instagram (Asha + Ravi), plus
 *  an UNASSIGNED Facebook Page and one linked to nothing — the noise that must be ignored. */
async function seedEstate(): Promise<Estate> {
  const admin = await makeUser("Admin");
  const asha = await makeUser("Asha");
  const ravi = await makeUser("Ravi");
  const fbP = await prisma.platform.create({ data: { name: "Facebook", slug: "facebook" } });
  const igP = await prisma.platform.create({ data: { name: "Instagram", slug: "instagram" } });
  const fbAcc = await makeAccount(fbP.id, "Bollywood Chronicle");
  const igAcc = await makeAccount(igP.id, "Bollywood Chronicle", "bollywoodchronicle");
  const loose = await makeAccount(fbP.id, "Unassigned Page");
  await assign(fbAcc.id, asha.id, admin.id);
  await assign(igAcc.id, asha.id, admin.id);
  await assign(igAcc.id, ravi.id, admin.id);

  const conn = await prisma.metaConnection.create({
    data: { metaUserId: `mu-pw-${++n}`, connectedById: admin.id, status: "ACTIVE", userTokenEnc: encryptToken("user-token") },
  });
  const fb = await prisma.metaAsset.create({
    data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "1001", name: "Bollywood Chronicle", username: "BollywoodChronicle", followerCount: 900, socialAccountId: fbAcc.id, pageTokenEnc: encryptToken("page-token-1001") },
  });
  const ig = await prisma.metaAsset.create({
    data: { connectionId: conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: "17841400000000001", name: "Bollywood Chronicle", username: "bollywoodchronicle", followerCount: 800, socialAccountId: igAcc.id },
  });
  await prisma.metaAsset.create({
    data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "2002", name: "Unassigned Page", socialAccountId: loose.id, pageTokenEnc: encryptToken("page-token-2002") },
  });
  await prisma.metaAsset.create({
    data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "3003", name: "Never Linked", pageTokenEnc: encryptToken("page-token-3003") },
  });
  return { admin, asha, ravi, conn, fb, ig, igAccountId: igAcc.id, fbAccountId: fbAcc.id, platforms: { facebook: fbP.id, instagram: igP.id } };
}

const FB_PATH = "1001/published_posts";
const IG_PATH = "17841400000000001/media";

describe("posting watch — poller and dashboard payload", () => {
  let e: Estate;

  beforeEach(async () => {
    resetPostingWatchStateForTests();
    invalidatePostingWatchCache();
    mockedFetch.mockReset();
    feeds = new Map();
    unexpected = [];
    mockedFetch.mockImplementation(async (path) => {
      const f = feeds.get(String(path));
      if (!f) {
        unexpected.push(String(path));
        return fail({ status: 0, error: "unexpected call in test" });
      }
      return f();
    });
    await prisma.apiUsage.deleteMany({ where: { operation: { startsWith: USAGE_OP } } });
    await prisma.systemSetting.deleteMany({ where: { key: POSTING_WATCH_MODE_KEY } });
    e = await seedEstate();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await prisma.systemSetting.deleteMany({ where: { key: POSTING_WATCH_MODE_KEY } });
    await prisma.apiUsage.deleteMany({ where: { operation: { startsWith: USAGE_OP } } });
    expect(unexpected).toEqual([]);
  });

  it("checks ONLY the Pages behind assigned channels, with the right token and a tiny request", async () => {
    feeds.set(FB_PATH, () => okFeed([{ id: "1001_9", at: ist(D, "10:10"), url: "https://www.facebook.com/reel/9" }]));
    feeds.set(IG_PATH, () => okFeed([{ id: "ig-1", at: ist(D, "08:00"), url: "https://www.instagram.com/reel/A/" }]));

    const r = await tick(ist(D, "10:30"));
    expect(r).toMatchObject({ status: "ran", checked: 2, calls: 2, failed: 0, wrote: true });

    const calls = mockedFetch.mock.calls.map(([path, params, token, opts]) => ({ path, params, token, opts }));
    expect(calls.map((c) => c.path).sort()).toEqual([FB_PATH, IG_PATH]);
    const fbCall = calls.find((c) => c.path === FB_PATH)!;
    const igCall = calls.find((c) => c.path === IG_PATH)!;
    expect(fbCall.token).toBe("page-token-1001"); // FB: the Page's own token
    expect(igCall.token).toBe("user-token"); // IG: the connection's user token
    expect(fbCall.params).toMatchObject({ fields: "id,created_time,permalink_url", limit: 3 });
    expect(igCall.params).toMatchObject({ fields: "id,timestamp,permalink", limit: 4 });
    expect(typeof (fbCall.params as { until?: unknown }).until).toBe("number");
    expect(fbCall.opts).toMatchObject({ recordUsage: false, label: "posting-watch-fb" });
    expect(igCall.opts).toMatchObject({ recordUsage: false, label: "posting-watch-ig" });

    const p = await read(new Date(ist(D, "10:30").getTime() + 1_000));
    expect(p.status).toBe("ok");
    expect(p.counts).toMatchObject({ monitored: 2, onSchedule: 1, quiet_today: 1, verifying: 0, cant_check: 0, not_connected: 0 });
    expect(p.channels).toHaveLength(1);
    expect(p.channels[0]).toMatchObject({
      platform: "instagram",
      name: "Bollywood Chronicle",
      href: "https://www.instagram.com/bollywoodchronicle/",
      group: "quiet_today",
      silentSince: ist(D, "08:00").toISOString(),
      lastPostAt: ist(D, "08:00").toISOString(),
      lastPostUrl: "https://www.instagram.com/reel/A/",
    });
    expect(p.channels[0].assignees.map((a) => a.name)).toEqual(["Asha", "Ravi"]);
  });

  it("a channel drops off as soon as a re-check finds a new post", async () => {
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "10:10") }]));
    feeds.set(IG_PATH, () => okFeed([{ id: "old", at: ist(D, "08:00") }]));
    await tick(ist(D, "10:30"));
    expect((await read(ist(D, "10:31"))).counts.quiet_today).toBe(1);

    // 'Quiet today' is re-checked every 3 minutes; FB is not due (its deadline is 12:10).
    mockedFetch.mockClear();
    feeds.set(IG_PATH, () => okFeed([{ id: "new", at: ist(D, "10:32") }]));
    const r = await tick(ist(D, "10:34"));
    expect(r).toMatchObject({ status: "ran", checked: 1 });
    expect(mockedFetch.mock.calls.map(([path]) => path)).toEqual([IG_PATH]);
    const p = await read(ist(D, "10:35"));
    expect(p.channels).toEqual([]);
    expect(p.counts).toMatchObject({ monitored: 2, onSchedule: 2, quiet_today: 0 });
  });

  it("a channel past its deadline is NEVER listed before Meta confirms it — only counted as verifying", async () => {
    // No check has run yet: both Chronicle Pages are past the day's first deadline (09:00).
    const p = await read(ist(D, "10:31"));
    expect(p.channels).toEqual([]);
    expect(p.counts).toMatchObject({ monitored: 2, verifying: 2, quiet_today: 0, no_post_today: 0, inactive: 0, cant_check: 0 });
    expect(p.monitor.verifyingSince).toBe(ist(D, "09:00").toISOString());
  });

  it("stores exact instants and updates each Page's row in place", async () => {
    feeds.set(FB_PATH, () => okFeed([{ id: "1001_1", at: ist(D, "10:10"), url: "https://www.facebook.com/reel/1" }]));
    feeds.set(IG_PATH, () => okFeed([{ id: "ig-1", at: ist(D, "08:00") }]));
    await tick(ist(D, "10:30"));
    const first = await prisma.metaPostWatch.findMany({ orderBy: { metaId: "asc" } });
    expect(first.map((w) => [w.kind, w.metaId, w.lastPostAt?.toISOString(), w.checkedAt?.toISOString(), w.lastPostId])).toEqual([
      ["FACEBOOK_PAGE", "1001", ist(D, "10:10").toISOString(), ist(D, "10:30").toISOString(), "1001_1"],
      ["INSTAGRAM_ACCOUNT", "17841400000000001", ist(D, "08:00").toISOString(), ist(D, "10:30").toISOString(), "ig-1"],
    ]);

    feeds.set(IG_PATH, () => fail({ status: 0, error: "The operation was aborted due to timeout" }));
    await tick(ist(D, "10:33"));
    const ig = await prisma.metaPostWatch.findUniqueOrThrow({ where: { kind_metaId: { kind: "INSTAGRAM_ACCOUNT", metaId: "17841400000000001" } } });
    const igBefore = first.find((w) => w.kind === "INSTAGRAM_ACCOUNT")!;
    expect(ig.id).toBe(igBefore.id); // updated, not re-inserted
    expect(ig.createdAt.toISOString()).toBe(igBefore.createdAt.toISOString());
    expect(ig).toMatchObject({ errorKind: "unreachable", consecutiveErrors: 1, error: "The operation was aborted due to timeout" });
    expect(ig.attemptedAt?.toISOString()).toBe(ist(D, "10:33").toISOString());
    expect(ig.checkedAt?.toISOString()).toBe(ist(D, "10:30").toISOString()); // the last SUCCESS stands
    expect(ig.lastPostAt?.toISOString()).toBe(ist(D, "08:00").toISOString());
  });

  it("checks nothing outside 07:00–23:00 IST", async () => {
    expect(await tick(ist(D, "23:10"))).toEqual({ status: "skipped", reason: "closed" });
    expect(await tick(ist(D, "06:59"))).toEqual({ status: "skipped", reason: "closed" });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("is dark without the Meta OAuth configuration (as every other Meta cron)", async () => {
    expect(await runPostingWatchTick({ now: ist(D, "10:30") })).toEqual({ status: "skipped", reason: "unconfigured" });
  });

  it("unassigning a channel stops watching it", async () => {
    await prisma.accountAssignment.updateMany({ where: { accountId: e.igAccountId }, data: { unassignedAt: new Date() } });
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "10:10") }]));
    await tick(ist(D, "10:30"));
    expect(mockedFetch.mock.calls.map(([path]) => path)).toEqual([FB_PATH]);
    expect((await read(ist(D, "10:31"))).counts.monitored).toBe(1);
  });

  it("an assignment to an inactive or deleted person does not count", async () => {
    await prisma.user.update({ where: { id: e.asha.id }, data: { status: "INACTIVE" } });
    await prisma.user.update({ where: { id: e.ravi.id }, data: { deletedAt: new Date() } });
    expect((await read(ist(D, "10:31"))).counts.monitored).toBe(0);
  });

  it("an assigned channel with no connected Page is listed as not connected, with its people", async () => {
    const pop = await makeAccount(e.platforms.facebook, "Bolly Pop");
    await assign(pop.id, e.ravi.id, e.admin.id);
    const p = await read(ist(D, "10:31"));
    expect(p.counts.not_connected).toBe(1);
    expect(p.notConnected).toEqual([
      { accountId: pop.id, platform: "facebook", name: "Bolly Pop", handle: "Bolly Pop", reason: "no_page", assignees: [{ id: e.ravi.id, name: "Ravi" }] },
    ]);
  });

  it("the registry's profile link is read: a typo'd handle still finds its Instagram account", async () => {
    // Prod: handle "papsnap" (someone else's account), link instagram.com/pappsnap.
    const linked = await makeAccount(e.platforms.instagram, "Paps Snap", "pappsnap");
    const assigned = await prisma.socialAccount.create({
      data: { handle: "papsnap", displayName: "Pap Snap", profileUrl: "https://www.instagram.com/pappsnap?igsh=dHQ1", platformId: e.platforms.instagram, status: "ACTIVE" },
    });
    await assign(assigned.id, e.ravi.id, e.admin.id);
    await prisma.metaAsset.create({
      data: { connectionId: e.conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: "17841400000000099", name: "Pap Snap", username: "pappsnap", socialAccountId: linked.id },
    });
    const p = await read(ist(D, "10:31"));
    expect(p.counts).toMatchObject({ monitored: 3, not_connected: 0 });
  });

  it("a Page removed on Account Growth is not watched, even when its channel is assigned", async () => {
    await prisma.metaAsset.update({ where: { id: e.ig.id }, data: { selected: false } });
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "10:10") }]));
    await tick(ist(D, "10:30"));
    expect(mockedFetch.mock.calls.map(([path]) => path)).toEqual([FB_PATH]);
    const p = await read(ist(D, "10:31"));
    expect(p.counts).toMatchObject({ monitored: 1, not_connected: 1 });
    expect(p.notConnected[0].platform).toBe("instagram");
  });

  it("an assignment on a duplicate registry row still watches the connected Page (exact-name fallback)", async () => {
    // The Page is linked to an UNASSIGNED row; the assignment sits on a second row with the
    // same name — the registry's duplicate-row case seen on prod.
    const linked = await makeAccount(e.platforms.facebook, "paparazzziii");
    const assigned = await makeAccount(e.platforms.facebook, "Paparazzii");
    await assign(assigned.id, e.ravi.id, e.admin.id);
    await prisma.metaAsset.create({
      data: { connectionId: e.conn.id, kind: "FACEBOOK_PAGE", metaId: "4004", name: "Paparazzii", username: "paparazzziii", socialAccountId: linked.id, pageTokenEnc: encryptToken("page-token-4004") },
    });
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "10:10") }]));
    feeds.set(IG_PATH, () => okFeed([{ id: "i", at: ist(D, "10:10") }]));
    feeds.set("4004/published_posts", () => okFeed([{ id: "p", at: ist(D, "07:45") }]));
    await tick(ist(D, "10:30"));
    const p = await read(ist(D, "10:31"));
    expect(p.channels).toHaveLength(1);
    expect(p.channels[0]).toMatchObject({ name: "Paparazzii", group: "quiet_today", silentSince: ist(D, "07:45").toISOString() });
    expect(p.channels[0].assignees.map((a) => a.name)).toEqual(["Ravi"]);
  });

  it("two same-name Pages on one assigned channel: the channel is posting while EITHER posts", async () => {
    const insider = await makeAccount(e.platforms.facebook, "Bollywood Insider");
    await assign(insider.id, e.asha.id, e.admin.id);
    await prisma.metaAsset.create({
      data: { connectionId: e.conn.id, kind: "FACEBOOK_PAGE", metaId: "5001", name: "Bollywood Insider", followerCount: 1_924_046, socialAccountId: insider.id, pageTokenEnc: encryptToken("t-5001") },
    });
    await prisma.metaAsset.create({
      data: { connectionId: e.conn.id, kind: "FACEBOOK_PAGE", metaId: "5002", name: "Bollywood Insider", followerCount: 525_640, socialAccountId: insider.id, pageTokenEnc: encryptToken("t-5002") },
    });
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "10:10") }]));
    feeds.set(IG_PATH, () => okFeed([{ id: "i", at: ist(D, "10:10") }]));
    feeds.set("5001/published_posts", () => okFeed([{ id: "dormant", at: new Date("2026-07-30T12:00:00Z") }]));
    feeds.set("5002/published_posts", () => okFeed([{ id: "active", at: ist(D, "10:20") }]));

    await tick(ist(D, "10:30"));
    let p = await read(ist(D, "10:31"));
    expect(p.channels).toEqual([]); // the 1.9M-follower twin is dormant, but the channel posted at 10:20

    // Nothing new on either Page by the channel's deadline (12:20) → both are re-asked and
    // the channel is flagged, measured from the newest post on EITHER Page.
    mockedFetch.mockClear();
    const r = await tick(ist(D, "12:22"));
    expect(mockedFetch.mock.calls.map(([path]) => path).sort()).toEqual(["5001/published_posts", "5002/published_posts", FB_PATH, IG_PATH].sort());
    expect(r).toMatchObject({ status: "ran" });
    p = await read(ist(D, "12:23"));
    const insiderRow = p.channels.find((c) => c.name === "Bollywood Insider")!;
    expect(insiderRow).toMatchObject({ group: "quiet_today", silentSince: ist(D, "10:20").toISOString() });
    expect(insiderRow.pages.map((pg) => pg.metaId)).toEqual(["5001", "5002"]); // primary = most followers
  });

  it("lost Page access and dead tokens are 'can't check', never a gap", async () => {
    feeds.set(FB_PATH, () =>
      fail({ status: 400, authInvalid: true, errorCode: 190, errorSubcode: 492, error: "The user must be an administrator, editor, or moderator of the page" }),
    );
    await prisma.metaConnection.update({ where: { id: e.conn.id }, data: { userTokenEnc: null } });
    const r = await tick(ist(D, "10:30"));
    // IG had no token, so only the FB request left the process.
    expect(mockedFetch.mock.calls.map(([path]) => path)).toEqual([FB_PATH]);
    expect(r).toMatchObject({ status: "ran", checked: 2, calls: 1, failed: 2 });
    const p = await read(ist(D, "10:31"));
    expect(p.counts).toMatchObject({ cant_check: 2, quiet_today: 0, no_post_today: 0, inactive: 0 });
    const fb = p.channels.find((c) => c.platform === "facebook")!;
    expect(fb).toMatchObject({ group: "cant_check", errorKind: "permission" });
    expect(fb.errorDetail).toContain("administrator");
    expect(p.channels.find((c) => c.platform === "instagram")).toMatchObject({ group: "cant_check", errorKind: "token" });
  });

  it("an app-level throttle signal stops the rest of the tick at once, then pauses every check", async () => {
    feeds.set(FB_PATH, () => fail({ status: 403, rateLimited: true, errorCode: 4, error: "Application request limit reached" }));
    feeds.set(IG_PATH, () => okFeed([{ id: "i", at: ist(D, "10:10") }]));
    vi.stubEnv("POSTING_WATCH_CONCURRENCY", "1");
    const r1 = await tick(ist(D, "10:30"));
    // FB sorts first; after its code-4 answer the IG check in the same tick must not start.
    expect(mockedFetch.mock.calls.map(([path]) => path)).toEqual([FB_PATH]);
    expect(r1).toMatchObject({ status: "ran", checked: 1, calls: 1 });
    expect(await tick(ist(D, "10:31"))).toEqual({ status: "skipped", reason: "paused" });
    const p = await read(ist(D, "10:31"));
    expect(p.monitor.pausedUntil).not.toBeNull();
    // Nothing was confirmed, so nothing is listed: both channels are still being verified.
    expect(p.channels).toEqual([]);
    expect(p.counts.verifying).toBe(2);
  });

  it("app-wide usage at 75%+ (any of calls, CPU or time) pauses the same way", async () => {
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "10:10") }], { source: "app", callCountPct: 10, usagePct: 80, regainMinutes: null }));
    feeds.set(IG_PATH, () => okFeed([{ id: "i", at: ist(D, "10:10") }]));
    vi.stubEnv("POSTING_WATCH_CONCURRENCY", "1");
    await tick(ist(D, "10:30"));
    expect(mockedFetch.mock.calls.map(([path]) => path)).toEqual([FB_PATH]);
    expect(await tick(ist(D, "10:31"))).toEqual({ status: "skipped", reason: "paused" });
  });

  it("five rate-limited answers in one tick mean 'slow down' for everything", async () => {
    for (let i = 0; i < 5; i++) {
      const acc = await makeAccount(e.platforms.facebook, `Busy ${i}`);
      await assign(acc.id, e.asha.id, e.admin.id);
      await prisma.metaAsset.create({
        data: { connectionId: e.conn.id, kind: "FACEBOOK_PAGE", metaId: `700${i}`, name: `Busy ${i}`, socialAccountId: acc.id, pageTokenEnc: encryptToken(`t-700${i}`) },
      });
      feeds.set(`700${i}/published_posts`, () => fail({ status: 400, errorCode: 80001, error: "There have been too many calls to this Page account." }));
    }
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "10:10") }]));
    feeds.set(IG_PATH, () => okFeed([{ id: "i", at: ist(D, "10:10") }]));
    expect(await tick(ist(D, "10:30"))).toMatchObject({ status: "ran", failed: 5 });
    expect(await tick(ist(D, "10:31"))).toEqual({ status: "skipped", reason: "paused" });
  });

  it("a Page whose own usage header is high is left alone for a while", async () => {
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "08:00") }], { source: "buc", callCountPct: 90, usagePct: 90, regainMinutes: null }));
    feeds.set(IG_PATH, () => okFeed([{ id: "i", at: ist(D, "08:00") }]));
    await tick(ist(D, "10:30"));
    mockedFetch.mockClear();
    await tick(ist(D, "10:34")); // both are 'quiet today' and due a re-check …
    expect(mockedFetch.mock.calls.map(([path]) => path)).toEqual([IG_PATH]); // … but FB is cooling down
  });

  it("the Page back-off honours Meta's CPU/time usage and its own regain estimate", async () => {
    // Calls are low but total time is at 80%, and Meta says access returns in 45 minutes.
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "08:00") }], { source: "buc", callCountPct: 5, usagePct: 80, regainMinutes: 45 }));
    feeds.set(IG_PATH, () => okFeed([{ id: "i", at: ist(D, "08:00") }]));
    await tick(ist(D, "10:30"));
    mockedFetch.mockClear();
    await tick(ist(D, "11:01")); // past the default 30 min, inside Meta's 45
    expect(mockedFetch.mock.calls.map(([path]) => path)).toEqual([IG_PATH]);
    mockedFetch.mockClear();
    await tick(ist(D, "11:16"));
    expect(mockedFetch.mock.calls.map(([path]) => path).sort()).toEqual([FB_PATH, IG_PATH].sort());
  });

  it("stops for the hour once the hourly call cap is spent", async () => {
    vi.stubEnv("POSTING_WATCH_HOURLY_CALL_CAP", "60"); // the floor the config allows
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "08:00") }]));
    feeds.set(IG_PATH, () => okFeed([{ id: "i", at: ist(D, "08:00") }]));
    // Both are confirmed silent at 10:30 and re-checked every 2 minutes: 2 calls a tick.
    for (let m = 0; m < 60; m += 2) {
      const r = await tick(new Date(ist(D, "10:30").getTime() + m * 60_000));
      expect(r).toMatchObject({ status: "ran", calls: 2 });
    }
    expect(mockedFetch).toHaveBeenCalledTimes(60);
    expect(await tick(ist(D, "11:29"))).toEqual({ status: "skipped", reason: "hourly_cap" });
    // The oldest calls age out of the hour and checking resumes.
    expect(await tick(ist(D, "11:31"))).toMatchObject({ status: "ran" });
  });

  it("a failed result write backs off from the DB for a few minutes", async () => {
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "08:00") }]));
    feeds.set(IG_PATH, () => okFeed([{ id: "i", at: ist(D, "08:00") }]));
    const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    let n = 0;
    // A tick's transactions: schema check, state read, result write — fail only the write.
    vi.spyOn(prisma, "$transaction").mockImplementation(((...args: unknown[]) =>
      ++n === 3 ? Promise.reject(new Error("Timed out fetching a new connection from the connection pool")) : real(...args)) as typeof prisma.$transaction);
    expect(await tick(ist(D, "10:30"))).toMatchObject({ status: "ran", calls: 2, wrote: false });
    expect(await tick(ist(D, "10:31"))).toEqual({ status: "skipped", reason: "db" });
    expect(await tick(ist(D, "10:32"))).toEqual({ status: "skipped", reason: "db" });
    expect(await tick(ist(D, "10:34"))).toMatchObject({ status: "ran", wrote: true });
  });

  it("every DB touch is a fail-fast transaction (1.5 s pool wait, 10 s cap, statement timeouts)", async () => {
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "10:10") }]));
    feeds.set(IG_PATH, () => okFeed([{ id: "i", at: ist(D, "08:00") }]));
    const spy = vi.spyOn(prisma, "$transaction");
    await tick(ist(D, "10:30"));
    await read(ist(D, "10:31"));
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4); // schema, read, write, dashboard read
    for (const call of spy.mock.calls) expect(call[1]).toEqual({ maxWait: 1500, timeout: 10000 });
  });

  it("never makes more calls than the per-tick cap", async () => {
    vi.stubEnv("POSTING_WATCH_MAX_CHECKS_PER_TICK", "1");
    feeds.set(FB_PATH, () => okFeed([]));
    feeds.set(IG_PATH, () => okFeed([]));
    const r = await tick(ist(D, "10:30"));
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "ran", due: 2, checked: 1 });
  });

  it("a second tick while one is in flight is skipped, never run alongside", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockedFetch.mockImplementation(async () => {
      await gate;
      return okFeed([]);
    });
    const first = tick(ist(D, "10:30"));
    expect(await tick(ist(D, "10:30"))).toEqual({ status: "skipped", reason: "running" });
    release();
    expect(await first).toMatchObject({ status: "ran" });
  });

  it("records ONE api_usage row per tick, not one per call", async () => {
    feeds.set(FB_PATH, () => okFeed([]));
    feeds.set(IG_PATH, () => okFeed([]));
    await tick(ist(D, "10:30"));
    // recordApiUsage is fire-and-forget: give it a moment to land. Per-call rows would be
    // "meta-oauth:posting-watch-fb/-ig"; the prefix match would count them too.
    // (That the fetcher honours recordUsage:false is tested in oauth-graph.test.ts.)
    let rows: Array<{ operation: string; calls: number }> = [];
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      rows = await prisma.apiUsage.findMany({ where: { operation: { startsWith: USAGE_OP } }, select: { operation: true, calls: true } });
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 100)); // any straggler would land by now
    rows = await prisma.apiUsage.findMany({ where: { operation: { startsWith: USAGE_OP } }, select: { operation: true, calls: true } });
    expect(rows).toEqual([{ operation: USAGE_OP, calls: 2 }]);
  });

  it("system_settings postingWatch.mode=off pauses everything without a restart", async () => {
    await prisma.systemSetting.create({ data: { key: POSTING_WATCH_MODE_KEY, value: "off" } });
    expect(await tick(ist(D, "10:30"))).toEqual({ status: "skipped", reason: "off" });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(await read(ist(D, "10:31"))).toMatchObject({ status: "off", reason: "switched_off", channels: [] });
  });

  it("a missing table reports 'paused' — never a 500 — and recovers on its own once it is back", async () => {
    // (tests/setup.ts renames it back if this test is ever interrupted mid-way.)
    await prisma.$executeRawUnsafe(`ALTER TABLE "meta_post_watch" RENAME TO "meta_post_watch_away"`);
    let renamed = true;
    try {
      expect(await read(ist(D, "10:31"))).toMatchObject({ status: "paused", reason: "schema" });
      expect(await tick(ist(D, "10:30"))).toEqual({ status: "skipped", reason: "schema" });
      expect(mockedFetch).not.toHaveBeenCalled();

      await prisma.$executeRawUnsafe(`ALTER TABLE "meta_post_watch_away" RENAME TO "meta_post_watch"`);
      renamed = false;
      // The verdict is cached for 10 minutes (no hammering), then re-checked — no restart.
      expect(await read(ist(D, "10:36"))).toMatchObject({ status: "paused", reason: "schema" });
      expect((await read(ist(D, "10:42"))).status).toBe("ok");
    } finally {
      if (renamed) await prisma.$executeRawUnsafe(`ALTER TABLE "meta_post_watch_away" RENAME TO "meta_post_watch"`);
      resetPostingWatchStateForTests();
    }
  });

  it("a table that vanishes AFTER the self-check passed pauses too, instead of failing every minute", async () => {
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "10:10") }]));
    feeds.set(IG_PATH, () => okFeed([{ id: "i", at: ist(D, "08:00") }]));
    expect((await read(ist(D, "10:29"))).status).toBe("ok"); // the self-check passes and is cached
    await prisma.$executeRawUnsafe(`ALTER TABLE "meta_post_watch" RENAME TO "meta_post_watch_away"`);
    try {
      expect(await tick(ist(D, "10:30"))).toEqual({ status: "skipped", reason: "schema" });
      expect(await read(ist(D, "10:31"))).toMatchObject({ status: "paused", reason: "schema" });
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "meta_post_watch_away" RENAME TO "meta_post_watch"`);
      resetPostingWatchStateForTests();
    }
  });

  it("a failed read serves the last good payload, marked stale, with the clock moved on", async () => {
    feeds.set(FB_PATH, () => okFeed([{ id: "f", at: ist(D, "10:10") }]));
    feeds.set(IG_PATH, () => okFeed([{ id: "i", at: ist(D, "08:00") }]));
    await tick(ist(D, "10:30"));
    const good = await read(ist(D, "10:31"));
    expect(good.channels).toHaveLength(1);

    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("Timed out fetching a new connection from the connection pool"));
    const stale = await read(ist(D, "10:38"));
    expect(stale).toMatchObject({ status: "ok", stale: true });
    expect(stale.channels).toEqual(good.channels);
    // The data is the 10:31 read; the clock is now — so durations on the card stay true.
    expect(stale.asOf).toBe(ist(D, "10:31").toISOString());
    expect(stale.now).toBe(ist(D, "10:38").toISOString());
  });

  it("switched off, the per-minute read touches nothing but the switch itself", async () => {
    // A transaction client that throws on ANY table but system_settings.
    const touched: string[] = [];
    const tx = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === "systemSetting") return { findUnique: async () => ({ key: POSTING_WATCH_MODE_KEY, value: "off" }) };
          touched.push(String(prop));
          throw new Error(`touched ${String(prop)}`);
        },
      },
    );
    const set = await loadMonitoredSet(tx as never, { withTokens: true, withWatch: true });
    expect(set).toMatchObject({ mode: "off", channels: [], notConnected: [] });
    expect(touched).toEqual([]);
  });
});
