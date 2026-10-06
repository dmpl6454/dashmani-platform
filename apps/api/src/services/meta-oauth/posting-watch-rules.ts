/**
 * Posting watch — the PURE rules: which channels are watched, the IST monitoring window,
 * when a channel's silence counts as a gap, which channels are due a check, and how a
 * failed check is classified.
 *
 * Nothing here imports anything or reads the clock, the database or the network. Every
 * function takes `now` (epoch ms) explicitly, so each rule is testable at any instant —
 * including the window edges — without fake timers.
 *
 * ── The rule (owner, 2026-10-03 / 2026-10-05) ────────────────────────────────────────
 * Only ASSIGNED channels are watched: a channel in the registry (social_accounts) that is
 * active and has at least one current assignment to an active person, and that has a
 * Facebook Page / Instagram account connected through Meta on Account Growth. Within
 * 07:00–23:00 IST such a channel is listed on the dashboard — with the people assigned to
 * it — once its newest post is 2h+ old, and drops off as soon as it posts again. Outside
 * the window a gap is fine and nothing is shown.
 *
 * Applied as a DAILY RESET: each IST day's silence is measured from
 * max(newest post, 07:00 that day). Overnight silence never counts — a channel that last
 * posted at 22:40 is flagged at 09:00 the next morning if it has not posted since 07:00.
 *
 * ── A channel can have more than one Page ────────────────────────────────────────────
 * The registry links a channel to its Meta Page by NAME, so a channel can resolve to two
 * same-name Pages (7 assigned channels on prod, 2026-10-05) — and in several of those the
 * bigger Page is the dormant one (Bollywood Insider: 1.9M followers, 5 posts in 7 days;
 * its 525k twin: 247). A channel therefore counts as posting when ANY of its Pages posts:
 * every Page is judged against the newest post across the channel (effectiveSnapshot),
 * and the channel is silent only when EVERY Page could be read and each one is confirmed
 * silent. While one Page cannot be read, "no Page posted" is unknown: the channel is
 * shown as "can't check", never as a gap.
 *
 * ── Why a flag needs a CONFIRMING check ──────────────────────────────────────────────
 * The deadline comes from the newest post we KNOW about; the channel may have posted
 * since. "Deadline passed" therefore only makes it due a check. It is shown as silent
 * only once a check that STARTED at least confirmDelayMs after the deadline found nothing
 * newer — until then it is "verifying". A flag on screen always means Meta itself was
 * asked past the 2h mark.
 *
 * ── Why polling is deadline-driven ───────────────────────────────────────────────────
 * Checking a channel before its known deadline cannot change whether a gap exists, so a
 * channel that keeps posting costs about one call per two hours; only channels already
 * silent are re-checked on a cadence, so they drop off soon after they post.
 */

export const IST_OFFSET_MS = 330 * 60_000; // IST = UTC+05:30, no DST.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type Kind = "FACEBOOK_PAGE" | "INSTAGRAM_ACCOUNT";

/** The three kinds of "silent", most actionable first. */
export type SilentGroup = "quiet_today" | "no_post_today" | "inactive";

/**
 * Why a check failed.
 * - token: the grant is dead (password change, expiry) — reconnect on Account Growth.
 * - permission: Meta refuses this account (not a Page admin / 2FA requirement).
 * - not_found: the object or request is invalid (deleted Page, renamed edge).
 * - rate_limited: Meta asked us to slow down.
 * - unreachable: no answer (timeout / network) — status 0.
 * - meta_error: any other refusal, including Meta's transient (#1)/(#2).
 */
export type ErrorKind = "token" | "permission" | "not_found" | "rate_limited" | "unreachable" | "meta_error";

const PERMANENT_ERRORS: ReadonlySet<ErrorKind> = new Set(["token", "permission", "not_found"]);
const ALL_ERRORS: ReadonlySet<string> = new Set(["token", "permission", "not_found", "rate_limited", "unreachable", "meta_error"]);

/** Deterministic until a human acts: re-asking every minute cannot fix it. */
export function isPermanentError(kind: ErrorKind): boolean {
  return PERMANENT_ERRORS.has(kind);
}

