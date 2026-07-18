import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import { prisma } from "@dashmani/db";
import { todayIST, istMidnight } from "@dashmani/shared";
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

    it("counts active employees correctly (employeeWhere: non-admin role required)", async () => {
      // The employeeWhere convention (2026-05-22): an "employee" is an ACTIVE,
      // non-deleted user with AT LEAST ONE role that is not Super Admin/Admin.
      // The pure-Admin beforeEach user and role-less users are deliberately
      // excluded. This test asserted 3 (any users) for weeks after that
      // deliberate change and silently failed.
      await createTestRole("Employee", []);
      await createTestUser({ name: "Employee A", email: "a@test.com", roleNames: ["Employee"] });
      await createTestUser({ name: "Employee B", email: "b@test.com", roleNames: ["Employee"] });
      await createTestUser({ name: "No Role User", email: "norole@test.com" }); // excluded — no role

      const res = await request(app)
        .get("/v1/analytics/overview")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalEmployees).toBe(2);
    });

    it("counts TOP-LEVEL org units as active teams (countTeams — matches the /teams page)", async () => {
      // countTeams() (2026-05-22, Issue 5) counts top-level org units
      // (parentId null) regardless of type — that is exactly what the /teams
      // page lists. Child units are not counted. The old assertion (TEAM-type
      // only) predated that deliberate change and silently failed.
      const design = await prisma.orgUnit.create({
        data: { name: "Design Team", type: "TEAM" },
      });
      await prisma.orgUnit.create({
        data: { name: "Content Team", type: "TEAM" },
      });
      await prisma.orgUnit.create({
        data: { name: "Marketing Dept", type: "DEPARTMENT" },
      });
      await prisma.orgUnit.create({
        data: { name: "Design Subteam", type: "TEAM", parentId: design.id }, // child — not counted
      });

      const res = await request(app)
        .get("/v1/analytics/overview")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.activeTeams).toBe(3);
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
      // totalEmployees uses employeeWhere (needs a non-admin role), and the
      // service's "today" is the IST date-key (istMidnight(todayIST())) — a
      // local-midnight Date would land on the wrong DATE row between 12:00 AM
      // and 5:30 AM IST. Mirror both conventions exactly.
      await createTestRole("Employee", []);
      const emp = await createTestUser({ name: "Attending Emp", email: "attend@test.com", roleNames: ["Employee"] });

      await prisma.attendance.create({
        data: {
          employeeId: emp.id,
          date: istMidnight(todayIST()),
          status: "PRESENT",
          checkIn: new Date(),
        },
      });

      const res = await request(app)
        .get("/v1/analytics/attendance")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalEmployees).toBe(1);
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

      // GET /v1/client/analytics deliberately serves getClientContentAnalytics
      // (the client portal /analytics page is CONTENT analytics — totalPosts,
      // postsByStatus, projectSummaries…), NOT the old project/task shape
      // (totalProjects/totalTasks). This test asserted the old shape for weeks
      // after that deliberate switch and silently failed.
      await prisma.contentPost.create({
        data: { title: "Post One", projectId: project.id, createdById: adminId, status: "DRAFT" },
      });
      await prisma.contentPost.create({
        data: { title: "Post Two", projectId: project.id, createdById: adminId, status: "PENDING_APPROVAL" },
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
      expect(res.body.data.totalPosts).toBe(2);
      expect(res.body.data.postsByStatus.DRAFT).toBe(1);
      expect(res.body.data.postsByStatus.PENDING_APPROVAL).toBe(1);
      expect(res.body.data.projectSummaries).toHaveLength(1);
      expect(res.body.data.projectSummaries[0].name).toBe("Social Campaign");
      expect(res.body.data.projectSummaries[0].postCount).toBe(2);
      expect(res.body.data.projectSummaries[0].pendingCount).toBe(1);
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

      const projectA = await prisma.project.create({
        data: { name: "Project A", clientId: clientA.id, status: "ACTIVE" },
      });
      const projectB = await prisma.project.create({
        data: { name: "Project B", clientId: clientB.id, status: "ACTIVE" },
      });
      // One post per client — client A must see ONLY their own in every field.
      await prisma.contentPost.create({
        data: { title: "A's Post", projectId: projectA.id, createdById: adminId },
      });
      await prisma.contentPost.create({
        data: { title: "B's Post", projectId: projectB.id, createdById: adminId },
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
      // Content-analytics shape (see previous test) — the SECURITY intent is
      // unchanged: nothing of client B may leak into client A's payload.
      expect(res.body.data.totalPosts).toBe(1);
      expect(res.body.data.projectSummaries).toHaveLength(1);
      expect(res.body.data.projectSummaries[0].name).toBe("Project A");
    });

    it("requires client authentication", async () => {
      const res = await request(app).get("/v1/client/analytics");
      expect(res.status).toBe(401);
    });
  });
});
