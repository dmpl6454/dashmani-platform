import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import "./setup";

describe("Teams API", () => {
  let adminToken: string;

  beforeEach(async () => {
    await createTestRole("Admin", [
      { resource: "teams", action: "view", scope: "global" },
      { resource: "teams", action: "create", scope: "global" },
      { resource: "teams", action: "edit", scope: "global" },
      { resource: "teams", action: "delete", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);
  });

  describe("POST /v1/teams", () => {
    it("creates a department", async () => {
      const res = await request(app)
        .post("/v1/teams")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Content Team", type: "DEPARTMENT" });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe("Content Team");
      expect(res.body.data.type).toBe("DEPARTMENT");
    });

    it("creates a sub-team under a department", async () => {
      const deptRes = await request(app)
        .post("/v1/teams")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Growth", type: "DEPARTMENT" });

      const res = await request(app)
        .post("/v1/teams")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Instagram Growth", type: "TEAM", parentId: deptRes.body.data.id });

      expect(res.status).toBe(201);
      expect(res.body.data.parent.name).toBe("Growth");
    });
  });

  describe("DELETE /v1/teams/:id", () => {
    it("prevents deleting team with members", async () => {
      const { prisma } = await import("@dashmani/db");
      const deptRes = await request(app)
        .post("/v1/teams")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Occupied Team", type: "TEAM" });

      await createTestUser({ name: "Member" });
      const member = await prisma.user.findFirst({ where: { name: "Member" } });
      await prisma.user.update({ where: { id: member!.id }, data: { orgUnitId: deptRes.body.data.id } });

      const res = await request(app)
        .delete(`/v1/teams/${deptRes.body.data.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("HAS_MEMBERS");
    });
  });
});