export function asErrorKind(v: unknown): ErrorKind | null {
  return typeof v === "string" && ALL_ERRORS.has(v) ? (v as ErrorKind) : null;
}

export interface WatchRules {
  /** Minutes after IST midnight the daily window opens (07:00 → 420). */
  windowStartMin: number;
  /** Minutes after IST midnight it closes (23:00 → 1380). Exclusive. */
  windowEndMin: number;
  /** Silence that counts as a gap. */
  gapMs: number;
  /**
   * How long after the deadline the confirming check waits. A post published seconds
   * before the deadline can take a moment to appear on the edge; asking exactly at the
   * deadline would flag it for one re-check cycle for nothing.
   */
  confirmDelayMs: number;
  /** Newest post older than this ⇒ "inactive" rather than "no post today". */
  inactiveAfterMs: number;
  /** Re-check cadence for a confirmed-silent channel, by how active it is. */
  recheckMs: Record<SilentGroup, number>;
  /** A run of TRANSIENT failures must last this long before the Page is shown as
   *  "can't check" (one timeout is not news; twenty minutes of them is). */
  transientGraceMs: number;
  /** Retry cadence for permanent failures. */
  permanentRetryMs: number;
  /** Ceiling for the transient back-off (1, 2, 4, 8, 16 min …). */
  transientRetryMaxMs: number;
  /** Back-off after Meta rate-limits this Page. */
  rateLimitedRetryMs: number;
}

export const DEFAULT_RULES: Readonly<WatchRules> = Object.freeze({
  windowStartMin: 7 * 60,
  windowEndMin: 23 * 60,
  gapMs: 2 * HOUR,
  confirmDelayMs: MINUTE,
  inactiveAfterMs: 7 * DAY,
  // ~90 Pages sit behind assigned channels (prod, 2026-10-05), so silent channels can be
  // re-checked often and drop off within minutes of posting again. ~20 are silent at a
  // typical hour ⇒ ~500 calls/hour; measured per-Page usage stayed at 1%.
  recheckMs: Object.freeze({ quiet_today: 2 * MINUTE, no_post_today: 3 * MINUTE, inactive: 15 * MINUTE }),
  transientGraceMs: 20 * MINUTE,
  permanentRetryMs: HOUR,
  transientRetryMaxMs: 16 * MINUTE,
  rateLimitedRetryMs: 30 * MINUTE,
}) as Readonly<WatchRules>;

// ── The IST window ──────────────────────────────────────────────────────────────

export interface DayWindow {
  /** Epoch ms of today's window open (07:00 IST). */
  start: number;
  /** Epoch ms of today's window close (23:00 IST). Exclusive. */
  end: number;
  /** now ∈ [start, end). */
  active: boolean;
  /** Today's open while it is open or yet to open today; otherwise tomorrow's. */
  nextStart: number;
  /** IST calendar day of `now`, YYYY-MM-DD. */
  dayKey: string;
}

/** The monitoring window for the IST calendar day containing `now`. */
export function windowAt(now: number, rules: Pick<WatchRules, "windowStartMin" | "windowEndMin"> = DEFAULT_RULES): DayWindow {
  const shifted = now + IST_OFFSET_MS;
  const istMidnightShifted = Math.floor(shifted / DAY) * DAY;
  const midnight = istMidnightShifted - IST_OFFSET_MS;
  const start = midnight + rules.windowStartMin * MINUTE;
  const end = midnight + rules.windowEndMin * MINUTE;
  const active = now >= start && now < end;
  const nextStart = now < end ? start : start + DAY;
  const dayKey = new Date(istMidnightShifted).toISOString().slice(0, 10);
  return { start, end, active, nextStart, dayKey };
}

// ── One Page's state ────────────────────────────────────────────────────────────

/** What the store remembers about one Page (epoch ms; null = never). */
export interface WatchSnapshot {
  /** Meta's newest post as of the last successful check (see foldOutcome). */
  lastPostAt: number | null;
  /** When the last SUCCESSFUL check started. A check that started before the deadline
   *  can never confirm a gap, so this is the start, not the finish. */
  checkedAt: number | null;
  /** When the last check of any outcome started. */
  attemptedAt: number | null;
  /** Kind of the last failure; null when the latest attempt succeeded. */
  errorKind: ErrorKind | null;
  /** First failure of the current failing streak. */
  errorSince: number | null;
  consecutiveErrors: number;
}

