/**
 * Notification-bell decision logic (spec §7.10, §9.8, prerequisites P3/P4).
 *
 * Pure and dependency-free so the HR and internal bells share one set of rules
 * and the apps/api vitest suite can prove them. The bells render ONLY from what
 * these functions return.
 *
 * ⚠️ The rule: only a LOADED response may claim emptiness. A failed request must
 * say so. The old bells rendered "No notifications yet" for any empty OR FAILED
 * list, which is the exact "data vanished" misreading documented in the
 * 2026-09-18 incident.
 *
 * ⚠️ No regex here, and none with lookbehind ever (older iOS Safari throws at
 * PARSE time and takes the whole page down).
 */

/** The server's `take: 50` on GET /hr/notifications and /admin/notifications. */
export const BELL_LIST_LIMIT = 50;

/** Bounds every string before it is inspected or parsed. */
const MAX_LINK_LENGTH = 2048;

export interface BellListView<T> {
  /** Nothing loaded and nothing failed yet: show the skeleton. */
  loading: boolean;
  /** The latest request failed (or answered with a malformed body): say so, offer Retry. */
  failed: boolean;
  /** A LOADED `[]` with no current failure. The only state allowed to say "No notifications yet". */
  empty: boolean;
  /**
   * Rows to render. On `failed`, these are the rows from the last successful load
   * (SWR keeps them), shown under the error notice; never fabricated.
   */
  rows: T[];
}

/**
 * Classify the bell list from an SWR `{ data, error }` pair, where `data` is the
 * API envelope `{ success, data: Notification[] }`.
 */
export function bellListView<T = unknown>(
  envelope: unknown,
  error: unknown,
  limit: number = BELL_LIST_LIMIT,
): BellListView<T> {
  const list =
    envelope !== null && typeof envelope === "object" && Array.isArray((envelope as { data?: unknown }).data)
      ? ((envelope as { data: T[] }).data)
      : null;
  const rows = list ? list.slice(0, limit) : [];

  if (error !== undefined && error !== null) {
    return { loading: false, failed: true, empty: false, rows };
  }
  if (envelope === undefined) {
    return { loading: true, failed: false, empty: false, rows: [] };
  }
  if (!list) {
    // A 200 whose body is not the expected list. We cannot claim emptiness.
    return { loading: false, failed: true, empty: false, rows: [] };
  }
  return { loading: false, failed: false, empty: rows.length === 0, rows };
}

interface NotificationLike {
  type?: unknown;
  metadata?: unknown;
}

function pipelineMetadata(n: unknown): Record<string, unknown> | null {
  if (n === null || typeof n !== "object") return null;
  const { type, metadata } = n as NotificationLike;
  if (type !== "PIPELINE") return null;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return metadata as Record<string, unknown>;
}

/**
 * HR bell (P3): the in-app path a PIPELINE row should open, or null.
 *
 * Only `type === "PIPELINE"` rows with a string `metadata.path` that starts with
 * `/pipeline/` qualify. Every other row keeps today's behaviour (open the detail
 * view). A path that starts with `/pipeline/` cannot be protocol-relative
 * (`//host`) or absolute, so `router.push` stays same-origin.
 */
export function pipelineNotificationPath(n: unknown): string | null {
  const meta = pipelineMetadata(n);
  if (!meta) return null;
  const path = meta.path;
  if (typeof path !== "string" || path.length > MAX_LINK_LENGTH) return null;
  return path.startsWith("/pipeline/") ? path : null;
}
