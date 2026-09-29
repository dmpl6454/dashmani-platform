/**
 * Pure SyncEngine scheduling rules (spec §5.5). No timers, no DOM, no fetch — the HR
 * `sync-engine.ts` owns those and asks this module every "how long / what next" question,
 * so the rules are unit-tested in one place (apps/api/tests/pipeline/frontend-pure.test.ts).
 *
 * `rand` is always injected (a () => number in [0, 1)) so jitter is testable.
 */
import type { PipelinePollMs, PipelineErrorCode, PipelineSyncRequest, PipelineSyncResponse } from "../types/pipeline";

export type Rand = () => number;

/** What the tab is showing. `project` wins over `board` when both are mounted. */
export type PipelineViewKind = "project" | "board" | "none";

export interface IntervalContext {
  view: PipelineViewKind;
  /** document.visibilityState === "visible". */
  visible: boolean;
  /** document.hasFocus(). */
  focused: boolean;
  /** No input for 5 minutes. */
  idle: boolean;
  /** navigator.onLine. */
  online: boolean;
}

/** Minutes of no input before the idle interval applies. */
export const PIPELINE_IDLE_AFTER_MS = 5 * 60_000;
/** A wake (visible / focus) syncs immediately only if the last sync is at least this old. */
export const PIPELINE_WAKE_MIN_GAP_MS = 3_000;
/** After one of your own writes the engine syncs at most once per this window. */
export const PIPELINE_POST_WRITE_GAP_MS = 2_000;
/** `hasMore` chains at most this many immediate follow-ups; then the thread reloads. */
export const PIPELINE_HAS_MORE_CHAIN_MAX = 3;
/** A hard reload (reload:true or an unexpected 4xx) happens at most once per this window. */
export const PIPELINE_RELOAD_MIN_GAP_MS = 10 * 60_000;
/** PIPELINE_DISABLED: re-check bootstrap this often (± jitter) while visible. */
export const PIPELINE_DISABLED_RECHECK_MS = 3 * 60_000;
/** After this long rate-limited, a subtle "Live updates paused for a moment" pill shows. */
export const PIPELINE_RATE_LIMIT_PILL_AFTER_MS = 2 * 60_000;
/** "Reconnecting…" shows only after this many consecutive failures. */
export const PIPELINE_RECONNECTING_AFTER_FAILURES = 2;
/** Back-off for an unexpected 4xx on /sync. */
export const PIPELINE_UNEXPECTED_4XX_BACKOFF_MS = 60_000;

const BACKOFF_STEPS_MS = [10_000, 20_000, 40_000, 60_000] as const;

/** `base × U(1 − frac, 1 + frac)`, rounded to a whole millisecond. */
export function jitter(base: number, rand: Rand, frac: number): number {
  return Math.round(base * (1 - frac + 2 * frac * rand()));
}

/**
 * The base interval for the current tab state, or null when polling is paused
 * (hidden or offline). Idle never makes polling FASTER than the view's own cadence.
 */
export function baseIntervalMs(ctx: IntervalContext, poll: PipelinePollMs): number | null {
  if (!ctx.visible || !ctx.online) return null;
  let base: number;
  if (ctx.view === "project") base = ctx.focused ? poll.project : poll.projectBg;
  else base = ctx.focused ? poll.board : poll.boardBg;
  if (ctx.idle) base = Math.max(base, poll.idle);
  return base;
}

/** The next tick: the base interval × U(0.8, 1.2), or null when paused. */
export function nextTickMs(ctx: IntervalContext, poll: PipelinePollMs, rand: Rand): number | null {
  const base = baseIntervalMs(ctx, poll);
  return base === null ? null : jitter(base, rand, 0.2);
}

/** Failure back-off: 10 → 20 → 40 → 60 s (capped), ± 30%. `failures` counts from 1. */
export function backoffMs(failures: number, rand: Rand): number {
  const i = Math.min(Math.max(failures, 1), BACKOFF_STEPS_MS.length) - 1;
  return jitter(BACKOFF_STEPS_MS[i], rand, 0.3);
}

/** A 429 pauses for `retryAfterSec` ± 20% (30 s when the body carried none). */
export function rateLimitPauseMs(retryAfterSec: number | undefined, rand: Rand): number {
  const sec = typeof retryAfterSec === "number" && retryAfterSec > 0 ? retryAfterSec : 30;
  return jitter(sec * 1000, rand, 0.2);
}

/** Coming back online syncs after 2 s plus up to 1 s of jitter. */
export function onlineWakeDelayMs(rand: Rand): number {
  return 2_000 + Math.round(1_000 * rand());
}

/** Should a visible / focus wake sync immediately? */
export function shouldSyncOnWake(lastSyncStartedAt: number | null, now: number): boolean {
  return lastSyncStartedAt === null || now - lastSyncStartedAt >= PIPELINE_WAKE_MIN_GAP_MS;
}

