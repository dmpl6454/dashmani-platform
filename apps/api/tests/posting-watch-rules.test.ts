/**
 * Posting watch — the PURE rules (no DB, no network, no clock).
 *
 * The rule (owner, 2026-10-03 / 2026-10-05): only ASSIGNED channels with a connected
 * Facebook Page / Instagram account are watched. Within 07:00–23:00 IST such a channel is
 * listed once its newest post is 2h+ old and drops off when it posts again; outside the
 * window gaps are allowed. Every instant below is an explicit IST time.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RULES,
  EMPTY_SNAPSHOT,
  buildMonitoredChannels,
  classify,
  classifyChannel,
  classifyFailure,
  deadlineFor,
  dueFor,
  effectiveSnapshot,
  facebookIdsIn,
  foldOutcome,
  isPermanentError,
  newestPostIn,
  normalizeHandle,
  orderDue,
  windowAt,
  type AssignedRowInput,
  type Due,
  type PageInput,
  type WatchSnapshot,
} from "../src/services/meta-oauth/posting-watch-rules";
import "./setup";

const ist = (day: string, hhmm: string): number => new Date(`${day}T${hhmm}:00.000+05:30`).getTime();
const D = "2026-10-05"; // a Monday
const PREV = "2026-10-04";
const MIN = 60_000;
const snap = (over: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ ...EMPTY_SNAPSHOT, ...over });

describe("windowAt — the 07:00–23:00 IST window", () => {
  it("is half-open: 07:00 is in, 23:00 is out", () => {
    expect(windowAt(ist(D, "06:59")).active).toBe(false);
    expect(windowAt(ist(D, "07:00")).active).toBe(true);
    expect(windowAt(ist(D, "22:59")).active).toBe(true);
    expect(windowAt(ist(D, "23:00")).active).toBe(false);
  });

  it("start and end are IST instants (01:30Z / 17:30Z), whatever the server's timezone", () => {
    const w = windowAt(ist(D, "12:00"));
    expect(new Date(w.start).toISOString()).toBe("2026-10-05T01:30:00.000Z");
    expect(new Date(w.end).toISOString()).toBe("2026-10-05T17:30:00.000Z");
    expect(w.dayKey).toBe(D);
  });

  it("00:30 IST already belongs to the NEW IST day (it is still yesterday in UTC)", () => {
    const w = windowAt(ist("2026-10-06", "00:30"));
    expect(w.dayKey).toBe("2026-10-06");
    expect(w.active).toBe(false);
    expect(new Date(w.nextStart).toISOString()).toBe("2026-10-06T01:30:00.000Z");
  });

  it("after 23:00 the next window is tomorrow's 07:00 IST", () => {
    expect(new Date(windowAt(ist(D, "23:30")).nextStart).toISOString()).toBe("2026-10-06T01:30:00.000Z");
  });

  it("honours a configured window", () => {
    const rules = { ...DEFAULT_RULES, windowStartMin: 8 * 60, windowEndMin: 20 * 60 };
    expect(windowAt(ist(D, "07:30"), rules).active).toBe(false);
    expect(windowAt(ist(D, "08:00"), rules).active).toBe(true);
    expect(windowAt(ist(D, "20:00"), rules).active).toBe(false);
  });
});

describe("classify — when a Page counts as silent", () => {
  it("the owner's example: a post at 08:00, nothing since — flagged from 10:00, once Meta confirms", () => {
    const last = ist(D, "08:00");
    expect(classify(snap({ lastPostAt: last, checkedAt: ist(D, "09:00") }), ist(D, "09:59")).state).toBe("ok");
    // Deadline passed but nobody has asked Meta since → verifying, never a flag on stale data.
    expect(classify(snap({ lastPostAt: last, checkedAt: ist(D, "09:00") }), ist(D, "10:00")).state).toBe("verifying");
    // A check that started at 10:01 found nothing newer → silent, measured from 08:00.
    expect(classify(snap({ lastPostAt: last, checkedAt: ist(D, "10:01"), attemptedAt: ist(D, "10:01") }), ist(D, "11:00"))).toEqual({
      state: "silent",
      group: "quiet_today",
      silentSince: last,
      deadline: ist(D, "10:00"),
    });
  });

  it("a check that STARTED before the deadline can never confirm a gap", () => {
    expect(classify(snap({ lastPostAt: ist(D, "08:00"), checkedAt: ist(D, "09:59") }), ist(D, "10:30")).state).toBe("verifying");
  });

  it("only a check started a full minute past the deadline confirms — one landing ON it (an hourly retry) does not", () => {
    // A post published seconds before 10:00 may not be on the edge yet at 10:00:00.
    const onDeadline = snap({ lastPostAt: ist(D, "08:00"), checkedAt: ist(D, "10:00"), attemptedAt: ist(D, "10:00") });
    expect(classify(onDeadline, ist(D, "10:00") + 30_000).state).toBe("verifying");
    expect(classify({ ...onDeadline, checkedAt: ist(D, "10:00") + 59_000 }, ist(D, "10:05")).state).toBe("verifying");
    // …so it is asked again at once, and that answer can confirm.
    expect(dueFor(onDeadline, ist(D, "10:01"))).toEqual({ reason: "confirm", priority: 0, dueAt: ist(D, "10:01") });
    expect(classify({ ...onDeadline, checkedAt: ist(D, "10:01") }, ist(D, "10:02")).state).toBe("silent");
  });

  it("overnight silence never counts: last post 22:40 → nothing before 09:00, measured from 07:00", () => {
    const last = ist(PREV, "22:40");
    expect(classify(snap({ lastPostAt: last, checkedAt: ist(PREV, "22:50") }), ist(D, "07:00")).state).toBe("ok");
    expect(classify(snap({ lastPostAt: last, checkedAt: ist(D, "07:30") }), ist(D, "08:59")).state).toBe("ok");
    expect(classify(snap({ lastPostAt: last, checkedAt: ist(D, "09:01") }), ist(D, "09:05"))).toMatchObject({
      state: "silent",
      group: "no_post_today",
      silentSince: ist(D, "07:00"),
    });
  });

  it("a post at 06:30 (before the window) still reads as 'nothing since 07:00' at 09:00", () => {
    expect(classify(snap({ lastPostAt: ist(D, "06:30"), checkedAt: ist(D, "09:02") }), ist(D, "09:05"))).toMatchObject({
      state: "silent",
      group: "no_post_today",
      silentSince: ist(D, "07:00"),
    });
  });

  it("outside the window nothing is flagged, even a Page that was silent all day", () => {
    const s = snap({ lastPostAt: ist(D, "08:00"), checkedAt: ist(D, "22:30") });
    expect(classify(s, ist(D, "22:59")).state).toBe("silent");
    expect(classify(s, ist(D, "23:00")).state).toBe("closed");
    expect(classify(s, ist("2026-10-06", "06:59")).state).toBe("closed");
  });

  it("a gap that would only complete after 23:00 is never shown", () => {
    expect(classify(snap({ lastPostAt: ist(D, "21:30"), checkedAt: ist(D, "21:31") }), ist(D, "22:59")).state).toBe("ok");
  });

  it("never posted, or nothing in 7 days → inactive", () => {
    expect(classify(snap({ checkedAt: ist(D, "09:02") }), ist(D, "09:10"))).toMatchObject({ state: "silent", group: "inactive" });
    const old = snap({ lastPostAt: ist("2026-09-27", "12:00"), checkedAt: ist(D, "09:02") });
    expect(classify(old, ist(D, "12:00"))).toMatchObject({ state: "silent", group: "inactive" });
  });

  it("a post stamped a few minutes ahead (clock skew) counts as 'just now', not as later", () => {
    // newestPostIn drops anything more than 5 min ahead, so only skew can reach here.
    const s = snap({ lastPostAt: ist(D, "12:03"), checkedAt: ist(D, "12:01") });
    expect(classify(s, ist(D, "12:00"))).toEqual({ state: "ok", deadline: ist(D, "14:00") });
  });

  it("a permanent failure is 'can't check' at once, at any hour — never a gap", () => {
    const s = snap({ errorKind: "permission", attemptedAt: ist(D, "09:01"), errorSince: ist(D, "09:01"), consecutiveErrors: 1 });
    expect(classify(s, ist(D, "09:02"))).toEqual({ state: "cant_check", errorKind: "permission", since: ist(D, "09:01") });
    expect(classify(s, ist(D, "23:30")).state).toBe("cant_check");
  });

  it("a transient failure is judged from the last success until it has lasted 20 minutes", () => {
    const s = snap({
      lastPostAt: ist(D, "08:00"),
      checkedAt: ist(D, "10:01"),
      attemptedAt: ist(D, "10:06"),
      errorKind: "unreachable",
      errorSince: ist(D, "10:06"),
      consecutiveErrors: 1,
    });
    expect(classify(s, ist(D, "10:10")).state).toBe("silent");
    expect(classify(s, ist(D, "10:25")).state).toBe("silent");
    expect(classify(s, ist(D, "10:26"))).toMatchObject({ state: "cant_check", errorKind: "unreachable" });
  });

  it("deadlineFor = max(newest post, today's 07:00) + 2h", () => {
    const w = windowAt(ist(D, "12:00"));
    expect(deadlineFor(ist(D, "10:15"), ist(D, "12:00"), w, DEFAULT_RULES)).toBe(ist(D, "12:15"));
    expect(deadlineFor(ist(PREV, "23:59"), ist(D, "12:00"), w, DEFAULT_RULES)).toBe(ist(D, "09:00"));
    expect(deadlineFor(null, ist(D, "12:00"), w, DEFAULT_RULES)).toBe(ist(D, "09:00"));
  });
});

describe("classifyChannel — a channel posts when ANY of its Pages posts", () => {
  it("a dormant twin Page does not make an active channel look silent", () => {
    const active = snap({ lastPostAt: ist(D, "11:30"), checkedAt: ist(D, "11:40") });
    const dormant = snap({ lastPostAt: ist("2026-07-30", "17:00"), checkedAt: ist(D, "11:40") });
    expect(classifyChannel([dormant, active], ist(D, "12:00")).state).toBe("ok");
  });

  it("silent only once EVERY Page was checked after the shared deadline", () => {
    const a = snap({ lastPostAt: ist(D, "08:00"), checkedAt: ist(D, "10:01") });
    const b = snap({ lastPostAt: ist(D, "07:30"), checkedAt: ist(D, "09:58") });
    // b's own deadline (09:30) passed long ago, but the CHANNEL's is 10:00 and b has not
    // been asked since then.
    expect(classifyChannel([a, b], ist(D, "10:05")).state).toBe("verifying");
    const b2 = { ...b, checkedAt: ist(D, "10:02") };
    expect(classifyChannel([a, b2], ist(D, "10:05"))).toMatchObject({ state: "silent", group: "quiet_today", silentSince: ist(D, "08:00") });
  });

  it("an unreadable twin makes the channel 'can't check', never silent — it may be the one posting", () => {
    // The readable Page is confirmed silent, but the other cannot be read: "no Page
    // posted" is unknown, so no gap may be shown.
    const quiet = snap({ lastPostAt: ist(D, "08:00"), checkedAt: ist(D, "10:02") });
    const broken = snap({ errorKind: "token", attemptedAt: ist(D, "10:02"), errorSince: ist(D, "09:00"), consecutiveErrors: 3 });
    expect(classifyChannel([quiet, broken], ist(D, "10:05"))).toEqual({ state: "cant_check", errorKind: "token", since: ist(D, "09:00") });
  });

  it("Bollywood Insider: a busy twin throttled for 20+ minutes does not let the dormant twin flag the channel", () => {
    const dormant = snap({ lastPostAt: ist(D, "08:00"), checkedAt: ist(D, "10:30") });
    const busyThrottled = snap({
      lastPostAt: ist(D, "08:00"),
      checkedAt: ist(D, "09:40"),
      attemptedAt: ist(D, "10:30"),
      errorKind: "rate_limited",
      errorSince: ist(D, "10:05"),
      consecutiveErrors: 2,
    });
    expect(classifyChannel([dormant, busyThrottled], ist(D, "10:31"))).toMatchObject({ state: "cant_check", errorKind: "rate_limited" });
  });

  it("a readable Page that is on schedule — or still being confirmed — decides the channel despite a broken twin", () => {
    const broken = snap({ errorKind: "permission", attemptedAt: ist(D, "09:00"), errorSince: ist(D, "09:00"), consecutiveErrors: 1 });
    const posting = snap({ lastPostAt: ist(D, "09:50"), checkedAt: ist(D, "09:55") });
    expect(classifyChannel([posting, broken], ist(D, "10:05")).state).toBe("ok");
    const awaiting = snap({ lastPostAt: ist(D, "08:00"), checkedAt: ist(D, "09:30") });
    expect(classifyChannel([awaiting, broken], ist(D, "10:05")).state).toBe("verifying");
  });

  it("can't check only when no Page can be checked — reporting the longest failure", () => {
    const a = snap({ errorKind: "token", attemptedAt: ist(D, "10:00"), errorSince: ist(D, "09:30"), consecutiveErrors: 2 });
    const b = snap({ errorKind: "permission", attemptedAt: ist(D, "10:00"), errorSince: ist(D, "08:00"), consecutiveErrors: 5 });
    expect(classifyChannel([a, b], ist(D, "10:05"))).toEqual({ state: "cant_check", errorKind: "permission", since: ist(D, "08:00") });
  });

  it("effectiveSnapshot lifts a Page to the channel's newest post, never lowers it", () => {
    const s = snap({ lastPostAt: ist(D, "09:00") });
    expect(effectiveSnapshot(s, ist(D, "10:00")).lastPostAt).toBe(ist(D, "10:00"));
    expect(effectiveSnapshot(s, ist(D, "08:00")).lastPostAt).toBe(ist(D, "09:00"));
    expect(effectiveSnapshot(s, null)).toBe(s);
  });
});

describe("dueFor — the deadline-driven polling schedule", () => {
  it("nothing is due outside the window", () => {
    expect(dueFor(snap({ lastPostAt: ist(D, "08:00") }), ist(D, "23:10"))).toBeNull();
    expect(dueFor(snap(), ist(D, "06:30"))).toBeNull();
  });

  it("nothing is due before the deadline; the confirming check waits one minute past it", () => {
    const s = snap({ lastPostAt: ist(D, "08:00"), checkedAt: ist(D, "08:30") });
    expect(dueFor(s, ist(D, "09:59"))).toBeNull();
    expect(dueFor(s, ist(D, "10:00"))).toBeNull();
    expect(dueFor(s, ist(D, "10:01"))).toEqual({ reason: "confirm", priority: 0, dueAt: ist(D, "10:01") });
  });

  it("a Page not checked yet today is due just after 09:00 (the day's first deadline)", () => {
    const s = snap({ lastPostAt: ist(PREV, "22:00"), checkedAt: ist(PREV, "22:10") });
    expect(dueFor(s, ist(D, "08:59"))).toBeNull();
    expect(dueFor(s, ist(D, "09:01"))?.reason).toBe("confirm");
  });

  it("re-check cadence: 2 min 'quiet today', 3 'no post today', 15 'inactive'", () => {
    const quiet = snap({ lastPostAt: ist(D, "08:00"), checkedAt: ist(D, "10:01") });
    expect(dueFor(quiet, ist(D, "10:02"))).toBeNull();
    expect(dueFor(quiet, ist(D, "10:03"))).toEqual({ reason: "recheck", priority: 2, dueAt: ist(D, "10:03") });

    const none = snap({ lastPostAt: ist(PREV, "20:00"), checkedAt: ist(D, "09:01") });
    expect(dueFor(none, ist(D, "09:03"))).toBeNull();
    expect(dueFor(none, ist(D, "09:04"))?.reason).toBe("recheck");

    const inactive = snap({ checkedAt: ist(D, "09:01") });
    expect(dueFor(inactive, ist(D, "09:15"))).toBeNull();
    expect(dueFor(inactive, ist(D, "09:16"))?.reason).toBe("recheck");
  });

  it("transient failures back off 1, 2, 4 … minutes, capped at 16", () => {
    const base = {
      lastPostAt: ist(D, "08:00"),
      checkedAt: ist(D, "09:00"),
      attemptedAt: ist(D, "10:01"),
      errorKind: "unreachable" as const,
      errorSince: ist(D, "10:01"),
    };
    expect(dueFor(snap({ ...base, consecutiveErrors: 1 }), ist(D, "10:01") + 30_000)).toBeNull();
    expect(dueFor(snap({ ...base, consecutiveErrors: 1 }), ist(D, "10:02"))).toEqual({ reason: "retry_transient", priority: 1, dueAt: ist(D, "10:02") });
    expect(dueFor(snap({ ...base, consecutiveErrors: 3 }), ist(D, "10:04"))).toBeNull();
    expect(dueFor(snap({ ...base, consecutiveErrors: 3 }), ist(D, "10:05"))?.reason).toBe("retry_transient");
    expect(dueFor(snap({ ...base, consecutiveErrors: 12 }), ist(D, "10:16"))).toBeNull();
    expect(dueFor(snap({ ...base, consecutiveErrors: 12 }), ist(D, "10:17"))?.reason).toBe("retry_transient");
  });

  it("permanent failures retry hourly; a rate-limited Page after 30 minutes", () => {
    const perm = snap({ attemptedAt: ist(D, "09:00"), errorKind: "token", errorSince: ist(D, "09:00"), consecutiveErrors: 1 });
    expect(dueFor(perm, ist(D, "09:59"))).toBeNull();
    expect(dueFor(perm, ist(D, "10:00"))).toEqual({ reason: "retry_permanent", priority: 3, dueAt: ist(D, "10:00") });
    const limited = snap({ attemptedAt: ist(D, "09:00"), errorKind: "rate_limited", errorSince: ist(D, "09:00"), consecutiveErrors: 1 });
    expect(dueFor(limited, ist(D, "09:29"))).toBeNull();
    expect(dueFor(limited, ist(D, "09:30"))?.reason).toBe("retry_transient");
  });

  it("a Page sharing a channel is due at the CHANNEL's deadline, not its own", () => {
    const dormant = snap({ lastPostAt: ist("2026-07-30", "17:00"), checkedAt: ist(D, "09:30") });
    const channelLast = ist(D, "10:00");
    expect(dueFor(effectiveSnapshot(dormant, channelLast), ist(D, "11:59"))).toBeNull();
    expect(dueFor(effectiveSnapshot(dormant, channelLast), ist(D, "12:01"))?.reason).toBe("confirm");
  });
});

describe("orderDue", () => {
  it("confirmations first, then transient retries, re-checks, permanent retries; oldest first; stable", () => {
    const d = (reason: Due["reason"], priority: number, dueAt: number): Due => ({ reason, priority, dueAt });
    const items = [
      { key: "z", due: d("retry_permanent", 3, 1) },
      { key: "b", due: d("recheck", 2, 5) },
      { key: "a", due: d("recheck", 2, 5) },
      { key: "c", due: d("confirm", 0, 9) },
      { key: "d", due: d("confirm", 0, 2) },
      { key: "e", due: d("retry_transient", 1, 1) },
    ];
    expect(orderDue(items).map((i) => i.key)).toEqual(["d", "c", "e", "a", "b", "z"]);
  });
});

describe("newestPostIn", () => {
  const now = ist(D, "12:00");

  it("reads Facebook created_time (+0000, no colon) and Instagram timestamp", () => {
    expect(newestPostIn([{ id: "1_2", created_time: "2026-10-05T04:00:00+0000", permalink_url: "https://fb/p" }], now)).toEqual({
      at: Date.UTC(2026, 9, 5, 4, 0, 0),
      id: "1_2",
      url: "https://fb/p",
    });
    expect(newestPostIn([{ id: "9", timestamp: "2026-10-05T05:30:00+0000", permalink: "https://ig/r" }], now)?.url).toBe("https://ig/r");
  });

  it("takes the newest across the page — an older pinned post listed first does not win", () => {
    const r = newestPostIn(
      [
        { id: "pinned", created_time: "2026-09-01T00:00:00+0000" },
        { id: "new", created_time: "2026-10-05T06:00:00+0000" },
        { id: "mid", created_time: "2026-10-05T05:00:00+0000" },
      ],
      now,
    );
    expect(r?.id).toBe("new");
  });

  it("ignores future-dated items beyond 5 minutes, unparseable dates and junk", () => {
    const r = newestPostIn(
      [
        { id: "scheduled", created_time: new Date(now + 10 * MIN).toISOString() },
        { id: "skew-ok", created_time: new Date(now + 2 * MIN).toISOString() },
        { id: "junk", created_time: "not a date" },
        {} as never,
      ],
      now,
    );
    expect(r?.id).toBe("skew-ok");
    expect(newestPostIn([], now)).toBeNull();
    expect(newestPostIn(undefined, now)).toBeNull();
  });
});

describe("classifyFailure", () => {
  const base = { status: 400, rateLimited: false, authInvalid: false };
  it("separates 'grant dead' (reconnect) from 'no Page access' (fix the Page role) — both are code 190", () => {
    expect(classifyFailure({ ...base, authInvalid: true, errorCode: 190, errorSubcode: 492 })).toBe("permission");
    expect(classifyFailure({ ...base, authInvalid: true, errorCode: 190, errorSubcode: 460 })).toBe("token");
    expect(classifyFailure({ ...base, authInvalid: true, errorCode: 102 })).toBe("token");
  });
  it("maps the remaining Graph families", () => {
    expect(classifyFailure({ ...base, errorCode: 10 })).toBe("permission");
    expect(classifyFailure({ ...base, errorCode: 200 })).toBe("permission");
    expect(classifyFailure({ ...base, errorCode: 100 })).toBe("not_found");
    expect(classifyFailure({ ...base, errorCode: 80001 })).toBe("rate_limited");
    expect(classifyFailure({ ...base, rateLimited: true, errorCode: 4 })).toBe("rate_limited");
    expect(classifyFailure({ ...base, status: 0 })).toBe("unreachable");
    expect(classifyFailure({ ...base, status: 500, errorCode: 2 })).toBe("meta_error");
  });
  it("only auth / permission / not-found are permanent", () => {
    expect(["token", "permission", "not_found"].every((k) => isPermanentError(k as never))).toBe(true);
    expect(["rate_limited", "unreachable", "meta_error"].some((k) => isPermanentError(k as never))).toBe(false);
  });
});

describe("foldOutcome", () => {
  it("Meta's current newest post is the truth — a deleted post stops counting", () => {
    const prev = { ...snap({ lastPostAt: ist(D, "10:00") }), lastPostId: "deleted", lastPostUrl: "u-deleted" };
    const after = foldOutcome(prev, { ok: true, startedAt: ist(D, "10:30"), newest: { at: ist(D, "09:00"), id: "x", url: "ux" } });
    expect(after).toMatchObject({ lastPostAt: ist(D, "09:00"), lastPostId: "x", lastPostUrl: "ux", checkedAt: ist(D, "10:30") });
    const newer = foldOutcome(prev, { ok: true, startedAt: ist(D, "10:30"), newest: { at: ist(D, "10:20"), id: "b", url: "ub" } });
    expect(newer).toMatchObject({ lastPostAt: ist(D, "10:20"), lastPostId: "b", lastPostUrl: "ub" });
  });

  it("an EMPTY feed keeps the last known post instead of flashing 'no posts'", () => {
    const prev = { ...snap({ lastPostAt: ist(D, "10:00") }), lastPostId: "a", lastPostUrl: "ua" };
    expect(foldOutcome(prev, { ok: true, startedAt: ist(D, "10:30"), newest: null })).toMatchObject({
      lastPostAt: ist(D, "10:00"),
      lastPostId: "a",
      checkedAt: ist(D, "10:30"),
    });
  });

  it("counts a failure streak, keeps its start, and a success clears it", () => {
    const f1 = foldOutcome(snap({ checkedAt: ist(D, "09:00") }), { ok: false, startedAt: ist(D, "10:01"), errorKind: "unreachable" });
    expect(f1).toMatchObject({ errorKind: "unreachable", errorSince: ist(D, "10:01"), consecutiveErrors: 1, attemptedAt: ist(D, "10:01"), checkedAt: ist(D, "09:00") });
    const f2 = foldOutcome(f1, { ok: false, startedAt: ist(D, "10:02"), errorKind: "meta_error" });
    expect(f2).toMatchObject({ errorKind: "meta_error", errorSince: ist(D, "10:01"), consecutiveErrors: 2 });
    const ok = foldOutcome(f2, { ok: true, startedAt: ist(D, "10:04"), newest: null });
    expect(ok).toMatchObject({ errorKind: null, errorSince: null, consecutiveErrors: 0, checkedAt: ist(D, "10:04") });
  });
});

describe("normalizeHandle", () => {
  it("strips @, share-link query strings and profile URLs", () => {
    expect(normalizeHandle("@BollywoodChronicle")).toBe("bollywoodchronicle");
    expect(normalizeHandle("creatorspaparazzi?igsh=YWdoZm42Z2o2azk3")).toBe("creatorspaparazzi");
    expect(normalizeHandle("https://www.instagram.com/viral_paps/?hl=en")).toBe("viral_paps");
    expect(normalizeHandle("https://facebook.com/paparazzziii")).toBe("paparazzziii");
    expect(normalizeHandle("https://m.facebook.com/DSRVideos.in/")).toBe("dsrvideos.in");
    expect(normalizeHandle("  Pap Desk ")).toBe("pap desk");
  });

  it("a link that names no account gives nothing — share links, profile.php, posts", () => {
    expect(normalizeHandle("https://www.facebook.com/share/1EUYcTfY6Z/")).toBe("");
    expect(normalizeHandle("https://www.facebook.com/profile.php?id=100078687452440")).toBe("");
    expect(normalizeHandle("https://www.instagram.com/reel/DPabc123/")).toBe("");
    expect(normalizeHandle("https://www.instagram.com/p/DPabc123/")).toBe("");
    // The old Page route names the account in its second segment.
    expect(normalizeHandle("https://www.facebook.com/pg/bollypopp/posts/")).toBe("bollypopp");
  });
});

describe("facebookIdsIn", () => {
  it("finds the numeric ids a handle or link names", () => {
    expect([...facebookIdsIn("https://www.facebook.com/profile.php?id=100078687452440")]).toEqual(["100078687452440"]);
    expect([...facebookIdsIn("596165523816494")]).toEqual(["596165523816494"]);
    expect([...facebookIdsIn("https://www.facebook.com/pages/Bolly-Updates/123456789012")]).toEqual(["123456789012"]);
    expect([...facebookIdsIn("https://www.facebook.com/Bollypopp/", "Bolly Pop", null)]).toEqual([]);
  });
});

describe("buildMonitoredChannels — which channels are watched", () => {
  const page = (over: Partial<PageInput> & { metaId: string }): PageInput => ({
    key: `${over.kind ?? "FACEBOOK_PAGE"}:${over.metaId}`,
    kind: "FACEBOOK_PAGE",
    name: "Page",
    username: null,
    followerCount: 0,
    socialAccountId: null,
    ...over,
  });
  const row = (over: Partial<AssignedRowInput> & { id: string }): AssignedRowInput => ({
    platform: "facebook",
    handle: over.id,
    displayName: over.id,
    assignees: [{ id: "u1", name: "Asha" }],
    ...over,
  });

  it("watches only Pages behind an assigned channel", () => {
    const pages = [
      page({ metaId: "1", name: "Bollywood Chronicle", socialAccountId: "sa-1" }),
      page({ metaId: "2", name: "Unassigned Page", socialAccountId: "sa-2" }),
      page({ metaId: "3", name: "Never Linked" }),
    ];
    const { channels, notConnected } = buildMonitoredChannels(pages, [row({ id: "sa-1", displayName: "Bollywood Chronicle" })]);
    expect(channels.map((c) => c.pages.map((p) => p.metaId))).toEqual([["1"]]);
    expect(channels[0].assignees).toEqual([{ id: "u1", name: "Asha" }]);
    expect(channels[0].matchedByName).toBe(false);
    expect(notConnected).toEqual([]);
  });

  it("falls back to an exact name / handle match when the assigned row has no linked Page", () => {
    // The registry's duplicate-row case on prod: the assignment sits on "Paparazzii",
    // while discovery linked the Page to another row.
    const pages = [page({ metaId: "10", name: "Paparazzii", username: "paparazzziii", socialAccountId: "sa-other" })];
    const { channels } = buildMonitoredChannels(pages, [row({ id: "sa-assigned", displayName: "Paparazzii", handle: "Paparazzii" })]);
    expect(channels).toHaveLength(1);
    expect(channels[0].matchedByName).toBe(true);
    // Handle against the IG username, with a share-link query string.
    const ig = [page({ kind: "INSTAGRAM_ACCOUNT", metaId: "20", name: "Creators Paparazzi", username: "creatorspaparazzi" })];
    const r = row({ id: "sa-ig", platform: "instagram", displayName: "Creators Paperazzi", handle: "creatorspaparazzi?igsh=abc" });
    expect(buildMonitoredChannels(ig, [r]).channels).toHaveLength(1);
  });

  it("never matches across platforms", () => {
    const pages = [page({ kind: "INSTAGRAM_ACCOUNT", metaId: "30", name: "Pap Desk", username: "papsdesk" })];
    const { channels, notConnected } = buildMonitoredChannels(pages, [row({ id: "sa-fb", platform: "facebook", displayName: "Pap Desk", handle: "Pap Desk" })]);
    expect(channels).toEqual([]);
    expect(notConnected.map((r) => r.id)).toEqual(["sa-fb"]);
  });

  it("does not fall back when the row already has a linked Page", () => {
    const pages = [
      page({ metaId: "40", name: "Just Bollywood", socialAccountId: "sa-jb" }),
      page({ metaId: "41", name: "Just Bollywood Extra" }),
    ];
    const { channels } = buildMonitoredChannels(pages, [row({ id: "sa-jb", displayName: "Just Bollywood Extra" })]);
    expect(channels[0].pages.map((p) => p.metaId)).toEqual(["40"]);
  });

  it("two same-name Pages on one channel are ONE watched channel, primary = most followers", () => {
    const pages = [
      page({ metaId: "50", name: "Bollywood Insider", followerCount: 525_640, socialAccountId: "sa-bi" }),
      page({ metaId: "51", name: "Bollywood Insider", followerCount: 1_924_046, socialAccountId: "sa-bi" }),
    ];
    const { channels } = buildMonitoredChannels(pages, [row({ id: "sa-bi" })]);
    expect(channels).toHaveLength(1);
    expect(channels[0].pages.map((p) => p.metaId)).toEqual(["51", "50"]);
    expect(channels[0].key).toBe("FACEBOOK_PAGE:51");
  });

  it("two assigned rows for the same Page merge into one channel with both people", () => {
    const pages = [page({ metaId: "60", name: "Mobile Multiplex", username: "MobileMultiplex", socialAccountId: "sa-a" })];
    const rows = [
      row({ id: "sa-a", assignees: [{ id: "u2", name: "Zoya" }] }),
      row({ id: "sa-b", displayName: "Mobile Multiplex", assignees: [{ id: "u1", name: "Asha" }, { id: "u2", name: "Zoya" }] }),
    ];
    const { channels } = buildMonitoredChannels(pages, rows);
    expect(channels).toHaveLength(1);
    expect(channels[0].assignees).toEqual([
      { id: "u1", name: "Asha" },
      { id: "u2", name: "Zoya" },
    ]);
  });

  it("an assigned row with no connected Page is reported as not connected, never dropped", () => {
    const { channels, notConnected } = buildMonitoredChannels([], [row({ id: "sa-x", displayName: "Bolly Pop" })]);
    expect(channels).toEqual([]);
    expect(notConnected.map((r) => [r.displayName, r.reason])).toEqual([["Bolly Pop", "no_page"]]);
  });

  it("Instagram is matched by username only: @viral_paps is not the connected @viralpaps", () => {
    // Prod, 2026-10-05: two different accounts (798 vs 389K followers) that a display-name
    // match used to merge.
    const pages = [page({ kind: "INSTAGRAM_ACCOUNT", metaId: "80", name: "Viral Paps", username: "viralpaps", socialAccountId: "sa-vp" })];
    const rows = [
      row({ id: "sa-vp", platform: "instagram", handle: "viralpaps", displayName: "Viral Paps", assignees: [{ id: "u1", name: "Asha" }] }),
      row({
        id: "sa-vp2",
        platform: "instagram",
        handle: "viral_paps?igsh=MWk0ZHY3cTYxYnRk",
        displayName: "Viral paps",
        profileUrl: "https://www.instagram.com/viral_paps?igsh=MWk0ZHY3cTYxYnRk",
        assignees: [{ id: "u3", name: "Ravi" }],
      }),
    ];
    const { channels, notConnected } = buildMonitoredChannels(pages, rows);
    expect(channels).toHaveLength(1);
    expect(channels[0].assignees.map((a) => a.name)).toEqual(["Asha"]);
    expect(notConnected.map((r) => [r.id, r.reason])).toEqual([["sa-vp2", "no_page"]]);
  });

  it("the registry's profile link is an identity too — it outranks a typo in the handle", () => {
    // Prod: handle "papsnap" (an unrelated person's account) but link instagram.com/pappsnap.
    const pages = [page({ kind: "INSTAGRAM_ACCOUNT", metaId: "81", name: "Pap Snap", username: "pappsnap" })];
    const r = row({ id: "sa-ps", platform: "instagram", handle: "papsnap", displayName: "Pap Snap", profileUrl: "https://www.instagram.com/pappsnap?igsh=dHQ1" });
    const { channels } = buildMonitoredChannels(pages, [r]);
    expect(channels.map((c) => c.pages.map((p) => p.metaId))).toEqual([["81"]]);
    expect(channels[0].matchedByName).toBe(true);
  });

  it("Facebook: a numeric Page id in the profile link matches even when the names differ", () => {
    const pages = [page({ metaId: "100064123456789", name: "Bolly Updates Official", socialAccountId: "sa-other" })];
    const r = row({ id: "sa-bu", handle: "Bolly Updates", displayName: "Bolly Updates", profileUrl: "https://www.facebook.com/profile.php?id=100064123456789" });
    expect(buildMonitoredChannels(pages, [r]).channels.map((c) => c.pages[0].metaId)).toEqual(["100064123456789"]);
  });

  it("Facebook: a stale vanity link does not block the exact-name match discovery itself relies on", () => {
    // Prod: facebook.com/MobileMultiplexxx is not a Page; the connected Page is @MobileMultiplex.
    const pages = [page({ metaId: "90", name: "Mobile Multiplex", username: "MobileMultiplex", socialAccountId: "sa-unassigned" })];
    const r = row({ id: "sa-mm", handle: "Mobile Multiplex", displayName: "Mobile Multiplex", profileUrl: "https://www.facebook.com/MobileMultiplexxx/" });
    expect(buildMonitoredChannels(pages, [r]).channels).toHaveLength(1);
    // …and a share link (no account in it) leaves the name match to decide.
    const desk = [page({ metaId: "91", name: "Pap Desk", username: "papsdesk" })];
    const r2 = row({ id: "sa-pd", handle: "Pap Desk", displayName: "Pap Desk", profileUrl: "https://www.facebook.com/share/1EUYcTfY6Z/" });
    expect(buildMonitoredChannels(desk, [r2]).channels).toHaveLength(1);
  });

  it("a fallback never bridges two channels: matches in more than one group are reported as ambiguous", () => {
    const pages = [
      page({ metaId: "100", name: "Filmy Gyan", socialAccountId: "sa-1" }),
      page({ metaId: "101", name: "Filmy Gyan", socialAccountId: "sa-2" }),
    ];
    const rows = [
      row({ id: "sa-1", displayName: "Filmy Gyan", assignees: [{ id: "u1", name: "Asha" }] }),
      row({ id: "sa-2", displayName: "Filmy Gyan", assignees: [{ id: "u3", name: "Ravi" }] }),
      row({ id: "sa-3", handle: "Filmy Gyan", displayName: "Filmy Gyan", assignees: [{ id: "u4", name: "Kabir" }] }),
    ];
    const { channels, notConnected } = buildMonitoredChannels(pages, rows);
    expect(channels.map((c) => [c.pages.map((p) => p.metaId), c.assignees.map((a) => a.name)])).toEqual([
      [["100"], ["Asha"]],
      [["101"], ["Ravi"]],
    ]);
    expect(notConnected.map((r) => [r.id, r.reason])).toEqual([["sa-3", "ambiguous"]]);
  });

  it("two separate unlinked Pages sharing a name are ambiguous too", () => {
    const pages = [page({ metaId: "110", name: "Bolly Talk" }), page({ metaId: "111", name: "Bolly Talk" })];
    const { channels, notConnected } = buildMonitoredChannels(pages, [row({ id: "sa-bt", handle: "Bolly Talk", displayName: "Bolly Talk" })]);
    expect(channels).toEqual([]);
    expect(notConnected[0].reason).toBe("ambiguous");
  });

  it("same-name twins linked to one row stay ONE group, even when that row is not assigned", () => {
    const pages = [
      page({ metaId: "120", name: "Bollywood Insider", followerCount: 525_640, socialAccountId: "sa-unassigned" }),
      page({ metaId: "121", name: "Bollywood Insider", followerCount: 1_924_046, socialAccountId: "sa-unassigned" }),
    ];
    const { channels, notConnected } = buildMonitoredChannels(pages, [row({ id: "sa-dup", handle: "Bollywood Insider", displayName: "Bollywood Insider" })]);
    expect(channels.map((c) => c.pages.map((p) => p.metaId))).toEqual([["121", "120"]]);
    expect(notConnected).toEqual([]);
  });

  it("the outcome does not depend on the order rows are visited in", () => {
    const pages = [page({ metaId: "130", name: "Bolly Cafe", socialAccountId: "sa-a" }), page({ metaId: "131", name: "Bolly Cafe Two" })];
    const rows = [
      row({ id: "sa-a", displayName: "Bolly Cafe" }),
      row({ id: "sa-b", handle: "Bolly Cafe", displayName: "Bolly Cafe" }),
      row({ id: "sa-c", handle: "Bolly Cafe Two", displayName: "Bolly Cafe" }),
    ];
    const shape = (rs: AssignedRowInput[]) => {
      const out = buildMonitoredChannels(pages, rs);
      return {
        channels: out.channels.map((c) => [c.pages.map((p) => p.metaId), c.rows.map((r) => r.id).sort()]),
        notConnected: out.notConnected.map((r) => [r.id, r.reason]).sort(),
      };
    };
    expect(shape([...rows].reverse())).toEqual(shape(rows));
    // sa-c names BOTH Pages (handle → 131, display → 130): two groups, so it joins neither.
    expect(shape(rows).notConnected).toEqual([["sa-c", "ambiguous"]]);
  });
});
