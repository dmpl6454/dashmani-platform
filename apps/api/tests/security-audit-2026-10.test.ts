/**
 * Regression tests for the 2026-10-28 security audit. Each case pins a hole that was
 * open before the fix: run against the old code, every assertion here fails.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app, { redactOauthQuery } from "../src/app";
import { prisma } from "@dashmani/db";
import { reportLinkSchema, isHttpUrl } from "@dashmani/shared";
import { createTestRole, createTestUser, generateToken, generateHrToken, generateClientToken } from "./helpers";
import { isPublicAddress, assertPublicHttpUrl } from "../src/utils/public-fetch";
import { safeUploadExtension } from "../src/middleware/upload";
import "./setup";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const EMPLOYEE_PERMS = [
  { resource: "employees", action: "view", scope: "own" },
  { resource: "tasks", action: "view", scope: "own" },
  { resource: "tasks", action: "edit", scope: "own" },
];
const ADMIN_PERMS = [
  { resource: "employees", action: "view", scope: "global" },
  { resource: "employees", action: "edit", scope: "global" },
  { resource: "tasks", action: "view", scope: "global" },
  { resource: "tasks", action: "edit", scope: "global" },
];

describe("security audit 2026-10-28", () => {
  let roleIds: Record<string, string>;
  beforeEach(async () => {
    const employee = await createTestRole("Employee", EMPLOYEE_PERMS);
    const admin = await createTestRole("Admin", ADMIN_PERMS);
    const superAdmin = await createTestRole("Super Admin", ADMIN_PERMS);
    roleIds = { employee: employee.id, admin: admin.id, superAdmin: superAdmin.id };
  });

  describe("presentation export cannot run shell commands", () => {
    it("refuses a theme outside Marp's built-in list, on create and update", async () => {
      const user = await createTestUser({ roleNames: ["Employee"] });
      const token = generateHrToken(user.id, user.email, ["Employee"]);
      const bad = await request(app)
        .post("/v1/hr/presentations")
        .set(auth(token))
        .send({ title: "x", markdown: "x", theme: "default; touch /tmp/pwned #" });
      expect(bad.status).toBe(400);

      const ok = await request(app).post("/v1/hr/presentations").set(auth(token)).send({ title: "x", markdown: "x" });
      expect(ok.status).toBe(201);
      expect(ok.body.data.theme).toBe("default");

      const upd = await request(app)
        .put(`/v1/hr/presentations/${ok.body.data.id}`)
        .set(auth(token))
        .send({ theme: "gaia$(id)" });
      expect(upd.status).toBe(400);
      const row = await prisma.presentation.findUniqueOrThrow({ where: { id: ok.body.data.id } });
      expect(row.theme).toBe("default");
    });
  });

  describe("employee-level accounts cannot read HR records", () => {
    it("profile data (Aadhaar, bank, salary) needs Admin or HR Manager", async () => {
      const victim = await createTestUser({ roleNames: ["Employee"] });
      await prisma.employeeProfile.create({ data: { userId: victim.id } });
      const snoop = await createTestUser({ roleNames: ["Employee"] });
      const res = await request(app)
        .get(`/v1/admin/employees/${victim.id}/profile-data`)
        .set(auth(generateToken(snoop.id, snoop.email, ["Employee"])));
      expect(res.status).toBe(403);

      const admin = await createTestUser({ roleNames: ["Admin"] });
      const ok = await request(app)
        .get(`/v1/admin/employees/${victim.id}/profile-data`)
        .set(auth(generateToken(admin.id, admin.email, ["Admin"])));
      expect(ok.status).toBe(200);
    });

    it("document and expense lists need Admin or HR Manager", async () => {
      const snoop = await createTestUser({ roleNames: ["Employee"] });
      const t = generateToken(snoop.id, snoop.email, ["Employee"]);
      for (const path of ["/v1/admin/documents", "/v1/admin/documents/pending", "/v1/admin/expenses", "/v1/admin/complaints", "/v1/admin/applications"]) {
        expect((await request(app).get(path).set(auth(t))).status, path).toBe(403);
      }
    });

    it("GET /employees/:id never returns the password hash", async () => {
      const target = await createTestUser({ roleNames: ["Admin"] });
      const viewer = await createTestUser({ roleNames: ["Employee"] });
      const viewerAuth = auth(generateToken(viewer.id, viewer.email, ["Employee"]));
      // Since scope enforcement (2026-10-28) an own-scope grant reads only its own record.
      const other = await request(app).get(`/v1/employees/${target.id}`).set(viewerAuth);
      expect(other.status).toBe(403);
      const own = await request(app).get(`/v1/employees/${viewer.id}`).set(viewerAuth);
      expect(own.status).toBe(200);
      expect(own.body.data.passwordHash).toBeUndefined();
      expect(JSON.stringify(own.body)).not.toContain("$2b$");
    });
  });

  describe("Super Admin is kept to Super Admins", () => {
    it("an Admin cannot grant Super Admin, even to themselves", async () => {
      const admin = await createTestUser({ roleNames: ["Admin"] });
      const res = await request(app)
        .put(`/v1/admin/users/${admin.id}/roles`)
        .set(auth(generateToken(admin.id, admin.email, ["Admin"])))
        .send({ roleIds: [roleIds.superAdmin] });
      expect(res.status).toBe(403);
      expect(await prisma.userRole.count({ where: { userId: admin.id, roleId: roleIds.superAdmin } })).toBe(0);
    });

    it("an Admin cannot strip a Super Admin's roles", async () => {
      const admin = await createTestUser({ roleNames: ["Admin"] });
      const sa = await createTestUser({ roleNames: ["Super Admin"] });
      const res = await request(app)
        .put(`/v1/admin/users/${sa.id}/roles`)
        .set(auth(generateToken(admin.id, admin.email, ["Admin"])))
        .send({ roleIds: [roleIds.employee] });
      expect(res.status).toBe(403);
    });

    it("a Super Admin still can", async () => {
      const sa = await createTestUser({ roleNames: ["Super Admin"] });
      const target = await createTestUser({ roleNames: ["Employee"] });
      const res = await request(app)
        .put(`/v1/admin/users/${target.id}/roles`)
        .set(auth(generateToken(sa.id, sa.email, ["Super Admin"])))
        .send({ roleIds: [roleIds.superAdmin] });
      expect(res.status).toBe(200);
    });

    it("a JWT claiming Admin is not enough when the database says otherwise", async () => {
      const demoted = await createTestUser({ roleNames: ["Employee"] });
      const target = await createTestUser({ roleNames: ["Employee"] });
      const res = await request(app)
        .put(`/v1/admin/users/${target.id}/roles`)
        .set(auth(generateToken(demoted.id, demoted.email, ["Admin"])))
        .send({ roleIds: [roleIds.employee] });
      expect(res.status).toBe(403);
    });
  });

  describe("tasks are scoped to their assignee or creator", () => {
    it("an own-scope employee cannot read or edit someone else's task", async () => {
      const owner = await createTestUser({ roleNames: ["Employee"] });
      const other = await createTestUser({ roleNames: ["Employee"] });
      const task = await prisma.task.create({ data: { title: "private", assigneeId: owner.id, createdById: owner.id } });
      const t = generateToken(other.id, other.email, ["Employee"]);
      expect((await request(app).get(`/v1/tasks/${task.id}`).set(auth(t))).status).toBe(404);
      expect((await request(app).get(`/v1/tasks/${task.id}/comments`).set(auth(t))).status).toBe(404);
      expect((await request(app).put(`/v1/tasks/${task.id}/status`).set(auth(t)).send({ status: "DONE" })).status).toBe(404);
      const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(after.status).not.toBe("DONE");

      const mine = generateToken(owner.id, owner.email, ["Employee"]);
      expect((await request(app).get(`/v1/tasks/${task.id}`).set(auth(mine))).status).toBe(200);
    });
  });

  describe("server-side fetches stay on the public internet", () => {
    it("classifies addresses", () => {
      for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
        expect(isPublicAddress(ip), ip).toBe(false);
      }
      for (const ip of ["8.8.8.8", "104.21.9.81", "2606:4700::1111"]) {
        expect(isPublicAddress(ip), ip).toBe(true);
      }
    });

    it("refuses non-http schemes, odd ports and internal hosts", async () => {
      for (const u of ["file:///etc/passwd", "http://127.0.0.1/", "http://example.com:3000/", "http://169.254.169.254/latest", "http://[::1]/", "http://localhost/"]) {
        await expect(assertPublicHttpUrl(u), u).rejects.toThrow();
      }
    });

    it("/admin/link-preview is staff only", async () => {
      const client = await prisma.client.create({
        data: { companyName: "C", contactName: "C", email: `c-${Date.now()}@x.com`, passwordHash: "x" },
      });
      const res = await request(app)
        .get("/v1/admin/link-preview?url=http://127.0.0.1:4000/")
        .set(auth(generateClientToken(client.id, client.email)));
      expect(res.status).toBe(403);
    });
  });

  describe("uploads and links", () => {
    it("never keeps an extension the MIME type does not allow", () => {
      expect(safeUploadExtension("application/pdf", "cv.html")).toBe(".pdf");
      expect(safeUploadExtension("image/png", "x.svg")).toBe(".png");
      expect(safeUploadExtension("image/jpeg", "Photo.JPEG")).toBe(".jpeg");
      expect(safeUploadExtension("application/vnd.ms-excel", "list.csv")).toBe(".csv");
      expect(safeUploadExtension("text/html", "x.html")).toBe("");
    });

    it("report links must be http(s)", () => {
      expect(isHttpUrl("javascript:alert(1)")).toBe(false);
      const bad = reportLinkSchema.safeParse({ accountId: "11111111-1111-4111-8111-111111111111", platform: "instagram", url: "javascript:alert(document.domain)" });
      expect(bad.success).toBe(false);
      const ok = reportLinkSchema.safeParse({ accountId: "11111111-1111-4111-8111-111111111111", platform: "instagram", url: "https://www.instagram.com/reel/abc/" });
      expect(ok.success).toBe(true);
    });

    it("invite tokens are blanked in the access log", () => {
      expect(redactOauthQuery("/v1/client/auth/join/secret-token")).toBe("/v1/client/auth/join/[redacted]");
      expect(redactOauthQuery("/v1/admin/users/invite/abc-123")).toBe("/v1/admin/users/invite/[redacted]");
    });
  });
});
