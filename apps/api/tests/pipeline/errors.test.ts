/**
 * pipeline/errors.test.ts — classifyDbError + pipelineErrorMiddleware (spec §3.3).
 *
 * The global errorHandler maps only AppError; everything else becomes 500 "An unexpected
 * error occurred". Most pipeline hot paths are RAW SQL, whose failures arrive as P2010
 * (SQLSTATE in meta.code) or as PrismaClientUnknownRequestError (SQLSTATE only in the
 * message). These tests force each class through REAL statements on pipelineDb and assert
 * none of them becomes a 500: capacity problems are 503 PIPELINE_BUSY + retryAfterSec
 * (retried silently by the client), conflicts are 409, missing references are 404.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { PrismaClient, Prisma } from "@dashmani/db";
import { MentionLimitError } from "@dashmani/shared";
import {
  classifyDbError,
  toPipelineError,
  pipelineErrorMiddleware,
  withRetryOnce,
  PipelineError,
  isIdempotencyKeyViolation,
} from "../../src/services/pipeline/errors";
import { pipelineDb, buildPipelineDbUrl } from "../../src/services/pipeline/db";
import { pipelineRead, pipelineWrite, resetPipelineBulkheadForTests } from "../../src/services/pipeline/tx";
import { AppError } from "../../src/middleware/error-handler";
import { BulkheadBusyError } from "../../src/utils/bulkhead";

// A second, independent one-connection client that holds row locks while pipelineDb
// (also one connection in this suite) runs into them.
const locker = new PrismaClient({ datasources: { db: { url: buildPipelineDbUrl(process.env.DATABASE_URL, 1)! } } });

afterAll(async () => {
  await locker.$disconnect();
  await pipelineDb.$disconnect();
});

beforeEach(() => resetPipelineBulkheadForTests());

async function insertPhase(key: string): Promise<string> {
  const rows = await pipelineDb.$queryRaw<Array<{ id: string }>>`
    INSERT INTO pipeline_phases (id, key, name, position, updated_at)
    VALUES (gen_random_uuid()::text, ${key}, 'Phase', 1, timezone('utc', now()))
    RETURNING id`;
  return rows[0].id;
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

function runMiddleware(err: unknown) {
  const res = mockRes();
  const next = vi.fn();
  const req = { method: "POST", path: "/pipeline/projects", baseUrl: "/v1", originalUrl: "/v1/pipeline/projects" };
  pipelineErrorMiddleware(err, req as unknown as Request, res as unknown as Response, next as unknown as NextFunction);
  return { res, next, body: res.body as { success: boolean; error: Record<string, unknown> } };
}

const known = (code: string, meta?: Record<string, unknown>, message = `stub ${code}`) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: Prisma.prismaVersion.client, meta });

describe("classifyDbError on real statements", () => {
  it("a lock wait past lock_timeout (a row held by another connection) → 55P03 → 503 PIPELINE_BUSY", async () => {
    const id = await insertPhase("zz_lock");
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let markLocked!: () => void;
    const locked = new Promise<void>((r) => (markLocked = r));
    const holder = locker.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM pipeline_phases WHERE id = ${id} FOR UPDATE`;
        markLocked();
        await hold;
      },
      { maxWait: 5000, timeout: 15000 },
    );
    await locked;

    const raw = await pipelineDb
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1ms'");
        await tx.$queryRaw`SELECT id FROM pipeline_phases WHERE id = ${id} FOR UPDATE`;
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    const wrapped = await pipelineWrite(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1ms'");
      await tx.$queryRaw`SELECT id FROM pipeline_phases WHERE id = ${id} FOR UPDATE`;
    }).then(
      () => null,
      (e: unknown) => e,
    );
    release();
    await holder;

    expect(classifyDbError(raw).sqlstate).toBe("55P03");
    const mapped = toPipelineError(raw)!;
    expect(mapped.statusCode).toBe(503);
    expect(mapped.code).toBe("PIPELINE_BUSY");
    // The wrapper already classified it.
    expect(wrapped).toBeInstanceOf(AppError);
    expect((wrapped as AppError).statusCode).toBe(503);
    expect((wrapped as AppError).code).toBe("PIPELINE_BUSY");
    const { res, body } = runMiddleware(wrapped);
    expect(res.statusCode).toBe(503);
    expect(body.error.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("a statement past the 2,500 ms statement_timeout → 57014 → 503", async () => {
    const t0 = Date.now();
    const err = await pipelineRead((db) => db.$queryRaw`SELECT 1 AS one FROM pg_sleep(3)`).then(
      () => null,
      (e: unknown) => e,
    );
    const took = Date.now() - t0;
    expect(took).toBeLessThan(2900);
    expect(classifyDbError(err).sqlstate).toBe("57014");
    expect((err as AppError).statusCode).toBe(503);
    expect((err as AppError).code).toBe("PIPELINE_BUSY");
  });

  it("a raw duplicate insert on pipeline_phases.key → 409 CONFLICT with the violated key parsed", async () => {
    await insertPhase("zz_dup");
    const raw = await insertPhase("zz_dup").then(
      () => null,
      (e: unknown) => e,
    );
    const info = classifyDbError(raw);
    expect(info.sqlstate).toBe("23505");
    // ⚠️ Prisma 5.22 reports a raw 23505 as P2010 whose meta.message is ONLY the DETAIL
    // line ("Key (key)=(zz_dup) already exists.") — the constraint name is not in it —
    // so the key is identified by its columns.
    expect(info.fields).toEqual(["key"]);
    expect(isIdempotencyKeyViolation(info)).toBe(false);
    expect(toPipelineError(raw)).toMatchObject({ statusCode: 409, code: "CONFLICT" });
    // When a message does name the constraint (UnknownRequestError shape), it is parsed.
    const named = classifyDbError(
      new Error('ERROR: duplicate key value violates unique constraint "pipeline_phases_key_key" SQLSTATE 23505'),
    );
    expect(named).toMatchObject({ sqlstate: "23505", constraint: "pipeline_phases_key_key" });
  });

  it("a raw duplicate message clientId is recognised as an idempotency-key replay, not a plain conflict", async () => {
    const author = await pipelineDb.user.create({
      data: { name: "Err Author", email: `pipeline-errors-author-${Date.now()}@test.com`, passwordHash: "x", status: "ACTIVE" },
    });
    const phaseId = await insertPhase("zz_idem");
    const [{ id: projectId }] = await pipelineDb.$queryRaw<Array<{ id: string }>>`
      INSERT INTO pipeline_projects (id, client_id, title, owner_id, created_by_id, phase_id, rank, updated_at)
      VALUES (gen_random_uuid()::text, 'p1', 'T', ${author.id}, ${author.id}, ${phaseId}, 'a0', timezone('utc', now()))
      RETURNING id`;
    const send = (seq: number) =>
      pipelineDb.$executeRaw`INSERT INTO pipeline_messages (id, client_id, project_id, seq, rev, author_id, body, updated_at)
                             VALUES (gen_random_uuid()::text, 'k-1', ${projectId}, ${seq}, ${seq}, ${author.id}, 'hi', timezone('utc', now()))`;
    await send(1);
    const err = await send(2).then(
      () => null,
      (e: unknown) => e,
    );
    const info = classifyDbError(err);
    expect(info).toMatchObject({ sqlstate: "23505", fields: ["author_id", "client_id"] });
    expect(isIdempotencyKeyViolation(info)).toBe(true);
    expect(isIdempotencyKeyViolation({ sqlstate: "23505", constraint: "pipeline_projects_created_by_id_client_id_key", fields: null, modelName: null })).toBe(true);
    expect(isIdempotencyKeyViolation({ sqlstate: "23505", constraint: null, fields: ["createdById", "clientId"], modelName: null })).toBe(true);
  });

  it("an ORM duplicate (P2002) → 23505 → 409 CONFLICT with the target fields", async () => {
    await pipelineDb.pipelinePhase.create({ data: { key: "zz_orm", name: "P", position: 1 } });
    const err = await pipelineDb.pipelinePhase.create({ data: { key: "zz_orm", name: "P", position: 2 } }).then(
      () => null,
      (e: unknown) => e,
    );
    const info = classifyDbError(err);
    expect(info.sqlstate).toBe("23505");
    expect(info.fields).toEqual(["key"]);
    expect(toPipelineError(err)).toMatchObject({ statusCode: 409, code: "CONFLICT" });
  });

  it("a raw FK violation (unknown phase) → 23503 → 404 PHASE_NOT_FOUND; an unknown user → USER_NOT_FOUND", async () => {
    const owner = await pipelineDb.user.create({
      data: { name: "Err Owner", email: `pipeline-errors-${Date.now()}@test.com`, passwordHash: "x", status: "ACTIVE" },
    });
    const phaseId = await insertPhase("zz_fk");
    const badPhase = await pipelineDb
      .$executeRaw`INSERT INTO pipeline_projects (id, client_id, title, owner_id, created_by_id, phase_id, rank, updated_at)
                   VALUES (gen_random_uuid()::text, 'c1', 'T', ${owner.id}, ${owner.id}, 'no-such-phase', 'a0', timezone('utc', now()))`
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(classifyDbError(badPhase).sqlstate).toBe("23503");
    expect(toPipelineError(badPhase)).toMatchObject({ statusCode: 404, code: "PHASE_NOT_FOUND" });

    const badUser = await pipelineDb
      .$executeRaw`INSERT INTO pipeline_projects (id, client_id, title, owner_id, created_by_id, phase_id, rank, updated_at)
                   VALUES (gen_random_uuid()::text, 'c2', 'T', 'no-such-user', 'no-such-user', ${phaseId}, 'a0', timezone('utc', now()))`
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(toPipelineError(badUser)).toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });

  it("an ORM update of a missing row (P2025) → 404 named after the model", async () => {
    const err = await pipelineDb.pipelineProject
      .update({ where: { id: "00000000-0000-4000-8000-000000000000" }, data: { title: "x" } })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(classifyDbError(err).sqlstate).toBe("P2025");
    expect(toPipelineError(err)).toMatchObject({ statusCode: 404, code: "PROJECT_NOT_FOUND" });
  });
});

describe("data exceptions (SQLSTATE class 22) are the client's fault, never a 500", () => {
  const capture = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );

  it("NUL in a raw parameter (P2010 22021) and through the ORM (UnknownRequestError) → 400 VALIDATION_ERROR", async () => {
    const raw = await capture(pipelineDb.$queryRaw`SELECT ${"a\u0000b"}::text AS t`);
    expect(classifyDbError(raw).sqlstate).toBe("22021");
    expect(toPipelineError(raw)).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    const orm = await capture(pipelineDb.systemSetting.findMany({ where: { key: "a\u0000b" } }));
    expect(orm).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(toPipelineError(orm)).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    // Through the wrapper and the middleware: a clean 400, not PIPELINE_INTERNAL.
    const wrapped = await capture(pipelineRead((db) => db.$queryRaw`SELECT ${"a\u0000b"}::text AS t`));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { res, body } = runMiddleware(wrapped);
    warn.mockRestore();
    expect(res.statusCode).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("int4 overflow (22003), a bad date (22008 / 22007), a \\u0000 in jsonb (22P05) and varchar overflow (22001) → 400", async () => {
    const errs = [
      await capture(pipelineDb.$queryRaw`SELECT (${2147483647}::int4 + 1) AS n`),
      await capture(pipelineDb.$queryRaw`SELECT ${"2026-13-40"}::date AS d`),
      await capture(pipelineDb.$queryRaw`SELECT ${"not a date"}::date AS d`),
      await capture(pipelineDb.$queryRaw`SELECT ${'{"a":"\\u0000"}'}::jsonb AS j`),
      await capture(
        pipelineDb.$executeRaw`INSERT INTO pipeline_phases (id, key, name, position, updated_at)
                               VALUES (gen_random_uuid()::text, 'zz_overflow', ${"n".repeat(500)}, 1, timezone('utc', now()))`,
      ),
    ];
    expect(errs.map((e) => classifyDbError(e).sqlstate)).toEqual(["22003", "22008", "22007", "22P05", "22001"]);
    for (const e of errs) expect(toPipelineError(e)).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
  });

  it("text the validators accepted — even from NUL or lone-surrogate input — is always storable", async () => {
    const { pipelineValidators: pv } = await import("@dashmani/shared");
    const values = [
      pv.pipelineTitle.parse("Launch\u0000plan \ud83d"),
      pv.pipelineBody.parse("hello \ud83d\u0000"),
      pv.pipelineDescription.parse("x\udc00y"),
      pv.deleteProjectSchema.parse({ confirmTitle: "a\u0000\ud800" }).confirmTitle,
    ];
    for (const s of values) {
      const rows = await pipelineDb.$queryRaw<Array<{ t: string }>>`SELECT ${s}::text AS t`;
      expect(rows[0].t).toBe(s);
    }
  });
});

describe("classifyDbError on stubbed shapes", () => {
  it("P2024 (pool timeout) and P2028 (transaction API error) → 503", () => {
    for (const code of ["P2024", "P2028"]) {
      expect(classifyDbError(known(code)).sqlstate).toBe(code);
      expect(toPipelineError(known(code))).toMatchObject({ statusCode: 503, code: "PIPELINE_BUSY" });
    }
  });

  it("P2010 carries the SQLSTATE in meta.code; P2034 maps to 40001", () => {
    expect(classifyDbError(known("P2010", { code: "40P01", message: "deadlock detected" })).sqlstate).toBe("40P01");
    expect(classifyDbError(known("P2034")).sqlstate).toBe("40001");
  });

  it("an UnknownRequestError with the SQLSTATE only in its message is classified by scanning", () => {
    const unknownErr = new Prisma.PrismaClientUnknownRequestError(
      'Error occurred during query execution:\nConnectorError(ConnectorError { kind: QueryError(PostgresError { code: "40001", message: "could not serialize access" }) })',
      { clientVersion: Prisma.prismaVersion.client },
    );
    expect(classifyDbError(unknownErr).sqlstate).toBe("40001");
    expect(classifyDbError(new Error("ERROR: canceling statement due to lock timeout")).sqlstate).toBe("55P03");
    expect(classifyDbError(new Error("ERROR: canceling statement due to statement timeout")).sqlstate).toBe("57014");
    expect(classifyDbError(new Error("deadlock detected")).sqlstate).toBe("40P01");
    expect(classifyDbError(new Error("SQLSTATE 23505 something")).sqlstate).toBe("23505");
  });

  it("connection-level failures are 503, not 500", () => {
    expect(toPipelineError(known("P1001"))).toMatchObject({ statusCode: 503, code: "PIPELINE_BUSY" });
    expect(toPipelineError(known("P1017"))).toMatchObject({ statusCode: 503 });
    const init = new Prisma.PrismaClientInitializationError("Can't reach database server", Prisma.prismaVersion.client);
    expect(toPipelineError(init)).toMatchObject({ statusCode: 503 });
    expect(toPipelineError(known("P2010", { code: "57P01" }))).toMatchObject({ statusCode: 503 });
    expect(toPipelineError(known("P2010", { code: "53300" }))).toMatchObject({ statusCode: 503 });
  });

  it("an error that is not a database error classifies to nothing", () => {
    expect(classifyDbError(new TypeError("x is undefined"))).toMatchObject({ sqlstate: null, constraint: null });
    expect(toPipelineError(new TypeError("x is undefined"))).toBeNull();
    expect(classifyDbError(undefined)).toMatchObject({ sqlstate: null });
  });
});

describe("withRetryOnce", () => {
  it("retries a deadlock or serialization failure exactly once after 50–150 ms", async () => {
    let calls = 0;
    const t0 = Date.now();
    const out = await withRetryOnce(async () => {
      calls++;
      if (calls === 1) throw known("P2010", { code: "40P01" });
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);

    calls = 0;
    const err = await withRetryOnce(async () => {
      calls++;
      throw known("P2034");
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(calls).toBe(2);
    expect(toPipelineError(err)).toMatchObject({ statusCode: 503, code: "PIPELINE_BUSY" });
  });

  it("retries a lock timeout (55P03) once too — the lock cycle a multi-row write can meet", async () => {
    // A due change locks several of each participant's rows; an ack or mark-all-read that
    // locks the same rows in another order makes ONE side wait out the 1 s lock_timeout.
    // The whole transaction rolled back, so running it again is a clean first attempt.
    for (const lost of [known("P2010", { code: "55P03" }), new Error("ERROR: canceling statement due to lock timeout")]) {
      let calls = 0;
      const out = await withRetryOnce(async () => {
        calls++;
        if (calls === 1) throw lost;
        return "ok";
      });
      expect(out).toBe("ok");
      expect(calls).toBe(2);
    }
  });

  it("never retries anything else", async () => {
    let calls = 0;
    await expect(
      withRetryOnce(async () => {
        calls++;
        throw known("P2010", { code: "23505" });
      }),
    ).rejects.toBeTruthy();
    expect(calls).toBe(1);
    // A statement timeout (57014) is not a lost race — a second try would only wait again.
    calls = 0;
    await expect(
      withRetryOnce(async () => {
        calls++;
        throw new Error("ERROR: canceling statement due to statement timeout");
      }),
    ).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });
});

describe("pipelineErrorMiddleware", () => {
  it("body-parser entity.too.large → 413 PAYLOAD_TOO_LARGE; entity.parse.failed → 400 INVALID_JSON", () => {
    const tooLarge = Object.assign(new Error("request entity too large"), { type: "entity.too.large", status: 413, statusCode: 413 });
    const badJson = Object.assign(new SyntaxError("Unexpected token } in JSON"), { type: "entity.parse.failed", status: 400, statusCode: 400, body: "{" });
    const a = runMiddleware(tooLarge);
    expect(a.res.statusCode).toBe(413);
    expect(a.body).toEqual({ success: false, error: { code: "PAYLOAD_TOO_LARGE", message: expect.any(String) } });
    const b = runMiddleware(badJson);
    expect(b.res.statusCode).toBe(400);
    expect(b.body.error.code).toBe("INVALID_JSON");
  });

  it("a ZodError → 400 VALIDATION_ERROR with details", () => {
    const zerr = z.object({ title: z.string() }).safeParse({ title: 3 });
    expect(zerr.success).toBe(false);
    const { res, body } = runMiddleware((zerr as { error: z.ZodError }).error);
    expect(res.statusCode).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toEqual([{ field: "title", message: expect.any(String) }]);
  });

  it("a MentionLimitError → 400 MENTION_LIMIT", () => {
    const { res, body } = runMiddleware(new MentionLimitError(21));
    expect(res.statusCode).toBe(400);
    expect(body.error.code).toBe("MENTION_LIMIT");
  });

  it("an AppError passes through, with retryAfterSec and current when present", () => {
    const busy = new BulkheadBusyError("PIPELINE_BUSY", "busy", 2, "wait_timeout");
    const a = runMiddleware(busy);
    expect(a.res.statusCode).toBe(503);
    expect(a.body.error).toMatchObject({ code: "PIPELINE_BUSY", retryAfterSec: 2 });
    const conflict = new PipelineError(409, "EDIT_CONFLICT", "Someone else changed this", { current: { title: "Theirs" } });
    const b = runMiddleware(conflict);
    expect(b.res.statusCode).toBe(409);
    expect(b.body.error).toMatchObject({ code: "EDIT_CONFLICT", current: { title: "Theirs" } });
    const plain = runMiddleware(new AppError(409, "PROJECT_ARCHIVED", "Archived"));
    expect(plain.body.error).toEqual({ code: "PROJECT_ARCHIVED", message: "Archived" });
  });

  it("an unknown error → 500 PIPELINE_INTERNAL, and the server message is never echoed", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { res, body } = runMiddleware(new Error("relation \"secret_table\" does not exist at /srv/app"));
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(body.error.code).toBe("PIPELINE_INTERNAL");
    expect(JSON.stringify(body)).not.toContain("secret_table");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("warnThrottled writes one line per key per 10 s and reports how many it held back", async () => {
    const { warnThrottled, resetThrottledWarnForTests } = await import("../../src/utils/throttled-warn");
    resetThrottledWarnForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t0 = 1_000_000;
    expect(warnThrottled("k", "[pipeline] 429 x", t0)).toBe(true);
    expect(warnThrottled("k", "[pipeline] 429 x", t0 + 1_000)).toBe(false);
    expect(warnThrottled("k", "[pipeline] 429 x", t0 + 9_999)).toBe(false);
    expect(warnThrottled("other", "[pipeline] 413 y", t0 + 5_000)).toBe(true); // keys are independent
    expect(warnThrottled("k", "[pipeline] 429 x", t0 + 10_000)).toBe(true);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    resetThrottledWarnForTests();
    expect(lines).toEqual([
      "[pipeline] 429 x",
      "[pipeline] 413 y",
      "[pipeline] 429 x (+2 held back since the line 10s ago)",
    ]);
  });

  it("defers to Express when the response has already started", () => {
    const res = mockRes();
    res.headersSent = true;
    const next = vi.fn();
    const err = new Error("late");
    pipelineErrorMiddleware(err, {} as Request, res as unknown as Response, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledWith(err);
  });
});
