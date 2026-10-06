/**
 * Posting watch — which ASSIGNED channels have gone 2h+ without a new post on their
 * connected Facebook Page / Instagram account between 07:00 and 23:00 IST (owner request,
 * 2026-10-03; scoped to assigned channels 2026-10-05).
 *
 * This file holds the poller tick and the dashboard payload. The rules (which channels,
 * window, deadline, confirmation, retry cadence) are PURE and live in
 * posting-watch-rules.ts.
 *
 * ── Why a dedicated poller ──────────────────────────────────────────────────────────
 * meta_posts is refreshed by the 3-hourly posts sync, after a ~30-minute channel sweep:
 * a new post can take ~3.5h to land there (measured 2026-10-03: Bollywood Chronicle's
 * newest stored FB post was 1h21m behind the live feed). That cannot detect a 2-hour gap,
 * so this asks Meta directly — one small three-field read per check (two for an Instagram
 * account whose own feed looks silent: its accepted Collabs are read too) — and only when a
 * Page's deadline makes it due. ~90 Pages sit behind assigned channels.
 *
 * ── Performance contract (owner: "performance takes priority") ─────────────────────
 *  - NOTHING here runs on a request path except the dashboard read, which is a memoised
 *    DB read and never calls Meta.
 *  - Every DB touch goes through pwTx(): a short transaction that waits at most
 *    DB_MAX_WAIT_MS for a pooled connection and caps every statement. If the 10-slot main
 *    pool is busy (sign-in, HR submit), the watch gives up and skips — it never queues
 *    behind them for the pool's 20 s.
 *  - Bounded work: at most maxChecksPerTick checks and maxCallsPerTick Meta calls per tick
 *    (each check reserves its worst case before it starts), an hourly call cap, a small
 *    concurrency, a wall-clock budget per tick, and a claim-before-first-await overlap
 *    guard (a concurrent tick skips; it never takes over).
 *  - api_usage gets ONE row per tick (calls: n), not one per call.
 *  - Meta's own throttle telemetry (x-business-use-case-usage) is honoured: a Page past
 *    USAGE_COOLDOWN_PCT is left alone for a while; an app-level signal pauses everything.
 *    Within one check too: a slow-down on the first read means the second is not made.
 */
import { randomUUID } from "crypto";
import { prisma, Prisma, type MetaPostWatch } from "@dashmani/db";
import { oauthGraphFetch, type MetaUsage, type OauthGraphResult } from "./oauth-graph";
import { metaOauthConfigured } from "./meta-config";
import { decryptToken, scrubSecrets } from "../../utils/token-crypto";
import { recordApiUsage } from "../api-usage.service";
import { createSingleFlightMemo } from "../../utils/single-flight-memo";
import { warnThrottled } from "../../utils/throttled-warn";
import {
  DEFAULT_RULES,
  asErrorKind,
  buildMonitoredChannels,
  classifyChannel,
  classifyFailure,
  dueFor,
  effectiveSnapshot,
  foldOutcome,
  groupLastPostAt,
  newestPostIn,
  orderDue,
  windowAt,
  type AssignedRowInput,
  type CheckOutcome,
  type Due,
  type ErrorKind,
  type FeedItem,
  type FoldedSnapshot,
  type NewestPost,
  type Kind,
  type MonitoredChannel,
  type NotConnectedReason,
  type NotConnectedRow,
  type PageInput,
  type SilentGroup,
  type WatchRules,
} from "./posting-watch-rules";

// ── Configuration ──────────────────────────────────────────────────────────────────

const MINUTE = 60_000;

/** Runtime pause without a restart: system_settings `postingWatch.mode` = "off". */
export const POSTING_WATCH_MODE_KEY = "postingWatch.mode";

/** NaN-, empty- and range-guarded integer env read (a bad value falls back, never 1 ms). */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** "HH:MM" (IST) → minutes after midnight; anything else falls back. */
function envClock(name: string, fallbackMin: number): number {
  const raw = (process.env[name] ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return fallbackMin;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return fallbackMin;
  return h * 60 + min;
}

export interface PostingWatchConfig {
  enabled: boolean;
  tickMs: number;
  bootDelayMs: number;
  maxChecksPerTick: number;
  /** Graph calls one tick may make (an Instagram check can cost two). */
  maxCallsPerTick: number;
  hourlyCallCap: number;
  concurrency: number;
  requestTimeoutMs: number;
  /** Stop starting new checks after this long into a tick. */
  tickBudgetMs: number;
  rules: WatchRules;
}

export function postingWatchConfig(): PostingWatchConfig {
  const tickMs = envInt("POSTING_WATCH_TICK_MS", MINUTE, 15_000, 10 * MINUTE);
  let windowStartMin = envClock("POSTING_WATCH_WINDOW_START", DEFAULT_RULES.windowStartMin);
  let windowEndMin = envClock("POSTING_WATCH_WINDOW_END", DEFAULT_RULES.windowEndMin);
  if (windowEndMin <= windowStartMin) {
    windowStartMin = DEFAULT_RULES.windowStartMin;
    windowEndMin = DEFAULT_RULES.windowEndMin;
  }
  return {
    enabled: process.env.POSTING_WATCH_ENABLED !== "0",
    tickMs,
    bootDelayMs: envInt("POSTING_WATCH_BOOT_DELAY_MS", 7 * MINUTE, 0, 60 * MINUTE),
    maxChecksPerTick: envInt("POSTING_WATCH_MAX_CHECKS_PER_TICK", 60, 1, 300),
    // Never below the most a single check can cost, or that kind of check could never run.
    maxCallsPerTick: Math.max(maxCallsFor("INSTAGRAM_ACCOUNT"), envInt("POSTING_WATCH_MAX_CALLS_PER_TICK", 120, 1, 3_000)),
    hourlyCallCap: envInt("POSTING_WATCH_HOURLY_CALL_CAP", 2400, 60, 20_000),
    concurrency: envInt("POSTING_WATCH_CONCURRENCY", 3, 1, 6),
    requestTimeoutMs: envInt("POSTING_WATCH_REQUEST_TIMEOUT_MS", 8_000, 2_000, 20_000),
    tickBudgetMs: Math.min(Math.floor(tickMs * 0.75), 45_000),
    rules: {
      ...DEFAULT_RULES,
      recheckMs: { ...DEFAULT_RULES.recheckMs },
      windowStartMin,
      windowEndMin,
      gapMs: envInt("POSTING_WATCH_GAP_MINUTES", 120, 15, 12 * 60) * MINUTE,
    },
  };
}

// ── Fail-fast DB access ────────────────────────────────────────────────────────────

/** Max wait for a pooled connection. Past it the watch skips instead of queueing. */
const DB_MAX_WAIT_MS = 1_500;
const DB_TX_TIMEOUT_MS = 10_000;
const DB_STATEMENT_TIMEOUT_MS = 5_000;
const DB_LOCK_TIMEOUT_MS = 1_000;

/**
 * Run `fn` in a short transaction that cannot hog the shared pool.
 * ⚠️ Inside `fn`, use ONLY `tx` — a `prisma.*` call there would ask the pool for a second
 * connection while this one is held (with connection_limit=1, as in CI, that deadlocks
 * until the transaction times out).
 */
async function pwTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${DB_STATEMENT_TIMEOUT_MS}`);
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${DB_LOCK_TIMEOUT_MS}`);
      return fn(tx);
    },
    { maxWait: DB_MAX_WAIT_MS, timeout: DB_TX_TIMEOUT_MS },
  );
}

