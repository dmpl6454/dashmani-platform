/**
 * GET /v1/admin/meta/posting-watch — the gate and the envelope.
 *
 * The gate is [authenticate, requireInternalUser, requireAdminRole]: decided from the
 * signed JWT with NO database query, because the dashboard polls it every minute. Admin
 * and Super Admin pass; every other internal role, and every HR or client-portal token
 * (all three portals share one JWT secret), is refused.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app";
import { invalidatePostingWatchCache, resetPostingWatchStateForTests } from "../src/services/meta-oauth/posting-watch.service";
import "./setup";

const URL = "/v1/admin/meta/posting-watch";
const SECRET = process.env.JWT_SECRET || "dev-secret";
const token = (type: string, roles: string[]) =>
  jwt.sign({ userId: "00000000-0000-0000-0000-000000000001", email: "x@zz.test", roles, type }, SECRET, { expiresIn: "15m" });

describe("GET /v1/admin/meta/posting-watch", () => {
  beforeEach(() => {
    resetPostingWatchStateForTests();
    invalidatePostingWatchCache();
  });

  it("serves an Admin (and a Super Admin, any casing) without touching permissions", async () => {
    for (const roles of [["Admin"], ["super admin"], ["Employee", "Admin"]]) {
      const res = await request(app).get(URL).set("Authorization", `Bearer ${token("employee", roles)}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({ status: "ok", channels: [], notConnected: [] });
      expect(res.body.data.counts).toMatchObject({ monitored: 0, not_connected: 0 });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("refuses every non-admin internal role", async () => {
    for (const roles of [["Employee"], ["Team Lead"], ["Senior Employee"], []]) {
      const res = await request(app).get(URL).set("Authorization", `Bearer ${token("employee", roles)}`);
      expect(res.status).toBe(403);
    }
  });

  it("refuses HR- and client-portal tokens even when they carry an Admin role claim", async () => {
    for (const type of ["hr", "client"]) {
      const res = await request(app).get(URL).set("Authorization", `Bearer ${token(type, ["Admin"])}`);
      expect(res.status).toBe(403);
    }
  });

  it("requires a token", async () => {
    expect((await request(app).get(URL)).status).toBe(401);
  });
});
