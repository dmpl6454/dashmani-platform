import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { prisma } from "@dashmani/db";
import { hash } from "bcrypt";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import "./setup";

describe("Client Auth API", () => {
  let clientId: string;

  beforeEach(async () => {
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
  });

  describe("POST /v1/client/auth/login", () => {
    it("logs in a client with valid credentials", async () => {
      const res = await request(app)
        .post("/v1/client/auth/login")
        .send({ email: "client@test.com", password: "Client@123" });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.user.companyName).toBe("Test Corp");
    });

    it("rejects invalid credentials", async () => {
      const res = await request(app)
        .post("/v1/client/auth/login")
        .send({ email: "client@test.com", password: "wrong" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    });
  });

  describe("POST /v1/client/auth/refresh", () => {
    it("refreshes a client token", async () => {
      const loginRes = await request(app)
        .post("/v1/client/auth/login")
        .send({ email: "client@test.com", password: "Client@123" });

      const res = await request(app)
        .post("/v1/client/auth/refresh")
        .send({ refreshToken: loginRes.body.data.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
    });
  });

  describe("GET /v1/clients (admin)", () => {
    it("lists clients for admin users", async () => {
      await createTestRole("Admin", [
        { resource: "clients", action: "view", scope: "global" },
        { resource: "clients", action: "create", scope: "global" },
      ]);
      const admin = await createTestUser({ roleNames: ["Admin"] });
      const token = generateToken(admin.id, admin.email, ["Admin"]);

      const res = await request(app)
        .get("/v1/clients")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].companyName).toBe("Test Corp");
    });
  });

  describe("POST /v1/clients (admin)", () => {
    it("creates a new client", async () => {
      await createTestRole("Admin", [
        { resource: "clients", action: "view", scope: "global" },
        { resource: "clients", action: "create", scope: "global" },
      ]);
      const admin = await createTestUser({ roleNames: ["Admin"] });
      const token = generateToken(admin.id, admin.email, ["Admin"]);

      const res = await request(app)
        .post("/v1/clients")
        .set("Authorization", `Bearer ${token}`)
        .send({
          companyName: "New Client Co.",
          contactName: "Priya Patel",
          email: "priya@newclient.com",
          password: "NewClient@123",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.companyName).toBe("New Client Co.");
    });
  });
});
