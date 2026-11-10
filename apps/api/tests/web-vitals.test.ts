/**
 * Real-user page speed (Core Web Vitals), kept in the API's memory.
 * Locks: any signed-in portal may report; anonymous may not; malformed samples are dropped,
 * never stored; pages are grouped with ids folded to ":id"; the summary is the 75th
 * percentile; only admins read it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import "./setup";
import app from "../src/app";
import { normalizeRoute, resetVitalsForTests, rate } from "../src/services/web-vitals.service";
import { generateClientToken, generateHrToken, generateToken } from "./helpers";

const admin = () => `Bearer ${generateToken("00000000-0000-0000-0000-0000000000a1", "a@x.test", ["Admin"])}`;
const staff = () => `Bearer ${generateToken("00000000-0000-0000-0000-0000000000a2", "s@x.test", ["Employee"])}`;

describe("web vitals", () => {
  beforeEach(() => resetVitalsForTests());

  it("folds ids out of page paths", () => {
    expect(normalizeRoute("/employees/3f2a1b4c-1111-2222-3333-444455556666?tab=x")).toBe("/employees/:id");
    expect(normalizeRoute("/reports/42/")).toBe("/reports/:id");
    expect(normalizeRoute("")).toBe("/");
    expect(rate("LCP", 2500)).toBe("good");
    expect(rate("LCP", 4001)).toBe("poor");
  });

  it("refuses an anonymous report", async () => {
    expect((await request(app).post("/v1/web-vitals").send({ app: "client", samples: [] })).status).toBe(401);
  });

  it("keeps valid samples from any signed-in portal and drops the rest", async () => {
    const post = (auth: string, body: unknown) => request(app).post("/v1/web-vitals").set("Authorization", auth).send(body);
    const r1 = await post(`Bearer ${generateClientToken("00000000-0000-0000-0000-0000000000c1", "c@x.test")}`, {
      app: "client",
      samples: [
        { route: "/campaigns/3f2a1b4c-1111-2222-3333-444455556666", name: "LCP", value: 1000 },
        { route: "/campaigns/3f2a1b4c-1111-2222-3333-444455556667", name: "LCP", value: 2000 },
        { route: "/campaigns/x", name: "LCP", value: -5 }, // negative
        { route: "/campaigns/x", name: "WAT", value: 5 }, // unknown metric
        { route: "/campaigns/x", name: "LCP", value: "fast" }, // not a number
      ],
    });
    expect(r1.status).toBe(200);
    expect(r1.body.data.kept).toBe(2);
    const r2 = await post(`Bearer ${generateHrToken("00000000-0000-0000-0000-0000000000h1", "h@x.test")}`, { app: "hr", samples: [{ route: "/report", name: "INP", value: 120 }] });
    expect(r2.body.data.kept).toBe(1);
    const r3 = await post(staff(), { app: "not-a-portal", samples: [{ route: "/", name: "LCP", value: 100 }] });
    expect(r3.body.data.kept).toBe(0);
    expect((await post(staff(), { app: "internal" })).status).toBe(400);

    const sum = await request(app).get("/v1/admin/web-vitals").set("Authorization", admin());
    expect(sum.status).toBe(200);
    const lcp = sum.body.data.rows.find((r: any) => r.app === "client" && r.name === "LCP");
    expect(lcp).toMatchObject({ route: "/campaigns/:id", samples: 2, p75: 2000, rating: "good" });
    expect(sum.body.data.rows.find((r: any) => r.app === "hr")).toMatchObject({ route: "/report", name: "INP", p75: 120 });
  });

  it("shows the summary to admins only", async () => {
    expect((await request(app).get("/v1/admin/web-vitals").set("Authorization", staff())).status).toBe(403);
    expect((await request(app).get("/v1/admin/web-vitals").set("Authorization", `Bearer ${generateHrToken("00000000-0000-0000-0000-0000000000h2", "h2@x.test")}`)).status).toBe(403);
    expect((await request(app).get("/v1/admin/web-vitals")).status).toBe(401);
  });
});
