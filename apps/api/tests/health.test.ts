import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../src/app";

describe("GET /v1/health", () => {
  it("returns healthy status", async () => {
    const res = await request(app).get("/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("healthy");
  });
});
