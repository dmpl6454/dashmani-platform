/**
 * pipeline/email-mailer.test.ts — services/pipeline/email-mailer.ts without a network:
 * what each nodemailer 8 failure shape means for the worker (classifySendError), the
 * cooldown each outage gets, and the rule that a send hitting the hard ceiling closes the
 * pooled transport so the abandoned message can never be delivered late.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  transports: [] as Array<{ sendMail: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  next: null as null | ((mail: unknown) => Promise<unknown>),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => {
      const t = {
        sendMail: vi.fn((mail: unknown) => (h.next ? h.next(mail) : new Promise(() => {}))),
        close: vi.fn(),
      };
      h.transports.push(t);
      return t;
    }),
  },
}));

import {
  classifySendError,
  sendPipelineMail,
  MailTransportError,
  MailPermanentError,
  SEND_TIMEOUT_MS,
} from "../../src/services/pipeline/email-mailer";
import { cooldownMs, TRANSPORT_COOLDOWN_MS, AUTH_COOLDOWN_MS, ACCOUNT_COOLDOWN_MS, DAILY_LIMIT_COOLDOWN_MS } from "../../src/cron/pipeline-email.cron";

/** The shape nodemailer's smtp-connection _formatError produces. */
const nm = (code: string, command: string, response: string, message = "failed") =>
  Object.assign(new Error(`${message}: ${response}`), { code, command, response, responseCode: Number(response.slice(0, 3)) });

describe("pipeline email — mailer", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    h.next = null;
  });

  it("classifies every failure shape: transport, auth, account, daily limit, permanent recipient, or per-message", () => {
    const outage = (e: unknown) => {
      const c = classifySendError(e);
      if (c instanceof MailTransportError) return c.outage;
      if (c instanceof MailPermanentError) return "permanent";
      return null;
    };
    const cases: Array<[unknown, string | null]> = [
      [Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" }), "transport"],
      [Object.assign(new Error("Greeting never received"), { code: "ETIMEDOUT" }), "transport"],
      [nm("EAUTH", "AUTH PLAIN", "535-5.7.8 Username and Password not accepted"), "auth"],
      [nm("EPROTOCOL", "AUTH LOGIN", "454 4.7.0 Too many login attempts"), "auth"],
      [nm("EENVELOPE", "MAIL FROM", "550 5.4.5 Daily user sending limit exceeded."), "limit"],
      [nm("EMESSAGE", "DATA", "550 5.4.5 Daily user sending limit exceeded."), "limit"],
      [nm("EENVELOPE", "MAIL FROM", "421 4.7.0 Try again later, closing connection."), "account"],
      [nm("EENVELOPE", "MAIL FROM", "553 5.1.8 Sender address rejected"), "account"],
      [nm("EMESSAGE", "DATA", "421 4.7.28 unusual rate of unsolicited mail"), "account"],
      [nm("EMESSAGE", "DATA", "550 5.7.1 Message rejected due to policy"), "account"],
      [nm("EENVELOPE", "RCPT TO", "550 5.1.1 The email account that you tried to reach does not exist."), "permanent"],
      [nm("EENVELOPE", "RCPT TO", "553 5.1.3 Invalid address"), "permanent"],
      [nm("EENVELOPE", "RCPT TO", "450 4.2.1 The user is receiving mail at a rate that prevents additional messages"), null],
      [nm("EMESSAGE", "DATA", "552 5.3.4 Message size exceeds fixed limit"), null],
      [Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 }), null],
      [new Error("temporary failure"), null],
    ];
    for (const [err, want] of cases) expect([String((err as Error).message), outage(err)]).toEqual([String((err as Error).message), want]);
  });

  it("gives each outage its own pause: the daily limit longest", () => {
    expect(cooldownMs("transport")).toBe(TRANSPORT_COOLDOWN_MS);
    expect(cooldownMs("auth")).toBe(AUTH_COOLDOWN_MS);
    expect(cooldownMs("account")).toBe(ACCOUNT_COOLDOWN_MS);
    expect(cooldownMs("limit")).toBe(DAILY_LIMIT_COOLDOWN_MS);
    expect(DAILY_LIMIT_COOLDOWN_MS).toBeGreaterThanOrEqual(60 * 60_000);
  });

  it("a send that hits the hard ceiling closes the pool (queued mail is rejected, not delivered late) and the next send opens a fresh one", async () => {
    vi.stubEnv("NODE_ENV", "development"); // the real (mocked) transport, not the test refusal
    vi.stubEnv("SMTP_USER", "pipeline-test@example.test");
    vi.stubEnv("SMTP_PASS", "not-a-real-password");
    vi.useFakeTimers();
    const mail = { from: "a@example.test", to: "b@example.test", subject: "s", html: "<p>h</p>", text: "t" };

    const p = sendPipelineMail(mail);
    const outcome = expect(p).rejects.toMatchObject({ name: "MailTransportError", code: "ETIMEDOUT", outage: "transport" });
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1);
    await outcome;
    expect(h.transports).toHaveLength(1);
    expect(h.transports[0].close).toHaveBeenCalledTimes(1);

    h.next = async () => ({ messageId: "<ok@test>" });
    await sendPipelineMail(mail);
    expect(h.transports).toHaveLength(2); // a fresh pool
    expect(h.transports[1].close).not.toHaveBeenCalled();

    // A failure that is not a timeout leaves the pool alone.
    h.next = async () => {
      throw nm("EENVELOPE", "RCPT TO", "550 5.1.1 no such user");
    };
    await expect(sendPipelineMail(mail)).rejects.toBeInstanceOf(MailPermanentError);
    expect(h.transports).toHaveLength(2);
    expect(h.transports[1].close).not.toHaveBeenCalled();
  });
});
