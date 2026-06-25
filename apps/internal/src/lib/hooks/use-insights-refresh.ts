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
            onComplete?.();
          }
        } else {
          // Idle on initial mount probe — not running, nothing to show.
          setStatus("idle");
          setPhase("idle");
        }
      }
    },
    [onComplete, stopPolling],
  );

  const pollStatus = useCallback(async () => {
    try {
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

  // On mount: one status check — if a run is already in progress, start polling.
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
          startPolling();
        }
      } catch {
        // Silently ignore — we'll just start in idle
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [startPolling]);

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
      const res = await apiFetch<{ data: RunState }>("/admin/insights/refresh", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (!mountedRef.current) return;
      // If already running or just started — begin polling.
      applyState(res.data, true);
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