export const EMPTY_SNAPSHOT: Readonly<WatchSnapshot> = Object.freeze({
  lastPostAt: null,
  checkedAt: null,
  attemptedAt: null,
  errorKind: null,
  errorSince: null,
  consecutiveErrors: 0,
});

export type WatchState =
  /** Outside 07:00–23:00 IST: gaps are allowed, nothing is evaluated. */
  | { state: "closed" }
  /** Within its 2h cadence (or not due yet). */
  | { state: "ok"; deadline: number }
  /** Deadline passed but no check since — shown as a count, never as a flag. */
  | { state: "verifying"; deadline: number }
  | { state: "silent"; group: SilentGroup; silentSince: number; deadline: number }
  | { state: "cant_check"; errorKind: ErrorKind; since: number };

/** The latest attempt failed (a success after the failure clears this). */
function isFailing(s: WatchSnapshot): boolean {
  if (s.errorKind == null) return false;
  if (s.checkedAt == null) return true;
  return (s.attemptedAt ?? -Infinity) > s.checkedAt;
}

/** Silence is measured from max(newest post, today's 07:00). A post time slightly in the
 *  future (clock skew; newestPostIn already drops anything >5 min ahead) counts as now. */
function referenceInstant(lastPostAt: number | null, now: number, win: DayWindow): number {
  const last = lastPostAt == null ? -Infinity : Math.min(lastPostAt, now);
  return Math.max(last, win.start);
}

export function deadlineFor(lastPostAt: number | null, now: number, win: DayWindow, rules: WatchRules): number {
  return referenceInstant(lastPostAt, now, win) + rules.gapMs;
}

function groupFor(lastPostAt: number | null, now: number, win: DayWindow, rules: WatchRules): SilentGroup {
  if (lastPostAt == null || now - lastPostAt >= rules.inactiveAfterMs) return "inactive";
  return lastPostAt >= win.start ? "quiet_today" : "no_post_today";
}

export function classify(
  snap: WatchSnapshot,
  now: number,
  rules: WatchRules = DEFAULT_RULES,
  win: DayWindow = windowAt(now, rules),
): WatchState {
  // Checked before the window: lost access is news at any hour, and it is never a gap —
  // the channel may well be posting.
  if (isFailing(snap)) {
    const kind = snap.errorKind as ErrorKind;
    const since = snap.errorSince ?? snap.attemptedAt ?? now;
    if (isPermanentError(kind) || now - since >= rules.transientGraceMs) {
      return { state: "cant_check", errorKind: kind, since };
    }
    // A short transient blip: keep judging from the last successful check.
  }

  if (!win.active) return { state: "closed" };

  const ref = referenceInstant(snap.lastPostAt, now, win);
  const deadline = ref + rules.gapMs;
  if (now < deadline) return { state: "ok", deadline };
  // Only a check that started confirmDelayMs past the deadline may confirm: one started
  // AT the deadline (an hourly retry, a first check right after the DDL) could miss a post
  // published seconds before it that has not reached the edge yet.
  if (snap.checkedAt != null && snap.checkedAt >= deadline + rules.confirmDelayMs) {
    return { state: "silent", group: groupFor(snap.lastPostAt, now, win, rules), silentSince: ref, deadline };
  }
  return { state: "verifying", deadline };
}

// ── A channel with several Pages ────────────────────────────────────────────────

/** Newest post across a channel's Pages. */
export function groupLastPostAt(snaps: ReadonlyArray<Pick<WatchSnapshot, "lastPostAt">>): number | null {
  let best: number | null = null;
  for (const s of snaps) if (s.lastPostAt != null && (best == null || s.lastPostAt > best)) best = s.lastPostAt;
  return best;
}

/** A Page judged against its whole channel: any Page's post resets every Page's clock. */
export function effectiveSnapshot<S extends WatchSnapshot>(snap: S, channelLastPostAt: number | null): S {
  if (channelLastPostAt == null) return snap;
  if (snap.lastPostAt != null && snap.lastPostAt >= channelLastPostAt) return snap;
  return { ...snap, lastPostAt: channelLastPostAt };
}