// ── Schema self-check (mirrors services/pipeline/self-check.ts) ────────────────────

const SCHEMA_RECHECK_MS = 10 * MINUTE;
let schemaOk: boolean | null = null;
let schemaCheckedAt = 0;

/**
 * P2021 = table missing, P2022 = column missing; a raw statement reports the same as
 * P2010 carrying Postgres 42P01 (undefined table) / 42703 (undefined column). Anything
 * else is transient.
 */
function isSchemaMissing(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
  if (e?.code === "P2021" || e?.code === "P2022") return true;
  return e?.code === "P2010" && (e.meta?.code === "42P01" || e.meta?.code === "42703");
}

/**
 * The table vanished AFTER the self-check passed (e.g. a blanket `db push` from a branch
 * without the model): drop the cached verdict, so the feature reports "paused" and
 * re-checks every 10 minutes instead of failing every minute.
 */
function noteIfSchemaMissing(err: unknown, now: number): void {
  if (!isSchemaMissing(err)) return;
  schemaOk = false;
  schemaCheckedAt = now;
}

/**
 * True once meta_post_watch exists with every column. While it is missing the feature
 * reports "paused" (never a 500) and re-checks every 10 minutes, so applying the DDL
 * after a deploy needs no restart. A transient failure (busy pool) returns false for THIS
 * call only and caches no verdict.
 */
async function ensureSchema(now: number): Promise<boolean> {
  if (schemaOk === true) return true;
  if (schemaOk === false && now - schemaCheckedAt < SCHEMA_RECHECK_MS) return false;
  try {
    // findFirst selects every scalar, so a missing COLUMN fails too, not just the table.
    await pwTx((tx) => tx.metaPostWatch.findFirst());
    // Reached only on the transition to "ok" (the early return above), so this logs once.
    if (process.env.NODE_ENV !== "test") console.log("[posting-watch] schema self-check passed");
    schemaOk = true;
    return true;
  } catch (err) {
    if (isSchemaMissing(err)) {
      schemaOk = false;
      schemaCheckedAt = now;
      warnThrottled(
        "posting-watch:schema",
        "[posting-watch] ⚠️ SCHEMA SELF-CHECK FAILED — meta_post_watch is missing. The posting watch is PAUSED " +
          "until scripts/posting-watch-ddl.sql is applied; re-checking every 10 min.",
      );
      return false;
    }
    warnThrottled("posting-watch:schema-transient", `[posting-watch] schema check could not run: ${scrubSecrets(String(err)).slice(0, 200)}`);
    return false;
  }
}

// ── Loading the watched set ────────────────────────────────────────────────────────

const ASSET_SELECT = {
  id: true,
  kind: true,
  metaId: true,
  name: true,
  username: true,
  selected: true,
  followerCount: true,
  createdAt: true,
  connectionId: true,
  socialAccountId: true,
  connection: { select: { revokedAt: true } },
} as const;

const ASSET_SELECT_WITH_TOKEN = { ...ASSET_SELECT, pageTokenEnc: true } as const;

type AssetRow = Prisma.MetaAssetGetPayload<{ select: typeof ASSET_SELECT_WITH_TOKEN }>;

interface AssetLike {
  id: string;
  kind: Kind;
  metaId: string;
  selected: boolean;
  followerCount: number | null;
  createdAt: Date;
  connection: { revokedAt: Date | null };
}

export function pageKey(kind: Kind, metaId: string): string {
  return `${kind}:${metaId}`;
}

/**
 * The connected Pages, exactly as Account Growth's "Connected channels" shows them:
 * non-disconnected assets, ONE per (kind, metaId) — a Page reachable through two
 * connections is two rows — chosen by resolveDuplicateAssetIds()'s winner rule (selected
 * first, most followers, earliest connected, id), and kept only when that winner is
 * selected (not removed via Manage) on a connection that is not revoked.
 *
 * Mirrored here rather than called because resolveDuplicateAssetIds() runs its own
 * unbounded query and console.warns once per duplicate group on EVERY call — once a
 * minute from a poller, that is log spam and a wasted query.
 */
