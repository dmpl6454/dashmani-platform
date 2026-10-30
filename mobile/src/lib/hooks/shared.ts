// Cross-screen data hooks: day rollover, admin pending counts, tab badges and the
// shared task cache. All stores are module-level, so every screen (and the tab
// layouts) read ONE copy and share ONE request.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { apiFetch, istDateOf, todayIST } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useInvalidation, type ApiStatus } from "@/lib/hooks/useApi";

// ---------- tiny external store ----------
function createStore<S>(initial: S) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: (): S => state,
    set: (next: S): void => {
      if (Object.is(next, state)) return;
      state = next;
      Array.from(listeners).forEach((l) => l());
    },
    subscribe: (cb: () => void): (() => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------- useDayChange ----------
/**
 * Returns the IST day the screen loaded for, and calls `onNewDay(today)` when the screen
 * regains focus or the app returns to the foreground on a later IST day.
 */
export function useDayChange(onNewDay: (today: string) => void): string {
  const [loadedDate, setLoadedDate] = useState<string>(() => todayIST());
  const loadedRef = useRef(loadedDate);
  const cbRef = useRef(onNewDay);
  useEffect(() => {
    cbRef.current = onNewDay;
  });

  const check = useCallback(() => {
    const today = todayIST();
    if (today === loadedRef.current) return;
    loadedRef.current = today;
    setLoadedDate(today);
    cbRef.current(today);
  }, []);

  useFocusEffect(check);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") check();
    });
    return () => sub.remove();
  }, [check]);

  return loadedDate;
}

// ---------- Admin pending counts ----------
export type PendingCounts = {
  leaves: number | null;
  expenses: number | null;
  extraHours: number | null;
  newEmployees: number | null;
  documents: number | null;
  total: number;
  status: ApiStatus;
};

type PendingQueue = keyof Omit<PendingCounts, "total" | "status">;

// Joining dates are never counted here.
const PENDING_SOURCES: ReadonlyArray<readonly [PendingQueue, string]> = [
  ["leaves", "/admin/leave-requests?status=PENDING"],
  ["expenses", "/admin/expenses?status=PENDING"],
  ["extraHours", "/admin/extra-hours/pending"],
  ["newEmployees", "/admin/employees/pending"],
  ["documents", "/admin/documents/pending"],
];

const PENDING_TTL_MS = 60000;
const EMPTY_PENDING: PendingCounts = {
  leaves: null,
  expenses: null,
  extraHours: null,
  newEmployees: null,
  documents: null,
  total: 0,
  status: "loading",
};

const pendingStore = createStore<PendingCounts>(EMPTY_PENDING);
let pendingFetchedAt = 0;
let pendingInFlight: Promise<void> | null = null;
let pendingQueued: Promise<void> | null = null;
let pendingConsumers = 0;

const LIST_KEYS = ["items", "data", "rows", "results", "requests", "documents", "employees"];

/** Length of a list answer (bare array, or an object wrapping one). */
function countOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (isRecord(v)) {
    for (const key of LIST_KEYS) {
      const x = v[key];
      if (Array.isArray(x)) return x.length;
    }
    if (typeof v.total === "number") return v.total;
    if (typeof v.count === "number") return v.count;
    const firstArray = Object.values(v).find((x): x is unknown[] => Array.isArray(x));
    if (firstArray) return firstArray.length;
  }
  return 0;
}

function sumPending(c: PendingCounts): number {
  return (c.leaves ?? 0) + (c.expenses ?? 0) + (c.extraHours ?? 0) + (c.newEmployees ?? 0) + (c.documents ?? 0);
}

function loadPending(force: boolean): Promise<void> {
  if (pendingInFlight) {
    if (!force) return pendingInFlight;
    if (!pendingQueued) {
      pendingQueued = pendingInFlight.then(() => {
        pendingQueued = null;
        return loadPending(true);
      });
    }
    return pendingQueued;
  }
  if (!force && pendingFetchedAt > 0 && Date.now() - pendingFetchedAt < PENDING_TTL_MS) return Promise.resolve();

  let run!: Promise<void>;
  run = (async () => {
    try {
      const results = await Promise.allSettled(PENDING_SOURCES.map(([, path]) => apiFetch<unknown>(path)));
      const next: PendingCounts = { ...EMPTY_PENDING };
      PENDING_SOURCES.forEach(([key], i) => {
        const r = results[i];
        next[key] = r && r.status === "fulfilled" ? countOf(r.value) : null;
      });
      const anyOk = PENDING_SOURCES.some(([key]) => next[key] !== null);
      next.total = sumPending(next);
      next.status = anyOk ? "ok" : "failed";
      pendingFetchedAt = anyOk ? Date.now() : 0;
      pendingStore.set(next);
    } finally {
      if (pendingInFlight === run) pendingInFlight = null;
    }
  })();
  pendingInFlight = run;
  return run;
}

/** Admin dashboard queue counts (null = that queue failed to load). Cached 60 s across screens. */
export function usePendingCounts(): PendingCounts & {
  reload: () => Promise<void>;
  decrement: (q: keyof Omit<PendingCounts, "total" | "status">) => void;
} {
  const state = useSyncExternalStore(pendingStore.subscribe, pendingStore.get, pendingStore.get);

  useEffect(() => {
    pendingConsumers += 1;
    void loadPending(false);
    return () => {
      pendingConsumers -= 1;
    };
  }, []);

  const reload = useCallback(() => loadPending(true), []);

  const decrement = useCallback((q: PendingQueue) => {
    const cur = pendingStore.get();
    const v = cur[q];
    if (v == null || v <= 0) return;
    const next: PendingCounts = { ...cur };
    next[q] = v - 1;
    next.total = sumPending(next);
    pendingStore.set(next);
  }, []);

  return useMemo(() => ({ ...state, reload, decrement }), [state, reload, decrement]);
}

