import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { prisma } from "@dashmani/db";
import { hash } from "bcrypt";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import "./setup";

describe("Projects API", () => {
  let adminToken: string;
  let adminId: string;
  let clientId: string;
  let clientToken: string;

  beforeEach(async () => {
    // Create admin
    await createTestRole("Admin", [
      { resource: "clients", action: "view", scope: "global" },
      { resource: "clients", action: "create", scope: "global" },
      { resource: "clients", action: "edit", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminId = admin.id;
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);

    // Create client
    const passwordHash = await hash("Client@123", 12);
    const client = await prisma.client.create({
      data: {
        companyName: "Test Corp",
        contactName: "Test Client",
        email: "client@test.com",
        passwordHash,
        status: "ACTIVE",
      },
    });
    clientId = client.id;

    // Get client token
    const loginRes = await request(app)
      .post("/v1/client/auth/login")
      .send({ email: "client@test.com", password: "Client@123" });
    clientToken = loginRes.body.data.accessToken;
  });

  describe("POST /v1/projects", () => {
    it("creates a project", async () => {
      const res = await request(app)
        .post("/v1/projects")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Summer Campaign", clientId, description: "Social media campaign for summer" });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe("Summer Campaign");
      expect(res.body.data.client.id).toBe(clientId);
    });
  });

  describe("GET /v1/client/projects", () => {
    it("client sees only their own projects", async () => {
      await prisma.project.create({
        data: { name: "My Project", clientId },
      });

      const res = await request(app)
        .get("/v1/client/projects")
        .set("Authorization", `Bearer ${clientToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].name).toBe("My Project");
    });
  });

  describe("GET /v1/client/dashboard", () => {
    it("returns client dashboard data", async () => {
      await prisma.project.create({
        data: { name: "Dashboard Project", clientId },
      });

      const res = await request(app)
        .get("/v1/client/dashboard")
        .set("Authorization", `Bearer ${clientToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.client).toBeDefined();
      expect(res.body.data.projects.length).toBe(1);
    });
  });

  describe("Approvals", () => {
    it("admin creates approval, client responds", async () => {
      const project = await prisma.project.create({
        data: { name: "Approval Project", clientId },
      });

      // Admin creates approval
      const createRes = await request(app)
        .post(`/v1/projects/${project.id}/approvals`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ title: "Banner Design v1", description: "Please review the banner" });

      expect(createRes.status).toBe(201);
      expect(createRes.body.data.status).toBe("PENDING");

      // Client responds
      const respondRes = await request(app)
        .put(`/v1/client/approvals/${createRes.body.data.id}/respond`)
        .set("Authorization", `Bearer ${clientToken}`)
        .send({ status: "APPROVED", clientNote: "Looks great!" });

      expect(respondRes.status).toBe(200);
      expect(respondRes.body.data.status).toBe("APPROVED");
      expect(respondRes.body.data.clientNote).toBe("Looks great!");
    });
  });

  describe("Project linking", () => {
    it("links and unlinks account to project", async () => {
      const platform = await prisma.platform.create({ data: { name: "Instagram", slug: "instagram" } });
      const account = await prisma.socialAccount.create({
        data: { handle: "@test", displayName: "Test", platformId: platform.id },
      });
      const project = await prisma.project.create({
        data: { name: "Link Project", clientId },
      });

      const linkRes = await request(app)
        .post(`/v1/projects/${project.id}/accounts`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ accountId: account.id });

      expect(linkRes.status).toBe(201);

      const unlinkRes = await request(app)
        .delete(`/v1/projects/${project.id}/accounts/${account.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(unlinkRes.status).toBe(200);
    });
  });
});