type CantCheck = Extract<WatchState, { state: "cant_check" }>;

/**
 * A channel's state from its Pages' snapshots.
 *  - Every Page is judged against the channel's newest post, so they share one deadline.
 *  - ok > closed > verifying: one readable Page that is on schedule (or not yet
 *    confirmed) decides the channel. An unreadable twin cannot make it look silent.
 *  - Silent only when EVERY Page could be read and each one was confirmed silent past the
 *    shared deadline. If any Page cannot be read, its posts since its last good check are
 *    unknown — it may be the one posting — so the channel is "can't check", not a gap.
 */
export function classifyChannel(
  snaps: ReadonlyArray<WatchSnapshot>,
  now: number,
  rules: WatchRules = DEFAULT_RULES,
  win: DayWindow = windowAt(now, rules),
): WatchState {
  if (snaps.length === 0) return win.active ? { state: "verifying", deadline: win.start + rules.gapMs } : { state: "closed" };
  const last = groupLastPostAt(snaps);
  const states = snaps.map((s) => classify(effectiveSnapshot(s, last), now, rules, win));
  const failing = states.filter((s): s is CantCheck => s.state === "cant_check");
  const readable = states.filter((s) => s.state !== "cant_check");
  const live =
    readable.find((s) => s.state === "ok") ??
    readable.find((s) => s.state === "closed") ??
    readable.find((s) => s.state === "verifying");
  if (live) return live;
  // The longest-running failure is the one to report.
  if (failing.length > 0) return failing.reduce((a, b) => (a.since <= b.since ? a : b));
  return readable[0];
}

// ── What to check next ──────────────────────────────────────────────────────────

/**
 * - confirm: the deadline passed and nobody has asked Meta since — this is what makes a
 *   flag appear, so it goes first.
 * - retry_transient: a failed confirm/re-check; second, it is blocking a decision.
 * - recheck: a confirmed-silent channel, polled so it drops off soon after it posts.
 * - retry_permanent: auth/permission failures, retried hourly in case a human fixed it.
 */
export type DueReason = "confirm" | "retry_transient" | "recheck" | "retry_permanent";

const PRIORITY: Record<DueReason, number> = { confirm: 0, retry_transient: 1, recheck: 2, retry_permanent: 3 };

export interface Due {
  reason: DueReason;
  priority: number;
  /** When it became due — older first within a priority. */
  dueAt: number;
}

function retryDelay(kind: ErrorKind, consecutive: number, rules: WatchRules): number {
  if (isPermanentError(kind)) return rules.permanentRetryMs;
  if (kind === "rate_limited") return rules.rateLimitedRetryMs;
  const n = Math.max(1, Math.min(consecutive, 16));
  return Math.min(rules.transientRetryMaxMs, MINUTE * 2 ** (n - 1));
}

/** Pass the snapshot through effectiveSnapshot() first when the Page shares a channel. */
export function dueFor(
  snap: WatchSnapshot,
  now: number,
  rules: WatchRules = DEFAULT_RULES,
  win: DayWindow = windowAt(now, rules),
): Due | null {
  if (!win.active) return null;

  if (isFailing(snap)) {
    const kind = snap.errorKind as ErrorKind;
    const dueAt = (snap.attemptedAt ?? 0) + retryDelay(kind, snap.consecutiveErrors, rules);
    if (now < dueAt) return null;
    const reason: DueReason = isPermanentError(kind) ? "retry_permanent" : "retry_transient";
    return { reason, priority: PRIORITY[reason], dueAt };
  }

  const deadline = deadlineFor(snap.lastPostAt, now, win, rules);
  if (now < deadline) return null;

  // Same bar as classify(): a check started inside the settle minute cannot confirm.
  const confirmAt = deadline + rules.confirmDelayMs;
  if (snap.checkedAt == null || snap.checkedAt < confirmAt) {
    return now >= confirmAt ? { reason: "confirm", priority: PRIORITY.confirm, dueAt: confirmAt } : null;
  }

  const group = groupFor(snap.lastPostAt, now, win, rules);
  const dueAt = snap.checkedAt + rules.recheckMs[group];
  return now >= dueAt ? { reason: "recheck", priority: PRIORITY.recheck, dueAt } : null;
}

