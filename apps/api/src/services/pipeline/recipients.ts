/**
 * The ONE recipient predicate (spec §7.3), shared by every in-portal notification INSERT
 * (notify.ts, the due cron) and every email-outbox INSERT (email-outbox.ts), so a person
 * who gets a bell row for an event is exactly the person who can get its email.
 *
 * `u` must be the joined `users` row of the recipient `col`. `actor` is null for the due
 * cron; `allow` is the pilot allowlist in pilot mode, else null.
 */
import { Prisma } from "./db";

export function recipientFragment(col: Prisma.Sql, actor: string | null, allow: string[] | null): Prisma.Sql {
  return Prisma.sql`(u.status = 'ACTIVE' AND u.deleted_at IS NULL
    AND ${col} IS DISTINCT FROM ${actor}::text
    AND (${allow}::text[] IS NULL OR ${col} = ANY(${allow}::text[])))`;
}
