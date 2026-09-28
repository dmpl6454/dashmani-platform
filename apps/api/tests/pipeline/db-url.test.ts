/**
 * pipeline/db-url.test.ts — the dedicated pipeline Prisma client (spec §3.2).
 *
 * The pipeline runs on its OWN small pool so that no amount of pipeline traffic can take
 * a connection from login, HR submit or the bells (the 2026-07-08 / 2026-09-18 P2024
 * class). Its URL is derived from DATABASE_URL with the query string replaced, and it
 * carries hard server-side ceilings so a slow statement or a lock wait fails in seconds
 * (→ 503) instead of holding one of its 3 connections.
 */
import { describe, it, expect, afterAll } from "vitest";
import { buildPipelineDbUrl, parsePipelineDbConnections, pipelineDb } from "../../src/services/pipeline/db";

const SUFFIX =
  "connection_limit=3&pool_timeout=2&connect_timeout=5&options=-c%20statement_timeout%3D2500%20-c%20lock_timeout%3D1000";

describe("buildPipelineDbUrl", () => {
  it("strips the existing pool params and applies the pipeline ceilings", () => {
    expect(buildPipelineDbUrl("postgresql://u:p@h:5432/d?connection_limit=10&pool_timeout=20", 3)).toBe(
      `postgresql://u:p@h:5432/d?${SUFFIX}`,
    );
  });

  it("works on a URL with no query string", () => {
    expect(buildPipelineDbUrl("postgresql://u:p@h:5432/d", 3)).toBe(`postgresql://u:p@h:5432/d?${SUFFIX}`);
  });

  it("replaces the main process's statement_timeout options instead of keeping them", () => {
    const out = buildPipelineDbUrl(
      "postgresql://u:p@h:5432/d?connection_limit=10&options=-c%20statement_timeout%3D60000",
      1,
    );
    expect(out).toBe(`postgresql://u:p@h:5432/d?${SUFFIX.replace("connection_limit=3", "connection_limit=1")}`);
    expect(out!.includes("60000")).toBe(false);
  });

  it("keeps connection-identity params (schema, TLS, socket host) that the pool must not lose", () => {
    const out = buildPipelineDbUrl(
      "postgresql://u:p@h:5432/d?schema=public&sslmode=require&connection_limit=10&host=%2Fvar%2Frun%2Fpostgresql",
      3,
    );
    expect(out).toBe(
      `postgresql://u:p@h:5432/d?${SUFFIX}&schema=public&sslmode=require&host=%2Fvar%2Frun%2Fpostgresql`,
    );
  });

  it("hand-encodes the options value (%20 / %3D), never '+'", () => {
    const out = buildPipelineDbUrl("postgresql://u:p@h/d", 3)!;
    expect(out.includes("+")).toBe(false);
    expect(out).toContain("options=-c%20statement_timeout%3D2500%20-c%20lock_timeout%3D1000");
  });

  it("is fail-open on a missing URL", () => {
    expect(buildPipelineDbUrl(undefined, 3)).toBeUndefined();
    expect(buildPipelineDbUrl("", 3)).toBe("");
  });
});

describe("parsePipelineDbConnections", () => {
  it("defaults to 3 and clamps to 1..10", () => {
    expect(parsePipelineDbConnections(undefined)).toBe(3);
    expect(parsePipelineDbConnections("")).toBe(3);
    expect(parsePipelineDbConnections("abc")).toBe(3);
    expect(parsePipelineDbConnections("0")).toBe(3);
    expect(parsePipelineDbConnections("-2")).toBe(3);
    expect(parsePipelineDbConnections("1")).toBe(1);
    expect(parsePipelineDbConnections("3")).toBe(3);
    expect(parsePipelineDbConnections("2.5")).toBe(3);
    expect(parsePipelineDbConnections("50")).toBe(10);
  });
});

describe("pipelineDb", () => {
  afterAll(async () => {
    await pipelineDb.$disconnect();
  });

  it("runs with the pipeline statement and lock timeouts, not the main process's", async () => {
    const rows = await pipelineDb.$queryRaw<Array<{ st: string; lt: string }>>`
      SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt`;
    expect(rows).toEqual([{ st: "2500ms", lt: "1s" }]);
  });

  it("uses the test pool size (PIPELINE_DB_CONNECTIONS=1 in the main suite)", () => {
    expect(process.env.PIPELINE_DB_CONNECTIONS).toBe("1");
  });
});
