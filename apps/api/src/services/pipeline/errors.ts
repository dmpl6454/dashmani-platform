/**
 * Pipeline error classification and the router-local error middleware (spec §3.3).
 *
 * WHY. The global errorHandler maps only AppError; everything else — P2024, P2002,
 * P2025, P2028, body-parser errors and raw-query errors — becomes 500 "An unexpected
 * error occurred", which the pipeline client must never show and which says nothing
 * about whether a retry is safe. Most pipeline hot paths are raw SQL, and Prisma 5.22
 * reports a failed raw statement as P2010 (SQLSTATE in meta.code) or as
 * PrismaClientUnknownRequestError (SQLSTATE only in the message). classifyDbError reads
 * all three shapes, and toPipelineError maps them:
 *
 *   ZodError                                   → 400 VALIDATION_ERROR (+ details)
 *   body-parser                                → 413 PAYLOAD_TOO_LARGE / 400 INVALID_JSON
 *   MentionLimitError                          → 400 MENTION_LIMIT
 *   23505                                      → 409 CONFLICT (services replay idempotency
 *                                                keys BEFORE this, by constraint name)
 *   P2025                                      → 404 <MODEL>_NOT_FOUND
 *   P2003 / 23503                              → 404 PHASE_ / PROJECT_ / MESSAGE_ / USER_NOT_FOUND
 *   40P01, 40001 (after withRetryOnce), P2024, P2028, 57014, 55P03, connection loss,
 *   server shutdown or out of resources        → 503 PIPELINE_BUSY + retryAfterSec
 *   anything else                              → 500 PIPELINE_INTERNAL, logged with the
 *                                                route; the server message is never echoed
 */
import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { MentionLimitError } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { Prisma } from "./db";

/** How long a client should wait before retrying a 503 from the pipeline. */
export const PIPELINE_RETRY_AFTER_SEC = 2;

/** An AppError that can also carry retryAfterSec and a `current` payload (409 conflicts). */
export class PipelineError extends AppError {
  readonly retryAfterSec?: number;
  readonly current?: unknown;
  constructor(
    statusCode: number,
    code: string,
    message: string,
    extra: { retryAfterSec?: number; current?: unknown; details?: Array<{ field: string; message: string }> } = {},
  ) {
    super(statusCode, code, message, extra.details);
    this.name = "PipelineError";
    if (extra.retryAfterSec !== undefined) this.retryAfterSec = extra.retryAfterSec;
    if (extra.current !== undefined) this.current = extra.current;
  }
}

export interface DbErrorInfo {
  /**
   * The Postgres SQLSTATE (e.g. "23505"), or the Prisma code where no SQLSTATE applies
   * (P2025, P2003, P2024, P2028, P1xxx). null for anything that is not a database error.
   */
  sqlstate: string | null;
  /** Constraint name, when the database reported one (raw statements). */
  constraint: string | null;
  /** Fields of a unique/FK violation reported by the ORM (P2002 / P2003 meta). */
  fields: string[] | null;
  /** Prisma model name (P2025 / P2003 meta). */
  modelName: string | null;
}

/** A classified database error, thrown by pipelineRead / pipelineWrite. */
export class PipelineDbError extends PipelineError {
  constructor(
    statusCode: number,
    code: string,
    message: string,
    readonly info: DbErrorInfo,
    readonly original: unknown,
    extra: { retryAfterSec?: number } = {},
  ) {
    super(statusCode, code, message, extra);
    this.name = "PipelineDbError";
  }
}

const ORM_CODE_MAP: Record<string, string> = {
  P2002: "23505",
  P2034: "40001",
};
const ORM_KEEP = new Set(["P2025", "P2003", "P2024", "P2028"]);

/** Longest prefix of an error message we scan (Prisma messages are bounded; this is belt and braces). */
const SCAN_LIMIT = 4000;

interface MaybePrismaError {
  code?: unknown;
  meta?: { code?: unknown; message?: unknown; target?: unknown; field_name?: unknown; modelName?: unknown };
  message?: unknown;
  errorCode?: unknown;
}

