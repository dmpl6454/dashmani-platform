/**
 * pipeline/email-ddl-script.test.ts — static contract of scripts/pipeline-email-ddl.sql.
 *
 * Applied BY HAND to production before the PR merges (runbook
 * docs/superpowers/plans/2026-09-30-pipeline-email-runbook.md), so the same §12 review
 * rules as scripts/pipeline-ddl.sql are encoded here: the safety grep, one transaction with
 * a 3 s lock_timeout / 60 s statement_timeout / pinned search_path, idempotent creates,
 * FKs behind table-scoped guards, only the new table touched, no bare now(). Plus the one
 * thing Prisma cannot express — the partial unique coalescing index — must be there, text
 * for text, because the enqueue's ON CONFLICT clause infers it. The live proof (applied
 * twice, then an empty `prisma migrate diff --exit-code`) runs in CI's DDL rehearsal step.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import { PIPELINE_EMAIL_ARBITER_PROBE } from "../../src/services/pipeline/self-check";

const SCRIPT = path.resolve(__dirname, "../../../../scripts/pipeline-email-ddl.sql");

// Verbatim from spec §12 step 1.
const SAFETY_GREP =
  /DROP|ALTER TABLE "(users|notifications)"|ON "(users|notifications|report_links|daily_reports|social_accounts|link_metrics|link_metrics_latest)"/;

let raw = "";
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

describe("scripts/pipeline-email-ddl.sql", () => {
  it("exists", () => {
    expect(raw.length).toBeGreaterThan(0);
  });

  it("passes the §12 safety grep on every line, comments included", () => {
    expect(raw.split("\n").filter((line) => SAFETY_GREP.test(line))).toEqual([]);
  });

  it("runs in one transaction with a 3 s lock_timeout, a 60 s statement_timeout and search_path pinned", () => {
    const st = statements();
    expect(st[0].replace(/^\\set ON_ERROR_STOP on\s*/, "")).toBe("BEGIN");
    expect(st[1]).toBe("SET LOCAL lock_timeout = '3s'");
    expect(st[2]).toBe("SET LOCAL statement_timeout = '60s'");
    expect(st[3]).toBe("SET LOCAL search_path = public");
    expect(st[st.length - 1]).toBe("COMMIT");
    expect(st.slice(1).filter((s) => s === "BEGIN").length).toBe(0);
    expect(st.filter((s) => s === "COMMIT" || s === "ROLLBACK").length).toBe(1);
  });

  it("creates exactly the outbox table, IF NOT EXISTS, and alters no type", () => {
    const creates = statements().filter((s) => /^CREATE TABLE /.test(s));
    expect(creates.map((s) => /^CREATE TABLE IF NOT EXISTS "([a-z_]+)"/.exec(s)?.[1])).toEqual(["pipeline_email_outbox"]);
    expect(statements().filter((s) => /^ALTER TYPE /.test(s))).toEqual([]);
  });

  it("creates the two Prisma indexes and the partial unique coalescing key, all IF NOT EXISTS", () => {
    const idx = statements().filter((s) => /^CREATE (UNIQUE )?INDEX /.test(s));
    expect(idx).toEqual([
      `CREATE INDEX IF NOT EXISTS "pipeline_email_outbox_status_send_after_idx" ON "pipeline_email_outbox"("status", "send_after")`,
      `CREATE INDEX IF NOT EXISTS "pipeline_email_outbox_project_id_idx" ON "pipeline_email_outbox"("project_id")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_email_outbox_pending_key" ON "pipeline_email_outbox"("user_id", "project_id", "kind") WHERE "status" = 'pending'`,
    ]);
  });

  it("the self-check probes exactly the ON CONFLICT target the index serves", () => {
    expect(PIPELINE_EMAIL_ARBITER_PROBE.replace(/\s+/g, " ")).toContain(
      `ON CONFLICT ("user_id", "project_id", "kind") WHERE "status" = 'pending' DO NOTHING`,
    );
    expect(PIPELINE_EMAIL_ARBITER_PROBE.startsWith("EXPLAIN ")).toBe(true);
  });

  it("adds the 2 foreign keys only inside guards scoped to their own table, users last", () => {
    const flat = sql.replace(/\s+/g, " ");
    const guarded = [
      ...flat.matchAll(
        /DO \$\$ BEGIN IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = '([a-z_]+)' AND conrelid = '"public"\."([a-z_]+)"'::regclass\) THEN ALTER TABLE "([a-z_]+)" ADD CONSTRAINT "([a-z_]+)" FOREIGN KEY \("([a-z_]+)"\) REFERENCES "([a-z_]+)"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/g,
      ),
    ].map((m) => ({ guard: m[1], guardTable: m[2], table: m[3], name: m[4], col: m[5], ref: m[6] }));
    expect(guarded.map((g) => `${g.name} ${g.col}->${g.ref}`)).toEqual([
      "pipeline_email_outbox_project_id_fkey project_id->pipeline_projects",
      "pipeline_email_outbox_user_id_fkey user_id->users",
    ]);
    for (const g of guarded) {
      expect(g.guard).toBe(g.name);
      expect(g.guardTable).toBe("pipeline_email_outbox");
      expect(g.table).toBe("pipeline_email_outbox");
    }
    expect([...sql.matchAll(/ADD CONSTRAINT/g)].length).toBe(2);
    // Nothing but the end of its DO block and COMMIT after the users FK (its lock is held
    // until COMMIT, so it must come last).
    const tail = flat.slice(flat.indexOf(`REFERENCES "users"`));
    expect(tail.replace(/^REFERENCES "users"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE;/, "").trim()).toBe("END IF; END $$; COMMIT;");
  });

  it("alters no table but the outbox", () => {
    const targets = [...sql.matchAll(/ALTER TABLE\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(targets)).toEqual(new Set(["pipeline_email_outbox"]));
  });

  it("never uses now() at all (defaults are CURRENT_TIMESTAMP, as Prisma generates)", () => {
    expect([...sql.matchAll(/now\(\)/g)].length).toBe(0);
  });
});
