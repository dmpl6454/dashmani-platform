/**
 * One SyncEngine per tab (spec §5.5). It owns the timers, the visibility / focus /
 * online listeners and the single in-flight /sync request; every "how long, what next"
 * decision is delegated to the pure rules in @dashmani/shared (pipeline/sync-state).
 *
 * Invariants:
 *   - at most ONE request in flight; a wake during a request queues one follow-up;
 *   - paused while the tab is hidden or offline;
 *   - a failed poll never clears data (the store is only ever fed successful merges);
 *   - a merge exception reloads that project from route 6 instead of throwing.
 */
import {
  buildSyncRequest,
  classifySyncResult,
  connectionIndicator,
  initialSchedulerState,
  nextTickMs,
  onlineWakeDelayMs,
  planAfterAttempt,
  planHasMore,
  postWriteSyncAllowed,
  shouldSyncOnWake,
  PIPELINE_IDLE_AFTER_MS,
  type ConnectionIndicator,
  type PipelinePollMs,
  type PipelineSyncAck,
  type PipelineSyncResponse,
  type SchedulerState,
  type PipelineViewKind,
  type SyncOutcome,
} from "@dashmani/shared";
import { isApiError } from "./api";
import type { PipelineStore } from "./store";
import { PIPELINE_CLIENT_BUILD } from "./constants";

export interface EngineStatus {
  indicator: ConnectionIndicator;
  /** ms epoch of the last 200, or null. */
  lastOkAt: number | null;
  online: boolean;
  /** true after a wake (visible / online) until the first sync lands: "Updating…". */
  waking: boolean;
  /** Consecutive transient failures. */
  failures: number;
  /** Terminal 403 code, when stopped. */
  terminalCode: string | null;
}

export interface ProjectMount {
  id: string;
  /** The ack to send (only while the project view is visible), or null. */
  getAck(): PipelineSyncAck | null;
  /** Called with the ack after a successful sync carried it. */
  onAcked?(ack: PipelineSyncAck): void;
}

export interface SyncEngineOptions {
  store: PipelineStore;
  getPollMs(): PipelinePollMs;
  postSync(req: ReturnType<typeof buildSyncRequest>, signal: AbortSignal): Promise<PipelineSyncResponse>;
  /** 403 PIPELINE_DISABLED: re-check bootstrap (the provider revalidates it). */
  onDisabled(): void;
  /** Terminal 403: stop and show a friendly page with a manual Retry. */
  onTerminal(code: string): void;
  /** The delta merge threw, or hasMore chained too long: reload this project (route 6). */
  onReloadProject(projectId: string): void;
  /** reload:true or an unexpected 4xx: one hard reload (≤ once / 10 min). */
  onHardReload(): void;
}

const RELOAD_KEY = "pl-reload-at";

