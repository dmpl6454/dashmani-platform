import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import util from "node:util";
import app from "../src/app";
import { AppError, errorHandler } from "../src/middleware/error-handler";
import { resetThrottledWarnForTests } from "../src/utils/throttled-warn";

// ⚠️ The global errorHandler must never print the text of a request. body-parser attaches the
// raw body to its parse error as an own property (`body`), and util.inspect — which is what
// console.error("…", err) runs — prints it. These tests drive REAL malformed requests through
// the real app and the real handler and read back everything the process printed.

const PAN = "ABCDE1234F";
const ACCOUNT = "123456789012";
const IFSC = "HDFC0000317";
const SECRET_PASSWORD = "correct-horse-battery-staple-9";
// A truncated or hand-built bank submission: syntactically invalid JSON, every value sensitive.
const BAD_JSON = `{"pan":"${PAN}","accountNumber":"${ACCOUNT}","ifsc":"${IFSC}","password":"${SECRET_PASSWORD}",`;

const SENSITIVE = [PAN, ACCOUNT, IFSC, SECRET_PASSWORD, "accountNumber"];

type Spy = ReturnType<typeof vi.spyOn>;
let spies: Spy[] = [];

/** Everything written to the console since the spies were installed, rendered the way a log shows it. */
function printed(): string {
  return spies
    .flatMap((s) => s.mock.calls)
    .map((args) => args.map((a: unknown) => (typeof a === "string" ? a : util.inspect(a, { depth: 5 }))).join(" "))
    .join("\n");
}

beforeEach(() => {
  resetThrottledWarnForTests();
  spies = (["error", "warn", "log", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  spies.forEach((s) => s.mockRestore());
});

describe("errorHandler: malformed JSON never reaches the log", () => {
  it("answers 400 INVALID_JSON, and nothing sensitive is printed, on real creator and staff routes", async () => {
    for (const path of ["/v1/creator/auth/login", "/v1/auth/login", "/v1/hr/auth/register", "/v1/creator/me"]) {
      const res = await request(app).post(path).set("Content-Type", "application/json").send(BAD_JSON);
      expect(res.status, path).toBe(400);
      expect(res.body.error.code, path).toBe("INVALID_JSON");
    }
    const out = printed();
    for (const s of SENSITIVE) expect(out).not.toContain(s);
    // The parse failure was not swallowed silently: a type, a status and a length are logged.
    expect(out).toContain("entity.parse.failed");
    expect(out).toContain(`${BAD_JSON.length} characters`);
  });

  it("never prints the body of a malformed JSON request on any console channel (PAN, 12-digit account, IFSC)", async () => {
    const res = await request(app).post("/v1/creator/auth/signup").set("Content-Type", "application/json").send(BAD_JSON);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(SENSITIVE.join("|")));
    const out = printed();
    expect(out).not.toMatch(/ABCDE1234F|123456789012|HDFC0000317|correct-horse/);
    expect(out).not.toContain("body:");
  });

  it("does not print a large invalid body either (the length is logged, not the text)", async () => {
    const huge = `{"note":"${"x".repeat(200_000)}${PAN}`;
    const res = await request(app).post("/v1/creator/auth/login").set("Content-Type", "application/json").send(huge);
    expect(res.status).toBe(400);
    const out = printed();
    expect(out).not.toContain(PAN);
    expect(out.length).toBeLessThan(2_000);
    expect(out).toContain(`${huge.length} characters`);
  });

  it("answers 413 PAYLOAD_TOO_LARGE for an oversized body without printing it", async () => {
    const small = express();
    small.use(express.json({ limit: "1kb" }));
    small.post("/echo", (_req, res) => res.json({ ok: true }));
    small.use(errorHandler);
    const body = JSON.stringify({ pan: PAN, accountNumber: ACCOUNT, pad: "y".repeat(5_000) });
    const res = await request(small).post("/echo").set("Content-Type", "application/json").send(body);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    const out = printed();
    for (const s of SENSITIVE) expect(out).not.toContain(s);
  });

  it("treats a SyntaxError that carries the text it failed on as a client error, without printing it", async () => {
    const small = express();
    small.post("/boom", () => {
      const err = new SyntaxError("Unexpected token } in JSON") as SyntaxError & { body: string };
      err.body = BAD_JSON;
      throw err;
    });
    small.use(errorHandler);
    const res = await request(small).post("/boom");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
    const out = printed();
    for (const s of SENSITIVE) expect(out).not.toContain(s);
  });

  it("does not print the body of any other parser failure either (verify failed, Buffer body)", async () => {
    const small = express();
    small.post("/boom", () => {
      const err = Object.assign(new Error("verify failed"), {
        status: 403,
        type: "entity.verify.failed",
        body: Buffer.from(BAD_JSON),
      });
      throw err;
    });
    small.use(errorHandler);
    const res = await request(small).post("/boom");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("BAD_REQUEST");
    for (const s of SENSITIVE) expect(printed()).not.toContain(s);
  });

  it("holds back repeated lines (one per ten seconds per kind) so a hostile client cannot flood the log", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post("/v1/creator/auth/login").set("Content-Type", "application/json").send(BAD_JSON);
    }
    const lines = printed().split("\n").filter((l) => l.includes("entity.parse.failed"));
    expect(lines).toHaveLength(1);
  });
});

describe("errorHandler: behaviour that must not change", () => {
  it("an AppError is answered as before and logs nothing", async () => {
    const small = express();
    small.get("/e", () => {
      throw new AppError(409, "CONFLICT", "nope", [{ field: "a", message: "b" }]);
    });
    small.use(errorHandler);
    const res = await request(small).get("/e");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: { code: "CONFLICT", message: "nope", details: [{ field: "a", message: "b" }] } });
    expect(printed()).toBe("");
  });

  it("an unexpected error is still a generic 500 and is still logged for the operator", async () => {
    const small = express();
    small.get("/e", () => {
      throw new Error("kaboom: a real bug");
    });
    small.use(errorHandler);
    const res = await request(small).get("/e");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(res.body.error.message).toBe("An unexpected error occurred");
    expect(printed()).toContain("kaboom: a real bug");
  });

  it("an error that merely has a `body` property but is not a parser error is still a logged 500", async () => {
    // Only parser failures are exempt from logging the error object; anything else stays visible.
    const small = express();
    small.get("/e", () => {
      throw Object.assign(new Error("db exploded"), { body: "not a parse failure" });
    });
    small.use(errorHandler);
    const res = await request(small).get("/e");
    expect(res.status).toBe(500);
    expect(printed()).toContain("db exploded");
  });
});
