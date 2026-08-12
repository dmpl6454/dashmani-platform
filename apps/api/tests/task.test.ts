import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import { prisma } from "@dashmani/db";
import "./setup";

describe("Tasks API", () => {
  let adminToken: string;
  let adminId: string;
  let accountId: string;

  // accountId + dueDate became REQUIRED on task create (2026-05-22, "task/content
  // required fields on create" — Issue 8). Every create payload spreads required()
  // or the API correctly 400s. These tests silently failed for weeks because the
  // fixtures predated that deliberate validation change.
  const required = () => ({ accountId, dueDate: "2026-08-01" });

  beforeEach(async () => {
    await createTestRole("Admin", [
      { resource: "tasks", action: "view", scope: "global" },
      { resource: "tasks", action: "create", scope: "global" },
      { resource: "tasks", action: "edit", scope: "global" },
      { resource: "tasks", action: "delete", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminId = admin.id;
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);

    const uniq = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const platform = await prisma.platform.create({
      data: { name: `TaskTestPlat_${uniq}`, slug: `task-test-${uniq}` },
    });
    const account = await prisma.socialAccount.create({
      data: { handle: "tasktest", displayName: "Task Test Account", platformId: platform.id },
    });
    accountId = account.id;
  });

  describe("POST /v1/tasks", () => {
    it("creates a new task", async () => {
      const res = await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          title: "Design Instagram banner",
          description: "Create a banner for the summer campaign",
          priority: "HIGH",
          ...required(),
        });

      expect(res.status).toBe(201);
      expect(res.body.data.title).toBe("Design Instagram banner");
      expect(res.body.data.status).toBe("TODO");
      expect(res.body.data.priority).toBe("HIGH");
      expect(res.body.data.createdBy.id).toBe(adminId);
    });

    it("creates task with assignee", async () => {
      const assignee = await createTestUser({ name: "Designer" });

      const res = await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          title: "Write copy",
          assigneeId: assignee.id,
          ...required(),
        });

      expect(res.status).toBe(201);
      expect(res.body.data.assignee.id).toBe(assignee.id);
    });

    it("rejects a create without the required accountId + dueDate (Issue 8 validation)", async () => {
      const res = await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Missing required fields" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/tasks", () => {
    it("lists tasks", async () => {
      await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Task A", ...required() });
      await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Task B", ...required() });

      const res = await request(app)
        .get("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
    });

    it("filters by status", async () => {
      await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Todo task", ...required() });

      const res = await request(app)
        .get("/v1/tasks?status=TODO")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.every((t: any) => t.status === "TODO")).toBe(true);
    });
  });

  describe("PUT /v1/tasks/:id/status", () => {
    it("transitions task status to IN_PROGRESS", async () => {
      const createRes = await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Start this", ...required() });

      const res = await request(app)
        .put(`/v1/tasks/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "IN_PROGRESS" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("IN_PROGRESS");
    });

    it("sets completedAt when status is DONE", async () => {
      const createRes = await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Finish this", ...required() });

      const res = await request(app)
        .put(`/v1/tasks/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "DONE" });

      expect(res.status).toBe(200);
      expect(res.body.data.completedAt).toBeDefined();
    });

    it("blocks start when dependency not done", async () => {
      const depRes = await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Blocker task", ...required() });

      const taskRes = await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Blocked task", dependsOnId: depRes.body.data.id, ...required() });

      const res = await request(app)
        .put(`/v1/tasks/${taskRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "IN_PROGRESS" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("DEPENDENCY_NOT_DONE");
    });
  });

  describe("POST /v1/tasks/:id/comments", () => {
    it("adds a comment to a task", async () => {
      const createRes = await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Commentable task", ...required() });

      const res = await request(app)
        .post(`/v1/tasks/${createRes.body.data.id}/comments`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ body: "Looking good, proceed!" });

      expect(res.status).toBe(201);
      expect(res.body.data.body).toBe("Looking good, proceed!");
      expect(res.body.data.author.id).toBe(adminId);
    });
  });

  describe("DELETE /v1/tasks/:id", () => {
    it("deletes a task", async () => {
      const createRes = await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Delete me", ...required() });

      const res = await request(app)
        .delete(`/v1/tasks/${createRes.body.data.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
    });

    it("prevents deleting a task with dependents", async () => {
      const depRes = await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Dependency", ...required() });

      await request(app)
        .post("/v1/tasks")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Depends on it", dependsOnId: depRes.body.data.id, ...required() });

      const res = await request(app)
        .delete(`/v1/tasks/${depRes.body.data.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("HAS_DEPENDENTS");
    });
  });
});
