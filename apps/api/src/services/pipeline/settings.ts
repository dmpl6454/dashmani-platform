/**
 * The pipeline's runtime switches, read from `system_settings` (spec §3.2 "Settings memo",
 * §12 kill switches). Changing a row takes effect within 15 s with no deploy:
 *
 *   pipeline.mode            "off" | "pilot" | "on"; an absent or unrecognised value = off
 *   pipeline.pilotUserIds    JSON array of user ids, or a comma/space separated list
 *   pipeline.pollMs          a number (a floor for every interval) or a JSON object with
 *                            any of project/projectBg/board/boardBg/idle; clamped 2 s–10 min
 *   pipeline.minClientBuild  integer; older HR tabs are told to reload
 *
 * FAILURE SEMANTICS (review item 8): a read that FAILS must never look like "off" — the
 * client would show "paused" for a DB blip. A failed read is served from the last value
 * read successfully within 5 minutes; with none, callers get 503 PIPELINE_BUSY
 * (retried silently). PIPELINE_DISABLED is only ever the result of a SUCCESSFUL read.
 *
 * BACKOFF. After a failed read the next attempt waits RETRY_BACKOFF_MS: meanwhile the
 * last-known value (or the 503) is answered at once, without a load. Otherwise every
 * gated request during a blip would first wait for its own failing load (a read slot, up
 * to the 2 s bulkhead wait or the 5 s connect timeout) and only then fall back.
 */
import { PIPELINE_DEFAULT_POLL_MS, PIPELINE_MODES, type PipelineMode, type PipelinePollMs } from "@dashmani/shared";
import { pipelineRead } from "./tx";
import { PipelineError, PIPELINE_RETRY_AFTER_SEC } from "./errors";

export const PIPELINE_SETTING_KEYS = [
  "pipeline.mode",
  "pipeline.pilotUserIds",
  "pipeline.pollMs",
  "pipeline.minClientBuild",
] as const;

export interface PipelineSettings {
  mode: PipelineMode;
  pilotUserIds: ReadonlySet<string>;
  pollMs: PipelinePollMs;
  minClientBuild: number;
}

const MEMO_MS = 15_000;
const LAST_KNOWN_MS = 5 * 60_000;
const POLL_MIN_MS = 2_000;
const POLL_MAX_MS = 600_000;
const MAX_PILOT_IDS = 1_000;
const RETRY_BACKOFF_MS = 2_000;

type SettingRow = { key: string; value: string };
type Loader = () => Promise<SettingRow[]>;

const defaultLoader: Loader = () =>
  pipelineRead((db) =>
    db.systemSetting.findMany({
      where: { key: { in: [...PIPELINE_SETTING_KEYS] } },
      select: { key: true, value: true },
    }),
  );

let loader: Loader = defaultLoader;
let current: { settings: PipelineSettings; loadedAt: number } | null = null;
let inflight: Promise<PipelineSettings> | null = null;
let lastFailureLog = 0;
/** No load is attempted before this time (set after a failed load). */
let retryAt = 0;

function parseMode(raw: string | undefined): PipelineMode {
  const v = (raw ?? "").trim().toLowerCase();
  return (PIPELINE_MODES as readonly string[]).includes(v) ? (v as PipelineMode) : "off";
}

function parsePilotIds(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  let list: unknown = null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      list = JSON.parse(trimmed);
    } catch {
      list = null;
    }
  }
  const items = Array.isArray(list) ? list : trimmed.split(/[\s,]+/);
  for (const item of items) {
    if (typeof item !== "string") continue;
    const id = item.trim().toLowerCase();
    if (id) out.add(id);
    if (out.size >= MAX_PILOT_IDS) break;
  }
  return out;
}

const clampPoll = (n: number) => Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(n)));

function parsePollMs(raw: string | undefined): PipelinePollMs {
  const out: PipelinePollMs = { ...PIPELINE_DEFAULT_POLL_MS };
  if (!raw) return out;
  const trimmed = raw.trim();
  const asNumber = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(asNumber)) {
    // A single number raises every interval to at least that value (the "slow everything
    // down during the evening rush" knob).
    for (const k of Object.keys(out) as Array<keyof PipelinePollMs>) out[k] = clampPoll(Math.max(out[k], asNumber));
    return out;
  }
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const k of Object.keys(out) as Array<keyof PipelinePollMs>) {
        const v = obj[k];
        if (typeof v === "number" && Number.isFinite(v)) out[k] = clampPoll(v);
      }
    }
  } catch {
    // unparseable → defaults
  }
  return out;
}

function parseMinClientBuild(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n >= 0 && n <= 2_147_483_647 ? n : 0;
}

export function parsePipelineSettings(rows: SettingRow[]): PipelineSettings {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    mode: parseMode(byKey.get("pipeline.mode")),
    pilotUserIds: parsePilotIds(byKey.get("pipeline.pilotUserIds")),
    pollMs: parsePollMs(byKey.get("pipeline.pollMs")),
    minClientBuild: parseMinClientBuild(byKey.get("pipeline.minClientBuild")),
  };
}

function load(): Promise<PipelineSettings> {
  if (!inflight) {
    inflight = (async () => {
      try {
        const settings = parsePipelineSettings(await loader());
        current = { settings, loadedAt: Date.now() };
        return settings;
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

/**
 * The current settings (memoised 15 s, single-flight).
 * @throws PipelineError 503 PIPELINE_BUSY when unreadable and no value < 5 min old exists.
 */
function busy(): PipelineError {
  return new PipelineError(503, "PIPELINE_BUSY", "The pipeline is busy — retrying shortly", {
    retryAfterSec: PIPELINE_RETRY_AFTER_SEC,
  });
}

function lastKnown(now: number): PipelineSettings | null {
  return current && now - current.loadedAt < LAST_KNOWN_MS ? current.settings : null;
}

export async function getPipelineSettings(): Promise<PipelineSettings> {
  const now = Date.now();
  if (current && now - current.loadedAt < MEMO_MS) return current.settings;
  if (now < retryAt) {
    // Backing off after a failed load: answer from what we have, without a load.
    const known = lastKnown(now);
    if (known) return known;
    throw busy();
  }
  try {
    return await load();
  } catch (err) {
    retryAt = Date.now() + RETRY_BACKOFF_MS;
    const known = lastKnown(Date.now());
    if (known) return known;
    if (Date.now() - lastFailureLog > 10_000) {
      lastFailureLog = Date.now();
      console.warn("[pipeline] settings unreadable and no recent value — answering 503:", String(err));
    }
    throw busy();
  }
}

/**
 * Is `userId` on the pilot allowlist? The ONE place the comparison is made (the gate and
 * the directory's `pickable` both use it), so the two can never disagree. Ids are compared
 * lowercased — parsePilotIds lowercases the list.
 */
export function isPilotUser(settings: Pick<PipelineSettings, "pilotUserIds">, userId: string): boolean {
  return settings.pilotUserIds.has(userId.toLowerCase());
}

/** Forget the memo AND the last-known value (tests, and after the flag script writes). */
export function invalidatePipelineSettings(): void {
  current = null;
  retryAt = 0;
}

/** Tests only: replace the loader (null restores the real one). */
export function __setPipelineSettingsLoaderForTests(fn: Loader | null): void {
  loader = fn ?? defaultLoader;
}

/** Tests only: age the memo past its 15 s TTL while keeping it as the last-known value. */
export function __expirePipelineSettingsMemoForTests(): void {
  if (current) current = { ...current, loadedAt: Date.now() - MEMO_MS - 1 };
}
