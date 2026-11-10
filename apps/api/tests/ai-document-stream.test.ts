/**
 * /admin/ai/generate-<letter>/stream — the offer letter, appointment letter and contract,
 * streamed as server-sent events so the preview fills in as Claude writes.
 * Locks: the same permission as the non-streamed generators, unknown kinds 404, an unknown
 * employee (or no AI key) as a plain JSON error BEFORE the stream starts, the meta event first,
 * the pieces in order, and a failure part-way through reported as an `error` event.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import request from "supertest";
import "./setup";
import app from "../src/app";
import * as aiService from "../src/services/ai.service";
import { createTestRole, createTestUser, generateToken } from "./helpers";

const events = (body: string) =>
  body.split("\n\n").filter((c) => c.startsWith("data:")).map((c) => JSON.parse(c.slice(5).trim()));

describe("admin AI letters — streamed", () => {
  let auth = "";
  let employeeId = "";

  beforeEach(async () => {
    await createTestRole("Admin", [{ resource: "employees", action: "edit", scope: "global" }]);
    await createTestRole("Employee", [{ resource: "attendance", action: "view", scope: "own" }]);
    const admin = await createTestUser({ email: "hr-admin@x.test", roleNames: ["Admin"] });
    const emp = await createTestUser({ name: "Asha Rao", email: "asha@x.test", roleNames: ["Employee"] });
    employeeId = emp.id;
    auth = `Bearer ${generateToken(admin.id, admin.email, ["Admin"])}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("needs employees.edit, like the generators it streams", async () => {
    const emp = await createTestUser({ email: "plain@x.test", roleNames: ["Employee"] });
    const res = await request(app)
      .post("/v1/admin/ai/generate-offer-letter/stream")
      .set("Authorization", `Bearer ${generateToken(emp.id, emp.email, ["Employee"])}`)
      .send({ employeeId });
    expect(res.status).toBe(403);
    expect((await request(app).post("/v1/admin/ai/generate-contract/stream").send({})).status).toBe(401);
  });

  it("404s an unknown document kind", async () => {
    const res = await request(app).post("/v1/admin/ai/generate-poem/stream").set("Authorization", auth).send({});
    expect(res.status).toBe(404);
  });

  it("answers JSON before streaming for an unknown employee or no AI key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const off = await request(app).post("/v1/admin/ai/generate-contract/stream").set("Authorization", auth)
      .send({ employeeId, designation: "Editor", salary: 50000, contractDate: "2026-11-10" });
    expect(off.status).toBe(500);
    expect(off.body.error.code).toBe("AI_NOT_CONFIGURED");

    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const missing = await request(app).post("/v1/admin/ai/generate-contract/stream").set("Authorization", auth)
      .send({ employeeId: "00000000-0000-0000-0000-00000000dead", designation: "Editor", salary: 50000, contractDate: "2026-11-10" });
    expect(missing.status).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/json");
  });

  it("builds the real prompt, then streams meta, the pieces in order and done", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const real = aiService.prepareDocumentStream;
    let prompt = "";
    vi.spyOn(aiService, "prepareDocumentStream").mockImplementation(async (kind, input) => {
      const job = await real(kind, input); // the real builder: employee lookup + prompt
      expect(job.employeeName).toBe("Asha Rao");
      return {
        employeeName: job.employeeName,
        run: async (onText: (t: string) => void) => { prompt = kind; onText("<html>"); onText("<body>Dear Asha"); },
      };
    });
    const res = await request(app).post("/v1/admin/ai/generate-appointment-letter/stream").set("Authorization", auth)
      .send({ employeeId, designation: "Editor", salary: 50000, joiningDate: "2026-12-01" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    expect(events(res.text)).toEqual([
      { meta: { employeeName: "Asha Rao" } },
      { t: "<html>" },
      { t: "<body>Dear Asha" },
      { done: true },
    ]);
    expect(prompt).toBe("appointment-letter");
  });

  it("reports a failure part-way through as an error event", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(aiService, "prepareDocumentStream").mockResolvedValue({
      employeeName: "Asha Rao",
      run: async (onText: (t: string) => void) => { onText("<html>"); throw new Error("overloaded"); },
    });
    const res = await request(app).post("/v1/admin/ai/generate-offer-letter/stream").set("Authorization", auth).send({ employeeId });
    const ev = events(res.text);
    expect(ev[1]).toEqual({ t: "<html>" });
    expect(ev[2].error).toMatch(/failed while writing/);
    expect(ev.some((e) => e.done)).toBe(false);
  });
});
