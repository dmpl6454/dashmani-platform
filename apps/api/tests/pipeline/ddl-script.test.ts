/**
 * pipeline/ddl-script.test.ts — static contract of scripts/pipeline-ddl.sql (spec §12).
 *
 * That script is applied BY HAND to production before the schema PR merges, so a bad edit
 * cannot be caught by CI any other way. These assertions encode the §12 review rules:
 *   1. the safety grep prints nothing (no DROP, no DDL on users/notifications, no index on
 *      a hot table);
 *   2. everything runs in ONE transaction with a 3 s lock_timeout and a 60 s
 *      statement_timeout, so a lock that is not granted aborts cleanly instead of queueing
 *      behind (and in front of) login traffic on "users"; and it pins search_path to public,
 *      because every name in it is unqualified and psql's default is `"$user", public` (a
 *      schema named after the app role would otherwise receive the tables);
 *   3. it is idempotent: every create is IF NOT EXISTS, every FK is guarded by a check scoped
 *      to ITS table (a same-named constraint elsewhere must not skip it), the enum value is
 *      ADD VALUE IF NOT EXISTS, every seed is ON CONFLICT DO NOTHING;
 *   4. it only ever touches pipeline_* objects plus the one enum value;
 *   5. it seeds the board row and exactly the 7 §2 phases, Done being the only terminal one;
 *   6. raw timestamps are timezone('utc', now()), never a bare now() (spec §2 DB rule 2).
 * This file reads the script as text. The live proof — every statement executed, twice, then
 * an empty `prisma migrate diff` — runs in CI (the "Rehearse the pipeline DDL script" step in
 * .github/workflows/ci.yml) and is recorded in docs/superpowers/plans/2026-09-26-pipeline-ddl-runbook.md.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";

const SCRIPT = path.resolve(__dirname, "../../../../scripts/pipeline-ddl.sql");

// Verbatim from spec §12 step 1.
const SAFETY_GREP =
  /DROP|ALTER TABLE "(users|notifications)"|ON "(users|notifications|report_links|daily_reports|social_accounts|link_metrics|link_metrics_latest)"/;

const PIPELINE_TABLES = [
  "pipeline_board_state",
  "pipeline_messages",
  "pipeline_participants",
  "pipeline_phases",
  "pipeline_projects",
];

let raw = "";
/** The script with `--` comments removed (none of its string literals contain `--`). */
let sql = "";

beforeAll(() => {
  raw = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, "utf8") : "";
  sql = raw
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
});