/** Total pending approvals for the admin tab badge. Subscribe-only: never fetches by itself. */
export function usePendingTotal(): number | null {
  const state = useSyncExternalStore(pendingStore.subscribe, pendingStore.get, pendingStore.get);
  return state.status === "ok" ? state.total : null;
}

/** Mark the pending counts stale; refetches at once if a screen is showing them. */
export function invalidatePendingCounts(): void {
  pendingFetchedAt = 0;
  if (pendingConsumers > 0) void loadPending(true);
}

// ---------- Task cache ----------
export type Task = {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority?: string | null;
  dueDate?: string | null;
  createdBy?: { name?: string } | null;
  account?: { displayName?: string; handle?: string } | null;
  comments?: Array<{
    id: string;
    author?: { name?: string } | null;
    body?: string;
    content?: string;
    createdAt: string;
  }>;
};

const taskStore = createStore<Task[] | null>(null);

export const tasksCache: {
  setList(list: Task[]): void;
  getList(): Task[] | null;
  get(id: string): Task | undefined;
  patch(id: string, partial: Partial<Task>): void;
  subscribe(cb: () => void): () => void;
} = {
  setList(list: Task[]) {
    taskStore.set(Array.isArray(list) ? list.slice() : []);
  },
  getList() {
    return taskStore.get();
  },
  get(id: string) {
    const list = taskStore.get();
    return list ? list.find((t) => t.id === id) : undefined;
  },
  patch(id: string, partial: Partial<Task>) {
    const list = taskStore.get();
    if (!list) return;
    let changed = false;
    const next = list.map((t) => {
      if (t.id !== id) return t;
      changed = true;
      return { ...t, ...partial };
    });
    if (changed) taskStore.set(next);
  },
  subscribe(cb: () => void) {
    return taskStore.subscribe(cb);
  },
};

export function useTaskList(): Task[] | null {
  return useSyncExternalStore(taskStore.subscribe, taskStore.get, taskStore.get);
}

export function useTask(id: string): Task | undefined {
  const get = useCallback(() => tasksCache.get(id), [id]);
  return useSyncExternalStore(taskStore.subscribe, get, get);
}

/** Open tasks due today or overdue (IST). */
function countDue(list: Task[] | null): number {
  if (!list) return 0;
  const today = todayIST();
  let n = 0;
  for (const t of list) {
    const s = (t.status || "").toUpperCase();
    if (s === "DONE" || s === "CANCELLED") continue;
    if (!t.dueDate) continue;
    const day = istDateOf(t.dueDate);
    if (day && day <= today) n += 1;
  }
  return n;
}

// ---------- Badges (unread notifications + tasks due) ----------
const UNREAD_TTL_MS = 60000;
const unreadStore = createStore<number | null>(null);
let unreadFetchedAt = 0;
let unreadInFlight: Promise<void> | null = null;
let unreadQueued: Promise<void> | null = null;
let unreadGeneration = 0;
let unreadOwner: string | null = null;

function resetBadges(): void {
  unreadGeneration += 1;
  unreadFetchedAt = 0;
  unreadInFlight = null;
  unreadQueued = null;
  unreadStore.set(null);
  taskStore.set(null);
}

function loadUnread(force: boolean): Promise<void> {
  if (unreadInFlight) {
    if (!force) return unreadInFlight;
    if (!unreadQueued) {
      unreadQueued = unreadInFlight.then(() => {
        unreadQueued = null;
        return loadUnread(true);
      });
    }
    return unreadQueued;
  }
  if (!force && unreadFetchedAt > 0 && Date.now() - unreadFetchedAt < UNREAD_TTL_MS) return Promise.resolve();

  const gen = unreadGeneration;
  let run!: Promise<void>;
  run = (async () => {
    try {
      const r = await apiFetch<unknown>("/hr/notifications/count");
      if (gen !== unreadGeneration) return;
      const count = isRecord(r) && typeof r.count === "number" ? r.count : typeof r === "number" ? r : null;
      if (count !== null) {
        unreadStore.set(count);
        unreadFetchedAt = Date.now();
      }
    } catch {
      /* keep the last known count */
    } finally {
      if (unreadInFlight === run) unreadInFlight = null;
    }
  })();
  unreadInFlight = run;
  return run;
}

/**
 * Tab-bar / Home badges. `unread` comes from GET /hr/notifications/count (employee portal only;
 * refetched on mount, focus and foreground at most every 60 s, and at once on
 * `invalidate("notifications")`). `tasksDue` is derived from the shared task cache.
 */
export function useBadges(): { unread: number | null; tasksDue: number } {
  const { mode, user } = useAuth();
  const enabled = mode === "hr" && user !== null;
  const userId = user?.id ?? null;
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  });

  const unread = useSyncExternalStore(unreadStore.subscribe, unreadStore.get, unreadStore.get);

  useEffect(() => {
    if (!enabled) return;
    if (unreadOwner !== userId) {
      if (unreadOwner !== null) resetBadges();
      unreadOwner = userId;
    }
    void loadUnread(false);
  }, [enabled, userId]);

  useFocusEffect(
    useCallback(() => {
      if (enabledRef.current) void loadUnread(false);
    }, []),
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && enabledRef.current) void loadUnread(false);
    });
    return () => sub.remove();
  }, []);

  useInvalidation("notifications", () => {
    if (enabledRef.current) void loadUnread(true);
  });

  const list = useTaskList();
  const tasksDue = useMemo(() => countDue(list), [list]);

  return { unread: enabled ? unread : null, tasksDue };
}
