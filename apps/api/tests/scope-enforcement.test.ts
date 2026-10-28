/**
 * Routes that return company-wide data need a GLOBAL grant. rbac.ts used to check
 * only that a permission existed, so the Employee role's `employees.view` (scope own)
 * and the Team Lead / Senior Employee `reports.view` (team / own) read every
 * employee, every channel and every report.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import "./setup";
import app from "../src/app";
import { createTestRole, createTestUser, generateToken } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("scope enforcement on company-wide routes", () => {
  let employee: { id: string; token: string };
  let teamLead: { id: string; token: string };
  let admin: { id: string; token: string };

  beforeEach(async () => {
    await createTestRole("Employee", [
      { resource: "employees", action: "view", scope: "own" },
      { resource: "accounts", action: "view", scope: "own" },
      { resource: "reports", action: "view", scope: "own" },
    ]);
    await createTestRole("Team Lead", [
      { resource: "employees", action: "view", scope: "team" },
      { resource: "accounts", action: "view", scope: "team" },
      { resource: "reports", action: "view", scope: "team" },
    ]);
    await createTestRole("Admin", ["employees", "accounts", "reports"].map((resource) => ({ resource, action: "view", scope: "global" })));

    const make = async (role: string) => {
      const u = await createTestUser({ roleNames: [role] });
      return { id: u.id, token: generateToken(u.id, u.email, [role]) };
    };
    employee = await make("Employee");
    teamLead = await make("Team Lead");
    admin = await make("Admin");
  });

  const wideRoutes = [
    "/v1/employees",
    "/v1/accounts",
    "/v1/workload",
    "/v1/accounts/sync-followers/status",
    "/v1/admin/auto-teams",
    "/v1/admin/reports/summary",
    "/v1/admin/reports/true-links",
  ];

  for (const path of wideRoutes) {
    it(`${path}: own and team grants are refused, a global grant passes`, async () => {
      expect((await request(app).get(path).set(auth(employee.token))).status).toBe(403);
      expect((await request(app).get(path).set(auth(teamLead.token))).status).toBe(403);
      expect((await request(app).get(path).set(auth(admin.token))).status).not.toBe(403);
    });
  }

  it("an employee can read their own record but nobody else's", async () => {
    expect((await request(app).get(`/v1/employees/${employee.id}`).set(auth(employee.token))).status).toBe(200);
    expect((await request(app).get(`/v1/employees/${employee.id}/accounts`).set(auth(employee.token))).status).toBe(200);
    expect((await request(app).get(`/v1/employees/${admin.id}`).set(auth(employee.token))).status).toBe(403);
    expect((await request(app).get(`/v1/employees/${admin.id}/accounts`).set(auth(employee.token))).status).toBe(403);
    expect((await request(app).get(`/v1/employees/${employee.id}`).set(auth(admin.token))).status).toBe(200);
  });

  it("an own-scope grant cannot trigger a follower sync", async () => {
    const res = await request(app).post("/v1/accounts/00000000-0000-0000-0000-000000000000/sync-followers").set(auth(employee.token));
    expect(res.status).toBe(403);
  });
});
