"use client";
/**
 * PipelineProvider (spec §9.1, §9.3, §9.4): bootstrap + directory (SWR, user-keyed),
 * the store, the SyncEngine and the outbox. Rendered as `<PipelineProvider key={user.id}>`
 * so switching accounts resets every cursor, pending op and cache.
 *
 * It also owns the honest gate: children render only once bootstrap says the feature is
 * enabled for this user; otherwise the page says — in words — why not.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  backoffMs,
  jitter,
  makeClientId,
  PIPELINE_DISABLED_RECHECK_MS,
  shouldRecheckBootstrapForMode,
  shouldRecheckBootstrapPeriodically,
  shouldRevalidateBootstrapOnMount,
  type PipelineBootstrapEnabled,
  type PipelineCard,
  type PipelineDirectoryEntry,
  type PipelineNotNotified,
  type PipelinePhase,
} from "@dashmani/shared";
import { useHrAuth } from "@/lib/auth";
import { usePipelineBootstrap, usePipelineDirectory } from "@/lib/pipeline-swr";
import { describeError, isApiError, isRateLimited, isTransient, plApi, postSync, retryAfterMs } from "./api";
import { createPipelineStore, useStoreSelector, type PipelineStore } from "./store";
import { SyncEngine } from "./sync-engine";
import { loadOutbox, outboxPut, outboxRemove, OUTBOX_AUTO_REPLAY_MS } from "./outbox";
import { useIdle } from "./hooks/use-idle";
import { ToastProvider } from "./ui/Toast";
import { GateScreen, PausedBanner } from "./header/GateScreen";
import { Notices } from "./ui/Notices";

export interface MoveArgs {
  projectId: string;
  toPhaseId: string;
  basePhaseId: string;
  afterId: string | null;
  /** Optimistic local rank (keyBetween of the neighbours), or null for "at the end". */
  rank: string | null;
}

export type MoveResult =
  | { kind: "ok"; card: PipelineCard; placementAdjusted: boolean }
  | { kind: "conflict"; card: PipelineCard | null }
  | { kind: "checking" }
  | { kind: "error"; message: string };

export interface PipelineContextValue {
  meId: string;
  boot: PipelineBootstrapEnabled;
  store: PipelineStore;
  engine: SyncEngine;
  /** undefined while loading or after a failure (see directoryFailed). */
  directory: PipelineDirectoryEntry[] | undefined;
  dirById: ReadonlyMap<string, PipelineDirectoryEntry>;
  directoryFailed: boolean;
  retryDirectory(): void;
  /** An id the directory doesn't know: one throttled revalidate (≤ once / 2 min). */
  noteUnknownId(id: string): void;
  loadProject(id: string, around?: string | null): Promise<void>;
  send(input: { projectId: string; parentId: string | null; body: string }): string;
  retrySend(clientId: string): void;
  discardSend(clientId: string): void;
  move(args: MoveArgs): Promise<MoveResult>;
  /** Server-reported "wasn't notified" per message id (from the POST / PATCH response). */
  notNotified: Readonly<Record<string, PipelineNotNotified[]>>;
  setNotNotified(messageId: string, list: PipelineNotNotified[]): void;
}

const Ctx = createContext<PipelineContextValue | null>(null);

export function usePipeline(): PipelineContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePipeline outside PipelineProvider");
  return v;
}

/** Phases from the latest board snapshot, else from bootstrap. */
export function usePhases(): PipelinePhase[] {
  const { store, boot } = usePipeline();
  return useStoreSelector(store, (s) => s.board?.phases ?? boot.phases);
}

const MAX_SEND_ATTEMPTS = 5;
const UNKNOWN_ID_REVALIDATE_MS = 2 * 60_000;

