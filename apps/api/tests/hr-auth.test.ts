import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole } from "./helpers";
import { prisma } from "@dashmani/db";
import "./setup";

describe("HR Auth API", () => {
  beforeEach(async () => {
    await createTestRole("Employee", [
      { resource: "employees", action: "view", scope: "own" },
    ]);
  });

  describe("POST /v1/hr/auth/request-otp", () => {
    it("sends OTP for valid email", async () => {
      await createTestUser({ email: "hr@digitalsukoon.com", roleNames: ["Employee"] });

      const res = await request(app)
        .post("/v1/hr/auth/request-otp")
        .send({ identifier: "hr@digitalsukoon.com", channel: "EMAIL" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toMatch(/OTP sent/i);
    });

    it("sends OTP for valid phone", async () => {
      await prisma.user.create({
        data: {
          name: "Phone User",
          email: "phoneuser@digitalsukoon.com",
          passwordHash: "not-used",
          phone: "+919876543210",
          status: "ACTIVE",
        },
      });

      const res = await request(app)
        .post("/v1/hr/auth/request-otp")
        .send({ identifier: "+919876543210", channel: "SMS" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 404 for unknown identifier", async () => {
      const res = await request(app)
        .post("/v1/hr/auth/request-otp")
        .send({ identifier: "nobody@unknown.com", channel: "EMAIL" });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("USER_NOT_FOUND");
    });

    it("returns 400 for missing channel", async () => {
      const res = await request(app)
        .post("/v1/hr/auth/request-otp")
        .send({ identifier: "hr@digitalsukoon.com" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /v1/hr/auth/verify-otp", () => {
    it("returns tokens for correct OTP", async () => {
      const user = await createTestUser({
        email: "verify@digitalsukoon.com",
        roleNames: ["Employee"],
      });

      // Plant an OTP directly
      await prisma.otpToken.create({
        data: {
          userId: user.id,
          otp: "123456",
          channel: "EMAIL",
          target: "verify@digitalsukoon.com",
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      const res = await request(app)
        .post("/v1/hr/auth/verify-otp")
        .send({ identifier: "verify@digitalsukoon.com", otp: "123456" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.user.email).toBe("verify@digitalsukoon.com");
    });

    it("rejects invalid OTP", async () => {
      await createTestUser({
        email: "verify2@digitalsukoon.com",
        roleNames: ["Employee"],
      });

      const res = await request(app)
        .post("/v1/hr/auth/verify-otp")
        .send({ identifier: "verify2@digitalsukoon.com", otp: "000000" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_OTP");
    });

    it("rejects expired OTP", async () => {
      const user = await createTestUser({
        email: "verify3@digitalsukoon.com",
        roleNames: ["Employee"],
      });

      await prisma.otpToken.create({
        data: {
          userId: user.id,
          otp: "654321",
          channel: "EMAIL",
          target: "verify3@digitalsukoon.com",
          expiresAt: new Date(Date.now() - 1000), // already expired
        },
      });

      const res = await request(app)
        .post("/v1/hr/auth/verify-otp")
        .send({ identifier: "verify3@digitalsukoon.com", otp: "654321" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_OTP");
    });
  });

  describe("POST /v1/hr/auth/refresh", () => {
    it("returns new tokens for valid refresh token", async () => {
      const user = await createTestUser({
        email: "refresh@digitalsukoon.com",
        roleNames: ["Employee"],
      });

      // Get tokens via OTP flow
      await prisma.otpToken.create({
        data: {
          userId: user.id,
          otp: "111111",
          channel: "EMAIL",
          target: "refresh@digitalsukoon.com",
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      const verifyRes = await request(app)
        .post("/v1/hr/auth/verify-otp")
        .send({ identifier: "refresh@digitalsukoon.com", otp: "111111" });

      expect(verifyRes.status).toBe(200);
      const { refreshToken } = verifyRes.body.data;

      const res = await request(app)
        .post("/v1/hr/auth/refresh")
        .send({ refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
    });

    it("returns 401 for invalid refresh token", async () => {
      const res = await request(app)
        .post("/v1/hr/auth/refresh")
        .send({ refreshToken: "invalid.token.value" });

      expect(res.status).toBe(401);
    });

    it("returns 400 for missing refresh token", async () => {
      const res = await request(app)
        .post("/v1/hr/auth/refresh")
        .send({});

      expect(res.status).toBe(400);
    });
  });
});
