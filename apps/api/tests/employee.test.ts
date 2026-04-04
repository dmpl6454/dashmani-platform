import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import "./setup";

describe("Employees API", () => {
  let adminToken: string;

  beforeEach(async () => {
    await createTestRole("Admin", [
      { resource: "employees", action: "view", scope: "global" },
      { resource: "employees", action: "create", scope: "global" },
      { resource: "employees", action: "edit", scope: "global" },
      { resource: "employees", action: "delete", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);
  });

  describe("POST /v1/employees", () => {
    it("creates a new employee", async () => {
      const { prisma } = await import("@dashmani/db");
      const role = await prisma.role.findFirst({ where: { name: "Admin" } });

      const res = await request(app)
        .post("/v1/employees")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          name: "New Employee",
          email: "new@digitalsukoon.com",
          password: "NewPass123!",
          phone: "+919876543210",
          roleIds: [role!.id],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe("New Employee");
      expect(res.body.data.email).toBe("new@digitalsukoon.com");
    });

    it("returns 409 for duplicate email", async () => {
      const { prisma } = await import("@dashmani/db");
      const role = await prisma.role.findFirst({ where: { name: "Admin" } });

      await createTestUser({ email: "dup@test.com" });

      const res = await request(app)
        .post("/v1/employees")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          name: "Duplicate",
          email: "dup@test.com",
          password: "TestPass123!",
          roleIds: [role!.id],
        });

      expect(res.status).toBe(409);
    });
  });

  describe("GET /v1/employees", () => {
    it("lists employees with pagination", async () => {
      await createTestUser({ name: "Alice" });
      await createTestUser({ name: "Bob" });

      const res = await request(app)
        .get("/v1/employees?limit=10")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    });

    it("filters by search query", async () => {
      await createTestUser({ name: "Rahul Sharma", email: "rahul@test.com" });
      await createTestUser({ name: "Priya Patel", email: "priya@test.com" });

      const res = await request(app)
        .get("/v1/employees?search=rahul")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.some((e: any) => e.name === "Rahul Sharma")).toBe(true);
    });
  });

  describe("DELETE /v1/employees/:id", () => {
    it("soft deletes an employee", async () => {
      const emp = await createTestUser({ name: "ToDelete" });

      const res = await request(app)
        .delete(`/v1/employees/${emp.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);

      const getRes = await request(app)
        .get(`/v1/employees/${emp.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(getRes.status).toBe(404);
    });
  });
});
