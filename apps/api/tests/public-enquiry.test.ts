import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const sendEmail = vi.fn();
vi.mock("../src/services/email.service", async (orig) => ({
  ...(await orig<typeof import("../src/services/email.service")>()),
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

import app from "../src/app";

const valid = {
  intent: "Film / OTT",
  campaignName: "Monsoon <b>launch</b>",
  company: "Acme Films",
  budget: "₹10L – ₹50L",
  launchDate: "2026-11-01",
  email: "  Name@Company.com ",
};

describe("POST /v1/public/enquiries", () => {
  beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue({ messageId: "x" });
  });

  it("emails the enquiry to the sales inbox with Reply-To set to the enquirer", async () => {
    const res = await request(app).post("/v1/public/enquiries").send(valid);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { received: true } });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe("hello@digitalsukoon.com");
    expect(mail.replyTo).toBe("name@company.com");
    expect(mail.subject).toBe("[Website] Film / OTT enquiry · Acme Films");
    expect(mail.html).toContain("Monsoon launch");
    expect(mail.html).not.toContain("<b>launch");
  });

  it("requires a valid email", async () => {
    const missing = await request(app).post("/v1/public/enquiries").send({ ...valid, email: "" });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details[0]).toMatchObject({ field: "email", message: "Email is required" });
    const bad = await request(app).post("/v1/public/enquiries").send({ ...valid, email: "not-an-email" });
    expect(bad.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects an unknown intent or budget", async () => {
    expect((await request(app).post("/v1/public/enquiries").send({ ...valid, intent: "Spam" })).status).toBe(400);
    expect((await request(app).post("/v1/public/enquiries").send({ ...valid, budget: "₹1" })).status).toBe(400);
  });

  it("drops honeypot submissions without sending", async () => {
    const res = await request(app).post("/v1/public/enquiries").send({ ...valid, email: "bot@spam.com", website: "http://spam" });
    expect(res.status).toBe(201);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("answers 503 when the email cannot be sent", async () => {
    sendEmail.mockResolvedValue(null);
    const res = await request(app).post("/v1/public/enquiries").send({ ...valid, email: "other@company.com" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ENQUIRY_NOT_SENT");
  });

  it("allows a CORS preflight from the marketing site", async () => {
    const res = await request(app)
      .options("/v1/public/enquiries")
      .set("Origin", "https://digitalsukoon.com")
      .set("Access-Control-Request-Method", "POST");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://digitalsukoon.com");
  });
});
