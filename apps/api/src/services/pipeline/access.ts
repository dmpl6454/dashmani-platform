/**
 * Per-user access facts and the people directory, both memoised so a gated request costs
 * ZERO statements on a hit (spec §3.2, §8.3).
 *
 *   access memo     {active, isAdmin} per user — 60 s, single-flight, ≤ 500 entries.
 *                   A deactivated user is cut off within 60 s; every WRITE statement also
 *                   re-checks the actor's status in SQL (spec §4.3).
 *   directory memo  every non-ONBOARDING user's display name — 5 min, single-flight.
 *
 * `isAdmin` here only shows or hides buttons. Owner/admin ACTIONS re-check admin status
 * fresh in the database inside their transaction (pipeline-gates.ts, spec §4.5) — JWT
 * roles are never trusted for either.
 *
 * Both memos compute through pipelineRead (one gate slot) and are resolved by the gates
 * BEFORE a handler takes its own slot, so nothing ever waits for a slot it holds.
 */
import { DEFAULT_ROLES, stripBidi, truncateGraphemes, PIPELINE_LIMITS } from "@dashmani/shared";
import { createSingleFlightMemo } from "../../utils/single-flight-memo";
import { pipelineRead } from "./tx";

export interface PipelineAccess {
  /** ACTIVE and not soft-deleted. */
  active: boolean;
  /** Holds Super Admin or Admin (from the DB, not the JWT). */
  isAdmin: boolean;
  /** The user's display name (bidi-stripped, ≤ 60), read from the same row; "" if unknown. */
  name: string;
}

const ADMIN_ROLE_NAMES = [DEFAULT_ROLES.SUPER_ADMIN.name, DEFAULT_ROLES.ADMIN.name];

const accessMemo = createSingleFlightMemo({ ttlMs: 60_000, maxEntries: 500 });

export function getPipelineAccess(userId: string): Promise<PipelineAccess> {
  return accessMemo.memo(userId, () =>
    pipelineRead(async (db) => {
      const rows = await db.$queryRaw<Array<{ active: boolean; is_admin: boolean; name: string }>>`
        SELECT u.name,
               (u.status = 'ACTIVE' AND u.deleted_at IS NULL) AS active,
               EXISTS (
                 SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                  WHERE ur.user_id = u.id AND r.name = ANY(${ADMIN_ROLE_NAMES}::text[])
               ) AS is_admin
          FROM users u
         WHERE u.id = ${userId}`;
      const row = rows[0];
      // An unknown id (a token for a user that no longer exists) is simply not active.
      return {
        active: row?.active === true,
        isAdmin: row?.is_admin === true,
        name: row ? displayName(row.name ?? "") : "",
      };
    }),
  );
}

// ── Directory ────────────────────────────────────────────────────────────────────────

export interface PipelineDirectoryPerson {
  id: string;
  /** Bidi-stripped, whitespace-collapsed, ≤ 60 graphemes. */
  name: string;
  initials: string;
  active: boolean;
  /** Primary team name, only when another directory entry has the same name. */
  hint?: string;
}

export interface PipelineDirectory {
  entries: PipelineDirectoryPerson[];
  byId: ReadonlyMap<string, PipelineDirectoryPerson>;
  builtAt: number;
}

/** Safety cap on the directory size (the org has ~100s of users). */
const DIRECTORY_MAX_USERS = 5_000;
const DIRECTORY_TTL_MS = 5 * 60_000;

const directoryMemo = createSingleFlightMemo({ ttlMs: DIRECTORY_TTL_MS, maxEntries: 1 });

export function displayName(raw: string): string {
  const cleaned = stripBidi(raw).replace(/\s+/g, " ").trim();
  return truncateGraphemes(cleaned || "Unnamed", PIPELINE_LIMITS.directoryNameMax);
}

function firstGrapheme(word: string): string {
  // Array.from splits by code point, which is enough for an initial (never a lone surrogate).
  return Array.from(word)[0] ?? "";
}

export function initialsOf(name: string): string {
  const words = name.split(" ").filter((w) => w && w !== "…");
  if (words.length === 0) return "?";
  const first = firstGrapheme(words[0]);
  const last = words.length > 1 ? firstGrapheme(words[words.length - 1]) : "";
  return (first + last).toUpperCase() || "?";
}

async function buildDirectory(): Promise<PipelineDirectory> {
  const rows = await pipelineRead((db) =>
    db.$queryRaw<Array<{ id: string; name: string; active: boolean; team: string | null }>>`
      SELECT u.id, u.name,
             (u.status = 'ACTIVE' AND u.deleted_at IS NULL) AS active,
             o.name AS team
        FROM users u
        LEFT JOIN org_units o ON o.id = u.org_unit_id
       WHERE u.status <> 'ONBOARDING'
       ORDER BY lower(u.name), u.id
       LIMIT ${DIRECTORY_MAX_USERS}`,
  );
  const people = rows.map((r) => {
    const name = displayName(r.name ?? "");
    return { id: r.id, name, initials: initialsOf(name), active: r.active === true, team: r.team };
  });
  const counts = new Map<string, number>();
  for (const p of people) {
    const k = p.name.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const entries: PipelineDirectoryPerson[] = people.map((p) => {
    const e: PipelineDirectoryPerson = { id: p.id, name: p.name, initials: p.initials, active: p.active };
    if ((counts.get(p.name.toLowerCase()) ?? 0) > 1 && p.team) e.hint = displayName(p.team);
    return e;
  });
  return { entries, byId: new Map(entries.map((e) => [e.id, e])), builtAt: Date.now() };
}

export function getPipelineDirectory(): Promise<PipelineDirectory> {
  return directoryMemo.memo("directory", buildDirectory);
}

export function invalidatePipelineAccess(): void {
  accessMemo.clear();
  directoryMemo.clear();
}
