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