function scanMessage(message: string): string | null {
  const m = message.slice(0, SCAN_LIMIT);
  const sqlstate = /SQLSTATE (\w{5})/.exec(m) ?? /code: "(\w{5})"/.exec(m);
  if (sqlstate) return sqlstate[1];
  if (m.includes("canceling statement due to statement timeout")) return "57014";
  if (m.includes("canceling statement due to lock timeout")) return "55P03";
  if (m.includes("deadlock detected")) return "40P01";
  return null;
}

function constraintFrom(text: string): string | null {
  const m = /constraint "([^"]{1,128})"/.exec(text.slice(0, SCAN_LIMIT));
  return m ? m[1] : null;
}

/**
 * Column list of a unique / FK violation from the Postgres DETAIL line, e.g.
 * `Key (author_id, client_id)=(…) already exists.` → ["author_id", "client_id"].
 * ⚠️ Prisma 5.22 puts ONLY this DETAIL in a raw P2010's meta.message — the constraint
 * name is not reported — so raw-SQL callers identify the violated key by its columns.
 */
function keyColumnsFrom(text: string): string[] | null {
  const m = /Key \(([^)]{1,200})\)=/.exec(text.slice(0, SCAN_LIMIT));
  if (!m) return null;
  const cols = m[1].split(",").map((c) => c.trim().replace(/^"|"$/g, "")).filter(Boolean);
  return cols.length ? cols : null;
}

/** Derive {sqlstate, constraint} from any error Prisma, pg or the pipeline can throw. */
export function classifyDbError(err: unknown): DbErrorInfo {
  const none: DbErrorInfo = { sqlstate: null, constraint: null, fields: null, modelName: null };
  if (!err || typeof err !== "object") return none;
  if (err instanceof PipelineDbError) return err.info;

  const e = err as MaybePrismaError;
  const code = typeof e.code === "string" ? e.code : null;
  const meta = e.meta && typeof e.meta === "object" ? e.meta : undefined;
  const message = typeof e.message === "string" ? e.message : "";
  const metaMessage = typeof meta?.message === "string" ? meta.message : "";

  let sqlstate: string | null = null;
  if (code === "P2010" && typeof meta?.code === "string") sqlstate = meta.code;
  else if (code && ORM_CODE_MAP[code]) sqlstate = ORM_CODE_MAP[code];
  else if (code && (ORM_KEEP.has(code) || /^P1\d{3}$/.test(code))) sqlstate = code;
  if (!sqlstate && err instanceof Prisma.PrismaClientInitializationError) {
    sqlstate = typeof e.errorCode === "string" && e.errorCode ? e.errorCode : "P1001";
  }
  if (!sqlstate) sqlstate = scanMessage(metaMessage) ?? scanMessage(message);
  if (!sqlstate) return none;

  const target = meta?.target;
  let fields = Array.isArray(target) ? target.filter((t): t is string => typeof t === "string") : null;
  if (!fields || fields.length === 0) fields = keyColumnsFrom(metaMessage) ?? keyColumnsFrom(message);
  let constraint: string | null = typeof target === "string" ? target : null;
  if (!constraint && typeof meta?.field_name === "string") {
    // P2003: "pipeline_projects_phase_id_fkey (index)"
    constraint = meta.field_name.split(" ")[0] || null;
  }
  if (!constraint) constraint = constraintFrom(metaMessage) ?? constraintFrom(message);
  const modelName = typeof meta?.modelName === "string" ? meta.modelName : null;
  return { sqlstate, constraint, fields: fields && fields.length ? fields : null, modelName };
}

