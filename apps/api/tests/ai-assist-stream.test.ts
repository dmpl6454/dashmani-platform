/**
 * /admin/ai/assist/stream — the AI chat, streamed as server-sent events.
 * Locks: the same gate as /admin/ai/assist (client and HR tokens refused), a JSON error before
 * the stream starts, each piece of text as its own `data:` event in order, and a failure
 * part-way through reported as an `error` event rather than a silent cut-off.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import "./setup";
import app from "../src/app";
import * as aiService from "../src/services/ai.service";
import { generateClientToken, generateHrToken, generateToken } from "./helpers";

const PATH = "/v1/admin/ai/assist/stream";
const staff = () => `Bearer ${generateToken("00000000-0000-0000-0000-0000000000aa", "staff@x.test")}`;
const events = (body: string) =>
  body.split("\n\n").filter((c) => c.startsWith("data:")).map((c) => JSON.parse(c.slice(5).trim()));

describe("admin AI assistant — streamed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("refuses client, HR and missing tokens", async () => {
    const send = (auth?: string) => {
      const r = request(app).post(PATH);
      return (auth ? r.set("Authorization", auth) : r).send({ task: "hi" });
    };
    expect((await send(`Bearer ${generateClientToken("00000000-0000-0000-0000-000000000001", "c@x.test")}`)).status).toBe(403);
    expect((await send(`Bearer ${generateHrToken("00000000-0000-0000-0000-000000000002", "h@x.test")}`)).status).toBe(403);
    expect((await send()).status).toBe(401);
  });

  it("answers a plain JSON error before streaming when there is no question or no AI key", async () => {
    const empty = await request(app).post(PATH).set("Authorization", staff()).send({ task: "  " });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe("VALIDATION_ERROR");

    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const off = await request(app).post(PATH).set("Authorization", staff()).send({ task: "hi" });
    expect(off.status).toBe(500);
    expect(off.body.error.code).toBe("AI_NOT_CONFIGURED");
  });

  it("streams each piece of text in order, then done", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const spy = vi.spyOn(aiService, "aiAssistStream").mockImplementation(async (_input, onText) => {
      onText("Dear ");
      onText("team,");
    });
    const res = await request(app).post(PATH).set("Authorization", staff()).send({ task: "Draft a note" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    expect(events(res.text)).toEqual([{ t: "Dear " }, { t: "team," }, { done: true }]);
    expect(spy.mock.calls[0][0]).toMatchObject({ task: "Draft a note" });
  });

  it("reports a failure part-way through as an error event", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(aiService, "aiAssistStream").mockImplementation(async (_input, onText) => {
      onText("Half an ans");
      throw new Error("overloaded");
    });
    const res = await request(app).post(PATH).set("Authorization", staff()).send({ task: "hi" });
    expect(res.status).toBe(200);
    const ev = events(res.text);
    expect(ev[0]).toEqual({ t: "Half an ans" });
    expect(ev[1].error).toMatch(/failed while answering/);
    expect(ev.some((e) => e.done)).toBe(false);
  });
});
