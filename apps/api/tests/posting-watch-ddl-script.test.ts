/**
 * Static contract of scripts/posting-watch-ddl.sql.
 *
 * The script is applied BY HAND to production before the feature merges (the deploy runs
 * db:generate, never db:push), so a bad edit cannot be caught any other way. It must:
 *   1. run as ONE transaction with a 3 s lock_timeout, a 60 s statement_timeout and
 *      search_path pinned to public;
 *   2. be idempotent (every CREATE is IF NOT EXISTS);
 *   3. touch ONLY meta_post_watch — no DROP, no ALTER, no foreign key (so it takes no lock
 *      on any existing table);
 *   4. create every column the Prisma model declares, and the (kind, meta_id) unique index.
 * The live proof — applied twice, then an empty `prisma migrate diff` — runs in CI: the
 * "Rehearse the pipeline DDL scripts" step in .github/workflows/ci.yml also applies this
 * script (it drops meta_post_watch from the pushed schema first).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { Prisma } from "@dashmani/db";
import "./setup";

const SCRIPT = path.resolve(__dirname, "../../../scripts/posting-watch-ddl.sql");
const sql = fs.readFileSync(SCRIPT, "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

describe("scripts/posting-watch-ddl.sql", () => {
  it("is one transaction with lock/statement timeouts and a pinned search_path", () => {
    const lines = code.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines[0]).toBe("\\set ON_ERROR_STOP on");
    expect(lines[1]).toBe("BEGIN;");
    expect(lines).toContain("SET LOCAL lock_timeout = '3s';");
    expect(lines).toContain("SET LOCAL statement_timeout = '60s';");
    expect(lines).toContain("SET LOCAL search_path = public;");
    expect(lines[lines.length - 1]).toBe("COMMIT;");
  });

  it("is idempotent and touches nothing but meta_post_watch", () => {
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/\bALTER\b/i);
    expect(code).not.toMatch(/\bREFERENCES\b|\bFOREIGN KEY\b/i);
    expect(code).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/i);
    const creates = code.match(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)[^;]*/gi) ?? [];
    expect(creates).toHaveLength(2);
    for (const c of creates) expect(c).toMatch(/IF NOT EXISTS/i);
    for (const target of code.matchAll(/(?:CREATE TABLE IF NOT EXISTS|\bON)\s+"([^"]+)"/g)) {
      expect(target[1]).toBe("meta_post_watch");
    }
  });

  it("creates every column of the MetaPostWatch model and the (kind, meta_id) unique index", () => {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === "MetaPostWatch");
    expect(model).toBeDefined();
    const columns = model!.fields.filter((f) => f.kind === "scalar" || f.kind === "enum").map((f) => f.dbName ?? f.name);
    expect(columns.length).toBeGreaterThan(10);
    const table = /CREATE TABLE IF NOT EXISTS "meta_post_watch" \(([\s\S]*?)\n\);/.exec(code)?.[1] ?? "";
    for (const col of columns) expect(table).toContain(`"${col}"`);
    expect(code).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "meta_post_watch_kind_meta_id_key" ON "meta_post_watch"("kind", "meta_id");');
  });
});
