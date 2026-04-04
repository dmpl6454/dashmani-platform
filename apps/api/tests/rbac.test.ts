import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import "./setup";

describe("RBAC Middleware", () => {
  beforeEach(async () => {
    await createTestRole("Admin", [
      { resource: "roles", action: "view", scope: "global" },
      { resource: "roles", action: "create", scope: "global" },
    ]);
    await createTestRole("Employee", [
      { resource: "employees", action: "view", scope: "own" },
    ]);
  });

  it("allows access when user has required permission", async () => {
    const user = await createTestUser({ roleNames: ["Admin"] });
    const token = generateToken(user.id, user.email, ["Admin"]);

    const res = await request(app)
      .get("/v1/roles")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("denies access when user lacks required permission", async () => {
    const user = await createTestUser({ roleNames: ["Employee"] });
    const token = generateToken(user.id, user.email, ["Employee"]);

    const res = await request(app)
      .get("/v1/roles")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("denies access without authentication", async () => {
    const res = await request(app).get("/v1/roles");
    expect(res.status).toBe(401);
  });
});
