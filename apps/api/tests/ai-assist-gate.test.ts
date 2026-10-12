/**
 * /admin/ai/assist spends our AI budget. `authenticate` only checks the signature, and every
 * portal signs with the same secret — so client and HR logins must be refused explicitly.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import "./setup";
import app from "../src/app";
import { generateClientToken, generateHrToken } from "./helpers";

describe("admin AI assistant gate", () => {
  it("refuses a client-portal token", async () => {
    const res = await request(app).post("/v1/admin/ai/assist").set("Authorization", `Bearer ${generateClientToken("00000000-0000-0000-0000-000000000001", "c@x.test")}`).send({ prompt: "hi" });
    expect(res.status).toBe(403);
  });
  it("refuses an HR-portal token", async () => {
    const res = await request(app).post("/v1/admin/ai/assist").set("Authorization", `Bearer ${generateHrToken("00000000-0000-0000-0000-000000000002", "h@x.test")}`).send({ prompt: "hi" });
    expect(res.status).toBe(403);
  });
  it("refuses no token", async () => {
    expect((await request(app).post("/v1/admin/ai/assist").send({ prompt: "hi" })).status).toBe(401);
  });
});
