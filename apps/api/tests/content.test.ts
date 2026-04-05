import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { prisma } from "@dashmani/db";
import { hash } from "bcrypt";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import "./setup";

describe("Content API", () => {
  let adminToken: string;
  let adminId: string;
  let clientId: string;
  let clientToken: string;
  let projectId: string;
  let platformId: string;
  let accountId: string;

  beforeEach(async () => {
    // Create admin role with content + client permissions
    await createTestRole("Admin", [
      { resource: "content", action: "view", scope: "global" },
      { resource: "content", action: "create", scope: "global" },
      { resource: "content", action: "edit", scope: "global" },
      { resource: "content", action: "delete", scope: "global" },
      { resource: "clients", action: "view", scope: "global" },
      { resource: "clients", action: "create", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminId = admin.id;
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);

    // Create client
    const passwordHash = await hash("Client@123", 12);
    const client = await prisma.client.create({
      data: {
        companyName: "Content Corp",
        contactName: "Content Client",
        email: "content-client@test.com",
        passwordHash,
        status: "ACTIVE",
      },
    });
    clientId = client.id;

    // Get client token
    const loginRes = await request(app)
      .post("/v1/client/auth/login")
      .send({ email: "content-client@test.com", password: "Client@123" });
    clientToken = loginRes.body.data.accessToken;

    // Create project
    const project = await prisma.project.create({
      data: { name: "Summer Campaign", clientId: client.id },
    });
    projectId = project.id;

    // Create platform + account
    const platform = await prisma.platform.create({
      data: { name: "Instagram", slug: "instagram" },
    });
    platformId = platform.id;
    const account = await prisma.socialAccount.create({
      data: { handle: "@testbrand", displayName: "Test Brand", platformId: platform.id },
    });
    accountId = account.id;
  });

  describe("POST /v1/content", () => {
    it("creates a content post", async () => {
      const res = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          title: "Summer Sale Post",
          caption: "Check out our summer deals!",
          projectId,
          accountId,
          mediaUrls: ["https://example.com/image1.jpg"],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.title).toBe("Summer Sale Post");
      expect(res.body.data.status).toBe("DRAFT");
      expect(res.body.data.mediaUrls).toEqual(["https://example.com/image1.jpg"]);
      expect(res.body.data.project.id).toBe(projectId);
      expect(res.body.data.account.id).toBe(accountId);
      expect(res.body.data.createdBy.id).toBe(adminId);
    });

    it("creates a content post with scheduled date", async () => {
      const scheduledAt = "2026-04-15T10:00:00.000Z";
      const res = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          title: "Scheduled Post",
          projectId,
          scheduledAt,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.scheduledAt).toBeDefined();
    });

    it("rejects invalid project ID", async () => {
      const res = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          title: "Bad Project",
          projectId: "00000000-0000-0000-0000-000000000000",
        });

      expect(res.status).toBe(404);
    });
  });

  describe("GET /v1/content", () => {
    it("lists content posts", async () => {
      await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Post A", projectId });
      await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Post B", projectId });

      const res = await request(app)
        .get("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
    });

    it("filters by status", async () => {
      await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Draft Post", projectId });

      const res = await request(app)
        .get("/v1/content?status=DRAFT")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.every((p: any) => p.status === "DRAFT")).toBe(true);
    });

    it("filters by projectId", async () => {
      await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Project Post", projectId });

      const res = await request(app)
        .get(`/v1/content?projectId=${projectId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
    });

    it("searches by title", async () => {
      await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Unique Findable Title", projectId });
      await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Other Post", projectId });

      const res = await request(app)
        .get("/v1/content?search=Findable")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].title).toBe("Unique Findable Title");
    });
  });

  describe("GET /v1/content/:id", () => {
    it("gets a content post by ID", async () => {
      const createRes = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Detail Post", projectId, caption: "Some caption" });

      const res = await request(app)
        .get(`/v1/content/${createRes.body.data.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe("Detail Post");
      expect(res.body.data.caption).toBe("Some caption");
    });

    it("returns 404 for nonexistent ID", async () => {
      const res = await request(app)
        .get("/v1/content/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe("PUT /v1/content/:id", () => {
    it("updates a content post", async () => {
      const createRes = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Original Title", projectId });

      const res = await request(app)
        .put(`/v1/content/${createRes.body.data.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Updated Title", caption: "New caption" });

      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe("Updated Title");
      expect(res.body.data.caption).toBe("New caption");
    });
  });

  describe("PUT /v1/content/:id/status", () => {
    it("transitions DRAFT to PENDING_APPROVAL", async () => {
      const createRes = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Approval Post", projectId });

      const res = await request(app)
        .put(`/v1/content/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PENDING_APPROVAL" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("PENDING_APPROVAL");
    });

    it("transitions DRAFT to SCHEDULED (skip approval)", async () => {
      const createRes = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Direct Schedule", projectId });

      const res = await request(app)
        .put(`/v1/content/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "SCHEDULED" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("SCHEDULED");
    });

    it("sets publishedAt when transitioning to PUBLISHED", async () => {
      const createRes = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Publish Me", projectId });

      // DRAFT -> SCHEDULED
      await request(app)
        .put(`/v1/content/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "SCHEDULED" });

      // SCHEDULED -> PUBLISHED
      const res = await request(app)
        .put(`/v1/content/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PUBLISHED" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("PUBLISHED");
      expect(res.body.data.publishedAt).toBeDefined();
    });

    it("rejects invalid status transition", async () => {
      const createRes = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Invalid Transition", projectId });

      // DRAFT -> PUBLISHED is not valid (must go through SCHEDULED)
      const res = await request(app)
        .put(`/v1/content/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PUBLISHED" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
    });

    it("rejects transition from PUBLISHED", async () => {
      const createRes = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Already Published", projectId });

      // DRAFT -> SCHEDULED -> PUBLISHED
      await request(app)
        .put(`/v1/content/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "SCHEDULED" });
      await request(app)
        .put(`/v1/content/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PUBLISHED" });

      // PUBLISHED -> DRAFT should fail
      const res = await request(app)
        .put(`/v1/content/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "DRAFT" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
    });
  });

  describe("DELETE /v1/content/:id", () => {
    it("deletes a draft content post", async () => {
      const createRes = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Delete Me", projectId });

      const res = await request(app)
        .delete(`/v1/content/${createRes.body.data.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
    });

    it("prevents deleting a published post", async () => {
      const createRes = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Published Post", projectId });

      await request(app)
        .put(`/v1/content/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "SCHEDULED" });
      await request(app)
        .put(`/v1/content/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PUBLISHED" });

      const res = await request(app)
        .delete(`/v1/content/${createRes.body.data.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("ALREADY_PUBLISHED");
    });
  });

  describe("GET /v1/content/calendar", () => {
    it("returns content grouped by day for a month", async () => {
      await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          title: "April 10 Post",
          projectId,
          scheduledAt: "2026-04-10T10:00:00.000Z",
        });
      await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          title: "April 10 Post 2",
          projectId,
          scheduledAt: "2026-04-10T14:00:00.000Z",
        });
      await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          title: "April 20 Post",
          projectId,
          scheduledAt: "2026-04-20T09:00:00.000Z",
        });

      const res = await request(app)
        .get("/v1/content/calendar?year=2026&month=4")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.year).toBe(2026);
      expect(res.body.data.month).toBe(4);
      expect(res.body.data.days["2026-04-10"].length).toBe(2);
      expect(res.body.data.days["2026-04-20"].length).toBe(1);
    });
  });

  describe("Client content endpoints", () => {
    it("client sees content for their projects", async () => {
      await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Client Visible Post", projectId });

      const res = await request(app)
        .get("/v1/client/content")
        .set("Authorization", `Bearer ${clientToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].title).toBe("Client Visible Post");
    });

    it("client can approve content in PENDING_APPROVAL status", async () => {
      const createRes = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Needs Approval", projectId });

      // Move to PENDING_APPROVAL
      await request(app)
        .put(`/v1/content/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PENDING_APPROVAL" });

      // Client approves
      const res = await request(app)
        .put(`/v1/client/content/${createRes.body.data.id}/respond`)
        .set("Authorization", `Bearer ${clientToken}`)
        .send({ status: "APPROVED" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("APPROVED");
    });

    it("client can reject content in PENDING_APPROVAL status", async () => {
      const createRes = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Reject This", projectId });

      await request(app)
        .put(`/v1/content/${createRes.body.data.id}/status`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "PENDING_APPROVAL" });

      const res = await request(app)
        .put(`/v1/client/content/${createRes.body.data.id}/respond`)
        .set("Authorization", `Bearer ${clientToken}`)
        .send({ status: "REJECTED" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("REJECTED");
    });

    it("client cannot approve content not in PENDING_APPROVAL", async () => {
      const createRes = await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Still Draft", projectId });

      const res = await request(app)
        .put(`/v1/client/content/${createRes.body.data.id}/respond`)
        .set("Authorization", `Bearer ${clientToken}`)
        .send({ status: "APPROVED" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("NOT_PENDING");
    });

    it("client can view content calendar for their projects", async () => {
      await request(app)
        .post("/v1/content")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          title: "Client Calendar Post",
          projectId,
          scheduledAt: "2026-04-15T10:00:00.000Z",
        });

      const res = await request(app)
        .get("/v1/client/content/calendar?year=2026&month=4")
        .set("Authorization", `Bearer ${clientToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.days["2026-04-15"].length).toBe(1);
    });
  });
});
