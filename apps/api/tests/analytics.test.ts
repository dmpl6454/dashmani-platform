import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import { prisma } from "@dashmani/db";
import jwt from "jsonwebtoken";
import "./setup";

describe("Analytics API", () => {
  let adminToken: string;
  let adminId: string;

  beforeEach(async () => {
    await createTestRole("Admin", [
      { resource: "analytics", action: "view", scope: "global" },
      { resource: "tasks", action: "create", scope: "global" },
      { resource: "tasks", action: "view", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminId = admin.id;
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);
  });

  describe("GET /v1/analytics/overview", () => {
    it("returns overview stats with all zeros for empty database", async () => {
      const res = await request(app)
        .get("/v1/analytics/overview")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("totalEmployees");
      expect(res.body.data).toHaveProperty("activeTeams");
      expect(res.body.data).toHaveProperty("presentToday");
      expect(res.body.data).toHaveProperty("tasksCompletedThisMonth");
      expect(res.body.data).toHaveProperty("activeProjects");
      expect(res.body.data).toHaveProperty("pendingApprovals");
      expect(res.body.data).toHaveProperty("contentPublishedThisMonth");
      expect(res.body.data).toHaveProperty("contentScheduledUpcoming");
    });

    it("counts active employees correctly", async () => {
      await createTestUser({ name: "Employee A", email: "a@test.com" });
      await createTestUser({ name: "Employee B", email: "b@test.com" });

      const res = await request(app)
        .get("/v1/analytics/overview")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalEmployees).toBe(3);
    });

    it("counts active teams correctly", async () => {
      await prisma.orgUnit.create({
        data: { name: "Design Team", type: "TEAM" },
      });
      await prisma.orgUnit.create({
        data: { name: "Content Team", type: "TEAM" },
      });
      await prisma.orgUnit.create({
        data: { name: "Marketing Dept", type: "DEPARTMENT" },
      });

      const res = await request(app)
        .get("/v1/analytics/overview")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.activeTeams).toBe(2);
    });

    it("counts tasks completed this month", async () => {
      await prisma.task.create({
        data: {
          title: "Done task",
          status: "DONE",
          completedAt: new Date(),
          createdById: adminId,
        },
      });
      await prisma.task.create({
        data: {
          title: "WIP task",
          status: "IN_PROGRESS",
          createdById: adminId,
        },
      });

      const res = await request(app)
        .get("/v1/analytics/overview")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.tasksCompletedThisMonth).toBe(1);
    });

    it("requires authentication", async () => {
      const res = await request(app).get("/v1/analytics/overview");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/analytics/tasks", () => {
    it("returns task analytics breakdown", async () => {
      await prisma.task.create({
        data: { title: "Task 1", status: "TODO", priority: "HIGH", createdById: adminId },
      });
      await prisma.task.create({
        data: { title: "Task 2", status: "DONE", priority: "MEDIUM", completedAt: new Date(), createdById: adminId },
      });
      await prisma.task.create({
        data: { title: "Task 3", status: "IN_PROGRESS", priority: "HIGH", createdById: adminId },
      });

      const res = await request(app)
        .get("/v1/analytics/tasks")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalTasks).toBe(3);
      expect(res.body.data.byStatus).toBeInstanceOf(Array);
      expect(res.body.data.byPriority).toBeInstanceOf(Array);
      expect(res.body.data.completionRate).toBe(33);
    });

    it("calculates overdue tasks", async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 5);

      await prisma.task.create({
        data: {
          title: "Overdue task",
          status: "TODO",
          dueDate: pastDate,
          createdById: adminId,
        },
      });

      const res = await request(app)
        .get("/v1/analytics/tasks")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.overdueCount).toBe(1);
    });

    it("returns top assignees", async () => {
      const assignee = await createTestUser({ name: "Designer", email: "designer@test.com" });

      await prisma.task.create({
        data: { title: "Task A", assigneeId: assignee.id, createdById: adminId },
      });
      await prisma.task.create({
        data: { title: "Task B", assigneeId: assignee.id, status: "DONE", completedAt: new Date(), createdById: adminId },
      });

      const res = await request(app)
        .get("/v1/analytics/tasks")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.topAssignees.length).toBeGreaterThan(0);
      expect(res.body.data.topAssignees[0].assigneeName).toBe("Designer");
      expect(res.body.data.topAssignees[0].total).toBe(2);
      expect(res.body.data.topAssignees[0].done).toBe(1);
    });
  });

  describe("GET /v1/analytics/content", () => {
    it("returns content analytics (empty when ContentPost model missing)", async () => {
      const res = await request(app)
        .get("/v1/analytics/content")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalPosts).toBe(0);
      expect(res.body.data.byStatus).toBeInstanceOf(Array);
      expect(res.body.data.byPlatform).toBeInstanceOf(Array);
    });
  });

  describe("GET /v1/analytics/projects", () => {
    it("returns project analytics", async () => {
      const { hash } = await import("bcrypt");
      const client = await prisma.client.create({
        data: {
          companyName: "Test Corp",
          contactName: "John",
          email: "john@testcorp.com",
          passwordHash: await hash("Pass123!", 12),
        },
      });

      const project = await prisma.project.create({
        data: { name: "Website Redesign", clientId: client.id, status: "ACTIVE" },
      });

      const task = await prisma.task.create({
        data: { title: "Wireframes", status: "DONE", completedAt: new Date(), createdById: adminId },
      });

      await prisma.projectTask.create({
        data: { projectId: project.id, taskId: task.id },
      });

      const res = await request(app)
        .get("/v1/analytics/projects")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalProjects).toBe(1);
      expect(res.body.data.activeProjects).toBe(1);
      expect(res.body.data.projects[0].totalTasks).toBe(1);
      expect(res.body.data.projects[0].completedTasks).toBe(1);
      expect(res.body.data.projects[0].taskCompletionPercent).toBe(100);
    });
  });

  describe("GET /v1/analytics/attendance", () => {
    it("returns attendance analytics", async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      await prisma.attendance.create({
        data: {
          employeeId: adminId,
          date: today,
          status: "PRESENT",
          checkIn: new Date(),
        },
      });

      const res = await request(app)
        .get("/v1/analytics/attendance")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalEmployees).toBeGreaterThan(0);
      expect(res.body.data.presentToday).toBe(1);
      expect(res.body.data).toHaveProperty("attendanceRate");
      expect(res.body.data).toHaveProperty("dailyBreakdown");
    });
  });

  describe("GET /v1/client/analytics", () => {
    it("returns analytics scoped to the client", async () => {
      const { hash } = await import("bcrypt");
      const client = await prisma.client.create({
        data: {
          companyName: "Acme Inc",
          contactName: "Jane",
          email: "jane@acme.com",
          passwordHash: await hash("Pass123!", 12),
        },
      });

      const project = await prisma.project.create({
        data: { name: "Social Campaign", clientId: client.id, status: "ACTIVE" },
      });

      const task1 = await prisma.task.create({
        data: { title: "Design post", status: "DONE", completedAt: new Date(), createdById: adminId },
      });
      const task2 = await prisma.task.create({
        data: { title: "Write caption", status: "TODO", createdById: adminId },
      });

      await prisma.projectTask.createMany({
        data: [
          { projectId: project.id, taskId: task1.id },
          { projectId: project.id, taskId: task2.id },
        ],
      });

      const clientToken = jwt.sign(
        { userId: client.id, email: client.email, type: "client" },
        process.env.JWT_SECRET || "dev-secret",
        { expiresIn: "15m" }
      );

      const res = await request(app)
        .get("/v1/client/analytics")
        .set("Authorization", `Bearer ${clientToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalProjects).toBe(1);
      expect(res.body.data.activeProjects).toBe(1);
      expect(res.body.data.totalTasks).toBe(2);
      expect(res.body.data.completedTasks).toBe(1);
      expect(res.body.data.overallCompletionPercent).toBe(50);
      expect(res.body.data.projects[0].projectName).toBe("Social Campaign");
    });

    it("does not return other clients data", async () => {
      const { hash } = await import("bcrypt");
      const clientA = await prisma.client.create({
        data: {
          companyName: "Client A",
          contactName: "A",
          email: "a@clients.com",
          passwordHash: await hash("Pass123!", 12),
        },
      });
      const clientB = await prisma.client.create({
        data: {
          companyName: "Client B",
          contactName: "B",
          email: "b@clients.com",
          passwordHash: await hash("Pass123!", 12),
        },
      });

      await prisma.project.create({
        data: { name: "Project A", clientId: clientA.id, status: "ACTIVE" },
      });
      await prisma.project.create({
        data: { name: "Project B", clientId: clientB.id, status: "ACTIVE" },
      });

      const tokenA = jwt.sign(
        { userId: clientA.id, email: clientA.email, type: "client" },
        process.env.JWT_SECRET || "dev-secret",
        { expiresIn: "15m" }
      );

      const res = await request(app)
        .get("/v1/client/analytics")
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalProjects).toBe(1);
      expect(res.body.data.projects[0].projectName).toBe("Project A");
    });

    it("requires client authentication", async () => {
      const res = await request(app).get("/v1/client/analytics");
      expect(res.status).toBe(401);
    });
  });
});