/** The unique keys that are create/send idempotency keys (spec §3.3, §6). */
const IDEMPOTENCY_KEYS: Array<{ constraint: string; fields: string[][] }> = [
  {
    constraint: "pipeline_messages_author_id_client_id_key",
    fields: [["author_id", "client_id"], ["authorId", "clientId"]],
  },
  {
    constraint: "pipeline_projects_created_by_id_client_id_key",
    fields: [["created_by_id", "client_id"], ["createdById", "clientId"]],
  },
];

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * True when a 23505 is a replayed create/send key — `(author_id, client_id)` or
 * `(created_by_id, client_id)` — which the service must answer by re-reading the row by
 * that key (same project → 200 replayed; other project → 409 IDEMPOTENCY_KEY_REUSED),
 * never as a generic 409 CONFLICT. Matches by constraint name or by key columns.
 */
export function isIdempotencyKeyViolation(info: DbErrorInfo): boolean {
  if (info.sqlstate !== "23505") return false;
  return IDEMPOTENCY_KEYS.some(
    (k) => info.constraint === k.constraint || (info.fields !== null && k.fields.some((f) => sameSet(f, info.fields!))),
  );
}

/** SQLSTATEs / Prisma codes that mean "the database is saturated or briefly unavailable". */
function isBusy(sqlstate: string): boolean {
  if (sqlstate === "40P01" || sqlstate === "40001") return true; // after the one retry
  if (sqlstate === "57014" || sqlstate === "55P03") return true; // statement / lock timeout
  if (sqlstate === "P2024" || sqlstate === "P2028") return true; // pool timeout, tx API
  if (/^P1\d{3}$/.test(sqlstate)) return true; // cannot reach / connection closed
  if (sqlstate.startsWith("08")) return true; // connection exception
  if (sqlstate.startsWith("53")) return true; // insufficient resources (too many connections…)
  if (sqlstate === "57P01" || sqlstate === "57P02" || sqlstate === "57P03") return true; // shutdown / starting
  return false;
}

const NOT_FOUND_BY_MODEL: Record<string, string> = {
  PipelineProject: "PROJECT_NOT_FOUND",
  PipelineMessage: "MESSAGE_NOT_FOUND",
  PipelinePhase: "PHASE_NOT_FOUND",
  PipelineParticipant: "USER_NOT_FOUND",
  User: "USER_NOT_FOUND",
};

function fkNotFoundCode(info: DbErrorInfo): string {
  const c = `${info.constraint ?? ""} ${(info.fields ?? []).join(" ")}`;
  if (c.includes("phase_id") || c.includes("phaseId")) return "PHASE_NOT_FOUND";
  if (c.includes("parent_id") || c.includes("parentId")) return "MESSAGE_NOT_FOUND";
  if (c.includes("project_id") || c.includes("projectId")) return "PROJECT_NOT_FOUND";
  return "USER_NOT_FOUND";
}

const BUSY_MESSAGE = "The pipeline is busy — retrying shortly";

/** Map a DB error to its HTTP meaning; null when it is not one we recognise. */
function dbToPipelineError(err: unknown, info: DbErrorInfo): PipelineDbError | null {
  const s = info.sqlstate;
  if (!s) return null;
  if (isBusy(s)) {
    return new PipelineDbError(503, "PIPELINE_BUSY", BUSY_MESSAGE, info, err, {
      retryAfterSec: PIPELINE_RETRY_AFTER_SEC,
    });
  }
  if (s === "23505") return new PipelineDbError(409, "CONFLICT", "That was changed at the same time — please retry", info, err);
  if (s === "P2025") {
    const code = (info.modelName && NOT_FOUND_BY_MODEL[info.modelName]) || "NOT_FOUND";
    return new PipelineDbError(404, code, "Not found", info, err);
  }
  if (s === "P2003" || s === "23503") return new PipelineDbError(404, fkNotFoundCode(info), "Not found", info, err);
  return null;
}

interface BodyParserError {
  type?: unknown;
  status?: unknown;
  statusCode?: unknown;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  if (!err || typeof err !== "object") return false;
  const e = err as BodyParserError;
  const status = typeof e.status === "number" ? e.status : e.statusCode;
  return typeof e.type === "string" && typeof status === "number" && status >= 400 && status < 500;
}

