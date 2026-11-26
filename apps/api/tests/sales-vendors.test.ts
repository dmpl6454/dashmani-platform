/**
 * External pages + vendors and a Pipeline campaign's page list and revenue (owner's Pipeline
 * feedback, 2026-11-18). Sales-only: everything here is behind sales:view / sales:manage.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../src/app";
import { createTestRole, createTestUser, generateToken } from "./helpers";
import { invalidateInventoryCache } from "../src/services/sales/inventory.service";
import { upsertExternalPages } from "../src/services/sales/external-pages.service";
import { createProjectFixture } from "./pipeline/fixtures-messages";
import { seedPipelinePhases } from "./pipeline/pipeline-helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("sales: external pages, vendors, campaign pages and revenue", () => {
  let salesToken: string;
  let viewerToken: string;
  let employeeToken: string;
  let salesId: string;
  let projectId: string;

  beforeEach(async () => {
    await createTestRole("Sales", ["view", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Viewer", [{ resource: "sales", action: "view", scope: "global" }]);
    await createTestRole("Employee", [{ resource: "attendance", action: "view", scope: "own" }]);
    const s = await createTestUser({ name: "Sales Person", roleNames: ["Sales"] });
    const v = await createTestUser({ name: "Read Only", roleNames: ["Viewer"] });
    const e = await createTestUser({ name: "Plain Employee", roleNames: ["Employee"] });
    salesId = s.id;
    salesToken = generateToken(s.id, s.email, ["Sales"]);
    viewerToken = generateToken(v.id, v.email, ["Viewer"]);
    employeeToken = generateToken(e.id, e.email, ["Employee"]);
    await seedPipelinePhases();
    projectId = (await createProjectFixture({ ownerId: s.id, title: "Diwali launch" })).id;
    invalidateInventoryCache();
  });

  it("adds vendors and their pages; the inventory names the vendor", async () => {
    const v = await request(app).post("/v1/sales/vendors").set(auth(salesToken)).send({ name: "Archit", phone: "+91 98200 00000", email: "" });
    expect(v.status).toBe(201);
    expect(v.body.data).toMatchObject({ name: "Archit", email: null, active: true, pageCount: 0 });
    const page = await request(app).post("/v1/sales/external-pages").set(auth(salesToken)).send({
      vendorId: v.body.data.id, platform: "facebook", profileUrl: "https://www.facebook.com/MemeKaKeeda", name: "Meme Ka Keeda", followers: 2_400_000, category: "Meme", brandPaise: 300_000,
    });
    expect(page.status).toBe(201);
    expect(page.body.data).toMatchObject({ handle: "memekakeeda", category: "Meme", vendor: { name: "Archit" } });
    // The same handle on the same platform is one page.
    const dup = await request(app).post("/v1/sales/external-pages").set(auth(salesToken)).send({ platform: "facebook", handle: "@MemeKaKeeda", name: "Copy" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("HANDLE_TAKEN");
    const list = await request(app).get("/v1/sales/vendors").set(auth(viewerToken));
    expect(list.body.data[0]).toMatchObject({ name: "Archit", pageCount: 1 });
    const inv = await request(app).get("/v1/sales/inventory").set(auth(viewerToken));
    expect(inv.body.data.find((c: any) => c.handle === "memekakeeda")).toMatchObject({ source: "external", vendorName: "Archit", category: "Meme", platform: "facebook" });
    // Switching the page off takes it out of the inventory at once.
    const off = await request(app).put(`/v1/sales/external-pages/${page.body.data.id}`).set(auth(salesToken)).send({ ...page.body.data, vendorId: v.body.data.id, active: false });
    expect(off.status).toBe(200);
    const inv2 = await request(app).get("/v1/sales/inventory").set(auth(viewerToken));
    expect(inv2.body.data.some((c: any) => c.handle === "memekakeeda")).toBe(false);
  });

  it("a read-only sales user can't add, and a non-sales employee can't see", async () => {
    expect((await request(app).post("/v1/sales/vendors").set(auth(viewerToken)).send({ name: "X" })).status).toBe(403);
    expect((await request(app).get("/v1/sales/external-pages").set(auth(employeeToken))).status).toBe(403);
    expect((await request(app).get(`/v1/sales/pipeline/${projectId}/plan`).set(auth(employeeToken))).status).toBe(403);
  });

  it("attaches a category-wise page list to a campaign as a snapshot", async () => {
    await upsertExternalPages(
      [
        { platform: "instagram", handle: "cricketmasti", name: "Cricket Masti", category: "Cricket", followers: 900_000, brandPaise: 500_000, eventPaise: 700_000 },
        { platform: "instagram", handle: "memepur", name: "Memepur", category: "Meme", followers: 1_200_000, brandPaise: 200_000 },
      ],
      salesId,
    );
    const inv = await request(app).get("/v1/sales/inventory").set(auth(salesToken));
    const keys = inv.body.data.filter((c: any) => c.source === "external").map((c: any) => `${c.targetType}:${c.targetId}`);
    expect(keys).toHaveLength(2);
    const add = await request(app).post(`/v1/sales/pipeline/${projectId}/pages`).set(auth(salesToken)).send({ pageKeys: [...keys, keys[0]] });
    expect(add.status).toBe(200);
    expect(add.body.data.added).toBe(2);
    // Sorted by category, then followers.
    expect(add.body.data.pages.map((p: any) => [p.category, p.name, p.brandPaise])).toEqual([
      ["Cricket", "Cricket Masti", 500_000],
      ["Meme", "Memepur", 200_000],
    ]);
    // Adding again is harmless.
    const again = await request(app).post(`/v1/sales/pipeline/${projectId}/pages`).set(auth(salesToken)).send({ pageKeys: keys });
    expect(again.body.data.added).toBe(0);
    // A later price change never rewrites the agreed list.
    await upsertExternalPages([{ platform: "instagram", handle: "memepur", name: "Memepur", category: "Meme", followers: 1_200_000, brandPaise: 900_000 }], salesId);
    const plan = await request(app).get(`/v1/sales/pipeline/${projectId}/plan`).set(auth(viewerToken));
    expect(plan.body.data.pages.find((p: any) => p.name === "Memepur").brandPaise).toBe(200_000);
    // A key the inventory doesn't list is refused.
    const bad = await request(app).post(`/v1/sales/pipeline/${projectId}/pages`).set(auth(salesToken)).send({ pageKeys: ["external:00000000-0000-0000-0000-000000000000"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("PAGE_NOT_IN_INVENTORY");
    // Removing one.
    const one = plan.body.data.pages[0];
    const rm = await request(app).delete(`/v1/sales/pipeline/${projectId}/pages/${one.id}`).set(auth(salesToken));
    expect(rm.body.data.pages).toHaveLength(1);
    // The list goes with the project.
    await prisma.pipelineProject.delete({ where: { id: projectId } });
    expect(await prisma.pipelineProjectPage.count()).toBe(0);
  });

  it("records the campaign's revenue, with cash as an internal record", async () => {
    const empty = await request(app).get(`/v1/sales/pipeline/${projectId}/plan`).set(auth(salesToken));
    expect(empty.body.data).toEqual({ pages: [], revenue: null });
    const over = await request(app).put(`/v1/sales/pipeline/${projectId}/revenue`).set(auth(salesToken)).send({ amountPaise: 10_000_000, paymentMode: "cash", receivedPaise: 20_000_000 });
    expect(over.status).toBe(400);
    const r = await request(app).put(`/v1/sales/pipeline/${projectId}/revenue`).set(auth(salesToken)).send({ amountPaise: 10_000_000, paymentMode: "cash", receivedPaise: 4_000_000, receivedOn: "2026-11-18", note: "Advance in cash" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ amountPaise: 10_000_000, paymentMode: "cash", receivedPaise: 4_000_000, receivedOn: "2026-11-18" });
    // Cash is never an invoice or a payment.
    expect(await prisma.salesInvoice.count()).toBe(0);
    expect(await prisma.salesPayment.count()).toBe(0);
    const g = await request(app).put(`/v1/sales/pipeline/${projectId}/revenue`).set(auth(salesToken)).send({ amountPaise: 10_000_000, paymentMode: "gst" });
    expect(g.body.data).toMatchObject({ paymentMode: "gst", receivedPaise: 0, receivedOn: null });
    expect((await request(app).put(`/v1/sales/pipeline/${projectId}/revenue`).set(auth(viewerToken)).send({ amountPaise: 1, paymentMode: "gst" })).status).toBe(403);
    expect((await request(app).delete(`/v1/sales/pipeline/${projectId}/revenue`).set(auth(salesToken))).status).toBe(200);
    expect(await prisma.pipelineProjectRevenue.count()).toBe(0);
    // An unknown project is a 404.
    expect((await request(app).get("/v1/sales/pipeline/not-a-uuid/plan").set(auth(salesToken))).status).toBe(404);
  });
});
