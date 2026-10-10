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

  describe("POST /v1/client/auth/signup (public self-signup)", () => {
    const body = { companyName: "Brand New Co", contactName: "Nina", email: "Nina@BrandNew.test", password: "Str0ng-pass!", phone: "+91 98765 43210" };

    it("creates an ACTIVE client with instant access and a normalised email", async () => {
      const res = await request(app).post("/v1/client/auth/signup").send(body);
      expect(res.status).toBe(201);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.user).toMatchObject({ companyName: "Brand New Co", name: "Nina", email: "nina@brandnew.test" });
      const row = await prisma.client.findUniqueOrThrow({ where: { email: "nina@brandnew.test" } });
      expect(row.status).toBe("ACTIVE");
      expect(row.phone).toBe("+91 98765 43210");
      // The token works on a client route straight away.
      const me = await request(app).get("/v1/client/campaigns").set("Authorization", `Bearer ${res.body.data.accessToken}`);
      expect(me.status).toBe(200);
      // And the account can sign in with the email in any casing.
      const login = await request(app).post("/v1/client/auth/login").send({ email: "NINA@brandnew.test", password: body.password });
      expect(login.status).toBe(200);
    });

    it("never takes over an existing account — any casing → 409, row untouched", async () => {
      const res = await request(app).post("/v1/client/auth/signup").send({ ...body, email: "CLIENT@test.com", password: "Hijack-pass1!" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("EMAIL_EXISTS");
      const row = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(row.companyName).toBe("Test Corp");
      // The original password still works and the attempted one does not.
      expect((await request(app).post("/v1/client/auth/login").send({ email: "client@test.com", password: "Client@123" })).status).toBe(200);
      expect((await request(app).post("/v1/client/auth/login").send({ email: "client@test.com", password: "Hijack-pass1!" })).status).toBe(401);
    });

    it("consumes a pending invite for the same email so it cannot mint a second account", async () => {
      const invite = await prisma.clientInvite.create({ data: { email: "nina@brandnew.test", expiresAt: new Date(Date.now() + 86_400_000) } });
      expect((await request(app).post("/v1/client/auth/signup").send(body)).status).toBe(201);
      expect((await prisma.clientInvite.findUniqueOrThrow({ where: { id: invite.id } })).usedAt).not.toBeNull();
      const accept = await request(app).post("/v1/client/auth/register").send({ token: invite.token, password: "Another-pass1!" });
      expect(accept.status).toBe(400);
      expect(await prisma.client.count({ where: { email: "nina@brandnew.test" } })).toBe(1);
    });

    it("validates input and strips HTML from names", async () => {
      expect((await request(app).post("/v1/client/auth/signup").send({ ...body, password: "short" })).status).toBe(400);
      expect((await request(app).post("/v1/client/auth/signup").send({ ...body, email: "not-an-email" })).status).toBe(400);
      expect((await request(app).post("/v1/client/auth/signup").send({ contactName: "X", email: body.email, password: body.password })).status).toBe(400);
      const res = await request(app).post("/v1/client/auth/signup").send({ ...body, companyName: "<b>Acme</b> Ltd", phone: "" });
      expect(res.status).toBe(201);
      expect(res.body.data.user.companyName).toBe("Acme Ltd");
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
