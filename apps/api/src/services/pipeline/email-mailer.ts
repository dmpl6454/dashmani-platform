/**
 * The pipeline email worker's SMTP transport (owner request 2026-09-30).
 *
 * A DEDICATED, POOLED nodemailer transport — never email.service.ts's shared one — so a
 * burst of digests reuses ONE connection and a slow SMTP server can only ever slow the
 * worker, never a request:
 *   pool: true, maxConnections: 1   one connection, messages queued on it
 *   rateDelta/rateLimit             at most PIPELINE_EMAIL_RATE_PER_SEC messages a second
 *   connection/greeting/socket timeouts of 10–20 s (nodemailer's defaults are minutes)
 * plus a hard per-message ceiling (SEND_TIMEOUT_MS) on top. A send that hits the ceiling
 * closes the pool, so the abandoned message can never be delivered late.
 *
 * classifySendError() decides what a failure means for the worker: the transport or the
 * shared sender ACCOUNT is unusable (stop and pause — connection codes, AUTH, a 421, a
 * MAIL FROM refusal, a 4.7.x / 5.7.x / 5.4.5 status), this recipient is refused for good
 * (a 5xx at RCPT TO — no retry), or this one message failed (retry with backoff).
 *
 * Injectable for tests (setPipelineMailer). ⚠️ Under NODE_ENV=test with nothing injected it
 * REFUSES to send: vitest loads the repo-root .env, which may hold real SMTP credentials.
 */
import nodemailer from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool";
import { ipv4SmtpHost } from "../../utils/smtp-host";

export interface PipelineMail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface PipelineMailer {
  sendMail(mail: PipelineMail): Promise<unknown>;
}

/**
 * WHY sending is impossible right now, which picks the worker's cooldown:
 *   transport  the connection is broken (refused, reset, DNS, TLS, a hung send)
 *   auth       the login was refused (EAUTH, or any failure during AUTH)
 *   account    the SHARED sender account is being refused: a 421 at any stage, any refusal
 *              of MAIL FROM, or a 4.7.x / 5.7.x status (rate or policy blocks on the sender)
 *   limit      Gmail's daily sending limit (5.4.5) — nothing gets through for hours
 */
export type MailOutage = "transport" | "auth" | "account" | "limit";

/** The transport or the sender account is unusable right now: stop the tick and pause. */
export class MailTransportError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly outage: MailOutage = "transport",
    readonly responseCode?: number,
  ) {
    super(message);
    this.name = "MailTransportError";
  }
}

/**
 * The server refused THIS recipient for good (a 5xx at RCPT TO, e.g. 550 5.1.1 "no such
 * user"). Retrying cannot succeed, so the worker marks the rows 'failed' at once.
 */
export class MailPermanentError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly responseCode: number,
  ) {
    super(message);
    this.name = "MailPermanentError";
  }
}

export const SEND_TIMEOUT_MS = 30_000;

let injected: PipelineMailer | null = null;
let pooled: nodemailer.Transporter | null = null;

/** Tests only: route every send to `m` (null restores the real transport). */
export function setPipelineMailer(m: PipelineMailer | null): void {
  injected = m;
}

export function pipelineEmailFrom(): string {
  return `"Digital Sukoon Pipeline" <${process.env.SMTP_USER ?? ""}>`;
}

function ratePerSec(): number {
  const n = Number(process.env.PIPELINE_EMAIL_RATE_PER_SEC);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 2;
}

/**
 * Close and forget the pooled transport: every message still QUEUED on it is rejected
 * ("Connection pool was closed") instead of being delivered late, and the next send opens
 * a fresh pool. Used when a send hits the hard ceiling (a message the worker has given up
 * on must not arrive after the worker has already scheduled its retry).
 */
function dropPooledTransport(): void {
  const t = pooled;
  pooled = null;
  if (!t) return;
  try {
    t.close();
  } catch {
    // closing a broken pool can throw; it is discarded either way
  }
}

let pooling: Promise<nodemailer.Transporter> | null = null;

/**
 * The pooled transport, created on first use. The SMTP host is resolved to an IPv4 address
 * first (utils/smtp-host.ts): Gmail rejects this account's logins from the prod box over IPv6,
 * and nodemailer would otherwise pick IPv4 or IPv6 at random. Concurrent first sends share one
 * creation; after dropPooledTransport() the next send resolves and creates a fresh pool.
 */
function pooledTransport(): Promise<nodemailer.Transporter> {
  if (pooled) return Promise.resolve(pooled);
  if (!pooling) {
    pooling = (async () => {
      const options: SMTPPool.Options = {
        pool: true,
        maxConnections: 1,
        maxMessages: 100,
        rateDelta: 1000,
        rateLimit: ratePerSec(),
        ...(await ipv4SmtpHost(process.env.SMTP_HOST || "smtp.gmail.com")),
        port: parseInt(process.env.SMTP_PORT || "587", 10),
        secure: process.env.SMTP_SECURE === "true",
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      };
      pooled = nodemailer.createTransport(options);
      return pooled;
    })().finally(() => {
      pooling = null;
    });
  }
  return pooling;
}

