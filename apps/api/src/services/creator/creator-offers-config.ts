// Creator OFFERS: constants for the offers service and its worker. Kept apart from creator-config.ts (env-driven switches,
// owned by the catalogue/payment side) because none of these is an operator knob: each is a rule the worker's tests pin.
// Nothing here reads the environment, so nothing here can change what runs while the marketplace is dark.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The offer email. The first send is fire-and-forget after approve (review.approve), so a failure leaves `notified_at` NULL
 * and nothing else. creator_offers has no "attempts" column (and this phase adds no DDL), so each failed retry is written to
 * the booking's history as a marker line (RETRY_MARKER below) and the retries are counted from those lines: they survive a
 * restart and staff can read them.
 */
export const OFFER_EMAIL = {
  /** An offer is retried only once its first send has had this long to finish (the retry must never race it and mail twice). */
  MIN_AGE_MS: 10 * MINUTE,
  /** The wait before retry number i+1 (i = retries already failed), measured from the last failed retry (the first: from `offered_at`). */
  BACKOFF_MS: [10 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR, 12 * HOUR] as readonly number[],
  /** After this many failed retries the worker stops mailing this offer (the 48 h offer clock keeps running; staff were told). */
  MAX_RETRIES: 5,
  /** Staff are told once, after this many failed retries (about 2.7 hours in), while there is still time to ring the creator. */
  ALERT_AFTER_RETRIES: 3,
} as const;

/** The booking-history line written for a failed retry. Counted by the worker, so keep the wording in ONE place. */
export const RETRY_MARKER_CONTAINS = "could not be sent (offer ";
export const retryMarker = (pageName: string, offerId: string, retry: number) =>
  `Offer email to the creator for ${pageName} could not be sent (offer ${offerId}, retry ${retry})`.slice(0, 480);
export const RETRY_MARKER_RE = /\(offer ([0-9a-f-]{36}), retry (\d+)\)$/;

/** Kinds of staff alert the worker derives from state. The marker line proves one was SENT (see alertMarker). */
export type StaffAlertKind = "refund" | "missed" | "unverified" | "undelivered";
export const alertMarker = (kind: StaffAlertKind, offerId: string) => `Staff alerted [${kind}] (offer ${offerId})`;

/** A closed offer is looked at for a missing staff alert only this long after it closed (so the pass stays bounded). */
export const ALERT_LOOKBACK_MS = 3 * DAY;

/** After a launch-day reminder fails to send, no reminder is attempted for this long (the shared mailbox must not be hammered). */
export const REMINDER_PAUSE_MS = 30 * MINUTE;

/** Graph pages read for ONE link check: Facebook 25 a page, Instagram 50. Bounds the creator's request and our call budget. */
export const LINK_CHECK_MAX_PAGES = 3;

/**
 * Resuming after the worker was not running (marketplace switched off, CREATOR_OFFERS_CRON_ENABLED=0, the API down): the
 * creators could not answer, and the deadlines are wall-clock. system_settings keys (no schema change):
 *   HEARTBEAT_KEY  ISO time of the last tick that ran
 *   GRACE_KEY      JSON [{from, until}] (epoch ms): a posting deadline that fell in [from, until] is moved to `until`
 */
export const HEARTBEAT_KEY = "creatorOffers.lastTickAt";
export const GRACE_KEY = "creatorOffers.deadlineGrace";
/** Ticks are 5 minutes apart: a longer silence than this is an outage, not a slow tick. */
export const GAP_THRESHOLD_MS = 15 * MINUTE;
/** An outage longer than this does not extend offers any further (a three-week switch-off must not revive three-week-old offers). */
export const GAP_MAX_EXTEND_MS = 7 * DAY;
/** The link deadline of an affected offer moves to at most this long after the worker came back. */
export const GRACE_MAX_MS = DAY;
/** Grace periods remembered at once. */
export const GRACE_KEEP = 8;
