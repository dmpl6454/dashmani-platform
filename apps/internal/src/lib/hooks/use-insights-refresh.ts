import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "@/lib/api";

export interface RunState {
  running: boolean;
  phase: "idle" | "harvesting" | "extracting";
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  trigger: "manual" | "scheduled" | null;
  durationMs: number | null;
}

export type RefreshStatus = "idle" | "running" | "success" | "error";

interface UseInsightsRefreshOptions {
  onComplete?: () => void; // called when a run finishes successfully (e.g. mutate SWR)
}

export function useInsightsRefresh({ onComplete }: UseInsightsRefreshOptions = {}) {
  const [status, setStatus] = useState<RefreshStatus>("idle");
  const [phase, setPhase] = useState<RunState["phase"]>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Track whether we were running, so we can detect the transition to idle.
  const wasRunningRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  // Hold the latest onComplete in a ref so the callback chain (applyState →
  // pollStatus → startPolling) stays referentially stable across renders.
  // Without this, an inline onComplete recreated each render would cascade to
  // an unstable startPolling and re-fire the mount-probe effect on every keystroke.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const applyState = useCallback(
    (state: RunState, fromTrigger = false) => {
      if (!mountedRef.current) return;

      if (state.running) {
        wasRunningRef.current = true;
        setStatus("running");
        setPhase(state.phase);
      } else {
        // Transitioned from running → idle, or idle on first poll.
        if (wasRunningRef.current || fromTrigger) {
          stopPolling();
          wasRunningRef.current = false;
          if (state.lastError) {
            console.error("[insights-refresh] lastError:", state.lastError);
            setStatus("error");
            setErrorMsg(state.lastError);
          } else {
            setStatus("success");
            setErrorMsg(null);
            onCompleteRef.current?.();
          }
        } else {
          // Idle on initial mount probe — not running, nothing to show.
          setStatus("idle");
          setPhase("idle");
        }
      }
    },
    [stopPolling],
  );

  const pollStatus = useCallback(async () => {
    try {
      // GET /status envelope: data IS the RunState.
      const res = await apiFetch<{ data: RunState }>("/admin/insights/status");
      applyState(res.data);
    } catch (err) {
      // Polling failure — stop and surface error.
      console.error("[insights-refresh] poll error:", err);
      if (mountedRef.current) {
        stopPolling();
        wasRunningRef.current = false;
        setStatus("error");
      }
    }
  }, [applyState, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollIntervalRef.current = setInterval(pollStatus, 4_000);
  }, [pollStatus, stopPolling]);

  // Keep a stable ref to startPolling so the mount-probe effect can run
  // exactly once on mount without depending on (and re-firing for) it.
  const startPollingRef = useRef(startPolling);
  useEffect(() => {
    startPollingRef.current = startPolling;
  }, [startPolling]);

  // On mount: exactly ONE status check — if a run is already in progress,
  // start polling. Empty deps → runs once; never re-fires on search-box typing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ data: RunState }>("/admin/insights/status");
        if (cancelled || !mountedRef.current) return;
        if (res.data.running) {
          wasRunningRef.current = true;
          setStatus("running");
          setPhase(res.data.phase);
          startPollingRef.current();
        }
      } catch {
        // Silently ignore — we'll just start in idle
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const triggerRefresh = useCallback(async () => {
    if (status === "running") return;
    setStatus("running");
    setPhase("idle");
    setErrorMsg(null);
    wasRunningRef.current = true;

    try {
      // POST envelope nests the RunState at data.state — data itself is
      // { started, running, state } and has no phase/lastError of its own.
      const res = await apiFetch<{ data: { started: boolean; running: boolean; state: RunState } }>(
        "/admin/insights/refresh",
        { method: "POST", body: JSON.stringify({}) },
      );
      if (!mountedRef.current) return;
      // Apply the real RunState (data.state) so the phase shows and a
      // finished+errored state is classified as error, not success.
      applyState(res.data.state, true);
      if (res.data.running) {
        startPolling();
      }
    } catch (err) {
      console.error("[insights-refresh] trigger error:", err);
      if (mountedRef.current) {
        stopPolling();
        wasRunningRef.current = false;
        setStatus("error");
        setErrorMsg(null); // trigger failure, not API error
      }
    }
  }, [status, applyState, startPolling, stopPolling]);

  const dismiss = useCallback(() => {
    setStatus("idle");
    setErrorMsg(null);
  }, []);

  return { status, phase, errorMsg, triggerRefresh, dismiss };
}
