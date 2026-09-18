import { AppError } from "../middleware/error-handler";

// Bulkhead for heavy analytics queries.
//
// WHY (incident 2026-09-18, and the same class on 2026-07-08 / 2026-07-16): the API
// has ONE Prisma pool (10 connections) shared by everything — login, HR report
// submit, notifications, AND the engagement/leaderboard aggregations. When an
// analytics query gets slow (a table outgrows its index, a plan flips, the box
// swaps), a handful of admin dashboard loads hold every connection for minutes and
// EVERY OTHER REQUEST fails with P2024 → "An unexpected error occurred" on the
// login page. The core operations of 100+ employees must never depend on how fast
// an admin's chart query is.
//
// This gate caps how many heavy queries may be IN FLIGHT at once (default 2), so at
// least 8 pool connections always remain for the load-bearing paths, whatever the
// analytics queries do. Callers beyond the cap wait (without holding a connection)
// up to HEAVY_QUERY_MAX_WAIT_MS, then get a clean 503 REPORTS_BUSY the frontends
// already render as an error state — never a 500, never a stuck request.
//
// Use it INSIDE the memo (so cache hits bypass the gate), wrapping only the actual
// DB-bound compute. It is defence in depth: the 2026-09-18 fix also made the
// wrapped queries cheap again (link_metrics_latest), so under normal load this gate
// is never contended. Do NOT raise the cap to "make reports faster" — a higher cap
// re-couples login to analytics; make the query cheaper instead.
const MAX_CONCURRENT = envInt("HEAVY_QUERY_CONCURRENCY", 2, 1, 8);
const MAX_WAIT_MS = envInt("HEAVY_QUERY_MAX_WAIT_MS", 15_000, 100, 120_000);

let active = 0;
interface Waiter {
  label: string;
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}
const waiters: Waiter[] = [];

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function acquire(label: string): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      label,
      grant: () => {
        clearTimeout(waiter.timer);
        active++;
        resolve();
      },
      timer: setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        console.warn(
          `[heavy-query] ${label} waited ${MAX_WAIT_MS}ms for a slot (active=${active}, queued=${waiters.length}) — returning 503 REPORTS_BUSY`,
        );
        reject(
          new AppError(
            503,
            "REPORTS_BUSY",
            "Reports are busy right now — please try again in a moment.",
          ),
        );
      }, MAX_WAIT_MS),
    };
    waiters.push(waiter);
  });
}

function release(): void {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next.grant();
}

/** Run `fn` inside the heavy-query bulkhead. */
export async function withHeavyQuerySlot<T>(label: string, fn: () => Promise<T>): Promise<T> {
  await acquire(label);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Diagnostics / tests. */
export function heavyQueryGateStats(): { active: number; queued: number; maxConcurrent: number; maxWaitMs: number } {
  return { active, queued: waiters.length, maxConcurrent: MAX_CONCURRENT, maxWaitMs: MAX_WAIT_MS };
}

/** Tests only — drop queued waiters (rejecting them) and reset the counter. */
export function resetHeavyQueryGateForTests(): void {
  for (const w of waiters.splice(0)) {
    clearTimeout(w.timer);
  }
  active = 0;
}