/** Order due Pages: priority, then longest-waiting first, then key (stable). */
export function orderDue<T extends { key: string; due: Due }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => a.due.priority - b.due.priority || a.due.dueAt - b.due.dueAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

// ── Reading a check result ──────────────────────────────────────────────────────

export interface FeedItem {
  id?: string;
  /** Facebook published_posts. */
  created_time?: string;
  permalink_url?: string;
  /** Instagram media. */
  timestamp?: string;
  permalink?: string;
}

export interface NewestPost {
  at: number;
  id: string | null;
  url: string | null;
}

/**
 * The newest post in a feed page, ignoring anything dated more than `skewMs` in the
 * future. The page is read as a SET, not "item 0": a pinned post can sort first on some
 * surfaces, and the max over a few items is immune to that at no extra cost.
 */
export function newestPostIn(items: FeedItem[] | undefined | null, now: number, skewMs = 5 * MINUTE): NewestPost | null {
  let best: NewestPost | null = null;
  for (const it of items ?? []) {
    const raw = it?.created_time ?? it?.timestamp;
    if (typeof raw !== "string" || raw === "") continue;
    const at = Date.parse(raw);
    if (!Number.isFinite(at) || at > now + skewMs) continue;
    if (best == null || at > best.at) {
      const url = it.permalink_url ?? it.permalink ?? null;
      best = { at, id: typeof it.id === "string" ? it.id : null, url: typeof url === "string" ? url : null };
    }
  }
  return best;
}

/** The subset of a Graph result the classifier needs (mirrors OauthGraphResult). */
export interface GraphFailure {
  status: number;
  rateLimited: boolean;
  authInvalid: boolean;
  errorCode?: number;
  errorSubcode?: number;
}

/**
 * Map a failed Graph call to an ErrorKind.
 * Live-probed 2026-10-03 on prod: an account that is not (or no longer) a Page admin
 * under the 2FA rule answers code 190 / subcode 492, and a Page token killed by a
 * password change answers 190 / 460. Both are code 190, but only one is fixed by
 * reconnecting — the other needs Page access restored — so they are kept apart.
 */
export function classifyFailure(r: GraphFailure): ErrorKind {
  if (r.rateLimited) return "rate_limited";
  // Business-use-case throttles (80001 Pages, 80002 Instagram, …) say "too many calls",
  // not "rate limit", so the shared isRateLimitError() misses them.
  if (r.errorCode != null && r.errorCode >= 80000 && r.errorCode < 80100) return "rate_limited";
  if (r.errorCode === 190 && r.errorSubcode === 492) return "permission";
  if (r.authInvalid) return "token";
  if (r.errorCode === 10 || (r.errorCode != null && r.errorCode >= 200 && r.errorCode < 300)) return "permission";
  if (r.errorCode === 100 || r.errorCode === 803) return "not_found";
  if (r.status === 0) return "unreachable";
  return "meta_error";
}

// ── Folding a check result into the snapshot ────────────────────────────────────

export type CheckOutcome =
  | { ok: true; startedAt: number; newest: NewestPost | null }
  | { ok: false; startedAt: number; errorKind: ErrorKind };

export interface FoldedSnapshot extends WatchSnapshot {
  lastPostId: string | null;
  lastPostUrl: string | null;
}

/**
 * Apply one check to a snapshot.
 *
 * Meta's answer is the TRUTH: the newest post it returns now replaces what we stored,
 * even when it is older — a post that was deleted or unpublished must stop counting, or
 * a channel would look active for up to two hours after its only recent post vanished.
 * (newestPostIn takes the max over the page, so ordering quirks such as a pinned post
 * listed first cannot pull it backwards.)
 *
 * The one exception is an EMPTY feed for a Page we have seen post before: that is far
 * likelier a Meta hiccup than every post being deleted, so the last known post stands
 * rather than flashing the channel up as "no posts".
 */