/**
 * The AppError a pipeline response should carry for `err`, or null when `err` is
 * unexpected (the middleware then answers 500 PIPELINE_INTERNAL and logs it).
 */
export function toPipelineError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (err instanceof MentionLimitError) return new PipelineError(400, "MENTION_LIMIT", err.message);
  if (err instanceof ZodError) {
    const details = err.errors.map((i) => ({ field: i.path.join("."), message: i.message }));
    return new PipelineError(400, "VALIDATION_ERROR", "Invalid request data", { details });
  }
  if (isBodyParserError(err)) {
    if (err.type === "entity.too.large") return new PipelineError(413, "PAYLOAD_TOO_LARGE", "The request is too large");
    return new PipelineError(400, "INVALID_JSON", "The request body is not valid JSON");
  }
  return dbToPipelineError(err, classifyDbError(err));
}

/**
 * For the wrappers: a recognised error becomes its AppError (so a handler, a middleware
 * or the global handler all answer correctly); anything else is returned unchanged so a
 * real bug keeps its stack and is logged as a 500.
 */
export function normalizePipelineError(err: unknown): unknown {
  return toPipelineError(err) ?? err;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn`; on a deadlock (40P01) or serialization failure (40001) wait 50–150 ms and run
 * it ONE more time. Only for operations that are safe to repeat. A second failure is
 * thrown as is (it maps to 503).
 */
export async function withRetryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const { sqlstate } = classifyDbError(err);
    if (sqlstate !== "40P01" && sqlstate !== "40001") throw err;
    await sleep(50 + Math.floor(Math.random() * 101));
    return fn();
  }
}

// ── Logging ──────────────────────────────────────────────────────────────────────────
// 503s are expected under load and must not flood the log (morgan already logs every
// request), so each (code, sqlstate) pair is logged at most once per 10 s.
const BUSY_LOG_EVERY_MS = 10_000;
const lastBusyLog = new Map<string, number>();

function logBusy(err: AppError): void {
  const sqlstate = err instanceof PipelineDbError ? err.info.sqlstate : null;
  const key = `${err.code}:${sqlstate ?? "-"}`;
  const now = Date.now();
  const last = lastBusyLog.get(key) ?? 0;
  if (now - last < BUSY_LOG_EVERY_MS) return;
  lastBusyLog.set(key, now);
  if (lastBusyLog.size > 100) lastBusyLog.clear();
  console.warn(`[pipeline] ${err.statusCode} ${err.code}${sqlstate ? ` (${sqlstate})` : ""}`);
}

function routeLabel(req: Request): string {
  const routePath = (req as Request & { route?: { path?: unknown } }).route?.path;
  const path = typeof routePath === "string" ? routePath : req.path;
  return `${req.method} ${req.baseUrl ?? ""}${path ?? ""}`;
}

/**
 * Terminal error middleware for pipeline paths. Mounted at app level right after the
 * pipeline body parser (so 413 / malformed JSON are answered in JSON) and at the end of
 * the pipeline router (so nothing a pipeline route throws reaches the global 500).
 */
export function pipelineErrorMiddleware(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  const mapped = toPipelineError(err);
  if (!mapped) {
    console.error(`[pipeline] 500 ${routeLabel(req)}:`, err);
    res.status(500).json({
      success: false,
      error: { code: "PIPELINE_INTERNAL", message: "Something went wrong on our side — please try again" },
    });
    return;
  }
  if (mapped.statusCode >= 500) logBusy(mapped);
  const extra = mapped as AppError & { retryAfterSec?: unknown; current?: unknown };
  const body: Record<string, unknown> = { code: mapped.code, message: mapped.message };
  if (mapped.details) body.details = mapped.details;
  if (typeof extra.retryAfterSec === "number") {
    body.retryAfterSec = extra.retryAfterSec;
    res.setHeader("Retry-After", String(extra.retryAfterSec));
  }
  if (extra.current !== undefined) body.current = extra.current;
  res.status(mapped.statusCode).json({ success: false, error: body });
}