function readReloadAt(): number | null {
  try {
    const v = Number(sessionStorage.getItem(RELOAD_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export class SyncEngine {
  private o: SyncEngineOptions;
  private sched: SchedulerState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private queued = false;
  private started = false;
  private boardMounts = 0;
  private project: ProjectMount | null = null;
  private lastStartedAt: number | null = null;
  private lastPostWriteAt: number | null = null;
  private lastInputAt = Date.now();
  private hasMoreChain = 0;
  private waking = false;
  private statusListeners = new Set<() => void>();
  private status: EngineStatus;

  constructor(o: SyncEngineOptions) {
    this.o = o;
    this.sched = { ...initialSchedulerState, lastReloadAt: readReloadAt() };
    this.status = this.computeStatus();
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────────

  start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("focus", this.onFocus);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    this.kick(0);
  }

  stop() {
    this.started = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("focus", this.onFocus);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    this.clearTimer();
    this.inFlight?.abort();
    this.inFlight = null;
  }

  /** The board is mounted while the returned function has not been called. */
  mountBoard(): () => void {
    this.boardMounts++;
    this.kick(0);
    return () => {
      this.boardMounts = Math.max(0, this.boardMounts - 1);
    };
  }

  mountProject(m: ProjectMount): () => void {
    this.project = m;
    this.hasMoreChain = 0;
    this.kick(0);
    return () => {
      if (this.project === m) this.project = null;
    };
  }

  /** Any user input. Coming back from idle syncs immediately. */
  markInput() {
    const now = Date.now();
    const wasIdle = now - this.lastInputAt >= PIPELINE_IDLE_AFTER_MS;
    this.lastInputAt = now;
    if (wasIdle) this.kick(0);
  }

  /** Sync as soon as possible (a wake, a manual Retry, a newly loaded project). */
  syncNow() {
    this.kick(0);
  }

  /** After one of your own successful writes: at most one sync per 2 s. */
  afterWrite() {
    const now = Date.now();
    if (!postWriteSyncAllowed(this.lastPostWriteAt, now)) return;
    this.lastPostWriteAt = now;
    this.kick(0);
  }

  /** Manual Retry from the terminal page. */
  retry() {
    this.sched = { ...this.sched, mode: "running", terminalCode: null, failures: 0 };
    this.emit();
    this.kick(0);
  }

  getStatus = (): EngineStatus => this.status;

  subscribeStatus = (fn: () => void): (() => void) => {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  };

  // ── internals ───────────────────────────────────────────────────────────────────

  private visible() {
    return typeof document === "undefined" || document.visibilityState === "visible";
  }

  private online() {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  private view(): PipelineViewKind {
    if (this.project) return "project";
    return this.boardMounts > 0 ? "board" : "none";
  }

  private onVisibility = () => {
    if (!this.visible()) {
      this.clearTimer();
      return;
    }
    this.waking = true;
    this.emit();
    if (shouldSyncOnWake(this.lastStartedAt, Date.now())) this.kick(0);
    else this.schedule(null);
  };

  private onFocus = () => {
    if (shouldSyncOnWake(this.lastStartedAt, Date.now())) this.kick(0);
  };

  private onOnline = () => {
    this.waking = true;
    this.emit();
    this.kick(onlineWakeDelayMs(Math.random));
  };

  private onOffline = () => {
    this.clearTimer();
    this.emit();
  };

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private kick(delayMs: number) {
    if (!this.started) return;
    if (this.inFlight) {
      if (delayMs === 0) this.queued = true;
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => void this.run(), delayMs);
  }

  /** Schedule the next attempt: an explicit delay, or the normal interval. */
  private schedule(delayMs: number | null) {
    if (!this.started) return;
    if (this.sched.mode === "terminal") return;
    if (delayMs === null) {
      const idle = Date.now() - this.lastInputAt >= PIPELINE_IDLE_AFTER_MS;
      const focused = typeof document !== "undefined" && document.hasFocus();
      delayMs = nextTickMs(
        { view: this.view(), visible: this.visible(), focused, idle, online: this.online() },
        this.o.getPollMs(),
        Math.random,
      );
      if (delayMs === null) return; // paused: the visibility / online listeners wake us
    }
    this.clearTimer();
    this.timer = setTimeout(() => void this.run(), delayMs);
  }

  private async run() {
    this.timer = null;
    if (!this.started || this.inFlight || this.sched.mode === "terminal") return;
    if (!this.visible() || !this.online()) return;
    if (this.view() === "none") return;

    const project = this.project;
    const ack = project ? project.getAck() : null;
    const req = buildSyncRequest(this.o.store.getState(), {
      clientBuild: PIPELINE_CLIENT_BUILD,
      board: this.boardMounts > 0,
      projectId: project?.id ?? null,
      ack,
    });
    const startedAt = Date.now();
    this.lastStartedAt = startedAt;
    const ctl = new AbortController();
    this.inFlight = ctl;

    let res: PipelineSyncResponse | null = null;
    let outcome: SyncOutcome;
    try {
      res = await this.o.postSync(req, ctl.signal);
      outcome = classifySyncResult({ status: 200 });
    } catch (e) {
      outcome = classifySyncResult(
        isApiError(e) ? { status: e.status ?? 0, code: e.code, retryAfterSec: e.retryAfterSec } : { status: 0 },
      );
    }
    if (this.inFlight !== ctl) return; // stopped meanwhile
    this.inFlight = null;

    let followUp = false;
    if (res) {
      try {
        this.o.store.dispatch({ type: "syncOk", req, res, now: startedAt });
      } catch {
        if (req.project) this.o.onReloadProject(req.project.id);
      }
      if (ack && project?.onAcked) project.onAcked(ack);
      if (res.project?.hasMore) {
        if (planHasMore(this.hasMoreChain) === "follow_up") {
          this.hasMoreChain++;
          followUp = true;
        } else {
          this.hasMoreChain = 0;
          this.o.onReloadProject(res.project.id);
        }
      } else {
        this.hasMoreChain = 0;
      }
      this.waking = false;
    } else {
      this.o.store.dispatch({ type: "syncFailed" });
    }

    const decision = planAfterAttempt(this.sched, outcome, Date.now(), Math.random, {
      reloadRequested: res?.reload === true,
    });
    this.sched = decision.state;
    if (decision.action === "reload") {
      try {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      } catch {
        /* ignore */
      }
      this.o.onHardReload();
    } else if (decision.action === "recheckBootstrap") {
      this.o.onDisabled();
    } else if (decision.action === "stop") {
      this.o.onTerminal(this.sched.terminalCode ?? "FORBIDDEN");
    }
    this.emit();

    if (followUp || this.queued) {
      this.queued = false;
      if (this.sched.mode === "running" && outcome.kind === "ok") return this.kick(0);
    }
    this.queued = false;
    this.schedule(decision.delayMs);
  }

  private computeStatus(): EngineStatus {
    return {
      indicator: connectionIndicator(this.sched, Date.now()),
      lastOkAt: this.sched.lastOkAt,
      online: this.online(),
      waking: this.waking,
      failures: this.sched.failures,
      terminalCode: this.sched.terminalCode,
    };
  }

  private emit() {
    const next = this.computeStatus();
    const cur = this.status;
    if (
      cur.indicator === next.indicator &&
      cur.lastOkAt === next.lastOkAt &&
      cur.online === next.online &&
      cur.waking === next.waking &&
      cur.failures === next.failures &&
      cur.terminalCode === next.terminalCode
    ) {
      return;
    }
    this.status = next;
    this.statusListeners.forEach((l) => l());
  }
}