export function foldOutcome(
  prev: WatchSnapshot & { lastPostId?: string | null; lastPostUrl?: string | null },
  outcome: CheckOutcome,
): FoldedSnapshot {
  const base: FoldedSnapshot = {
    lastPostAt: prev.lastPostAt,
    lastPostId: prev.lastPostId ?? null,
    lastPostUrl: prev.lastPostUrl ?? null,
    checkedAt: prev.checkedAt,
    attemptedAt: outcome.startedAt,
    errorKind: prev.errorKind,
    errorSince: prev.errorSince,
    consecutiveErrors: prev.consecutiveErrors,
  };
  if (outcome.ok) {
    base.checkedAt = outcome.startedAt;
    base.errorKind = null;
    base.errorSince = null;
    base.consecutiveErrors = 0;
    const n = outcome.newest;
    if (n) {
      base.lastPostAt = n.at;
      base.lastPostId = n.id;
      base.lastPostUrl = n.url;
    }
    return base;
  }
  const continuing = isFailing(prev);
  base.errorKind = outcome.errorKind;
  base.errorSince = continuing ? prev.errorSince ?? outcome.startedAt : outcome.startedAt;
  base.consecutiveErrors = continuing ? prev.consecutiveErrors + 1 : 1;
  return base;
}

// ── Which channels are watched ──────────────────────────────────────────────────

/** One connected Page / IG account (already de-duplicated by kind + metaId). */
export interface PageInput {
  key: string;
  kind: Kind;
  metaId: string;
  name: string;
  username: string | null;
  followerCount: number | null;
  /** The registry row discovery linked this asset to (by name), if any. */
  socialAccountId: string | null;
}

/** One assigned registry row (social_accounts) with its current assignees. */
export interface AssignedRowInput {
  id: string;
  platform: "facebook" | "instagram";
  handle: string;
  displayName: string;
  /**
   * The registry's profile link. Often the better identity on prod: `handle` regularly
   * holds a display name, and in one case a typo the link does not share (handle
   * "papsnap" — an unrelated person's account — with link instagram.com/pappsnap).
   */
  profileUrl?: string | null;
  assignees: ReadonlyArray<{ id: string; name: string }>;
}

/**
 * Why an assigned row is not watched.
 * - no_page: no connected Page / account matches it.
 * - ambiguous: it matches Pages that belong to more than one channel. Joining them would
 *   merge channels that must be judged separately, so it is left for a human to link.
 */
export type NotConnectedReason = "no_page" | "ambiguous";

export interface NotConnectedRow extends AssignedRowInput {
  reason: NotConnectedReason;
}

export interface MonitoredChannel<P extends PageInput = PageInput> {
  /** The primary Page's key — stable while the channel's Pages do not change. */
  key: string;
  kind: Kind;
  /** Primary first (most followers, then metaId). */
  pages: P[];
  rows: AssignedRowInput[];
  /** Union over the rows, sorted by name. */
  assignees: Array<{ id: string; name: string }>;
  /** At least one row reached its Page through the fallback (id, username or exact
   *  name), not through discovery's link. */
  matchedByName: boolean;
}

const PLATFORM_KIND: Record<AssignedRowInput["platform"], Kind> = { facebook: "FACEBOOK_PAGE", instagram: "INSTAGRAM_ACCOUNT" };

/** First path segments that are Facebook / Instagram routes, not account names. */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  "share", "sharer", "sharer.php", "profile.php", "pages", "people", "groups", "watch", "reel", "reels", "p", "tv",
  "stories", "story.php", "permalink.php", "photo.php", "photo", "photos", "videos", "events", "explore",
  "accounts", "hashtag", "l.php", "home.php", "login", "login.php",
]);

/**
 * "@Name?igsh=…", "https://www.instagram.com/name/", "facebook.com/pg/name/posts" → "name".
 * A link that names no account (a share link, profile.php?id=…, a post) gives "".
 */
