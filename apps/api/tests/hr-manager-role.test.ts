/**
 * The HR Manager role: runs the people side of the internal portal, and cannot
 * reach past it — no reports, and no way to grant, edit or deactivate an
 * Admin / Super Admin / HR Manager (middleware/role-guard.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import "./setup";
import app from "../src/app";
import { prisma } from "@dashmani/db";
import { DEFAULT_ROLES } from "@dashmani/shared";
import { createTestRole, createTestUser, generateToken } from "./helpers";

const ADMIN_PERMS = ["employees", "attendance", "reports", "teams", "roles"].flatMap((resource) =>
  ["view", "create", "edit", "delete", "approve", "export", "manage"].map((action) => ({ resource, action, scope: "global" })),
);

// ⚠️ The beforeEach lives INSIDE a describe: at file top level it runs in parallel
// with tests/setup.ts's TRUNCATE (Vitest 1 runs same-level hooks in parallel).
describe("HR Manager role", () => {
let hrToken: string;
let adminToken: string;
let roleIds: Record<string, string>;

beforeEach(async () => {
  const admin = await createTestRole("Admin", ADMIN_PERMS);
  const superAdmin = await createTestRole("Super Admin", ADMIN_PERMS);
  const hr = await createTestRole(DEFAULT_ROLES.HR_MANAGER.name, DEFAULT_ROLES.HR_MANAGER.permissions.map((p) => ({ ...p })));
  const employee = await createTestRole("Employee", [{ resource: "employees", action: "view", scope: "own" }]);
  const sales = await createTestRole("Sales", [{ resource: "clients", action: "view", scope: "global" }]);
  roleIds = { admin: admin.id, superAdmin: superAdmin.id, hr: hr.id, employee: employee.id, sales: sales.id };

  const hrUser = await createTestUser({ roleNames: ["HR Manager"] });
  hrToken = generateToken(hrUser.id, hrUser.email, ["HR Manager"]);
  const adminUser = await createTestUser({ roleNames: ["Admin"] });
  adminToken = generateToken(adminUser.id, adminUser.email, ["Admin"]);
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

function newEmployee(roleId: string) {
  return {
    name: "New Hire",
    email: `hire-${Math.random().toString(36).slice(2)}@test.com`,
    password: "TestPass123!",
    roleIds: [roleId],
  };
}

describe("HR Manager — HR features", () => {
  it("lists employees and leave requests", async () => {
    expect((await request(app).get("/v1/employees").set(auth(hrToken))).status).toBe(200);
    expect((await request(app).get("/v1/admin/leave-requests").set(auth(hrToken))).status).toBe(200);
  });

  it("creates an Employee", async () => {
    const res = await request(app).post("/v1/employees").set(auth(hrToken)).send(newEmployee(roleIds.employee));
    expect(res.status).toBe(201);
  });

  it("sends and lists announcements", async () => {
    const post = await request(app).post("/v1/admin/announcements").set(auth(hrToken)).send({ title: "Holiday", message: "Office closed Friday" });
    expect(post.status).toBe(201);
    expect((await request(app).get("/v1/admin/announcements").set(auth(hrToken))).status).toBe(200);
  });

  it("cannot read link reports", async () => {
    expect((await request(app).get("/v1/admin/reports/summary").set(auth(hrToken))).status).toBe(403);
  });
});

describe("HR Manager — cannot reach admins", () => {
  for (const which of ["admin", "superAdmin", "hr", "sales"] as const) {
    it(`cannot create a user with the ${which} role`, async () => {
      const res = await request(app).post("/v1/employees").set(auth(hrToken)).send(newEmployee(roleIds[which]));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ROLE_NOT_ASSIGNABLE");
      expect(await prisma.user.count({ where: { name: "New Hire" } })).toBe(0);
    });
  }

  it("cannot grant Admin through an employee edit", async () => {
    const emp = await createTestUser({ roleNames: ["Employee"] });
    const res = await request(app).put(`/v1/employees/${emp.id}`).set(auth(hrToken)).send({ roleIds: [roleIds.admin] });
    expect(res.status).toBe(403);
    expect(await prisma.userRole.count({ where: { userId: emp.id, roleId: roleIds.admin } })).toBe(0);
  });

  it("cannot invite or create an admin via the admin-user routes", async () => {
    const invite = await request(app).post("/v1/admin/users/invite").set(auth(hrToken)).send({ email: "x@test.com", roleIds: [roleIds.admin] });
    expect(invite.status).toBe(403);
    const create = await request(app).post("/v1/admin/users/create").set(auth(hrToken))
      .send({ name: "X", email: "y@test.com", password: "TestPass123!", roleIds: [roleIds.superAdmin] });
    expect(create.status).toBe(403);
  });

  it("cannot edit, deactivate or change the salary of an Admin", async () => {
    const target = await createTestUser({ roleNames: ["Admin"] });
    const edit = await request(app).put(`/v1/employees/${target.id}`).set(auth(hrToken)).send({ status: "INACTIVE" });
    expect(edit.status).toBe(403);
    expect(edit.body.error.code).toBe("PROTECTED_USER");
    expect((await request(app).delete(`/v1/employees/${target.id}`).set(auth(hrToken))).status).toBe(403);
    expect((await request(app).put(`/v1/admin/employees/${target.id}/profile-data`).set(auth(hrToken)).send({ salary: 1 })).status).toBe(403);
    // Two routers mount handlers on these paths; the earlier-mounted ones are guarded too.
    expect((await request(app).put(`/v1/admin/employees/${target.id}/profile`).set(auth(hrToken)).send({ salary: 1 })).status).toBe(403);
    expect((await request(app).put(`/v1/admin/employees/${target.id}/reject`).set(auth(hrToken))).status).toBe(403);
    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after?.status).toBe("ACTIVE");
    expect(after?.deletedAt).toBeNull();
  });

  it("can still edit a Sales employee's record (only granting Sales is admin-only)", async () => {
    const target = await createTestUser({ roleNames: ["Sales"] });
    const res = await request(app).put(`/v1/employees/${target.id}`).set(auth(hrToken)).send({ name: "Renamed Seller" });
    expect(res.status).toBe(200);
  });

  it("cannot change role assignments directly", async () => {
    const emp = await createTestUser({ roleNames: ["Employee"] });
    const res = await request(app).put(`/v1/admin/users/${emp.id}/roles`).set(auth(hrToken)).send({ roleIds: [roleIds.hr] });
    expect(res.status).toBe(403);
  });

  it("is judged by the database, not a stale token claiming Admin", async () => {
    const hrUser = await createTestUser({ roleNames: ["HR Manager"] });
    const forged = generateToken(hrUser.id, hrUser.email, ["HR Manager", "Admin"]);
    const res = await request(app).post("/v1/employees").set(auth(forged)).send(newEmployee(roleIds.admin));
    expect(res.status).toBe(403);
  });
});

describe("Admin is unaffected", () => {
  it("still creates an HR Manager and edits an Admin", async () => {
    const res = await request(app).post("/v1/employees").set(auth(adminToken)).send(newEmployee(roleIds.hr));
    expect(res.status).toBe(201);
    const target = await createTestUser({ roleNames: ["Admin"] });
    const edit = await request(app).put(`/v1/employees/${target.id}`).set(auth(adminToken)).send({ name: "Renamed Admin" });
    expect(edit.status).toBe(200);
  });
});
});
