/**
 * insights-runner.ts — in-memory singleton that orchestrates an on-demand
 * "full enrichment pass": social-insights harvest (IG/FB captions → link_content)
 * followed by entity extraction (link_content → entities via Claude Haiku).
 *
 * This module has NO DB writes of its own; all persistence is handled by the
 * crons it calls. It exists purely to:
 *  1. prevent a second manual run from starting while one is in flight,
 *  2. expose live phase/progress to the status endpoint, and
 *  3. surface cron errors honestly to admins instead of only to server logs.
 *
 * NOTE: The scheduled setInterval callers in index.ts call runSocialInsightsRefresh()
 * and runEntityExtraction() INDEPENDENTLY every 6h without going through this
 * singleton. That means a scheduled run can overlap a manual run — both will
 * complete independently (the underlying crons are idempotent). The singleton's
 * `running` flag only guards manual triggers from stacking on each other.
 */

import { runSocialInsightsRefresh } from "../cron/social-insights.cron";
import { runEntityExtraction } from "../cron/entity-extraction.cron";

export type Phase = "idle" | "harvesting" | "extracting";

export interface RunState {
  running: boolean;
  phase: Phase;
  startedAt: string | null;   // ISO-8601
  finishedAt: string | null;  // ISO-8601
  lastError: string | null;   // human-readable message; never a raw stack
  trigger: "manual" | "scheduled" | null;
  durationMs: number | null;
}

const state: RunState = {
  running: false,
  phase: "idle",
  startedAt: null,
  finishedAt: null,
  lastError: null,
  trigger: null,
  durationMs: null,
};

/** Returns a shallow copy of the current run state (safe to serialise to JSON). */
export function getInsightsRunState(): RunState {
  return { ...state };
}

/**
 * Starts a background enrichment pass if one is not already running.
 *
 * Returns immediately — the HTTP response can be sent before the work completes.
 *
 * @returns { started: true, running: true }  — freshly started
 *          { started: false, running: true } — already in flight; no-op
 */
export function triggerInsightsRun(
  trigger: "manual" | "scheduled" = "manual",
): { started: boolean; running: boolean } {
  if (state.running) {
    return { started: false, running: true };
  }

  const startMs = Date.now();
  state.running = true;
  state.phase = "harvesting";
  state.startedAt = new Date(startMs).toISOString();
  state.finishedAt = null;
  state.lastError = null;
  state.trigger = trigger;
  state.durationMs = null;

  // Fire-and-forget; errors are caught and stored — never allowed to propagate
  // as an unhandled rejection.
  (async () => {
    try {
      await runSocialInsightsRefresh();

      state.phase = "extracting";
      await runEntityExtraction();

      const endMs = Date.now();
      state.running = false;
      state.phase = "idle";
      state.finishedAt = new Date(endMs).toISOString();
      state.durationMs = endMs - startMs;
    } catch (err) {
      const endMs = Date.now();
      state.lastError = err instanceof Error ? err.message : String(err);
      state.running = false;
      state.phase = "idle";
      state.finishedAt = new Date(endMs).toISOString();
      state.durationMs = endMs - startMs;
    }
  })().catch((unhandled) => {
    // Belt-and-suspenders: the async IIFE above already catches everything, but
    // if something truly escapes the inner try/catch, absorb it here so the
    // process never crashes due to an unhandled rejection from this module.
    // Reset state fully (mirror the inner cleanup) so status never reports a
    // permanently-"running" run after a last-resort failure.
    const endMs = Date.now();
    console.error("[insights-runner] unhandled error in background run:", unhandled);
    state.lastError = unhandled instanceof Error ? unhandled.message : String(unhandled);
    state.running = false;
    state.phase = "idle";
    state.finishedAt = new Date(endMs).toISOString();
    state.durationMs = endMs - startMs;
  });

  return { started: true, running: true };
}
