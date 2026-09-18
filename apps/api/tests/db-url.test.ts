import { describe, it, expect } from "vitest";
import { withConnectionPool } from "../src/db-url";

describe("withConnectionPool", () => {
  it("appends pool params to a URL that has none", () => {
    const out = withConnectionPool("postgresql://u:p@localhost:5432/db");
    expect(out).toContain("connection_limit=10");
    expect(out).toContain("pool_timeout=20");
    expect(out).toContain("connect_timeout=15");
    // first param uses ?, the rest use &
    expect(out).toBe(
      "postgresql://u:p@localhost:5432/db?connection_limit=10&pool_timeout=20&connect_timeout=15",
    );
  });

  it("does NOT override an explicit connection_limit already in the URL", () => {
    const url = "postgresql://u:p@localhost:5432/db?connection_limit=25";
    // Respect an operator-set value; only fill in the params that are missing.
    const out = withConnectionPool(url);
    expect(out).toContain("connection_limit=25");
    expect(out).not.toContain("connection_limit=10");
    expect(out).toContain("pool_timeout=20"); // still fills the missing ones
  });

  it("appends with & when the URL already has a query string", () => {
    const out = withConnectionPool("postgresql://u:p@localhost:5432/db?schema=public");
    expect(out).toBe(
      "postgresql://u:p@localhost:5432/db?schema=public&connection_limit=10&pool_timeout=20&connect_timeout=15",
    );
  });

  it("returns the input unchanged when it is empty/undefined (fail-open)", () => {
    expect(withConnectionPool(undefined)).toBeUndefined();
    expect(withConnectionPool("")).toBe("");
  });

  it("returns the input unchanged when it is not a parseable connection string", () => {
    // Never throw on a weird value — Prisma will surface its own error later.
    expect(withConnectionPool("not a url")).toBe("not a url");
  });
});

// ── DB_STATEMENT_TIMEOUT_MS → Postgres `options` (2026-09-18) ─────────────────
describe("withConnectionPool — statement_timeout knob", () => {
  const base = "postgresql://u:p@localhost:5432/db";

  it("adds nothing when the knob is unset", () => {
    expect(withConnectionPool(base, { statementTimeoutMs: undefined })).not.toContain("options=");
  });

  it("appends a hand-encoded `options=-c statement_timeout=<ms>` when set", () => {
    const out = withConnectionPool(base, { statementTimeoutMs: "60000" })!;
    expect(out).toContain("connection_limit=10");
    // %20 for the space and %3D for '=' — never '+' (Prisma's URL parser does not
    // treat '+' as a space inside `options`).
    expect(out.endsWith("&options=-c%20statement_timeout%3D60000")).toBe(true);
    expect(out).not.toContain("+");
  });

  it("ignores a non-numeric value and never overrides an explicit `options` already in the URL", () => {
    expect(withConnectionPool(base, { statementTimeoutMs: "sixty" })).not.toContain("options=");
    const explicit = withConnectionPool(`${base}?options=-c%20statement_timeout%3D5`, { statementTimeoutMs: "60000" })!;
    expect(explicit).toContain("statement_timeout%3D5");
    expect(explicit).not.toContain("60000");
  });
});