/**
 * The instant before which a wake must not sync: a failed attempt's back-off, a 429
 * pause or a PIPELINE_DISABLED re-check. null after a 200 (or a terminal stop, which
 * never polls again). Without it every alt-tab during an outage re-polled, defeating the
 * 10 → 60 s back-off and `retryAfterSec` across every open tab.
 */
export function holdUntilAfter(outcome: SyncOutcome, delayMs: number | null, now: number): number | null {
  if (outcome.kind === "ok" || outcome.kind === "terminal" || delayMs === null) return null;
  return now + delayMs;
}

/**
 * A visible / focus / back-from-idle wake: 0 = sync now; a positive number = a hold is
 * pending, wait that long; null = not due yet (the last sync started < 3 s ago).
 */
export function wakeDelayMs(lastSyncStartedAt: number | null, holdUntil: number | null, now: number): number | null {
  if (holdUntil !== null && now < holdUntil) return holdUntil - now;
  return shouldSyncOnWake(lastSyncStartedAt, now) ? 0 : null;
}

const POLL_KEYS = ["project", "projectBg", "board", "boardBg", "idle"] as const;

/**
 * The server's cadence from a sync response (§8.5: `pipeline.pollMs` must reach open
 * tabs). Only a complete set of positive finite numbers is adopted; anything else (an
 * older server's bare number, a partial or junk object) keeps `current`. An unchanged
 * set keeps identity.
 */
export function adoptServerPollMs(current: PipelinePollMs | null, incoming: unknown): PipelinePollMs | null {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return current;
  const o = incoming as Record<string, unknown>;
  const next = {} as Record<(typeof POLL_KEYS)[number], number>;
  for (const k of POLL_KEYS) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return current;
    next[k] = v;
  }
  if (current && POLL_KEYS.every((k) => current[k] === next[k])) return current;
  return next as PipelinePollMs;
}

/**
 * True when a complete (no hasMore) answer to OUR thread cursor reports a head BEHIND it
 * — only possible after a DB restore. The store never moves a cursor down, so without a
 * reload of the thread every newer message would be skipped until a manual refresh.
 */
export function threadCursorRegressed(req: PipelineSyncRequest, res: PipelineSyncResponse): boolean {
  const q = req.project;
  const r = res.project;
  if (!q || !r || r.id !== q.id || r.status === "deleted" || r.hasMore) return false;
  return r.rev < q.rev;
}

/** Should a post-write sync fire now (at most once per 2 s)? */
export function postWriteSyncAllowed(lastPostWriteSyncAt: number | null, now: number): boolean {
  return lastPostWriteSyncAt === null || now - lastPostWriteSyncAt >= PIPELINE_POST_WRITE_GAP_MS;
}

/** A hard reload is allowed at most once per 10 minutes. */
export function reloadAllowed(lastReloadAt: number | null, now: number): boolean {
  return lastReloadAt === null || now - lastReloadAt >= PIPELINE_RELOAD_MIN_GAP_MS;
}

// ── Response classification ─────────────────────────────────────────────────────────

/** What a finished /sync attempt looked like, as the engine saw it. */
export interface SyncAttemptResult {
  /** HTTP status; 0 for a network error, a timeout or a non-JSON body. */
  status: number;
  code?: PipelineErrorCode | string;
  retryAfterSec?: number;
}

export type SyncOutcome =
  /** 200: merge, reset the back-off. */
  | { kind: "ok" }
  /** 429: pause for retryAfterSec ± 20%, keep the data. */
  | { kind: "rate_limited"; retryAfterSec?: number }
  /** 503, 5xx, HTML 502, network error, or a transient refresh failure: back off. */
  | { kind: "transient" }
  /** 400, 404 or another unexpected 4xx: back off 60 s, then at most one reload / 10 min. */
  | { kind: "unexpected" }
  /** 403 PIPELINE_DISABLED: "Pipeline is paused". NOT terminal — re-check bootstrap. */
  | { kind: "disabled" }
  /** 403 NOT_IN_PILOT, ACCOUNT_INACTIVE, FORBIDDEN (or an unknown 403): stop polling. */
  | { kind: "terminal"; code: string };

const TERMINAL_403 = new Set(["PIPELINE_NOT_IN_PILOT", "ACCOUNT_INACTIVE", "FORBIDDEN"]);

