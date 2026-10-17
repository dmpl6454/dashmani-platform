import { Request, Response, NextFunction } from "express";
import { error } from "../utils/response";
import { warnThrottled } from "../utils/throttled-warn";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// ── Body-parser failures ─────────────────────────────────────────────────────────────
// ⚠️ NEVER log one of these errors itself. body-parser builds its parse failure as
// `createError(400, err, { body: <the raw request text>, type: "entity.parse.failed" })`, so the
// text of the request is an own enumerable property of the error, and util.inspect (which is
// what `console.error("…", err)` runs) prints it in full. A truncated or hand-built JSON body
// to a route that takes a password, a reset token, or (once creators connect a bank account) a
// PAN, an account number and an IFSC would then sit in the pm2 log, which no scrubber covers.
// Such a failure is the client's mistake: it is answered 4xx and logged as a type, a status and
// a LENGTH, never a value.
const BODY_PARSER_TYPE_RE = /^(entity|request|stream|parameters|charset|encoding)\./;

interface BodyParserFailure {
  status: number;
  type: string;
  code: string;
  message: string;
  /** Characters of the request text the parser held, or null when it held none. */
  bodyLength: number | null;
}

function bodyParserFailure(err: unknown): BodyParserFailure | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { type?: unknown; status?: unknown; statusCode?: unknown; body?: unknown };
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 400;
  const bodyLength = typeof e.body === "string" || Buffer.isBuffer(e.body) ? e.body.length : null;
  const type = typeof e.type === "string" ? e.type : null;

  if (type !== null && BODY_PARSER_TYPE_RE.test(type) && status >= 400 && status < 500) {
    if (type === "entity.too.large") {
      return { status: 413, type, code: "PAYLOAD_TOO_LARGE", message: "The request is too large", bodyLength };
    }
    if (type === "entity.parse.failed") {
      return { status: 400, type, code: "INVALID_JSON", message: "The request body is not valid JSON", bodyLength };
    }
    return { status, type, code: "BAD_REQUEST", message: "The request could not be read", bodyLength };
  }
  // A JSON.parse failure that carries the text it failed on, whoever tagged it.
  if (err instanceof SyntaxError && "body" in err) {
    return { status: 400, type: "SyntaxError", code: "INVALID_JSON", message: "The request body is not valid JSON", bodyLength };
  }
  return null;
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return error(res, err.code, err.message, err.statusCode, err.details);
  }
  const parseFailure = bodyParserFailure(err);
  if (parseFailure) {
    const length = parseFailure.bodyLength === null ? "" : `, ${parseFailure.bodyLength} characters`;
    warnThrottled(
      `body-parser:${parseFailure.status}:${parseFailure.type}`,
      `[request] ${parseFailure.status} ${parseFailure.type} (body not logged${length})`,
    );
    return error(res, parseFailure.code, parseFailure.message, parseFailure.status);
  }
  console.error("Unhandled error:", err);
  return error(res, "INTERNAL_ERROR", "An unexpected error occurred", 500);
}
