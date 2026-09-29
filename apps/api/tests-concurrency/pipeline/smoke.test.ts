import { describe, it, expect } from "vitest";
import { prisma } from "@dashmani/db";

/**
 * Wiring check for the pipeline concurrency suite (P8). The races themselves live in
 * races.test.ts and skip-freedom.test.ts next to this file.
 *
 * It proves the job's wiring: this file is picked up ONLY by vitest.concurrency.config.ts
 * (the main suite excludes tests-concurrency/), tests/setup.ts has already TRUNCATEd the
 * job's own freshly pushed database in beforeEach, and the pipeline pool is sized at 3.
 */
describe("pipeline concurrency suite (skeleton)", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });

  it("sizes the pipeline pool at 3 connections", () => {
    expect(process.env.PIPELINE_DB_CONNECTIONS).toBe("3");
  });

  it("reaches its database with the schema pushed", async () => {
    const rows = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM users`;
    expect(rows[0].n).toBe(0);
  });
});