function statements(): string[] {
  return sql
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

describe("scripts/pipeline-ddl.sql (spec §12)", () => {
  it("exists", () => {
    expect(raw.length).toBeGreaterThan(0);
  });

  it("passes the §12 safety grep on every line, comments included", () => {
    const hits = raw.split("\n").filter((line) => SAFETY_GREP.test(line));
    expect(hits).toEqual([]);
  });

  it("runs in one transaction with a 3 s lock_timeout, a 60 s statement_timeout and search_path pinned", () => {
    const st = statements();
    // psql meta-commands carry no ';' — strip a leading \set line before comparing.
    const first = st[0].replace(/^\\set ON_ERROR_STOP on\s*/, "");
    expect(first).toBe("BEGIN");
    expect(st[1]).toBe("SET LOCAL lock_timeout = '3s'");
    expect(st[2]).toBe("SET LOCAL statement_timeout = '60s'");
    expect(st[3]).toBe("SET LOCAL search_path = public");
    expect(st[st.length - 1]).toBe("COMMIT");
    // Exactly one top-level transaction (DO-block bodies split into fragments that start
    // with "DO $$" / "END", never with a bare BEGIN or COMMIT).
    expect(st.slice(1).filter((s) => s === "BEGIN").length).toBe(0);
    expect(st.filter((s) => s === "COMMIT" || s === "ROLLBACK").length).toBe(1);
  });

  it("adds exactly one enum value, idempotently, and alters no other type", () => {
    const alters = statements().filter((s) => /^ALTER TYPE /.test(s));
    expect(alters).toEqual([`ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PIPELINE'`]);
  });

  it("creates exactly the five pipeline tables, each IF NOT EXISTS", () => {
    const creates = statements().filter((s) => /^CREATE TABLE /.test(s));
    expect(creates.every((s) => s.startsWith("CREATE TABLE IF NOT EXISTS "))).toBe(true);
    const names = creates.map((s) => /^CREATE TABLE IF NOT EXISTS "([a-z_]+)"/.exec(s)?.[1]).sort();
    expect(names).toEqual(PIPELINE_TABLES);
  });

  it("creates every secondary index IF NOT EXISTS, and only on pipeline tables", () => {
    const idx = statements().filter((s) => /^CREATE (UNIQUE )?INDEX /.test(s));
    // §2: phases 2, projects 6, participants 1, messages 5 (primary keys are inline).
    expect(idx.length).toBe(14);
    for (const s of idx) {
      expect(s).toMatch(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS "pipeline_[a-z_]+" ON "pipeline_[a-z_]+"/);
    }
  });

  it("adds the 8 foreign keys only inside guards scoped to their own table, so a second run is a no-op", () => {
    const adds = [...sql.matchAll(/ADD CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]);
    expect(adds.length).toBe(8);
    // Each ADD CONSTRAINT must sit directly under the guard for THAT name on THAT table. A
    // name-only guard would also match a same-named constraint on another table or schema
    // and silently skip the FK.
    const flat = sql.replace(/\s+/g, " ");
    const guarded = [
      ...flat.matchAll(
        /DO \$\$ BEGIN IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = '([a-z_]+)' AND conrelid = '"public"\."([a-z_]+)"'::regclass\) THEN ALTER TABLE "([a-z_]+)" ADD CONSTRAINT "([a-z_]+)"/g,
      ),
    ].map((m) => ({ guardName: m[1], guardTable: m[2], table: m[3], name: m[4] }));
    expect(guarded.map((g) => g.name).sort()).toEqual([...adds].sort());
    for (const g of guarded) {
      expect(g.guardName).toBe(g.name);
      expect(g.guardTable).toBe(g.table);
      expect(g.name.startsWith("pipeline_")).toBe(true);
    }
  });

  it("alters no table except pipeline_* ones", () => {
    const targets = [...sql.matchAll(/ALTER TABLE\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => t.startsWith("pipeline_"))).toBe(true);
  });

  it("seeds the board row idempotently", () => {
    const flat = sql.replace(/\s+/g, " ");
    expect(flat).toContain(
      `INSERT INTO "pipeline_board_state" ("id", "seq", "updated_at") VALUES (1, 0, timezone('utc', now())) ON CONFLICT DO NOTHING`,
    );
  });

  it("seeds exactly the 7 §2 phases in order, Done terminal, ON CONFLICT (key) DO NOTHING", () => {
    const flat = sql.replace(/\s+/g, " ");
    const insert = /INSERT INTO "pipeline_phases" \(([^)]*)\) VALUES (.*?) ON CONFLICT \("key"\) DO NOTHING/.exec(flat);
    expect(insert).not.toBeNull();
    expect(insert![1]).toBe(`"id", "key", "name", "position", "is_terminal", "created_at", "updated_at"`);
    const rows = [
      ...insert![2].matchAll(
        /\(gen_random_uuid\(\)::text, '([a-z_]+)', '([^']+)', (\d), (true|false), timezone\('utc', now\(\)\), timezone\('utc', now\(\)\)\)/g,
      ),
    ].map((m) => [m[1], m[2], Number(m[3]), m[4] === "true"]);
    expect(rows).toEqual([
      ["brief", "Brief", 1, false],
      ["planning", "Planning", 2, false],
      ["in_production", "In Production", 3, false],
      ["review", "Review", 4, false],
      ["approved", "Approved", 5, false],
      ["live", "Live", 6, false],
      ["done", "Done", 7, true],
    ]);
  });

  it("never uses a bare now()", () => {
    const all = [...sql.matchAll(/now\(\)/g)].length;
    const wrapped = [...sql.matchAll(/timezone\('utc', now\(\)\)/g)].length;
    expect(all).toBeGreaterThan(0);
    expect(wrapped).toBe(all);
  });
});
