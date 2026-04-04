import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import "./setup";

describe("Attendance API", () => {
  let employeeToken: string;
  let employeeId: string;
  let managerToken: string;

  beforeEach(async () => {
    await createTestRole("Employee", [
      { resource: "attendance", action: "view", scope: "own" },
      { resource: "attendance", action: "create", scope: "own" },
    ]);
    await createTestRole("Manager", [
      { resource: "attendance", action: "view", scope: "team" },
      { resource: "attendance", action: "approve", scope: "team" },
    ]);

    const employee = await createTestUser({ name: "Worker", roleNames: ["Employee"] });
    employeeId = employee.id;
    employeeToken = generateToken(employee.id, employee.email, ["Employee"]);

    const manager = await createTestUser({ name: "Manager", roleNames: ["Manager"] });
    managerToken = generateToken(manager.id, manager.email, ["Manager"]);
  });

  describe("POST /v1/attendance/check-in", () => {
    it("creates a check-in record", async () => {
      const res = await request(app)
        .post("/v1/attendance/check-in")
        .set("Authorization", `Bearer ${employeeToken}`);

      expect(res.status).toBe(201);
      expect(res.body.data.employeeId).toBe(employeeId);
      expect(res.body.data.checkIn).toBeDefined();
    });

    it("prevents double check-in", async () => {
      await request(app)
        .post("/v1/attendance/check-in")
        .set("Authorization", `Bearer ${employeeToken}`);

      const res = await request(app)
        .post("/v1/attendance/check-in")
        .set("Authorization", `Bearer ${employeeToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("ALREADY_CHECKED_IN");
    });
  });

  describe("POST /v1/attendance/check-out", () => {
    it("records check-out after check-in", async () => {
      await request(app)
        .post("/v1/attendance/check-in")
        .set("Authorization", `Bearer ${employeeToken}`);

      const res = await request(app)
        .post("/v1/attendance/check-out")
        .set("Authorization", `Bearer ${employeeToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.checkOut).toBeDefined();
    });

    it("fails without prior check-in", async () => {
      const res = await request(app)
        .post("/v1/attendance/check-out")
        .set("Authorization", `Bearer ${employeeToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("NOT_CHECKED_IN");
    });
  });

  describe("POST /v1/attendance/leave", () => {
    it("creates a leave request", async () => {
      const res = await request(app)
        .post("/v1/attendance/leave")
        .set("Authorization", `Bearer ${employeeToken}`)
        .send({
          startDate: "2026-04-10",
          endDate: "2026-04-12",
          reason: "Family function in Delhi",
          type: "CASUAL",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("PENDING");
    });
  });

  describe("PUT /v1/attendance/leave/:id/approve", () => {
    it("manager approves leave and creates attendance records", async () => {
      const { prisma } = await import("@dashmani/db");

      const leaveRes = await request(app)
        .post("/v1/attendance/leave")
        .set("Authorization", `Bearer ${employeeToken}`)
        .send({
          startDate: "2026-04-10",
          endDate: "2026-04-11",
          reason: "Personal",
          type: "CASUAL",
        });

      const res = await request(app)
        .put(`/v1/attendance/leave/${leaveRes.body.data.id}/approve`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ approved: true });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("APPROVED");

      // Verify attendance records created
      const records = await prisma.attendance.findMany({
        where: { employeeId, status: "LEAVE" },
      });
      expect(records.length).toBe(2);
    });
  });
});
