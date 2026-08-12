import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import { prisma } from "@dashmani/db";
import "./setup";

describe("Accounts API", () => {
  let adminToken: string;
  let adminId: string;
  let platformId: string;

  beforeEach(async () => {
    await createTestRole("Admin", [
      { resource: "accounts", action: "view", scope: "global" },
      { resource: "accounts", action: "create", scope: "global" },
      { resource: "accounts", action: "edit", scope: "global" },
      { resource: "accounts", action: "delete", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminId = admin.id;
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);

    const platform = await prisma.platform.create({
      data: { name: "Instagram", slug: "instagram" },
    });
    platformId = platform.id;
  });

  describe("GET /v1/platforms", () => {
    it("lists all platforms", async () => {
      const res = await request(app)
        .get("/v1/platforms")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].slug).toBe("instagram");
    });
  });

  describe("POST /v1/accounts", () => {
    it("creates a social account", async () => {
      const res = await request(app)
        .post("/v1/accounts")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          handle: "@digitalsukoon",
          displayName: "Digital Sukoon",
          platformId,
          clientName: "Digital Sukoon",
        });

      expect(res.status).toBe(201);
      // sanitizeAccountHandle strips the leading "@" at the write boundary (the
      // 2026-06-27 "@@ handle" fix) — the stored/returned handle is bare.
      expect(res.body.data.handle).toBe("digitalsukoon");
      expect(res.body.data.platform.slug).toBe("instagram");
    });

    it("prevents duplicate handle on same platform", async () => {
      await request(app)
        .post("/v1/accounts")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ handle: "@dup", displayName: "Dup", platformId });

      const res = await request(app)
        .post("/v1/accounts")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ handle: "@dup", displayName: "Dup 2", platformId });

      expect(res.status).toBe(409);
    });
  });

  describe("POST /v1/accounts/:id/assign", () => {
    it("assigns an employee to an account", async () => {
      const account = await prisma.socialAccount.create({
        data: { handle: "@test", displayName: "Test", platformId },
      });
      const employee = await createTestUser({ name: "Social Manager" });

      const res = await request(app)
        .post(`/v1/accounts/${account.id}/assign`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ employeeId: employee.id, reason: "Primary handler" });

      expect(res.status).toBe(201);
      expect(res.body.data.employee.id).toBe(employee.id);
    });

    it("prevents duplicate active assignment", async () => {
      const account = await prisma.socialAccount.create({
        data: { handle: "@dup-assign", displayName: "Dup Assign", platformId },
      });
      const employee = await createTestUser({ name: "Already Assigned" });

      await request(app)
        .post(`/v1/accounts/${account.id}/assign`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ employeeId: employee.id });

      const res = await request(app)
        .post(`/v1/accounts/${account.id}/assign`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ employeeId: employee.id });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("ALREADY_ASSIGNED");
    });
  });

  describe("DELETE /v1/accounts/:id/assign/:employeeId", () => {
    it("unassigns an employee", async () => {
      const account = await prisma.socialAccount.create({
        data: { handle: "@unassign", displayName: "Unassign", platformId },
      });
      const employee = await createTestUser({ name: "To Unassign" });

      await request(app)
        .post(`/v1/accounts/${account.id}/assign`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ employeeId: employee.id });

      const res = await request(app)
        .delete(`/v1/accounts/${account.id}/assign/${employee.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
    });
  });

  describe("GET /v1/workload", () => {
    it("returns workload matrix with account and task counts", async () => {
      const res = await request(app)
        .get("/v1/workload")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.some((e: any) => e.id === adminId)).toBe(true);
    });
  });
});