export function classifySyncResult(r: SyncAttemptResult): SyncOutcome {
  const s = r.status;
  if (s >= 200 && s < 300) return { kind: "ok" };
  if (s === 429) return { kind: "rate_limited", retryAfterSec: r.retryAfterSec };
  if (s === 403) {
    if (r.code === "PIPELINE_DISABLED") return { kind: "disabled" };
    const code = typeof r.code === "string" && r.code ? r.code : "FORBIDDEN";
    return { kind: "terminal", code: TERMINAL_403.has(code) ? code : "FORBIDDEN" };
  }
  // 401 reaches the engine only when apiFetch could not complete a refresh for a
  // TRANSIENT reason (a rejected refresh redirects to /login before we ever see it).
  if (s === 0 || s === 401 || s >= 500) return { kind: "transient" };
  return { kind: "unexpected" };
}

// ── Scheduler state ────────────────────────────────────────────────────────────────

export interface SchedulerState {
  /** "running" polls; "disabled" re-checks bootstrap; "terminal" waits for a manual Retry. */
  mode: "running" | "disabled" | "terminal";
  terminalCode: string | null;
  /** Consecutive transient failures (resets on 200). */
  failures: number;
  /** When the current rate-limit streak began (null when not rate-limited). */
  rateLimitedSince: number | null;
  lastOkAt: number | null;
  lastReloadAt: number | null;
}

export const initialSchedulerState: SchedulerState = {
  mode: "running",
  terminalCode: null,
  failures: 0,
  rateLimitedSince: null,
  lastOkAt: null,
  lastReloadAt: null,
};

export interface SchedulerDecision {
  state: SchedulerState;
  /**
   * Delay until the next attempt. `null` = schedule from the normal interval
   * (after a 200) or stop (terminal). The engine applies nextTickMs for null+running.
   */
  delayMs: number | null;
  /** "reload" = one hard reload once the outbox flushes; "recheckBootstrap" = poll bootstrap. */
  action: "none" | "reload" | "recheckBootstrap" | "stop";
}

/**
 * The scheduler's reaction to one finished attempt. Pure: the same input always gives
 * the same decision. A failure NEVER signals the store to clear anything.
 */
export function planAfterAttempt(
  prev: SchedulerState,
  outcome: SyncOutcome,
  now: number,
  rand: Rand,
  opts: { reloadRequested?: boolean } = {},
): SchedulerDecision {
  switch (outcome.kind) {
    case "ok": {
      const state: SchedulerState = {
        ...prev,
        mode: "running",
        terminalCode: null,
        failures: 0,
        rateLimitedSince: null,
        lastOkAt: now,
      };
      if (opts.reloadRequested && reloadAllowed(prev.lastReloadAt, now)) {
        return { state: { ...state, lastReloadAt: now }, delayMs: null, action: "reload" };
      }
      return { state, delayMs: null, action: "none" };
    }
    case "rate_limited":
      return {
        state: { ...prev, mode: "running", rateLimitedSince: prev.rateLimitedSince ?? now },
        delayMs: rateLimitPauseMs(outcome.retryAfterSec, rand),
        action: "none",
      };
    case "transient": {
      const failures = prev.failures + 1;
      return {
        state: { ...prev, mode: "running", failures, rateLimitedSince: null },
        delayMs: backoffMs(failures, rand),
        action: "none",
      };
    }
    case "unexpected": {
      const reload = reloadAllowed(prev.lastReloadAt, now);
      return {
        state: { ...prev, failures: prev.failures + 1, lastReloadAt: reload ? now : prev.lastReloadAt },
        delayMs: PIPELINE_UNEXPECTED_4XX_BACKOFF_MS,
        action: reload ? "reload" : "none",
      };
    }
    case "disabled":
      return {
        state: { ...prev, mode: "disabled", failures: 0, rateLimitedSince: null },
        delayMs: jitter(PIPELINE_DISABLED_RECHECK_MS, rand, 0.2),
        action: "recheckBootstrap",
      };
    case "terminal":
      return {
        state: { ...prev, mode: "terminal", terminalCode: outcome.code, rateLimitedSince: null },
        delayMs: null,
        action: "stop",
      };
  }
}

/** What the status pill should say. Data is never cleared by any of these. */
export type ConnectionIndicator =
  | "live"
  | "reconnecting"
  | "rate_limited"
  | "paused"
  | "unavailable";

export function connectionIndicator(s: SchedulerState, now: number): ConnectionIndicator {
  if (s.mode === "terminal") return "unavailable";
  if (s.mode === "disabled") return "paused";
  if (s.rateLimitedSince !== null && now - s.rateLimitedSince >= PIPELINE_RATE_LIMIT_PILL_AFTER_MS) {
    return "rate_limited";
  }
  if (s.failures >= PIPELINE_RECONNECTING_AFTER_FAILURES) return "reconnecting";
  return "live";
}

/** hasMore: follow up immediately (count < 3), or reload the thread from route 6. */
export function planHasMore(chainCount: number): "follow_up" | "reload_thread" {
  return chainCount < PIPELINE_HAS_MORE_CHAIN_MAX ? "follow_up" : "reload_thread";
}
