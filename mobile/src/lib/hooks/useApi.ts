// Data-loading hook shared by every screen (re-exported by `@/components/ui`).
//
// Contract (compatible with the legacy ui.tsx hook):
//   const { data, loading, refreshing, error, refresh, reload, setData } = useApi(fetcher, deps)
// plus: status ("loading" | "ok" | "failed"), fetching, errorCode, errorStatus, isEmpty, mutate.
//
// - Out-of-order results are dropped (a sequence ref; only the latest request lands).
// - deps change → status "loading" and data null, unless `keepData` (data kept, `fetching` true).
//   Kept data is only a placeholder while the new request is in flight: if the first request for
//   the new deps FAILS, the old data (which belongs to the previous deps) is dropped and status
//   becomes "failed" — stale data is never left on screen labelled with the new deps.
// - `refresh` (pull-to-refresh) keeps data and sets `refreshing`; `reload` is silent and keeps data.
// - `loading === (status === "loading" && data === null)`.
// - `status: "failed"` only when there is no data to show; a failed refetch over data loaded for
//   the SAME deps keeps "ok" and exposes `error`. Only a LOADED answer may claim emptiness (`isEmpty`).
// - Focus / foreground refetches are opt-in, silent, throttled by `staleMs`, skipped while fetching.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { ApiError } from "@/lib/api";

export type ApiStatus = "loading" | "ok" | "failed";

export type UseApiOptions = {
  /** Silently refetch when the screen regains focus (throttled by staleMs). Default false. */
  refetchOnFocus?: boolean;
  /** Silently refetch when the app returns to the foreground. Default false. */
  refetchOnForeground?: boolean;
  /** Minimum age (ms) of the last good load before a focus/foreground refetch. Default 30000. */
  staleMs?: number;
  /**
   * Keep showing the previous data while a deps change refetches. Default false.
   * If that refetch fails, the previous data is dropped (status "failed").
   */
  keepData?: boolean;
  /** When false nothing is fetched (status stays "loading", `loading` is false). Default true. */
  enabled?: boolean;
};

export type UseApiResult<T> = {
  data: T | null;
  status: ApiStatus;
  loading: boolean;
  refreshing: boolean;
  fetching: boolean;
  error: string | null;
  errorCode: string | null;
  errorStatus: number | null;
  isEmpty: boolean;
  refresh: () => Promise<void>;
  reload: () => Promise<void>;
  setData: Dispatch<SetStateAction<T | null>>;
  mutate: (fn: (prev: T | null) => T | null) => void;
};

type RunMode = "reset" | "keep" | "refresh" | "silent";

function messageOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return "Something went wrong";
}

