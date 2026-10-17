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
 * The state is in process memory on purpose: it costs nothing on the webhook path (which must
 * answer in 5 seconds), and a restart at worst lets one more email through per key.
 *
 * Provider text must never reach a value here unescaped or unscrubbed: adminAlert() escapes
 * every label and value, and callers pass only our own wording, ids and scrubbed codes.
 */

const WINDOW_MS = 60 * 60 * 1000;
/** Across ALL keys: a hard ceiling per window, so many different keys cannot add up to a flood. */
const MAX_PER_WINDOW = 12;
const MAX_KEYS = 200;

const lastSent = new Map<string, { at: number; held: number }>();
let windowStart = 0;
let sentInWindow = 0;
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
    }
    const prev = lastSent.get(key);
    const quiet = prev !== undefined && now - prev.at < WINDOW_MS;
    if (!prev && lastSent.size >= MAX_KEYS) lastSent.clear(); // bounded: a restart-sized reset is fine
    if (quiet || sentInWindow >= MAX_PER_WINDOW) {
      // Held back: remember how many, so the next email that does go out can say so.
      const entry = lastSent.get(key) ?? { at: 0, held: 0 };
      entry.held++;
      lastSent.set(key, entry);
      return false;
    }
    const held = lastSent.get(key)?.held ?? 0;
    lastSent.set(key, { at: now, held: 0 });
    sentInWindow++;
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

/** Tests only. */
export function resetPayoutAlertsForTests(): void {
  lastSent.clear();
  windowStart = 0;
  sentInWindow = 0;
}

/** Tests only: resolves once every alert handed to the mailer so far has finished, `onSent` included. */
export async function flushPayoutAlertsForTests(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}