export function pickLiveChannels<A extends AssetLike>(assets: A[]): Map<string, A> {
  const groups = new Map<string, A[]>();
  for (const a of assets) {
    const k = pageKey(a.kind, a.metaId);
    const list = groups.get(k);
    if (list) list.push(a);
    else groups.set(k, [a]);
  }
  const live = new Map<string, A>();
  for (const [k, list] of groups) {
    list.sort(
      (a, b) =>
        Number(b.selected) - Number(a.selected) ||
        (b.followerCount ?? 0) - (a.followerCount ?? 0) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
    const winner = list[0];
    if (winner.selected && winner.connection.revokedAt == null) live.set(k, winner);
  }
  return live;
}

/**
 * A current assignment: not unassigned, to a person who is ACTIVE and not deleted — the
 * owner's definition (2026-10-05). Deliberately NO role filter, unlike Submission gaps:
 * that feature measures employees' own report submissions, while here anyone assigned to
 * a channel is someone to show next to its gap.
 */
const ACTIVE_ASSIGNMENT = { unassignedAt: null, employee: { status: "ACTIVE" as const, deletedAt: null } };

/** An assigned FB/IG channel: ACTIVE in the registry, with ≥1 current assignment. */
async function loadAssignedRows(tx: Prisma.TransactionClient): Promise<AssignedRowInput[]> {
  const rows = await tx.socialAccount.findMany({
    where: {
      status: "ACTIVE",
      platform: { slug: { in: ["facebook", "instagram"] } },
      assignments: { some: ACTIVE_ASSIGNMENT },
    },
    select: {
      id: true,
      handle: true,
      displayName: true,
      profileUrl: true,
      platform: { select: { slug: true } },
      assignments: { where: ACTIVE_ASSIGNMENT, select: { employee: { select: { id: true, name: true } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform.slug === "facebook" ? ("facebook" as const) : ("instagram" as const),
    handle: r.handle,
    displayName: r.displayName,
    profileUrl: r.profileUrl,
    assignees: r.assignments.map((a) => ({ id: a.employee.id, name: a.employee.name })),
  }));
}

export interface PageAsset extends PageInput {
  assetId: string;
  connectionId: string;
  pageTokenEnc: string | null;
}

type WatchRow = MetaPostWatch;

export interface MonitoredSet {
  mode: "on" | "off";
  channels: MonitoredChannel<PageAsset>[];
  notConnected: NotConnectedRow[];
  /** Keyed by pageKey(); absent when the Page has never been checked. */
  watch: Map<string, WatchRow>;
  /** connectionId → encrypted user token (IG reads). Only when tokens were requested. */
  userTokenEnc: Map<string, string | null>;
}

/**
 * Everything the tick and the dashboard read, in one short transaction. Bounded by the
 * size of the estate (≈420 assets, ≈100 assigned rows, ≈90 watched Pages), never by
 * history: no post rows are read.
 */
export async function loadMonitoredSet(
  tx: Prisma.TransactionClient,
  opts: { withTokens: boolean; withWatch: boolean },
): Promise<MonitoredSet> {
  const modeRow = await tx.systemSetting.findUnique({ where: { key: POSTING_WATCH_MODE_KEY } });
  const mode = modeRow?.value?.trim().toLowerCase() === "off" ? "off" : "on";
  // Switched off: the kill switch must also take the per-minute DB read off the pool.
  if (mode === "off") return { mode, channels: [], notConnected: [], watch: new Map(), userTokenEnc: new Map() };
  const assets: AssetRow[] = (await tx.metaAsset.findMany({
    where: { disconnectedAt: null },
    select: opts.withTokens ? ASSET_SELECT_WITH_TOKEN : ASSET_SELECT,
  })) as AssetRow[];
  const live = pickLiveChannels(assets);
  const rows = await loadAssignedRows(tx);
  const pages: PageAsset[] = [...live.entries()].map(([key, a]) => ({
    key,
    kind: a.kind,
    metaId: a.metaId,
    name: a.name,
    username: a.username ?? null,
    followerCount: a.followerCount ?? null,
    socialAccountId: a.socialAccountId ?? null,
    assetId: a.id,
    connectionId: a.connectionId,
    pageTokenEnc: opts.withTokens ? a.pageTokenEnc ?? null : null,
  }));
  const { channels, notConnected } = buildMonitoredChannels(pages, rows);

  const watch = new Map<string, WatchRow>();
  const watchedMetaIds = [...new Set(channels.flatMap((c) => c.pages.map((p) => p.metaId)))];
  if (opts.withWatch && watchedMetaIds.length > 0) {
    const watchRows = await tx.metaPostWatch.findMany({ where: { metaId: { in: watchedMetaIds } } });
    for (const w of watchRows) watch.set(pageKey(w.kind, w.metaId), w);
  }

  const userTokenEnc = new Map<string, string | null>();
  if (opts.withTokens) {
    const connIds = [...new Set(channels.flatMap((c) => c.pages.map((p) => p.connectionId)))];
    if (connIds.length > 0) {
      const conns = await tx.metaConnection.findMany({ where: { id: { in: connIds } }, select: { id: true, userTokenEnc: true } });
      for (const c of conns) userTokenEnc.set(c.id, c.userTokenEnc);
    }
  }
  return { mode, channels, notConnected, watch, userTokenEnc };
}

function snapshotOf(row: WatchRow | undefined): FoldedSnapshot {
  return {
    lastPostAt: row?.lastPostAt ? row.lastPostAt.getTime() : null,
    lastPostId: row?.lastPostId ?? null,
    lastPostUrl: row?.lastPostUrl ?? null,
    checkedAt: row?.checkedAt ? row.checkedAt.getTime() : null,
    attemptedAt: row?.attemptedAt ? row.attemptedAt.getTime() : null,
    errorKind: asErrorKind(row?.errorKind),
    errorSince: row?.errorSince ? row.errorSince.getTime() : null,
    consecutiveErrors: row?.consecutiveErrors ?? 0,
  };
}

// ── Health (process-local; the API is a single process) ────────────────────────────

let running: { startedAt: number } | null = null;
/** Global pause after an app-level throttle signal. */
let pausedUntil = 0;
/** After a failed result write the watch leaves the DB alone for a while: a pool that
 *  cannot take one small write must not be asked again every minute, and the same Pages
 *  must not be re-polled from Meta while their results cannot be stored. */
let dbBackoffUntil = 0;
const DB_WRITE_BACKOFF_MS = 3 * MINUTE;
/** Per-Page back-off after its own BUC usage crossed USAGE_COOLDOWN_PCT. */
const cooldownUntil = new Map<string, number>();
/** Calls in the trailing hour, for the hourly cap. */
let callLog: Array<{ at: number; n: number }> = [];

const USAGE_COOLDOWN_PCT = 75;
const PAGE_COOLDOWN_MS = 30 * MINUTE;
const GLOBAL_PAUSE_MS = 15 * MINUTE;
/** Ceiling on Meta's estimated_time_to_regain_access, so one odd header cannot park a
 *  Page for days. */
const MAX_REGAIN_MS = 6 * 60 * MINUTE;
/** This many rate-limited answers in one tick means "slow down", not "one busy Page". */
const RATE_LIMITED_PAUSE_THRESHOLD = 5;
const STALE_TICK_MS = 10 * MINUTE;

/** Meta's verdict in one usage reading: "app" = slow the whole app down, "page" = leave this
 *  Page alone for a while, null = carry on. checkPage and the tick both decide with it. */
function throttleOf(u: MetaUsage): "app" | "page" | null {
  if (!u) return null;
  if (u.source === "app") return u.usagePct >= USAGE_COOLDOWN_PCT ? "app" : null;
  return u.usagePct >= USAGE_COOLDOWN_PCT || (u.regainMinutes ?? 0) > 0 ? "page" : null;
}

/** Of two readings, the one to obey: an app-wide throttle outranks a Page one, a throttle
 *  outranks none, and between equals the longer regain estimate, then the busier, wins. */
function moreUrgent(a: MetaUsage, b: MetaUsage): MetaUsage {
  if (!a) return b;
  if (!b) return a;
  const rank = (u: MetaUsage): number => {
    const v = throttleOf(u);
    return v === "app" ? 2 : v === "page" ? 1 : 0;
  };
  if (rank(a) !== rank(b)) return rank(a) > rank(b) ? a : b;
  const ga = a.regainMinutes ?? 0;
  const gb = b.regainMinutes ?? 0;
  if (ga !== gb) return ga > gb ? a : b;
  return b.usagePct > a.usagePct ? b : a;
}
const SUMMARY_EVERY_MS = 15 * MINUTE;

const summary = { since: 0, ticks: 0, checks: 0, ok: 0, failed: {} as Record<string, number>, calls: 0 };

function callsInLastHour(now: number): number {
  callLog = callLog.filter((e) => now - e.at < 60 * MINUTE);
  return callLog.reduce((s, e) => s + e.n, 0);
}

function maybeLogSummary(now: number): void {
  if (summary.since === 0) summary.since = now;
  if (now - summary.since < SUMMARY_EVERY_MS) return;
  if (summary.ticks > 0 && process.env.NODE_ENV !== "test") {
    const failed = Object.entries(summary.failed)
      .map(([k, n]) => `${k}=${n}`)
      .join(" ");
    console.log(
      `[posting-watch] last ${Math.round((now - summary.since) / MINUTE)}m: ticks=${summary.ticks} ` +
        `checks=${summary.checks} ok=${summary.ok}${failed ? ` failed(${failed})` : ""} calls=${summary.calls}` +
        (pausedUntil > now ? ` PAUSED until ${new Date(pausedUntil).toISOString()}` : ""),
    );
  }
  summary.since = now;
  summary.ticks = 0;
  summary.checks = 0;
  summary.ok = 0;
  summary.failed = {};
  summary.calls = 0;
}

// ── One check ─────────────────────────────────────────────────────────────────────

const FB_FIELDS = "id,created_time,permalink_url";
const IG_FIELDS = "id,timestamp,permalink";
/** A few items, not one: the newest is taken as the max over the page, which is immune
 *  to a pinned post sorting first. Same call cost as limit=1. */
const FB_LIMIT = 3;
const IG_LIMIT = 4;

/**
 * Instagram Collabs. A Collab is OWNED by the account that started it, so it is listed only on
 * the owner's /media — never on a collaborator's — although, once the collaborator ACCEPTS, it
 * shows on both profiles. GET /{ig-user}/collaborative_media lists exactly those: media where
 * this account is an ACCEPTED collaborator, whoever owns it. Live-probed 2026-10-06 on all 62
 * watched accounts (0 errors, ~0.5 s each): @movifiedhollywood's own /media was 10 days old
 * while its accepted Collabs with @movifiedbollywood were 3 days old.
 *
 * Why not /tags + GET /{media}/collaborators (tried first, rejected on live data):
 *  - /tags also holds every fan's photo tag, and /collaborators answers only for media the
 *    token's user CREATED (Meta's docs; (#100) for anyone else's), so a Collab owned by an
 *    outside account could never be confirmed — and fans' tags alone made 4 of the 11
 *    accounts that needed the lookup "can't check";
 *  - it also lists PENDING invites (2 of @movifiedhollywood's newest), which are not on the
 *    account's profile.
 *
 * The list is NOT newest-first: it comes roughly in the order the account accepted, in
 * batches, and `since`/`until` are ignored (probed). A Collab posted in the last hours was also
 * accepted in the last hours — acceptance follows posting — so it sits at the top: the newest
 * is taken as the max over one generous page. Census of all 56 watched accounts that have
 * Collabs (2026-10-06, lists paged to 1,000): the newest was at position 22 or better on every
 * one, and every Collab of the last 7 days within the first 50. A recent Collab can only be
 * missed if the account accepts 100+ older invites after it. limit=100 costs what limit=50 does
 * (p50 0.52 s vs 0.49 s).
 */
const IG_COLLAB_FIELDS = "id,timestamp,permalink";
const IG_COLLAB_LIMIT = 100;
/** The most one check can cost: an Instagram check reads its own feed and, when that looks
 *  silent, its Collabs; a Facebook check is one read. The tick reserves this much BEFORE a
 *  check starts, so concurrent checks can never together overrun its call budget. */
function maxCallsFor(kind: Kind): number {
  return kind === "INSTAGRAM_ACCOUNT" ? 2 : 1;
}

export interface CheckJob {
  key: string;
  kind: Kind;
  metaId: string;
  token: string | null;
  prev: FoldedSnapshot;
}

export interface CheckResult {
  job: CheckJob;
  outcome: CheckOutcome;
  /** Requests that left the process: 0 with no token, 1 for a plain read, 2 when an
   *  Instagram check also read its Collabs. */
  calls: number;
  error: string | null;
  usage: MetaUsage;
  /** Graph code 4: the APP's own limit — everything should slow down. */
  appThrottled: boolean;
}

/**
 * A Graph answer that is not a readable list, turned into a failed check. `context` names the
 * read that failed; `priorUsage` is an earlier read's reading in the same check, so a second
 * call that times out (no headers) cannot hide the first call's slow-down.
 */
function failedCheck(
  job: CheckJob,
  startedAt: number,
  res: OauthGraphResult<unknown>,
  calls: number,
  opts: { context?: string; priorUsage?: MetaUsage } = {},
): CheckResult {
  const context = opts.context ?? "";
  const usage = moreUrgent(opts.priorUsage ?? null, res.usage);
  if (res.ok) {
    // 200 with an unreadable body (oauthGraphFetch returns ok:true, data undefined).
    return { job, outcome: { ok: false, startedAt, errorKind: "meta_error" }, calls, error: `${context}Meta returned an unreadable response.`, usage, appThrottled: false };
  }
  return {
    job,
    outcome: { ok: false, startedAt, errorKind: classifyFailure(res) },
    calls,
    error: `${context}${res.error ?? `HTTP ${res.status}`}`.slice(0, 300),
    usage,
    appThrottled: res.errorCode === 4,
  };
}

const isList = <T>(res: OauthGraphResult<{ data?: T[] }>): res is OauthGraphResult<{ data: T[] }> & { data: { data: T[] } } =>
  res.ok && !!res.data && Array.isArray(res.data.data);

/**
 * The newest ACCEPTED Collab of this Instagram account, or null when it has none. A failed read
 * fails the whole check (never "no Collab"): a Collab we could not see may be the very post
 * that keeps the channel off the list.
 */
async function newestCollab(
  job: CheckJob & { token: string },
  startedAt: number,
  timeoutMs: number,
): Promise<{ newest: NewestPost | null; usage: MetaUsage; failure: OauthGraphResult<unknown> | null }> {
  const res = await oauthGraphFetch<{ data?: FeedItem[] }>(
    `${job.metaId}/collaborative_media`,
    { fields: IG_COLLAB_FIELDS, limit: IG_COLLAB_LIMIT },
    job.token,
    { label: "posting-watch-ig-collabs", timeoutMs, recordUsage: false },
  );
  if (!isList(res)) return { newest: null, usage: res.usage, failure: res };
  // Max over the page (not its first item): the list is not newest-first.
  return { newest: newestPostIn(res.data.data, startedAt), usage: res.usage, failure: null };
}

/**
 * One newest-post read (plus, for an Instagram account whose own feed looks silent, its
 * Collabs). Never throws (oauthGraphFetch never throws).
 */
export async function checkPage(
  job: CheckJob,
  startedAt: number,
  cfg: Pick<PostingWatchConfig, "requestTimeoutMs"> & { rules: Pick<WatchRules, "gapMs"> },
): Promise<CheckResult> {
  if (!job.token) {
    return {
      job,
      outcome: { ok: false, startedAt, errorKind: "token" },
      calls: 0,
      error: "No usable Meta access token for this channel — reconnect on Account Growth.",
      usage: null,
      appThrottled: false,
    };
  }
  const isIg = job.kind === "INSTAGRAM_ACCOUNT";
  const res = await oauthGraphFetch<{ data?: FeedItem[] }>(
    isIg ? `${job.metaId}/media` : `${job.metaId}/published_posts`,
    {
      fields: isIg ? IG_FIELDS : FB_FIELDS,
      limit: isIg ? IG_LIMIT : FB_LIMIT,
      // Server-side guard against scheduled (future-dated) posts hiding real ones.
      // Live-probed 2026-10-03: accepted on both edges. +60 s tolerates clock skew.
      until: Math.floor(startedAt / 1000) + 60,
    },
    job.token,
    { label: isIg ? "posting-watch-ig" : "posting-watch-fb", timeoutMs: cfg.requestTimeoutMs, recordUsage: false },
  );
  if (!isList(res)) return failedCheck(job, startedAt, res, 1);
  let newest = newestPostIn(res.data.data, startedAt);
  let calls = 1;
  let usage = res.usage;
  // Collabs only matter when the account's own posts would leave it silent; a post inside
  // the gap already answers the question at no extra cost.
  if (isIg && (newest == null || newest.at <= startedAt - cfg.rules.gapMs)) {
    // Meta has just asked us to slow down. The Collab read decides whether this account is
    // silent, so the check cannot finish without it: it fails as rate-limited (never a flag),
    // and the tick backs off as the reading says.
    if (throttleOf(usage)) {
      return {
        job,
        outcome: { ok: false, startedAt, errorKind: "rate_limited" },
        calls,
        error: "Meta asked us to slow down before this account's Collabs could be read.",
        usage,
        appThrottled: false,
      };
    }
    const collab = await newestCollab({ ...job, token: job.token }, startedAt, cfg.requestTimeoutMs);
    calls++;
    if (collab.failure) return failedCheck(job, startedAt, collab.failure, calls, { context: "Reading its Collabs: ", priorUsage: usage });
    usage = moreUrgent(usage, collab.usage);
    if (collab.newest && (newest == null || collab.newest.at > newest.at)) newest = collab.newest;
  }
  return { job, outcome: { ok: true, startedAt, newest }, calls, error: null, usage, appThrottled: false };
}

/** Bounded-concurrency map; `fn` must not throw. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** FB reads with the Page's own token, IG with the connection's user token — the rule in
 *  meta-posts.service.ts tokenForAsset(). Decrypted per tick, never logged. */
function tokenResolver(set: MonitoredSet): (p: PageAsset) => string | null {
  const userTokens = new Map<string, string | null>();
  const decrypt = (enc: string | null | undefined): string | null => {
    if (!enc) return null;
    try {
      return decryptToken(enc);
    } catch {
      return null;
    }
  };
  return (p) => {
    if (p.kind === "FACEBOOK_PAGE") return decrypt(p.pageTokenEnc);
    if (!userTokens.has(p.connectionId)) userTokens.set(p.connectionId, decrypt(set.userTokenEnc.get(p.connectionId)));
    return userTokens.get(p.connectionId) ?? null;
  };
}

// ── The tick ──────────────────────────────────────────────────────────────────────

export type TickResult =
  | {
      status: "skipped";
      reason: "running" | "disabled" | "unconfigured" | "closed" | "paused" | "hourly_cap" | "schema" | "db" | "off";
    }
  | { status: "ran"; due: number; checked: number; calls: number; failed: number; wrote: boolean };

export interface TickOptions {
  /** Injected clock for tests; production uses the real clock. */
  now?: Date;
  /** Tests only: run without the five META_OAUTH_* vars. */
  skipConfigCheck?: boolean;
}

/**
 * One poller tick. Claims the overlap flag BEFORE its first await and releases it in
 * `finally`; a concurrent call returns { skipped: "running" } and never takes over (a
 * takeover could not stop the old tick's JS anyway — 2026-09-08 house rule).
 */
export function runPostingWatchTick(opts: TickOptions = {}): Promise<TickResult> {
  if (running) {
    const age = Date.now() - running.startedAt;
    if (age > STALE_TICK_MS) {
      warnThrottled(
        "posting-watch:stale",
        `[posting-watch] ⚠️ previous tick still running after ${Math.round(age / MINUTE)} min — skipping`,
      );
    }
    return Promise.resolve({ status: "skipped", reason: "running" });
  }
  running = { startedAt: Date.now() }; // claimed before the first await
  return (async (): Promise<TickResult> => {
    try {
      return await tickInner(opts);
    } finally {
      running = null;
    }
  })();
}

async function tickInner(opts: TickOptions): Promise<TickResult> {
  const cfg = postingWatchConfig();
  const nowMs = opts.now ? opts.now.getTime() : Date.now();
  const clock = (): number => (opts.now ? nowMs : Date.now());

  if (!cfg.enabled) return { status: "skipped", reason: "disabled" };
  if (!opts.skipConfigCheck && !metaOauthConfigured()) return { status: "skipped", reason: "unconfigured" };
  const win = windowAt(nowMs, cfg.rules);
  if (!win.active) return { status: "skipped", reason: "closed" };
  if (pausedUntil > nowMs) return { status: "skipped", reason: "paused" };
  if (dbBackoffUntil > nowMs) return { status: "skipped", reason: "db" };
  const hourRemaining = cfg.hourlyCallCap - callsInLastHour(nowMs);
  if (hourRemaining <= 0) {
    warnThrottled("posting-watch:hourly-cap", `[posting-watch] hourly call cap (${cfg.hourlyCallCap}) reached — skipping`);
    return { status: "skipped", reason: "hourly_cap" };
  }
  if (!(await ensureSchema(nowMs))) return { status: "skipped", reason: "schema" };

  let set: MonitoredSet;
  try {
    set = await pwTx((tx) => loadMonitoredSet(tx, { withTokens: true, withWatch: true }));
  } catch (err) {
    if (isSchemaMissing(err)) {
      noteIfSchemaMissing(err, nowMs);
      warnThrottled("posting-watch:schema", "[posting-watch] ⚠️ meta_post_watch disappeared — the posting watch is PAUSED; re-checking every 10 min.");
      return { status: "skipped", reason: "schema" };
    }
    warnThrottled("posting-watch:db-read", `[posting-watch] state read skipped (DB busy or failing): ${scrubSecrets(String(err)).slice(0, 200)}`);
    return { status: "skipped", reason: "db" };
  }
  if (set.mode === "off") return { status: "skipped", reason: "off" };

  // Who is due, most urgent first. Each Page is judged against its channel's newest post.
  const candidates: Array<{ key: string; due: Due; page: PageAsset; snap: FoldedSnapshot }> = [];
  for (const ch of set.channels) {
    const snaps = ch.pages.map((p) => snapshotOf(set.watch.get(p.key)));
    const channelLast = groupLastPostAt(snaps);
    ch.pages.forEach((page, i) => {
      if ((cooldownUntil.get(page.key) ?? 0) > nowMs) return;
      const due = dueFor(effectiveSnapshot(snaps[i], channelLast), nowMs, cfg.rules, win);
      if (due) candidates.push({ key: page.key, due, page, snap: snaps[i] });
    });
  }
  const picked = orderDue(candidates).slice(0, Math.min(cfg.maxChecksPerTick, hourRemaining));

  summary.ticks++;
  if (picked.length === 0) {
    maybeLogSummary(nowMs);
    return { status: "ran", due: 0, checked: 0, calls: 0, failed: 0, wrote: false };
  }

  const tokenFor = tokenResolver(set);
  const jobs: CheckJob[] = picked.map((p) => ({
    key: p.key,
    kind: p.page.kind,
    metaId: p.page.metaId,
    token: tokenFor(p.page),
    prev: p.snap,
  }));

  const startedReal = Date.now();
  // The tick's CALL budget (a check can cost more than one call): never past the hourly cap,
  // never more than maxCallsPerTick in one tick. Each check reserves the most it could cost
  // before it starts, so even concurrent checks cannot overrun it; what goes unused is
  // released. A check that does not fit stays due and runs on a later tick.
  const callBudget = Math.min(hourRemaining, cfg.maxCallsPerTick);
  let callsUsed = 0;
  let callsReserved = 0;
  const results = await runPool(jobs, cfg.concurrency, async (job): Promise<CheckResult | null> => {
    // Budget is wall-clock (real time), even under an injected test clock.
    if (Date.now() - startedReal > cfg.tickBudgetMs) return null;
    if (pausedUntil > clock()) return null;
    const reserve = maxCallsFor(job.kind);
    if (callsUsed + callsReserved + reserve > callBudget) return null;
    callsReserved += reserve;
    try {
      const r = await checkPage(job, clock(), cfg);
      callsUsed += r.calls;
      // React to Meta's throttle telemetry at once, so the rest of this tick obeys it. Meta
      // throttles on calls, CPU or time — whichever is highest (usagePct) — and says how
      // long a throttle already in force will last (regainMinutes).
      const regainMs = Math.min(MAX_REGAIN_MS, (r.usage?.regainMinutes ?? 0) * MINUTE);
      const throttle = throttleOf(r.usage);
      if (r.appThrottled || throttle === "app") {
        pausedUntil = Math.max(pausedUntil, clock() + Math.max(GLOBAL_PAUSE_MS, regainMs));
      } else if (throttle === "page") {
        cooldownUntil.set(job.key, clock() + Math.max(PAGE_COOLDOWN_MS, regainMs));
      }
      return r;
    } catch (err) {
      // checkPage cannot throw by contract; a bug here must not end the tick.
      warnThrottled("posting-watch:check-threw", `[posting-watch] check threw: ${scrubSecrets(String(err)).slice(0, 200)}`);
      // Calls it made before throwing are unknown: the whole reservation counts against this
      // tick's budget. (The hourly log and api_usage see only completed checks; by contract
      // this path never runs.)
      callsUsed += reserve;
      return null;
    } finally {
      callsReserved -= reserve;
    }
  });

  const done = results.filter((r): r is CheckResult => r != null);
  let calls = 0;
  let failed = 0;
  let rateLimited = 0;
  const writes: Array<{ kind: Kind; metaId: string; snap: FoldedSnapshot; error: string | null }> = [];
  for (const r of done) {
    calls += r.calls;
    if (!r.outcome.ok) {
      failed++;
      summary.failed[r.outcome.errorKind] = (summary.failed[r.outcome.errorKind] ?? 0) + 1;
      if (r.outcome.errorKind === "rate_limited") rateLimited++;
    } else {
      summary.ok++;
    }
    writes.push({ kind: r.job.kind, metaId: r.job.metaId, snap: foldOutcome(r.job.prev, r.outcome), error: r.error });
  }
  if (rateLimited >= RATE_LIMITED_PAUSE_THRESHOLD) {
    pausedUntil = Math.max(pausedUntil, clock() + GLOBAL_PAUSE_MS);
  }
  if (pausedUntil > nowMs) {
    warnThrottled(
      "posting-watch:paused",
      `[posting-watch] Meta asked us to slow down — pausing checks until ${new Date(pausedUntil).toISOString()}`,
    );
  }
  for (const [k, until] of cooldownUntil) if (until <= nowMs) cooldownUntil.delete(k);

  summary.checks += done.length;
  summary.calls += calls;
  if (calls > 0) {
    callLog.push({ at: nowMs, n: calls });
    // ONE api_usage row for the whole tick (oauthGraphFetch was told recordUsage:false).
    recordApiUsage({ provider: "meta", operation: "meta-oauth:posting-watch", calls, units: calls });
  }

  let wrote = false;
  if (writes.length > 0) {
    try {
      await pwTx((tx) => writeSnapshots(tx, writes));
      wrote = true;
      invalidatePostingWatchCache();
    } catch (err) {
      noteIfSchemaMissing(err, nowMs);
      dbBackoffUntil = Math.max(dbBackoffUntil, clock() + DB_WRITE_BACKOFF_MS);
      warnThrottled(
        "posting-watch:db-write",
        `[posting-watch] result write skipped (DB busy or failing) — backing off ${DB_WRITE_BACKOFF_MS / MINUTE} min: ${scrubSecrets(String(err)).slice(0, 200)}`,
      );
    }
  }
  maybeLogSummary(nowMs);
  return { status: "ran", due: candidates.length, checked: done.length, calls, failed, wrote };
}

type SnapshotWrite = { kind: Kind; metaId: string; snap: FoldedSnapshot; error: string | null };

/**
 * Store a tick's results in ONE statement — a single round trip however many Pages were
 * checked, so the connection is held for milliseconds, not one upsert per Page.
 */
async function writeSnapshots(tx: Prisma.TransactionClient, writes: SnapshotWrite[]): Promise<void> {
  // One row per Page: ON CONFLICT cannot touch the same row twice in a statement.
  const unique = [...new Map(writes.map((w) => [pageKey(w.kind, w.metaId), w])).values()];
  // The timestamp(3) columns hold UTC, as Prisma writes them. Converting explicitly means
  // the session time zone can never shift a stored instant.
  const ts = (ms: number | null) => Prisma.sql`(${ms == null ? null : new Date(ms).toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const rows = unique.map(
    (w) => Prisma.sql`(
      ${randomUUID()}, ${w.kind}::"MetaAssetKind", ${w.metaId},
      ${ts(w.snap.lastPostAt)}, ${w.snap.lastPostId}, ${w.snap.lastPostUrl},
      ${ts(w.snap.checkedAt)}, ${ts(w.snap.attemptedAt)},
      ${w.snap.errorKind}, ${w.snap.errorKind && w.error ? scrubSecrets(w.error).slice(0, 300) : null},
      ${ts(w.snap.errorSince)}, ${w.snap.consecutiveErrors}::int,
      (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
    )`,
  );
  await tx.$executeRaw`
    INSERT INTO "meta_post_watch" (
      "id", "kind", "meta_id",
      "last_post_at", "last_post_id", "last_post_url",
      "checked_at", "attempted_at",
      "error_kind", "error",
      "error_since", "consecutive_errors",
      "created_at", "updated_at"
    )
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("kind", "meta_id") DO UPDATE SET
      "last_post_at" = EXCLUDED."last_post_at",
      "last_post_id" = EXCLUDED."last_post_id",
      "last_post_url" = EXCLUDED."last_post_url",
      "checked_at" = EXCLUDED."checked_at",
      "attempted_at" = EXCLUDED."attempted_at",
      "error_kind" = EXCLUDED."error_kind",
      "error" = EXCLUDED."error",
      "error_since" = EXCLUDED."error_since",
      "consecutive_errors" = EXCLUDED."consecutive_errors",
      "updated_at" = EXCLUDED."updated_at"`;
}

// ── The dashboard payload ─────────────────────────────────────────────────────────

export type PostingWatchPlatform = "facebook" | "instagram";
export type PostingWatchGroup = SilentGroup | "cant_check";

export interface PostingWatchPerson {
  id: string;
  name: string;
}

export interface PostingWatchChannel {
  key: string;
  platform: PostingWatchPlatform;
  /** The primary Page's name (most followers). */
  name: string;
  /** Where the channel lives on Meta (FB: numeric Page id; IG: username). */
  href: string | null;
  /** Every connected Page behind this channel (usually one). */
  pages: Array<{ metaId: string; name: string; href: string | null }>;
  /** Who it is assigned to. */
  assignees: PostingWatchPerson[];
  group: PostingWatchGroup;
  /** Newest post across the channel's Pages. */
  lastPostAt: string | null;
  lastPostUrl: string | null;
  /** Silence is measured from here: max(newest post, today's window open). */
  silentSince: string | null;
  /** Newest successful check across the channel's Pages. */
  checkedAt: string | null;
  errorKind: ErrorKind | null;
  /** Meta's own (secret-scrubbed) message for a failing check. */
  errorDetail: string | null;
  errorSince: string | null;
}

export interface PostingWatchNotConnected {
  accountId: string;
  platform: PostingWatchPlatform;
  name: string;
  handle: string;
  /** no_page: nothing connected matches it; ambiguous: it matches Pages of several channels. */
  reason: NotConnectedReason;
  assignees: PostingWatchPerson[];
}

export interface PostingWatchPayload {
  /** ok = live; off = switched off; paused = DDL missing; unavailable = no data could be read. */
  status: "ok" | "off" | "paused" | "unavailable";
  reason: "disabled" | "switched_off" | "schema" | "db" | null;
  /** The real current time (also on a stale payload, so durations stay true). */
  now: string;
  /** When the channel data was read: equals `now` unless the payload is stale. */
  asOf: string;
  window: {
    start: string;
    end: string;
    active: boolean;
    nextStart: string;
    startMinute: number;
    endMinute: number;
    timeZone: "Asia/Kolkata";
  };
  thresholdMinutes: number;
  /** Served from the last good read because the latest one failed. */
  stale: boolean;
  monitor: {
    configured: boolean;
    pausedUntil: string | null;
    /** Newest check of any outcome across the watched Pages. */
    lastCheckAt: string | null;
    /** Newest SUCCESSFUL check. Far behind lastCheckAt = checks are failing. */
    lastSuccessAt: string | null;
    /** Oldest deadline among channels still awaiting their confirming check. Checks run
     *  within a minute or two of a deadline, so an old value means they are behind. */
    verifyingSince: string | null;
  };
  counts: {
    monitored: number;
    onSchedule: number;
    verifying: number;
    quiet_today: number;
    no_post_today: number;
    inactive: number;
    cant_check: number;
    not_connected: number;
  };
  channels: PostingWatchChannel[];
  notConnected: PostingWatchNotConnected[];
}

const GROUP_ORDER: Record<PostingWatchGroup, number> = { quiet_today: 0, no_post_today: 1, inactive: 2, cant_check: 3 };

/** FB: the numeric Page id (permanent; ~120 Pages have no username). IG: the username
 *  (there is no id-based Instagram URL). Same asymmetric rule as channelHref(). */
function pageHref(kind: Kind, metaId: string, username: string | null): string | null {
  if (kind === "FACEBOOK_PAGE") return /^\d+$/.test(metaId) ? `https://www.facebook.com/${metaId}` : null;
  return username ? `https://www.instagram.com/${encodeURIComponent(username)}/` : null;
}

const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString());
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function emptyCounts(): PostingWatchPayload["counts"] {
  return { monitored: 0, onSchedule: 0, verifying: 0, quiet_today: 0, no_post_today: 0, inactive: 0, cant_check: 0, not_connected: 0 };
}

function basePayload(nowMs: number, cfg: PostingWatchConfig): PostingWatchPayload {
  const win = windowAt(nowMs, cfg.rules);
  return {
    status: "ok",
    reason: null,
    now: new Date(nowMs).toISOString(),
    asOf: new Date(nowMs).toISOString(),
    window: {
      start: new Date(win.start).toISOString(),
      end: new Date(win.end).toISOString(),
      active: win.active,
      nextStart: new Date(win.nextStart).toISOString(),
      startMinute: cfg.rules.windowStartMin,
      endMinute: cfg.rules.windowEndMin,
      timeZone: "Asia/Kolkata",
    },
    thresholdMinutes: Math.round(cfg.rules.gapMs / MINUTE),
    stale: false,
    monitor: {
      configured: metaOauthConfigured(),
      pausedUntil: pausedUntil > nowMs ? new Date(pausedUntil).toISOString() : null,
      lastCheckAt: null,
      lastSuccessAt: null,
      verifyingSince: null,
    },
    counts: emptyCounts(),
    channels: [],
    notConnected: [],
  };
}

/**
 * Turn a loaded set into the dashboard payload. Pure apart from the module health
 * fields read by basePayload; exported so a read-only dry run can render exactly what the
 * dashboard would.
 */
export function buildPayloadFrom(set: MonitoredSet, nowMs: number, cfg: PostingWatchConfig = postingWatchConfig()): PostingWatchPayload {
  const out = basePayload(nowMs, cfg);
  const win = windowAt(nowMs, cfg.rules);
  const counts = emptyCounts();
  const channels: PostingWatchChannel[] = [];
  let lastCheck: number | null = null;
  let lastSuccess: number | null = null;
  let verifyingSince: number | null = null;

  for (const ch of set.channels) {
    counts.monitored++;
    const rows = ch.pages.map((p) => set.watch.get(p.key));
    const snaps = rows.map((r) => snapshotOf(r));
    for (const s of snaps) {
      if (s.attemptedAt != null && (lastCheck == null || s.attemptedAt > lastCheck)) lastCheck = s.attemptedAt;
      if (s.checkedAt != null && (lastSuccess == null || s.checkedAt > lastSuccess)) lastSuccess = s.checkedAt;
    }
    const st = classifyChannel(snaps, nowMs, cfg.rules, win);
    let group: PostingWatchGroup | null = null;
    let silentSince: number | null = null;
    switch (st.state) {
      case "ok":
      case "closed":
        counts.onSchedule++;
        break;
      case "verifying":
        counts.verifying++;
        if (verifyingSince == null || st.deadline < verifyingSince) verifyingSince = st.deadline;
        break;
      case "silent":
        group = st.group;
        silentSince = st.silentSince;
        counts[st.group]++;
        break;
      case "cant_check":
        group = "cant_check";
        counts.cant_check++;
        break;
    }
    if (group == null) continue;

    // The newest post (and its link) across the channel's Pages.
    let newestIdx = -1;
    snaps.forEach((s, i) => {
      if (s.lastPostAt != null && (newestIdx < 0 || s.lastPostAt > (snaps[newestIdx].lastPostAt as number))) newestIdx = i;
    });
    const checked = snaps.reduce<number | null>((m, s) => (s.checkedAt != null && (m == null || s.checkedAt > m) ? s.checkedAt : m), null);
    const failingRow =
      st.state === "cant_check" ? rows.find((r) => r?.errorKind === st.errorKind && r?.errorSince?.getTime() === st.since) ?? rows.find((r) => r?.errorKind) : undefined;
    const primary = ch.pages[0];
    channels.push({
      key: ch.key,
      platform: ch.kind === "FACEBOOK_PAGE" ? "facebook" : "instagram",
      name: primary.name,
      href: pageHref(primary.kind, primary.metaId, primary.username),
      pages: ch.pages.map((p) => ({ metaId: p.metaId, name: p.name, href: pageHref(p.kind, p.metaId, p.username) })),
      assignees: ch.assignees.map((a) => ({ id: a.id, name: a.name })),
      group,
      lastPostAt: newestIdx >= 0 ? iso(snaps[newestIdx].lastPostAt) : null,
      lastPostUrl: newestIdx >= 0 ? snaps[newestIdx].lastPostUrl : null,
      silentSince: iso(silentSince),
      checkedAt: iso(checked),
      errorKind: st.state === "cant_check" ? st.errorKind : null,
      errorDetail: st.state === "cant_check" ? failingRow?.error ?? null : null,
      errorSince: st.state === "cant_check" ? iso(st.since) : null,
    });
  }

  // Longest silence first (ISO strings compare chronologically as plain strings), then
  // name, then key — so equal rows never shuffle between polls.
  channels.sort(
    (x, y) =>
      GROUP_ORDER[x.group] - GROUP_ORDER[y.group] ||
      cmp(x.silentSince ?? x.errorSince ?? "", y.silentSince ?? y.errorSince ?? "") ||
      x.name.localeCompare(y.name) ||
      cmp(x.key, y.key),
  );

  const notConnected: PostingWatchNotConnected[] = set.notConnected.map((r) => ({
    accountId: r.id,
    platform: r.platform,
    name: r.displayName,
    handle: r.handle,
    reason: r.reason,
    assignees: [...r.assignees].sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({ id: a.id, name: a.name })),
  }));
  counts.not_connected = notConnected.length;

  return {
    ...out,
    monitor: { ...out.monitor, lastCheckAt: iso(lastCheck), lastSuccessAt: iso(lastSuccess), verifyingSince: iso(verifyingSince) },
    counts,
    channels,
    notConnected,
  };
}

async function buildPayload(nowMs: number): Promise<PostingWatchPayload> {
  const cfg = postingWatchConfig();
  if (!cfg.enabled) return { ...basePayload(nowMs, cfg), status: "off", reason: "disabled" };
  if (!(await ensureSchema(nowMs))) {
    // ensureSchema returns false for a transient failure too; only a cached verdict means
    // the DDL is missing. A transient failure throws so the caller can serve the last
    // good payload instead of flashing "unavailable".
    if (schemaOk === false) return { ...basePayload(nowMs, cfg), status: "paused", reason: "schema" };
    throw new Error("posting-watch schema check could not run");
  }
  let set: MonitoredSet;
  try {
    set = await pwTx((tx) => loadMonitoredSet(tx, { withTokens: false, withWatch: true }));
  } catch (err) {
    noteIfSchemaMissing(err, nowMs);
    if (isSchemaMissing(err)) return { ...basePayload(nowMs, cfg), status: "paused", reason: "schema" };
    throw err;
  }
  if (set.mode === "off") return { ...basePayload(nowMs, cfg), status: "off", reason: "switched_off" };
  return buildPayloadFrom(set, nowMs, cfg);
}

const READ_TTL_MS = 15_000;
const LAST_GOOD_MAX_AGE_MS = 10 * MINUTE;
const readMemo = createSingleFlightMemo({ ttlMs: READ_TTL_MS, maxEntries: 8 });
let lastGood: { at: number; payload: PostingWatchPayload } | null = null;

/** ⚠️ MANDATORY in the beforeEach of any test touching this service (cross-test pollution). */
export function invalidatePostingWatchCache(): void {
  readMemo.clear();
}

/**
 * The dashboard payload. NEVER throws: a failed read serves the last good payload (marked
 * stale) for up to 10 minutes, then an honest "unavailable" — so the card can never show
 * a raw error, and the route never answers 500 because the pool had a bad minute.
 */
export function getPostingWatch(opts: { now?: Date } = {}): Promise<PostingWatchPayload> {
  const nowMs = opts.now ? opts.now.getTime() : Date.now();
  const key = opts.now ? `at:${nowMs}` : "live";
  return readMemo.memo(key, async () => {
    try {
      const payload = await buildPayload(nowMs);
      if (payload.status === "ok") lastGood = { at: nowMs, payload };
      return payload;
    } catch (err) {
      warnThrottled("posting-watch:read", `[posting-watch] dashboard read failed: ${scrubSecrets(String(err)).slice(0, 200)}`);
      const fresh = basePayload(nowMs, postingWatchConfig());
      if (lastGood && nowMs - lastGood.at <= LAST_GOOD_MAX_AGE_MS) {
        // The channel data is the last good read (asOf says when); the clock fields are
        // rebuilt for NOW, so durations, "checked … ago" and the window stay true.
        return {
          ...lastGood.payload,
          now: fresh.now,
          window: fresh.window,
          monitor: { ...lastGood.payload.monitor, configured: fresh.monitor.configured, pausedUntil: fresh.monitor.pausedUntil },
          stale: true,
        };
      }
      return { ...fresh, status: "unavailable", reason: "db" };
    }
  });
}

// ── Test hooks ────────────────────────────────────────────────────────────────────

/** Reset every module-level flag, cache and counter. Tests only. */
export function resetPostingWatchStateForTests(): void {
  running = null;
  pausedUntil = 0;
  dbBackoffUntil = 0;
  cooldownUntil.clear();
  callLog = [];
  schemaOk = null;
  schemaCheckedAt = 0;
  lastGood = null;
  summary.since = 0;
  summary.ticks = 0;
  summary.checks = 0;
  summary.ok = 0;
  summary.failed = {};
  summary.calls = 0;
  readMemo.clear();
}