function sameDeps(a: readonly unknown[] | null, b: readonly unknown[]): boolean {
  if (a === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[] = [],
  options: UseApiOptions = {},
): UseApiResult<T> {
  const {
    refetchOnFocus = false,
    refetchOnForeground = false,
    staleMs = 30000,
    keepData = false,
    enabled = true,
  } = options;

  const [data, setDataState] = useState<T | null>(null);
  const [status, setStatus] = useState<ApiStatus>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);

  const fetcherRef = useRef(fetcher);
  const keepDataRef = useRef(keepData);
  const dataRef = useRef<T | null>(null);
  const seqRef = useRef(0);
  const inFlightRef = useRef(false);
  const lastLoadedAtRef = useRef(0);
  const mountedRef = useRef(false);
  // Generation of the caller's deps (bumped whenever their values change) and the generation
  // the current `data` was loaded for. They differ only while kept (stale) data is on screen.
  const lastDepsRef = useRef<readonly unknown[] | null>(null);
  const depsGenRef = useRef(0);
  const dataGenRef = useRef(0);

  // Keep the latest fetcher/options without re-identifying refresh/reload.
  // Declared first so it runs before the load effect below.
  useEffect(() => {
    fetcherRef.current = fetcher;
    keepDataRef.current = keepData;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setData = useCallback<Dispatch<SetStateAction<T | null>>>((action) => {
    // A plain value set by the caller describes the current deps.
    if (typeof action !== "function") dataGenRef.current = depsGenRef.current;
    setDataState((prev) => {
      const next = typeof action === "function" ? (action as (p: T | null) => T | null)(prev) : action;
      dataRef.current = next;
      return next;
    });
  }, []);

  const mutate = useCallback((fn: (prev: T | null) => T | null) => setData(fn), [setData]);

  const run = useCallback(
    async (mode: RunMode): Promise<void> => {
      const seq = ++seqRef.current;
      inFlightRef.current = true;
      if (mode === "reset") {
        dataRef.current = null;
        dataGenRef.current = depsGenRef.current;
        setDataState(null);
        setStatus("loading");
        setError(null);
        setErrorCode(null);
        setErrorStatus(null);
      }
      if (mode === "refresh") setRefreshing(true);
      setFetching(true);
      try {
        const result = await fetcherRef.current();
        if (!mountedRef.current || seq !== seqRef.current) return;
        dataRef.current = result;
        dataGenRef.current = depsGenRef.current;
        setDataState(result);
        setStatus("ok");
        setError(null);
        setErrorCode(null);
        setErrorStatus(null);
        lastLoadedAtRef.current = Date.now();
      } catch (e: unknown) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        setError(messageOf(e));
        setErrorCode(e instanceof ApiError ? (e.code ?? null) : null);
        setErrorStatus(e instanceof ApiError ? (e.status ?? null) : null);
        if (dataRef.current !== null && dataGenRef.current !== depsGenRef.current) {
          // The data on screen was kept from the previous deps (keepData) and the load for the
          // new deps failed: never leave it on screen as if it answered the new deps.
          dataRef.current = null;
          dataGenRef.current = depsGenRef.current;
          setDataState(null);
          lastLoadedAtRef.current = 0;
        }
        setStatus(dataRef.current === null ? "failed" : "ok");
      } finally {
        if (seq === seqRef.current) {
          inFlightRef.current = false;
          if (mountedRef.current) {
            setRefreshing(false);
            setFetching(false);
          }
        }
      }
    },
    [],
  );

  // Initial load + reload whenever the caller's deps (or `enabled`) change.
  useEffect(() => {
    if (!sameDeps(lastDepsRef.current, deps)) {
      lastDepsRef.current = [...deps];
      depsGenRef.current += 1;
    }
    if (!enabled) return;
    void run(keepDataRef.current && dataRef.current !== null ? "keep" : "reset");
  }, [...deps, enabled]);

  const refresh = useCallback(() => run("refresh"), [run]);
  const reload = useCallback(() => run("silent"), [run]);

  const staleMsRef = useRef(staleMs);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    staleMsRef.current = staleMs;
    enabledRef.current = enabled;
  });

  const refetchIfStale = useCallback(() => {
    if (!enabledRef.current || inFlightRef.current) return;
    if (lastLoadedAtRef.current > 0 && Date.now() - lastLoadedAtRef.current < staleMsRef.current) return;
    void run("silent");
  }, [run]);

  useFocusEffect(
    useCallback(() => {
      if (!refetchOnFocus) return;
      // The first focus coincides with the initial load (in flight) and is skipped.
      refetchIfStale();
    }, [refetchOnFocus, refetchIfStale]),
  );

  useEffect(() => {
    if (!refetchOnForeground) return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") refetchIfStale();
    });
    return () => sub.remove();
  }, [refetchOnForeground, refetchIfStale]);

  const isEmpty = status === "ok" && (data == null || (Array.isArray(data) && data.length === 0));

  return {
    data,
    status,
    loading: enabled && status === "loading" && data === null,
    refreshing,
    fetching,
    error,
    errorCode,
    errorStatus,
    isEmpty,
    refresh,
    reload,
    setData,
    mutate,
  };
}

/** Returns `value` once it has stopped changing for `ms` milliseconds. */
export function useDebounce<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

// ---------- Cross-screen invalidation bus ----------
// A screen that changes server state calls `invalidate("tasks")`; every mounted
// screen subscribed with `useInvalidation("tasks", reload)` refetches at once.

export type InvalidationKey = "home" | "report" | "tasks" | "leave" | "approvals" | "notifications";

const listeners = new Map<InvalidationKey, Set<() => void>>();

export function invalidate(key: InvalidationKey): void {
  const set = listeners.get(key);
  if (!set) return;
  Array.from(set).forEach((cb) => {
    try {
      cb();
    } catch (e: unknown) {
      if (__DEV__) console.warn(`invalidate("${key}") listener failed`, e);
    }
  });
}

export function useInvalidation(key: InvalidationKey, cb: () => void): void {
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  });
  useEffect(() => {
    const handler = () => cbRef.current();
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(handler);
    return () => {
      const current = listeners.get(key);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) listeners.delete(key);
    };
  }, [key]);
}
