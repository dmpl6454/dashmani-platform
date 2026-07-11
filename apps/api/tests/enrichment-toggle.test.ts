import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import { prisma } from "@dashmani/db";
import { ENRICHMENT_ENABLED_KEY as KEY } from "../src/constants/enrichment";
import "./setup";

// system_settings is NOT truncated by tests/setup.ts's beforeEach TRUNCATE (unlike
// most tables) — this file owns cleanup of the one key it writes, so a leftover
// "enrichment.enabled" row from this suite can never leak into another test file.
// Imports the SAME constant the route/cron use, so this test can never test a
// different key than the code actually reads/writes.

describe("Enrichment toggle (admin kill-switch for LLM entity-extraction)", () => {
  let viewToken: string;
  let manageToken: string;

  beforeEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: KEY } });

    await createTestRole("ReportsViewer", [{ resource: "reports", action: "view", scope: "global" }]);
    const viewer = await createTestUser({ email: `viewer-${Date.now()}@test.com`, roleNames: ["ReportsViewer"] });
    viewToken = generateToken(viewer.id, viewer.email, ["ReportsViewer"]);

    await createTestRole("ReportsManager", [
      { resource: "reports", action: "view", scope: "global" },
      { resource: "reports", action: "manage", scope: "global" },
    ]);
    const manager = await createTestUser({ email: `manager-${Date.now()}@test.com`, roleNames: ["ReportsManager"] });
    manageToken = generateToken(manager.id, manager.email, ["ReportsManager"]);
  });

  afterEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: KEY } });
  });

  describe("GET /v1/admin/enrichment/toggle", () => {
    it("defaults to enabled when the key has never been set", async () => {
      const res = await request(app)
        .get("/v1/admin/enrichment/toggle")
        .set("Authorization", `Bearer ${viewToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);
    });

    it("reflects a stored 'false' value as disabled", async () => {
      await prisma.systemSetting.create({ data: { key: KEY, value: "false" } });

      const res = await request(app)
        .get("/v1/admin/enrichment/toggle")
        .set("Authorization", `Bearer ${viewToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(false);
    });

    it("reflects a stored 'true' value as enabled", async () => {
      await prisma.systemSetting.create({ data: { key: KEY, value: "true" } });

      const res = await request(app)
        .get("/v1/admin/enrichment/toggle")
        .set("Authorization", `Bearer ${viewToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);
    });

    it("returns 403 without reports:view permission", async () => {
      await createTestRole("NoPerms", []);
      const user = await createTestUser({ email: `noperms-${Date.now()}@test.com`, roleNames: ["NoPerms"] });
      const token = generateToken(user.id, user.email, ["NoPerms"]);

      const res = await request(app)
        .get("/v1/admin/enrichment/toggle")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it("returns 401 without authentication", async () => {
      const res = await request(app).get("/v1/admin/enrichment/toggle");
      expect(res.status).toBe(401);
    });
  });

  describe("PUT /v1/admin/enrichment/toggle", () => {
    it("disables extraction — upserts the system_settings row to 'false'", async () => {
      const res = await request(app)
        .put("/v1/admin/enrichment/toggle")
        .set("Authorization", `Bearer ${manageToken}`)
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(false);

      const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
      expect(row?.value).toBe("false");
    });

    it("re-enables extraction — upserts back to 'true'", async () => {
      await prisma.systemSetting.create({ data: { key: KEY, value: "false" } });

      const res = await request(app)
        .put("/v1/admin/enrichment/toggle")
        .set("Authorization", `Bearer ${manageToken}`)
        .send({ enabled: true });

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);

      const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
      expect(row?.value).toBe("true");
    });

    it("rejects a non-boolean body with 400", async () => {
      const res = await request(app)
        .put("/v1/admin/enrichment/toggle")
        .set("Authorization", `Bearer ${manageToken}`)
        .send({ enabled: "false" });

      expect(res.status).toBe(400);
    });

    it("returns 403 for a reports:view-only token (manage required to write)", async () => {
      const res = await request(app)
        .put("/v1/admin/enrichment/toggle")
        .set("Authorization", `Bearer ${viewToken}`)
        .send({ enabled: false });

      expect(res.status).toBe(403);
    });

    it("returns 401 without authentication", async () => {
      const res = await request(app).put("/v1/admin/enrichment/toggle").send({ enabled: false });
      expect(res.status).toBe(401);
    });
  });
});