export function PipelineProvider({ children }: { children: React.ReactNode }) {
  const { user } = useHrAuth();
  const userId = user?.id ?? null;
  const boot = usePipelineBootstrap(userId);
  const reason = boot.data && !boot.data.enabled ? boot.data.reason : null;
  const mutateBoot = boot.mutate;

  // G2 (GA): a cached "not enabled" answer — e.g. not_in_pilot, cached by the sidebar before
  // the flip to on — is re-fetched ONCE when the gate mounts, so an in-app link (a bell row)
  // never shows "isn't available for your account yet" from a stale cache. A bound mutate()
  // with no arguments bypasses SWR's 10-minute dedupe (it drops the in-flight marker first);
  // revalidateIfStale alone would be deduped for up to 10 minutes after the sidebar's fetch.
  // Until that re-fetch settles the gate shows "Loading", never the cached reason: true from
  // the FIRST render (the cache is painted before any effect runs).
  const [recheckPending, setRecheckPending] = useState(() => shouldRevalidateBootstrapOnMount(boot.data));
  const mountChecked = useRef(false);
  useEffect(() => {
    if (mountChecked.current) return;
    mountChecked.current = true;
    if (!recheckPending) return;
    const settled = () => setRecheckPending(false);
    void mutateBoot().then(settled, settled);
    // Once, against what the cache held at mount — later answers are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paused (off / self-check failed) and not_in_pilot are NOT terminal: re-check every 3 min
  // ± jitter while visible (not_in_pilot clears when the pilot becomes GA).
  useEffect(() => {
    if (!shouldRecheckBootstrapPeriodically(reason)) return;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      t = setTimeout(() => {
        if (document.visibilityState === "visible") void mutateBoot();
        tick();
      }, jitter(PIPELINE_DISABLED_RECHECK_MS, Math.random, 0.2));
    };
    tick();
    return () => clearTimeout(t);
  }, [reason, mutateBoot]);

  if (!userId) return null;

  if (!boot.data) {
    return (
      <GateScreen
        kind={boot.error ? "load_failed" : "loading"}
        reason={boot.error ? describeError(boot.error) : null}
        errorStatus={isApiError(boot.error) ? boot.error.status : undefined}
        onRetry={() => void mutateBoot()}
        retrying={boot.isValidating}
      />
    );
  }
  if (!boot.data.enabled) {
    if (recheckPending) return <GateScreen kind="loading" />;
    // The latest check FAILED, so the cached not_in_pilot may be stale (GA): say we couldn't
    // check, not "being tried out with a small group" — the next check (Retry, ~3 min) settles it.
    if (boot.error && boot.data.reason === "not_in_pilot") {
      return (
        <GateScreen
          kind="load_failed"
          reason={describeError(boot.error)}
          errorStatus={isApiError(boot.error) ? boot.error.status : undefined}
          onRetry={() => void mutateBoot()}
          retrying={boot.isValidating}
        />
      );
    }
    return <GateScreen kind={boot.data.reason === "paused" ? "off" : boot.data.reason} onRetry={() => void mutateBoot()} retrying={boot.isValidating} />;
  }
  return (
    <ToastProvider>
      <EnabledProvider userId={userId} boot={boot.data} recheckBootstrap={() => void mutateBoot()}>
        {children}
      </EnabledProvider>
    </ToastProvider>
  );
}

function EnabledProvider({
  userId,
  boot,
  recheckBootstrap,
  children,
}: {
  userId: string;
  boot: PipelineBootstrapEnabled;
  recheckBootstrap: () => void;
  children: React.ReactNode;
}) {
  const [store] = useState(() => createPipelineStore(userId));
  const bootRef = useRef(boot);
  bootRef.current = boot;
  const [terminal, setTerminal] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [notNotified, setNotNotifiedState] = useState<Record<string, PipelineNotNotified[]>>({});
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const later = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  }, []);

  const loadProject = useCallback(
    async (id: string, around?: string | null) => {
      const detail = await plApi.getProject(id, around ?? null);
      store.dispatch({ type: "projectDetail", detail, now: Date.now() });
    },
    [store],
  );

  const recheckRef = useRef(recheckBootstrap);
  recheckRef.current = recheckBootstrap;
  /** When a sync's mode mismatch last re-checked bootstrap (shouldRecheckBootstrapForMode). */
  const lastModeRecheck = useRef(0);

  const [engine] = useState(
    () =>
      new SyncEngine({
        store,
        getPollMs: () => bootRef.current.pollMs,
        postSync,
        onDisabled: () => {
          setDisabled(true);
          recheckRef.current();
        },
        onTerminal: (code) => setTerminal(code),
        // G3 (GA): a sync reports a mode other than the one bootstrap gave this tab (the flip to
        // "on" while the tab stayed focused): re-check bootstrap — its new mode re-keys the
        // directory, so newly enabled colleagues become pickable without a reload or a refocus.
        onServerMode: (mode) => {
          const now = Date.now();
          if (!shouldRecheckBootstrapForMode(bootRef.current.mode, mode, lastModeRecheck.current, now)) return;
          lastModeRecheck.current = now;
          recheckRef.current();
        },
        onReloadProject: (id) => {
          loadProject(id).catch(() => {
            /* the next sync or a manual reload settles it */
          });
        },
        onHardReload: () => {
          // After the outbox flushes: wait (≤ 30 s) while any send is still in flight.
          let tries = 0;
          const attempt = () => {
            const busy = Object.values(store.getState().sends).some((s) => s.status === "sending");
            if (busy && tries++ < 15) return void setTimeout(attempt, 2000);
            window.location.reload();
          };
          attempt();
        },
      }),
  );

  useEffect(() => {
    engine.start();
    const unsub = engine.subscribeStatus(() => {
      if (engine.getStatus().indicator !== "paused") setDisabled(false);
    });
    const ts = timers.current;
    return () => {
      unsub();
      engine.stop();
      ts.forEach(clearTimeout);
      ts.clear();
    };
  }, [engine]);

  const markInput = useCallback(() => engine.markInput(), [engine]);
  useIdle(markInput);

  // ── directory ─────────────────────────────────────────────────────────────────
  const dir = usePipelineDirectory(userId, true, boot.mode);
  const dirById = useMemo(() => {
    const m = new Map<string, PipelineDirectoryEntry>();
    for (const d of dir.data ?? []) m.set(d.id, d);
    return m;
  }, [dir.data]);
  const lastUnknownRevalidate = useRef(0);
  const mutateDir = dir.mutate;
  const noteUnknownId = useCallback(
    (id: string) => {
      if (!dir.data || dirById.has(id)) return;
      const now = Date.now();
      if (now - lastUnknownRevalidate.current < UNKNOWN_ID_REVALIDATE_MS) return;
      lastUnknownRevalidate.current = now;
      void mutateDir();
    },
    [dir.data, dirById, mutateDir],
  );

  // ── sends (spec §9.4) ─────────────────────────────────────────────────────────
  const execute = useCallback(
    async (clientId: string): Promise<void> => {
      const s = store.getState().sends[clientId];
      if (!s || s.authorId !== userId || s.status === "blocked") return;
      store.dispatch({ type: "sendUpdate", clientId, patch: { status: "sending", attempts: s.attempts + 1, note: null } });
      try {
        const r = await plApi.postMessage(s.projectId, {
          clientId,
          body: s.body,
          ...(s.parentId ? { parentId: s.parentId } : {}),
        });
        store.dispatch({ type: "messageUpsert", message: r.message, root: r.root });
        store.dispatch({ type: "sendRemove", clientId });
        outboxRemove(userId, clientId);
        if (r.notNotified.length) setNotNotifiedState((m) => ({ ...m, [r.message.id]: r.notNotified }));
        engine.afterWrite();
      } catch (e) {
        const code = isApiError(e) ? e.code : undefined;
        const ended = Date.now();
        if (isApiError(e) && e.status === 409 && code === "IDEMPOTENCY_KEY_REUSED") {
          // Mint a new key once and resend.
          const cur = store.getState().sends[clientId];
          store.dispatch({ type: "sendRemove", clientId });
          outboxRemove(userId, clientId);
          if (cur && cur.attempts < MAX_SEND_ATTEMPTS) {
            const fresh = makeClientId();
            store.dispatch({ type: "sendAdd", send: { ...cur, clientId: fresh, attempts: MAX_SEND_ATTEMPTS - 1 } });
            outboxPut(userId, { clientId: fresh, authorId: userId, projectId: cur.projectId, parentId: cur.parentId, body: cur.body, createdAt: cur.createdAt });
            void execute(fresh);
          }
          return;
        }
        if (isApiError(e) && (e.status === 409 || e.status === 404 || e.status === 400 || e.status === 403)) {
          // Never resent: the text stays visible and copyable with the reason.
          const note =
            code === "MESSAGE_DELETED"
              ? "The message you replied to was deleted — post in the main conversation instead."
              : code === "PROJECT_ARCHIVED"
                ? "This project is archived, so the message wasn't sent. Your text is kept — copy it."
                : describeError(e);
          store.dispatch({ type: "sendUpdate", clientId, patch: { status: "blocked", note, lastAttemptEndedAt: ended } });
          outboxRemove(userId, clientId);
          return;
        }
        if (isRateLimited(e)) {
          const wait = retryAfterMs(e);
          store.dispatch({
            type: "sendUpdate",
            clientId,
            patch: { status: "held", note: `Sending is slowed down — retrying in ${Math.round(wait / 1000)} s`, lastAttemptEndedAt: ended },
          });
          // One at a time, in the order they were WRITTEN (clientId is a random UUID, so
          // sorting by it could post B before A): stagger by position among held sends.
          const held = Object.values(store.getState().sends)
            .filter((x) => x.status === "held")
            .sort((x, y) => x.createdAt - y.createdAt || (x.clientId < y.clientId ? -1 : 1))
            .map((x) => x.clientId);
          later(() => void execute(clientId), wait + Math.max(0, held.indexOf(clientId)) * 750);
          return;
        }
        if (isTransient(e)) {
          const attempts = store.getState().sends[clientId]?.attempts ?? MAX_SEND_ATTEMPTS;
          store.dispatch({ type: "sendUpdate", clientId, patch: { status: "retrying", note: null, lastAttemptEndedAt: ended } });
          if (attempts < MAX_SEND_ATTEMPTS) later(() => void execute(clientId), backoffMs(attempts, Math.random));
          return;
        }
        store.dispatch({ type: "sendUpdate", clientId, patch: { status: "blocked", note: describeError(e), lastAttemptEndedAt: ended } });
        outboxRemove(userId, clientId);
      }
    },
    [store, userId, engine, later],
  );

  const send = useCallback(
    (input: { projectId: string; parentId: string | null; body: string }) => {
      const clientId = makeClientId();
      const createdAt = Date.now();
      store.dispatch({
        type: "sendAdd",
        send: { clientId, authorId: userId, projectId: input.projectId, parentId: input.parentId, body: input.body, createdAt, status: "sending", attempts: 0, lastAttemptEndedAt: null, note: null },
      });
      outboxPut(userId, { clientId, authorId: userId, projectId: input.projectId, parentId: input.parentId, body: input.body, createdAt });
      void execute(clientId);
      return clientId;
    },
    [store, userId, execute],
  );

  const retrySend = useCallback(
    (clientId: string) => {
      const s = store.getState().sends[clientId];
      if (!s) return;
      store.dispatch({ type: "sendUpdate", clientId, patch: { attempts: 0, status: "sending" } });
      outboxPut(userId, { clientId, authorId: userId, projectId: s.projectId, parentId: s.parentId, body: s.body, createdAt: s.createdAt });
      void execute(clientId);
    },
    [store, userId, execute],
  );

  const discardSend = useCallback(
    (clientId: string) => {
      store.dispatch({ type: "sendRemove", clientId });
      outboxRemove(userId, clientId);
    },
    [store, userId],
  );

  // Outbox replay on mount: < 5 min replays automatically; older asks Send / Discard.
  const replayed = useRef(false);
  useEffect(() => {
    if (replayed.current) return;
    replayed.current = true;
    const now = Date.now();
    const toReplay: string[] = [];
    // Oldest first, and one at a time: `seq` is assigned at commit, so firing them all at
    // once could post messages written offline out of the order they were written.
    const items = [...loadOutbox(userId)].sort((a, b) => a.createdAt - b.createdAt);
    for (const item of items) {
      const fresh = now - item.createdAt < OUTBOX_AUTO_REPLAY_MS;
      store.dispatch({
        type: "sendAdd",
        send: { ...item, status: fresh ? "sending" : "failed", attempts: 0, lastAttemptEndedAt: null, note: null },
      });
      if (fresh) toReplay.push(item.clientId);
    }
    void (async () => {
      for (const clientId of toReplay) await execute(clientId);
    })();
  }, [store, userId, execute]);

  // ── moves (spec §9.4) ─────────────────────────────────────────────────────────
  const move = useCallback(
    async (a: MoveArgs): Promise<MoveResult> => {
      const opId = makeClientId();
      store.dispatch({
        type: "moveAdd",
        move: { opId, projectId: a.projectId, toPhaseId: a.toPhaseId, basePhaseId: a.basePhaseId, rank: a.rank, status: "inflight", settledAt: null },
      });
      const body = { toPhaseId: a.toPhaseId, afterId: a.afterId, basePhaseId: a.basePhaseId };
      const attempt = async (tries: number): Promise<MoveResult> => {
        try {
          const r = await plApi.moveProject(a.projectId, body);
          store.dispatch({ type: "cardUpsert", card: r.card });
          store.dispatch({ type: "moveRemove", projectId: a.projectId, opId });
          engine.afterWrite();
          return { kind: "ok", card: r.card, placementAdjusted: r.placementAdjusted };
        } catch (e) {
          const code = isApiError(e) ? e.code : undefined;
          if (code === "MOVE_CONFLICT") {
            const cur = (isApiError(e) ? e.current : null) as PipelineCard | null;
            if (cur && typeof cur === "object" && "phaseId" in cur) {
              store.dispatch({ type: "cardUpsert", card: cur });
              store.dispatch({ type: "moveRemove", projectId: a.projectId, opId });
              // An unanswered earlier attempt that did land comes back as a "conflict"
              // with the card already where we asked: that is a success.
              if (cur.phaseId === a.toPhaseId && tries > 0) return { kind: "ok", card: cur, placementAdjusted: false };
              store.dispatch({ type: "noticeAdd", kind: "move_conflict", projectId: a.projectId, phaseId: cur.phaseId });
              return { kind: "conflict", card: cur };
            }
            store.dispatch({ type: "moveRemove", projectId: a.projectId, opId });
            engine.syncNow();
            return { kind: "conflict", card: null };
          }
          if (isRateLimited(e) && tries < 3) {
            await new Promise((res) => later(() => res(null), retryAfterMs(e)));
            return attempt(tries + 1);
          }
          if (isTransient(e)) {
            store.dispatch({ type: "moveUpdate", projectId: a.projectId, opId, patch: { status: "checking", settledAt: Date.now() } });
            if (tries === 0) {
              await new Promise((res) => later(() => res(null), 2000));
              const still = store.getState().moves[a.projectId];
              if (still && still.opId === opId) {
                store.dispatch({ type: "moveUpdate", projectId: a.projectId, opId, patch: { status: "inflight" } });
                return attempt(1);
              }
            }
            engine.syncNow();
            return { kind: "checking" };
          }
          store.dispatch({ type: "moveRemove", projectId: a.projectId, opId });
          return { kind: "error", message: describeError(e) };
        }
      };
      return attempt(0);
    },
    [store, engine, later],
  );

  const setNotNotified = useCallback((messageId: string, list: PipelineNotNotified[]) => {
    setNotNotifiedState((m) => ({ ...m, [messageId]: list }));
  }, []);

  const value = useMemo<PipelineContextValue>(
    () => ({
      meId: userId,
      boot,
      store,
      engine,
      directory: dir.data,
      dirById,
      directoryFailed: !dir.data && !!dir.error,
      retryDirectory: () => void mutateDir(),
      noteUnknownId,
      loadProject,
      send,
      retrySend,
      discardSend,
      move,
      notNotified,
      setNotNotified,
    }),
    [userId, boot, store, engine, dir.data, dir.error, dirById, mutateDir, noteUnknownId, loadProject, send, retrySend, discardSend, move, notNotified, setNotNotified],
  );

  if (terminal) {
    return (
      <GateScreen
        kind={terminal === "PIPELINE_NOT_IN_PILOT" ? "not_in_pilot" : terminal === "ACCOUNT_INACTIVE" ? "inactive" : "forbidden"}
        onRetry={() => {
          setTerminal(null);
          engine.retry();
          recheckBootstrap();
        }}
      />
    );
  }

  // 403 PIPELINE_DISABLED mid-session: keep everything mounted (data and unsent text stay
  // visible and copyable) and say so; the engine re-checks every ~3 min and resumes itself.
  return (
    <Ctx.Provider value={value}>
      {disabled && <PausedBanner />}
      <Notices />
      {children}
    </Ctx.Provider>
  );
}
