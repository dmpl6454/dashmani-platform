import { prisma } from "@dashmani/db";
import { adminAlert } from "./creator-email";

/**
 * Staff alerts for the payout money path, rate-limited so a bad loop can never flood the shared
 * Gmail account.
 *
 * ⚠️ WHY A LIMIT. Every email goes out from hr@digitalsukoon.com, which also carries password
 * resets for every portal. The cases that alert are exactly the ones that repeat in bulk: an
 * unreadable webhook payload is redelivered by Razorpay for 24 hours, and an empty Razorpay
 * balance fails EVERY transfer at once. One email per key per hour tells staff everything the
 * next 300 would; the rows themselves (status, error code, event log) stay the record, and the
 * next email that does go out says how many it held back.
 *
 * ⚠️ "SENT" MEANS THE MAILER SAID SO. sendEmail() never throws: it resolves to null when
 * SMTP_USER / SMTP_PASS are unset and when the send fails (a rejected login, an unreachable
 * host). So the promise adminAlert() returns resolving is NOT evidence of delivery; only a
 * non-null result is. Everything that treats an alert as delivered (the quiet hour for its key,
 * and the `alerted_*` stamp a caller puts on a row so a digest skips it) therefore waits for that
 * result:
 *   • the key's quiet hour is claimed up front, so duplicates arriving while the send is in flight
 *     are held back rather than each opening an SMTP connection; if the send then fails, the quiet
 *     hour is RELEASED (and the held-back count folded back in), so the next occurrence tries again;
 *   • `onSent` runs only after a successful send. A row stamped from it is therefore never stamped
 *     for an email nobody received, and a row whose email failed stays un-stamped for the digest.
 *     (A crash between the send and the stamp leaves the row un-stamped: the safe direction.)
 * A failed attempt still counts against the global ceiling below: with SMTP down every occurrence
 * would otherwise open a connection, which is the flood this file exists to prevent. At most
 * MAX_PER_WINDOW attempts an hour reach the mail server, successful or not.
 *
 * The hourly state is in process memory on purpose: it costs nothing on the webhook path (which must
 * answer in 5 seconds), and a restart at worst lets one more email through per key.
 *
 * ⚠️ TWO BUDGETS, MONEY FIRST. A creator can cause an alert by their own action (declining an offer, asking for a
 * bank change), and a publisher with a dozen pages can decline them all in a minute. If those shared ONE ceiling with
 * "a transfer failed", "a dispute opened" and "a refund is stuck", a creator could silence the alerts staff most need
 * for the rest of the hour. So the ceiling is counted per LANE: the routine lane (routineAlertKey: creator-triggered and
 * digest-style keys) has its own small allowance, and every other key (the default, so an unknown caller is treated as
 * money-critical) counts only against the critical one. The lanes never borrow from each other.
 *
 * ⚠️ "ONCE A DAY" NEEDS A MARKER THAT SURVIVES A RESTART: alertStaffDurably keeps its last-sent marker in system_settings
 * (no DDL: the table already holds the runtime switches), written only after the mailer said the email went out. Every
 * deploy restarts the process and wipes the in-memory state, so a daily alert kept only in memory is re-sent after every
 * deploy, from the mailbox that also sends every portal's password resets.
 *
 * Provider text must never reach a value here unescaped or unscrubbed: adminAlert() escapes
 * every label and value, and callers pass only our own wording, ids and scrubbed codes.
 */

const WINDOW_MS = 60 * 60 * 1000;
/** Across ALL money-critical keys: a hard ceiling per window, so many different keys cannot add up to a flood. */
const MAX_PER_WINDOW = 12;
/** The routine lane's own ceiling. It is deliberately smaller: these alerts say "nothing to do unless this repeats". */
const MAX_ROUTINE_PER_WINDOW = 6;
/** The two ceilings, for the tests that prove a burst is spread over several hours and never dropped. */
export const ALERT_CEILINGS = { critical: MAX_PER_WINDOW, routine: MAX_ROUTINE_PER_WINDOW } as const;
const MAX_KEYS = 200;

/**
 * Keys a creator (or a routine digest) can cause. They count against the routine lane only. Anything NOT listed here is
 * money-critical: a new caller is protected by default and has to be listed on purpose to be demoted.
 */
const ROUTINE_KEY_PREFIXES = ["creator-offer-closed:", "creator-offer-problem:", "creator-offers-", "payout-bank-change:", "payout-bank-change-pending"];
export const routineAlertKey = (key: string): boolean => ROUTINE_KEY_PREFIXES.some((p) => key.startsWith(p));

const lastSent = new Map<string, { at: number; held: number }>();
let windowStart = 0;
let sentInWindow = 0;
let routineSentInWindow = 0;
/** Sends still waiting on the mailer, so a test can wait for them (and for their `onSent`). */
const inFlight = new Set<Promise<void>>();

export interface PayoutAlertOptions {
  /** Epoch ms. Tests only. */
  now?: number;
  /**
   * Runs once, and only after the mailer reported the email went out: never for a held-back alert
   * and never for a failed send. It runs AFTER alertStaffOncePerHour has returned (the webhook does
   * not wait for SMTP), so it must not assume the caller is still waiting. A throw is logged.
   */
  onSent?: () => void | Promise<void>;
  /** Force a lane. Default: derived from the key (routineAlertKey). */
  lane?: "critical" | "routine";
}

