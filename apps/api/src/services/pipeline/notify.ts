/**
 * Pipeline notifications (spec §7). The ONLY writer of `NotificationType.PIPELINE` rows —
 * `NOTIFICATION_AUDIENCE.PIPELINE = []`, so a stray dispatchNotification writes nothing.
 *
 * ⚠️ Rules (spec §7.2–§7.3, §10 "Forbidden"):
 *   - every id comes from plnId() / plnIdSql() — deterministic, UUID-shaped, so
 *     markAsRead and the existing bell routes work unchanged and every write is an
 *     idempotent primary-key upsert or probe (no scan, no new index);
 *   - every INSERT filters its recipients through recipientFragment();
 *   - no admin lookup anywhere: admins are notified only as participants;
 *   - writes go through the caller's `tx` (the action's own transaction) — never
 *     pipelineDb, never the global prisma.
 */
import { createHash } from "crypto";
import { Prisma } from "./db";

export const PLN_KINDS = ["messages", "mention", "reply", "added", "moved", "due_soon", "overdue"] as const;
export type PlnKind = (typeof PLN_KINDS)[number];

/** md5('pln:<kind>:' || parts joined by ':')::uuid::text — the TypeScript half. */
export function plnId(kind: PlnKind, ...parts: string[]): string {
  const h = createHash("md5").update(`pln:${kind}:${parts.join(":")}`, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The SQL half of plnId(). A string part is bound as a parameter; a Prisma.Sql part is a
 * column expression that must already render as text exactly like the JS part (dates via
 * `to_char(d, 'YYYY-MM-DD')`, ints via `::text`). A parity test asserts both agree.
 */
export function plnIdSql(kind: PlnKind, ...parts: Array<string | Prisma.Sql>): Prisma.Sql {
  const pieces = parts.map((p) => (typeof p === "string" ? Prisma.sql`${p}::text` : p));
  return Prisma.sql`md5(${`pln:${kind}:`}::text || ${Prisma.join(pieces, " || ':' || ")})::uuid::text`;
}

/**
 * The one recipient predicate every notification INSERT uses (spec §7.3). `u` must be the
 * joined `users` row of the recipient `col`. `actor` is null for the due cron; `allow` is
 * the pilot allowlist in pilot mode, else null.
 */
export function recipientFragment(col: Prisma.Sql, actor: string | null, allow: string[] | null): Prisma.Sql {
  return Prisma.sql`(u.status = 'ACTIVE' AND u.deleted_at IS NULL
    AND ${col} IS DISTINCT FROM ${actor}::text
    AND (${allow}::text[] IS NULL OR ${col} = ANY(${allow}::text[])))`;
}
