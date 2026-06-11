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
    it("auto-unassigns members and deletes the team", async () => {
      const { prisma } = await import("@dashmani/db");
      const teamRes = await request(app)
        .post("/v1/teams")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Occupied Team", type: "TEAM" });
      const teamId = teamRes.body.data.id;

      await createTestUser({ name: "Member" });
      const member = await prisma.user.findFirst({ where: { name: "Member" } });
      await request(app)
        .post(`/v1/teams/${teamId}/members`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ userId: member!.id });

      const res = await request(app)
        .delete(`/v1/teams/${teamId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      // Member survives; their primary team is cleared (no other membership).
      const after = await prisma.user.findUnique({ where: { id: member!.id } });
      expect(after).not.toBeNull();
      expect(after!.orgUnitId).toBeNull();
    });
  });

  describe("Multi-team membership", () => {
    it("lets one employee belong to two teams at once", async () => {
      const { prisma } = await import("@dashmani/db");
      const teamA = (await request(app).post("/v1/teams").set("Authorization", `Bearer ${adminToken}`).send({ name: "Team A", type: "TEAM" })).body.data;
      const teamB = (await request(app).post("/v1/teams").set("Authorization", `Bearer ${adminToken}`).send({ name: "Team B", type: "TEAM" })).body.data;

      await createTestUser({ name: "Multi" });
      const user = await prisma.user.findFirst({ where: { name: "Multi" } });

      // Add to A (becomes primary), then to B — must NOT remove A.
      await request(app).post(`/v1/teams/${teamA.id}/members`).set("Authorization", `Bearer ${adminToken}`).send({ userId: user!.id });
      await request(app).post(`/v1/teams/${teamB.id}/members`).set("Authorization", `Bearer ${adminToken}`).send({ userId: user!.id });

      const memberships = await prisma.teamMembership.findMany({ where: { userId: user!.id } });
      expect(memberships).toHaveLength(2);
      expect(memberships.map((m) => m.orgUnitId).sort()).toEqual([teamA.id, teamB.id].sort());

      // Both teams list the member.
      const aDetail = (await request(app).get(`/v1/teams/${teamA.id}`).set("Authorization", `Bearer ${adminToken}`)).body.data;
      const bDetail = (await request(app).get(`/v1/teams/${teamB.id}`).set("Authorization", `Bearer ${adminToken}`)).body.data;
      expect(aDetail.members.map((m: any) => m.id)).toContain(user!.id);
      expect(bDetail.members.map((m: any) => m.id)).toContain(user!.id);

      // Removing from B leaves A intact and primary.
      await request(app).delete(`/v1/teams/${teamB.id}/members/${user!.id}`).set("Authorization", `Bearer ${adminToken}`);
      const remaining = await prisma.teamMembership.findMany({ where: { userId: user!.id } });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].orgUnitId).toBe(teamA.id);
      const refreshed = await prisma.user.findUnique({ where: { id: user!.id } });
      expect(refreshed!.orgUnitId).toBe(teamA.id);
    });

    it("re-points primary to a surviving team when the primary team is left", async () => {
      const { prisma } = await import("@dashmani/db");
      const teamA = (await request(app).post("/v1/teams").set("Authorization", `Bearer ${adminToken}`).send({ name: "Primary A", type: "TEAM" })).body.data;
      const teamB = (await request(app).post("/v1/teams").set("Authorization", `Bearer ${adminToken}`).send({ name: "Secondary B", type: "TEAM" })).body.data;

      await createTestUser({ name: "Repoint" });
      const user = await prisma.user.findFirst({ where: { name: "Repoint" } });
      await request(app).post(`/v1/teams/${teamA.id}/members`).set("Authorization", `Bearer ${adminToken}`).send({ userId: user!.id });
      await request(app).post(`/v1/teams/${teamB.id}/members`).set("Authorization", `Bearer ${adminToken}`).send({ userId: user!.id });

      // A is primary; leaving A must promote B to primary, not orphan the user.
      await request(app).delete(`/v1/teams/${teamA.id}/members/${user!.id}`).set("Authorization", `Bearer ${adminToken}`);
      const refreshed = await prisma.user.findUnique({ where: { id: user!.id } });
      expect(refreshed!.orgUnitId).toBe(teamB.id);
    });
  });
});
