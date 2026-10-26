/**
 * Connecting the portals: GET /auth/portals (which staff portals an account may enter),
 * POST /auth/handoff (a one-time code for a target portal, as its /login#handoff= URL) and
 * POST /auth/handoff/exchange (the target's login page turns the code into its own session).
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app";
import { prisma } from "@dashmani/db";
import { createTestUser, generateClientToken, generateHrToken, generateToken } from "./helpers";
import { _expireHandoffsForTest } from "../src/services/portal-handoff.service";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const decode = (t: string) => jwt.decode(t) as { type: string; userId: string };
const codeOf = (url: string) => url.split("handoff=")[1];

// `roles` / `role_permissions` are not in the suite's TRUNCATE list (the seed's roles persist), so
// the roles are upserted rather than created.
async function ensureRole(name: string, perms: Array<{ resource: string; action: string; scope: string }>) {
  const role = await prisma.role.upsert({ where: { name }, update: {}, create: { name, description: `${name} (test)` } });
  for (const p of perms) {
    await prisma.rolePermission.upsert({
      where: { roleId_resource_action_scope: { roleId: role.id, ...p } },
      update: {},
      create: { roleId: role.id, ...p },
    });
  }
  return role;
}

// Everything sits under one describe so the seeding hook runs AFTER the global truncation in
// tests/setup.ts: Vitest 1.x runs hooks of the same level in parallel (sequence.hooks: "parallel"),
// and a root-level beforeEach would race the TRUNCATE and lose its rows mid-way.
describe("connecting the portals", () => {

let salesUser: { id: string; email: string };
let employee: { id: string; email: string };
let salesToken: string;
let employeeToken: string;

beforeEach(async () => {
  await ensureRole("Sales", [
    { resource: "sales", action: "view", scope: "global" },
    { resource: "sales", action: "manage", scope: "global" },
  ]);
  await ensureRole("Employee", [{ resource: "tasks", action: "view", scope: "global" }]);
  salesUser = await createTestUser({ email: "seller@ds.test", roleNames: ["Sales"] });
  employee = await createTestUser({ email: "plain@ds.test", roleNames: ["Employee"] });
  salesToken = generateToken(salesUser.id, salesUser.email, ["Sales"]);
  employeeToken = generateToken(employee.id, employee.email, ["Employee"]);
});

describe("GET /auth/portals", () => {
  it("tells each staff account which portals it may enter, and refuses non-staff tokens", async () => {
    const forSales = await request(app).get("/v1/auth/portals").set(auth(salesToken));
    expect(forSales.status).toBe(200);
    expect(forSales.body.data.portals.map((p: { key: string; access: boolean }) => [p.key, p.access])).toEqual([
      ["internal", true], ["hr", true], ["sales", true],
    ]);
    expect(forSales.body.data.links.map((l: { key: string }) => l.key)).toEqual(["client", "creators", "jobs", "web"]);
    expect(forSales.body.data.portals.every((p: { url: string }) => /^https?:\/\/[^/]+$/.test(p.url))).toBe(true);

    const forEmployee = await request(app).get("/v1/auth/portals").set(auth(employeeToken));
    expect(forEmployee.body.data.portals.find((p: { key: string }) => p.key === "sales").access).toBe(false);

    // An HR token is a staff token too; a client token is not; no token is not.
    expect((await request(app).get("/v1/auth/portals").set(auth(generateHrToken(employee.id, employee.email)))).status).toBe(200);
    expect((await request(app).get("/v1/auth/portals").set(auth(generateClientToken("client-1", "c@brand.test")))).status).toBe(403);
    expect((await request(app).get("/v1/auth/portals")).status).toBe(401);
  });
});

describe("handoff between the staff portals", () => {
  it("opens the sales portal from the staff portal without a second sign-in, once", async () => {
    const h = await request(app).post("/v1/auth/handoff").set(auth(salesToken)).send({ target: "sales" });
    expect(h.status).toBe(200);
    expect(h.body.data.url).toMatch(/\/login#handoff=[0-9a-f]{64}$/);
    expect(h.body.data.expiresInSeconds).toBe(60);

    const ex = await request(app).post("/v1/auth/handoff/exchange").send({ code: codeOf(h.body.data.url) });
    expect(ex.status).toBe(200);
    expect(ex.body.data.target).toBe("sales");
    expect(ex.body.data.user).toMatchObject({ id: salesUser.id, email: "seller@ds.test", roles: ["Sales"] });
    expect(decode(ex.body.data.accessToken)).toMatchObject({ type: "employee", userId: salesUser.id });
    // The minted session really works on the target portal's API.
    expect((await request(app).get("/v1/sales/inventory").set(auth(ex.body.data.accessToken))).status).toBe(200);
    // One use only.
    const again = await request(app).post("/v1/auth/handoff/exchange").send({ code: codeOf(h.body.data.url) });
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe("HANDOFF_INVALID");
  });

  it("mints an HR session for the HR portal, and a staff session back from an HR token", async () => {
    const toHr = await request(app).post("/v1/auth/handoff").set(auth(employeeToken)).send({ target: "hr" });
    expect(toHr.status).toBe(200);
    const hr = await request(app).post("/v1/auth/handoff/exchange").send({ code: codeOf(toHr.body.data.url) });
    expect(hr.status).toBe(200);
    expect(hr.body.data.target).toBe("hr");
    expect(decode(hr.body.data.accessToken)).toMatchObject({ type: "hr", userId: employee.id });
    // The HR session may go the other way too.
    const back = await request(app).post("/v1/auth/handoff").set(auth(hr.body.data.accessToken)).send({ target: "internal" });
    expect(back.status).toBe(200);
    const staff = await request(app).post("/v1/auth/handoff/exchange").send({ code: codeOf(back.body.data.url) });
    expect(staff.status).toBe(200);
    expect(decode(staff.body.data.accessToken)).toMatchObject({ type: "employee", userId: employee.id });
  });

  it("refuses a portal the account has no role for, an unknown target, a bad code and an expired code", async () => {
    const denied = await request(app).post("/v1/auth/handoff").set(auth(employeeToken)).send({ target: "sales" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PORTAL_NO_ACCESS");
    expect((await request(app).post("/v1/auth/handoff").set(auth(employeeToken)).send({ target: "client" })).status).toBe(400);
    expect((await request(app).post("/v1/auth/handoff").send({ target: "hr" })).status).toBe(401);
    expect((await request(app).post("/v1/auth/handoff/exchange").send({ code: "f".repeat(64) })).status).toBe(410);
    expect((await request(app).post("/v1/auth/handoff/exchange").send({ code: "nope" })).status).toBe(400);

    const h = await request(app).post("/v1/auth/handoff").set(auth(salesToken)).send({ target: "sales" });
    _expireHandoffsForTest();
    expect((await request(app).post("/v1/auth/handoff/exchange").send({ code: codeOf(h.body.data.url) })).status).toBe(410);
  });
});

});