export function normalizeHandle(raw: string): string {
  let h = (raw ?? "").trim();
  const url = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)?(?:instagram|facebook|fb)\.com\/([^?#]*)/i.exec(h);
  if (url) {
    const segs = url[1].split("/").filter((s) => s !== "");
    const first = (segs[0] ?? "").toLowerCase();
    // facebook.com/pg/<name>/… is the old Page route: the name is the second segment.
    h = first === "pg" ? segs[1] ?? "" : RESERVED_SEGMENTS.has(first) ? "" : segs[0] ?? "";
  }
  h = h.split("?")[0].split("#")[0];
  while (h.startsWith("@")) h = h.slice(1);
  return h.trim().toLowerCase();
}

/** A username-like identity (no spaces) named by a handle or a profile link, or null. */
function usernameIn(raw: string | null | undefined): string | null {
  const h = normalizeHandle(raw ?? "");
  return h !== "" && !/\s/.test(h) ? h : null;
}

/**
 * Numeric Facebook ids named by a handle or a link: profile.php?id=…, facebook.com/<id>,
 * /pages/<name>/<id>, /people/<name>/<id>, or a bare id. (Same idea as fbLookupKeys().)
 */
export function facebookIdsIn(...sources: Array<string | null | undefined>): Set<string> {
  const ids = new Set<string>();
  for (const raw of sources) {
    const s = (raw ?? "").trim();
    if (s === "") continue;
    for (const m of s.matchAll(/[?&]id=(\d{5,})/g)) ids.add(m[1]);
    if (/^\d{5,}$/.test(s)) ids.add(s);
    const path = /facebook\.com\/(?:(?:pages|people)\/[^/?#]+\/)?(\d{5,})(?:[/?#]|$)/i.exec(s);
    if (path) ids.add(path[1]);
  }
  return ids;
}

function normalizeName(raw: string): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The connected Pages an assigned row with no linked Page should join. Strongest evidence
 * first; only the first tier that matches anything is used.
 *   1. Facebook: a numeric Page id in the handle or profile link.
 *   2. A username, from the handle or the profile link, equal to the Page's username.
 *   3. Facebook: the handle or display name equal to the Page's name — the way discovery
 *      itself links Pages (a stale vanity URL must not block it: prod's assigned "Mobile
 *      Multiplex" row links facebook.com/MobileMultiplexxx, which is not a Page at all).
 * Instagram is matched by USERNAME ONLY. An account is its username and profile names are
 * not unique: prod's registry @viral_paps (798 followers) is a different account from the
 * connected @viralpaps "Viral Paps" (389K), and a name match merged the two.
 */
function fallbackMatches<P extends PageInput>(r: AssignedRowInput, pages: ReadonlyArray<P>): P[] {
  if (r.platform === "facebook") {
    const ids = facebookIdsIn(r.handle, r.profileUrl);
    const byId = ids.size > 0 ? pages.filter((p) => ids.has(p.metaId)) : [];
    if (byId.length > 0) return byId;
  }
  const usernames = new Set([usernameIn(r.handle), usernameIn(r.profileUrl)].filter((u): u is string => u != null));
  const byUsername = usernames.size > 0 ? pages.filter((p) => p.username != null && usernames.has(p.username.trim().toLowerCase())) : [];
  if (byUsername.length > 0) return byUsername;
  if (r.platform !== "facebook") return [];
  const names = new Set([normalizeName(normalizeHandle(r.handle)), normalizeName(r.displayName)].filter((n) => n !== ""));
  return names.size > 0 ? pages.filter((p) => names.has(normalizeName(p.name))) : [];
}

/**
 * Join assigned registry rows to connected Pages.
 *
 * 1. A Page linked to an assigned row (meta_assets.social_account_id) belongs to it.
 *    Pages linked to the SAME row (the same-name twins discovery links to one row) stay
 *    together even when that row is not itself assigned.
 * 2. An assigned row with NO linked Page falls back to fallbackMatches() — Page id,
 *    username, then (Facebook only) exact name. The registry holds duplicate rows for some
 *    channels (prod, 2026-10-05: the assignment on "Paparazzii", Meta's link on another
 *    row for the same Page); without this, assigned channels whose Pages are connected
 *    would go unwatched.
 * 3. A fallback never bridges channels. Its matches are compared with the groups step 1
 *    left (so the outcome does not depend on the order rows are visited in); if they span
 *    more than one, the row is reported as ambiguous instead of merging channels.
 * 4. Rows and Pages that end up connected form ONE channel (union-find): its Pages are
 *    judged together, its assignees are the union.
 *
 * Rows with no Page come back in `notConnected` with a reason — listed, never dropped.
 */
export function buildMonitoredChannels<P extends PageInput>(
  pages: ReadonlyArray<P>,
  rows: ReadonlyArray<AssignedRowInput>,
): { channels: MonitoredChannel<P>[]; notConnected: NotConnectedRow[] } {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c) as string;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const union = (a: string, b: string) => {
    add(a);
    add(b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra);
  };

  const rowById = new Map(rows.map((r) => [r.id, r]));
  const pageByKey = new Map(pages.map((p) => [p.key, p]));
  for (const r of rows) add(`R:${r.id}`);
  for (const p of pages) add(`P:${p.key}`);

  // 1. Discovery's links. A row nobody is assigned to is still a node here, so the Pages
  //    linked to it stay one group; it never becomes a channel on its own (see below).
  const linked = new Set<string>();
  for (const p of pages) {
    if (!p.socialAccountId) continue;
    const r = rowById.get(p.socialAccountId);
    if (r) {
      if (PLATFORM_KIND[r.platform] !== p.kind) continue;
      linked.add(r.id);
    }
    union(`R:${p.socialAccountId}`, `P:${p.key}`);
  }

  // 2–3. The fallback, decided against the groups as step 1 left them.
  const groupOf = new Map<string, string>();
  for (const p of pages) groupOf.set(p.key, find(`P:${p.key}`));
  const pagesOf: Record<Kind, P[]> = {
    FACEBOOK_PAGE: pages.filter((p) => p.kind === "FACEBOOK_PAGE"),
    INSTAGRAM_ACCOUNT: pages.filter((p) => p.kind === "INSTAGRAM_ACCOUNT"),
  };
  const matchedByNameRows = new Set<string>();
  const ambiguousRows = new Set<string>();
  for (const r of rows) {
    if (linked.has(r.id)) continue;
    const hits = fallbackMatches(r, pagesOf[PLATFORM_KIND[r.platform]]);
    if (hits.length === 0) continue;
    if (new Set(hits.map((p) => groupOf.get(p.key))).size > 1) {
      ambiguousRows.add(r.id);
      continue;
    }
    for (const p of hits) union(`R:${r.id}`, `P:${p.key}`);
    matchedByNameRows.add(r.id);
  }

  const comps = new Map<string, { pages: P[]; rows: AssignedRowInput[] }>();
  for (const node of parent.keys()) {
    const isPage = node.startsWith("P:");
    const row = isPage ? undefined : rowById.get(node.slice(2));
    if (!isPage && !row) continue; // an unassigned registry row: a grouping node only
    const root = find(node);
    let c = comps.get(root);
    if (!c) {
      c = { pages: [], rows: [] };
      comps.set(root, c);
    }
    if (row) c.rows.push(row);
    else c.pages.push(pageByKey.get(node.slice(2)) as P);
  }

  const channels: MonitoredChannel<P>[] = [];
  const notConnected: NotConnectedRow[] = [];
  for (const c of comps.values()) {
    if (c.rows.length === 0) continue; // Pages no assigned row reaches are not watched
    if (c.pages.length === 0) {
      for (const r of c.rows) notConnected.push({ ...r, reason: ambiguousRows.has(r.id) ? "ambiguous" : "no_page" });
      continue;
    }
    c.pages.sort((a, b) => (b.followerCount ?? 0) - (a.followerCount ?? 0) || (a.metaId < b.metaId ? -1 : a.metaId > b.metaId ? 1 : 0));
    c.rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const people = new Map<string, { id: string; name: string }>();
    for (const r of c.rows) for (const a of r.assignees) people.set(a.id, { id: a.id, name: a.name });
    channels.push({
      key: c.pages[0].key,
      kind: c.pages[0].kind,
      pages: c.pages,
      rows: c.rows,
      assignees: [...people.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)),
      matchedByName: c.rows.some((r) => matchedByNameRows.has(r.id)),
    });
  }
  channels.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  notConnected.sort((a, b) => a.displayName.localeCompare(b.displayName) || (a.id < b.id ? -1 : 1));
  return { channels, notConnected };
}