function realMailer(): PipelineMailer {
  return { sendMail: async (mail) => (await pooledTransport()).sendMail(mail) };
}

function getMailer(): PipelineMailer {
  if (injected) return injected;
  if (process.env.NODE_ENV === "test") {
    throw new MailTransportError("no mailer injected under NODE_ENV=test (refusing real SMTP)", "ETESTMAILER");
  }
  return realMailer();
}

/** nodemailer codes for "the connection/auth is broken", not "this one message was refused". */
const TRANSPORT_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EAUTH", "EDNS", "ETLS", "EPROXY", "ECONNREFUSED", "ENOTFOUND"]);
/** Enhanced status codes that describe the SENDER (rate, policy, auth), not the recipient. */
const SENDER_STATUS = /\b(?:4\.7\.\d{1,3}|5\.7\.\d{1,3})\b/;
/** Gmail's "Daily user sending limit exceeded". */
const DAILY_LIMIT_STATUS = /\b5\.4\.5\b/;

/**
 * Classify a failed send (nodemailer 8 shapes: `code`, `responseCode`, `command` —
 * 'MAIL FROM', 'RCPT TO', 'DATA', 'AUTH …', 'CONN', 'API' — and `response`, the server's
 * reply line). Returns the error the worker acts on, or null for a per-message failure
 * that is retried with backoff.
 *
 * ⚠️ Account-level refusals arrive as EENVELOPE / EMESSAGE, not as connection codes —
 * e.g. "550 5.4.5 Daily user sending limit exceeded" or "421 4.7.0 Try again later" at
 * MAIL FROM. Treating those as per-message failures would keep sending (up to 30 a minute)
 * into an account that password resets and HR mail share, and burn every row's attempts.
 */
export function classifySendError(err: unknown): MailTransportError | MailPermanentError | null {
  const e = err as { code?: unknown; responseCode?: unknown; command?: unknown; response?: unknown; message?: unknown };
  const code = typeof e?.code === "string" ? e.code : undefined;
  const responseCode = typeof e?.responseCode === "number" ? e.responseCode : undefined;
  const command = typeof e?.command === "string" ? e.command : "";
  const message = typeof e?.message === "string" ? e.message : String(err);
  const reply = `${typeof e?.response === "string" ? e.response : ""} ${message}`;

  if (code && TRANSPORT_CODES.has(code)) {
    return new MailTransportError(message, code, code === "EAUTH" ? "auth" : "transport", responseCode);
  }
  if (/^AUTH\b/.test(command)) return new MailTransportError(message, code, "auth", responseCode);
  if (DAILY_LIMIT_STATUS.test(reply)) return new MailTransportError(message, code, "limit", responseCode);
  if (responseCode === 421 || command === "MAIL FROM" || SENDER_STATUS.test(reply)) {
    return new MailTransportError(message, code, "account", responseCode);
  }
  if (command === "RCPT TO" && responseCode !== undefined && responseCode >= 500 && responseCode <= 599) {
    return new MailPermanentError(message, code, responseCode);
  }
  return null;
}

/**
 * Send one message with a hard ceiling. Resolves on success; rejects with
 * MailTransportError when the transport or the sender account is unusable (the worker
 * stops the tick and pauses), MailPermanentError when this recipient is refused for good,
 * or the original error for a per-message failure.
 */
export async function sendPipelineMail(mail: PipelineMail): Promise<void> {
  const mailer = getMailer();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new MailTransportError(`send timed out after ${SEND_TIMEOUT_MS} ms`, "ETIMEDOUT", "transport"));
    }, SEND_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([mailer.sendMail(mail), timeout]);
  } catch (err) {
    // The message may still be queued on the pool: close it, so it can never go out late
    // (after the worker has already scheduled a retry — a duplicate).
    if (timedOut && mailer !== injected) dropPooledTransport();
    if (err instanceof MailTransportError || err instanceof MailPermanentError) throw err;
    throw classifySendError(err) ?? err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A short, credential-free description of a send failure for `last_error`. */
export function describeMailError(err: unknown): string {
  const e = err as { code?: unknown; responseCode?: unknown; message?: unknown };
  const parts = [typeof e?.code === "string" ? e.code : null, typeof e?.responseCode === "number" ? String(e.responseCode) : null];
  const msg = typeof e?.message === "string" ? e.message : String(err);
  return [...parts.filter(Boolean), msg].join(" ").slice(0, 500);
}