/**
 * Email staff about `subject`, unless this `key` already emailed in the last hour (or the global
 * ceiling is reached). Never throws and never waits for the mail server.
 * @returns true when an email was handed to the mailer, false when it was held back. This is NOT
 * "delivered": use `onSent` for anything that must only happen once the email actually went out.
 */
export function alertStaffOncePerHour(
  key: string,
  subject: string,
  details: Array<{ label: string; value: string }>,
  path?: string,
  opts: PayoutAlertOptions = {},
): boolean {
  try {
    const now = opts.now ?? Date.now();
    if (now - windowStart >= WINDOW_MS) {
      windowStart = now;
      sentInWindow = 0;
      routineSentInWindow = 0;
    }
    const routine = (opts.lane ?? (routineAlertKey(key) ? "routine" : "critical")) === "routine";
    const prev = lastSent.get(key);
    const quiet = prev !== undefined && now - prev.at < WINDOW_MS;
    if (!prev && lastSent.size >= MAX_KEYS) lastSent.clear(); // bounded: a restart-sized reset is fine
    if (quiet || (routine ? routineSentInWindow >= MAX_ROUTINE_PER_WINDOW : sentInWindow >= MAX_PER_WINDOW)) {
      // Held back: remember how many, so the next email that does go out can say so.
      const entry = lastSent.get(key) ?? { at: 0, held: 0 };
      entry.held++;
      lastSent.set(key, entry);
      return false;
    }
    const held = lastSent.get(key)?.held ?? 0;
    lastSent.set(key, { at: now, held: 0 });
    if (routine) routineSentInWindow++;
    else sentInWindow++;
    const body = held > 0 ? [...details, { label: "Held back", value: `${held} similar alert(s) since the last email for this event` }] : details;

    // Fire and forget: SMTP can take seconds and the webhook has 5 to answer [R28].
    const task = (async () => {
      let delivered = false;
      try {
        // null / undefined = sendEmail's "not configured" or "send failed" (it swallows both).
        delivered = (await adminAlert(subject, body, path)) != null;
      } catch (err) {
        console.error("[payout-alert] email failed:", (err as Error)?.message ?? "unknown error");
      }
      if (!delivered) {
        // Release the quiet hour so the next occurrence retries, and give back what it held.
        const cur = lastSent.get(key);
        if (cur && cur.at === now) {
          cur.at = 0;
          cur.held += held;
        }
        return;
      }
      if (opts.onSent) {
        try {
          await opts.onSent();
        } catch (err) {
          console.error("[payout-alert] could not record the alert:", (err as Error)?.message ?? "unknown error");
        }
      }
    })();
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
    return true;
  } catch (err) {
    console.error("[payout-alert] could not alert:", (err as Error)?.message ?? "unknown error");
    return false;
  }
}

// ── Once a day, across restarts ─────────────────────────────────────────────────────────────────

/** system_settings key prefix of the last-sent markers (one row per alert key, overwritten, never one per day). */
export const ALERT_MARKER_PREFIX = "creatorPayouts.alerted:";

export interface DurableAlertOptions extends PayoutAlertOptions {
  /** Quiet while the stored marker equals this token (for example the IST day). */
  token?: string;
  /** Quiet while the stored marker, an epoch ms, is younger than this. Ignored when `token` is given. */
  quietMs?: number;
}

/**
 * alertStaffOncePerHour with a quiet period that outlives the process: the marker is read first and written only after the mailer
 * reported the email went out (a failed send leaves the slot open for the next try). If the marker cannot be read (a database
 * blip) it falls back to the in-memory hour rather than skipping an alert about money. Never throws.
 * @returns true when an email was handed to the mailer.
 */
export async function alertStaffDurably(
  key: string,
  subject: string,
  details: Array<{ label: string; value: string }>,
  path?: string,
  opts: DurableAlertOptions = {},
): Promise<boolean> {
  try {
    const now = opts.now ?? Date.now();
    let marker: string | null = null;
    try {
      marker = (await prisma.systemSetting.findUnique({ where: { key: ALERT_MARKER_PREFIX + key }, select: { value: true } }))?.value ?? null;
    } catch (err) {
      console.error("[payout-alert] could not read the alert marker:", (err as Error)?.message ?? "unknown error");
    }
    if (marker !== null) {
      const quiet = opts.token !== undefined ? marker === opts.token : opts.quietMs !== undefined && now - Number(marker) < opts.quietMs;
      if (quiet) return false;
    }
    const stamp = opts.token ?? String(now);
    return alertStaffOncePerHour(key, subject, details, path, {
      ...opts,
      onSent: async () => {
        await prisma.systemSetting.upsert({ where: { key: ALERT_MARKER_PREFIX + key }, create: { key: ALERT_MARKER_PREFIX + key, value: stamp }, update: { value: stamp } });
        await opts.onSent?.();
      },
    });
  } catch (err) {
    console.error("[payout-alert] could not alert:", (err as Error)?.message ?? "unknown error");
    return false;
  }
}

/** Tests only. */
export function resetPayoutAlertsForTests(): void {
  lastSent.clear();
  windowStart = 0;
  sentInWindow = 0;
  routineSentInWindow = 0;
}

/** Tests only: forget every durable marker (system_settings is not truncated between tests). */
export async function clearPayoutAlertMarkersForTests(): Promise<void> {
  await prisma.systemSetting.deleteMany({ where: { key: { startsWith: ALERT_MARKER_PREFIX } } });
}

/** Tests only: resolves once every alert handed to the mailer so far has finished, `onSent` included. */
export async function flushPayoutAlertsForTests(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}
