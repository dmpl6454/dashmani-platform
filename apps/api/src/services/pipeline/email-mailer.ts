/**
 * The pipeline email worker's SMTP transport (owner request 2026-09-30).
 *
 * A DEDICATED, POOLED nodemailer transport — never email.service.ts's shared one — so a
 * burst of digests reuses ONE connection and a slow SMTP server can only ever slow the
 * worker, never a request:
 *   pool: true, maxConnections: 1   one connection, messages queued on it
 *   rateDelta/rateLimit             at most PIPELINE_EMAIL_RATE_PER_SEC messages a second
 *   connection/greeting/socket timeouts of 10–20 s (nodemailer's defaults are minutes)
 * plus a hard per-message ceiling (SEND_TIMEOUT_MS) on top.
 *
 * Injectable for tests (setPipelineMailer). ⚠️ Under NODE_ENV=test with nothing injected it
 * REFUSES to send: vitest loads the repo-root .env, which may hold real SMTP credentials.
 */
import nodemailer from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool";

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

/** An error that means the transport itself is unusable right now (stop this tick). */
export class MailTransportError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "MailTransportError";
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

function realMailer(): PipelineMailer {
  if (!pooled) {
    const options: SMTPPool.Options = {
      pool: true,
      maxConnections: 1,
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: ratePerSec(),
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587", 10),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    };
    pooled = nodemailer.createTransport(options);
  }
  const t = pooled;
  return { sendMail: (mail) => t.sendMail(mail) };
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

/**
 * Send one message with a hard ceiling. Resolves on success; rejects with
 * MailTransportError when the transport is unusable (the worker stops the tick), or with
 * the original error for a per-message failure.
 */
export async function sendPipelineMail(mail: PipelineMail): Promise<void> {
  const mailer = getMailer();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MailTransportError(`send timed out after ${SEND_TIMEOUT_MS} ms`, "ETIMEDOUT")), SEND_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([mailer.sendMail(mail), timeout]);
  } catch (err) {
    if (err instanceof MailTransportError) throw err;
    const code = (err as { code?: unknown })?.code;
    if (typeof code === "string" && TRANSPORT_CODES.has(code)) {
      throw new MailTransportError(String((err as Error)?.message ?? err), code);
    }
    throw err;
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
