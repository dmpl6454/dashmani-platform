import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole } from "./helpers";
import "./setup";

describe("Auth API", () => {
  beforeEach(async () => {
    await createTestRole("Employee", [
      { resource: "employees", action: "view", scope: "own" },
    ]);
  });

  describe("POST /v1/auth/login", () => {
    it("returns tokens for valid credentials", async () => {
      await createTestUser({ email: "test@digitalsukoon.com", password: "TestPass123!", roleNames: ["Employee"] });

      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: "test@digitalsukoon.com", password: "TestPass123!" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.user.email).toBe("test@digitalsukoon.com");
      expect(res.body.data.user.roles).toContain("Employee");
    });

    it("returns 401 for wrong password", async () => {
      await createTestUser({ email: "test@digitalsukoon.com", password: "TestPass123!", roleNames: ["Employee"] });

      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: "test@digitalsukoon.com", password: "WrongPass!" });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("returns 401 for non-existent user", async () => {
      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: "nobody@test.com", password: "TestPass123!" });

      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid email format", async () => {
      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: "not-an-email", password: "TestPass123!" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 403 for inactive user", async () => {
      const { prisma } = await import("@dashmani/db");
      const user = await createTestUser({ email: "inactive@test.com", password: "TestPass123!", roleNames: ["Employee"] });
      await prisma.user.update({ where: { id: user.id }, data: { status: "INACTIVE" } });

      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: "inactive@test.com", password: "TestPass123!" });

      expect(res.status).toBe(403);
    });
  });

  describe("POST /v1/auth/refresh", () => {
    it("returns new tokens for valid refresh token", async () => {
      await createTestUser({ email: "test@digitalsukoon.com", password: "TestPass123!", roleNames: ["Employee"] });

      const loginRes = await request(app)
        .post("/v1/auth/login")
        .send({ email: "test@digitalsukoon.com", password: "TestPass123!" });

      const res = await request(app)
        .post("/v1/auth/refresh")
        .send({ refreshToken: loginRes.body.data.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
    });
  });

  describe("POST /v1/auth/logout", () => {
    it("clears refresh tokens for authenticated user", async () => {
      await createTestUser({ email: "test@digitalsukoon.com", password: "TestPass123!", roleNames: ["Employee"] });

      const loginRes = await request(app)
        .post("/v1/auth/login")
        .send({ email: "test@digitalsukoon.com", password: "TestPass123!" });

      const res = await request(app)
        .post("/v1/auth/logout")
        .set("Authorization", `Bearer ${loginRes.body.data.accessToken}`);

      expect(res.status).toBe(200);
    });

    it("returns 401 without token", async () => {
      const res = await request(app).post("/v1/auth/logout");
      expect(res.status).toBe(401);
    });
  });
});
