import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import "./setup";

describe("Roles API", () => {
  let adminToken: string;

  beforeEach(async () => {
    await createTestRole("Super Admin", [
      { resource: "roles", action: "view", scope: "global" },
      { resource: "roles", action: "create", scope: "global" },
      { resource: "roles", action: "edit", scope: "global" },
      { resource: "roles", action: "delete", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Super Admin"] });
    adminToken = generateToken(admin.id, admin.email, ["Super Admin"]);
  });

  describe("POST /v1/roles", () => {
    it("creates a new custom role", async () => {
      const res = await request(app)
        .post("/v1/roles")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          name: "Content QA",
          description: "Can approve content",
          permissions: [
            { resource: "content", action: "approve", scope: "global" },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe("Content QA");
      expect(res.body.data.permissions).toHaveLength(1);
    });
  });

  describe("GET /v1/roles", () => {
    it("lists all roles", async () => {
      const res = await request(app)
        .get("/v1/roles")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
    });
  });

  describe("DELETE /v1/roles/:id", () => {
    it("deletes a non-system role", async () => {
      const role = await createTestRole("Temp Role", []);

      const res = await request(app)
        .delete(`/v1/roles/${role.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
    });
  });
});
