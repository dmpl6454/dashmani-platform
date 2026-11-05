/**
 * Smart invoicing PR 0 (spec-00 §2.1–2.4, 2.9, 2.12): the feature routers are mounted after
 * sales.routes.ts and gate like it, sendDownload, hasPermission, the private memory upload's
 * limits, the dashboard feed filter, the new event entity types, and the portal no longer
 * overriding the server's INVOICE_LOCKED sentence.
 */
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../src/app";
import apiRouter from "../src/routes";
import salesRoutes from "../src/routes/sales.routes";
import salesAccountsRoutes from "../src/routes/sales-accounts.routes";
import salesTallyRoutes from "../src/routes/sales-tally.routes";
import salesImportRoutes from "../src/routes/sales-import.routes";
import salesBankRoutes from "../src/routes/sales-bank.routes";
import { admin, ENTITY_TYPES, manage, sendDownload, staffId, view } from "../src/routes/sales-route-kit";
import { hasPermission } from "../src/middleware/rbac";
import { memoryUpload, sha256Hex } from "../src/middleware/upload-private";
import { AppError, errorHandler } from "../src/middleware/error-handler";
import { asyncHandler } from "../src/utils/async-handler";
import { success } from "../src/utils/response";
import { logSalesEvent } from "../src/services/sales/common";
import { ApiError } from "../../sales/src/lib/api";
import { errorSentence } from "../../sales/src/lib/messages";
import { createTestRole, createTestUser, generateClientToken, generateHrToken, generateToken } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

// One probe route per feature router, using the kit's gates — added once, at load. A request to
// it through the real app proves the router is mounted and gated exactly like sales.routes.ts.
const FEATURES = [
  { name: "accounts", router: salesAccountsRoutes, path: "/sales/accounts" },
  { name: "tally", router: salesTallyRoutes, path: "/sales/tally" },
  { name: "imports", router: salesImportRoutes, path: "/sales/imports" },
  { name: "bank", router: salesBankRoutes, path: "/sales/bank" },
] as const;
for (const f of FEATURES) {
  f.router.get(`${f.path}/__probe`, ...view, asyncHandler(async (req, res) => success(res, { feature: f.name, by: staffId(req) })));
  f.router.post(`${f.path}/__probe`, ...manage, asyncHandler(async (_req, res) => success(res, { wrote: f.name })));
  f.router.delete(`${f.path}/__probe`, ...admin, asyncHandler(async (_req, res) => success(res, { admin: f.name })));
}

describe("feature routers", () => {
  let viewer: { id: string; token: string };
  let seller: { id: string; token: string };
  let boss: { id: string; token: string };
  let nobody: { id: string; token: string };

  beforeEach(async () => {
    await createTestRole("Viewer", [{ resource: "sales", action: "view", scope: "global" }]);
    await createTestRole("Sales", ["view", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Employee", [{ resource: "tasks", action: "view", scope: "own" }]);
    const mk = async (name: string, role: string) => {
      const u = await createTestUser({ name, roleNames: [role] });
      return { id: u.id, token: generateToken(u.id, u.email, [role]) };
    };
    viewer = await mk("Viewer", "Viewer");
    seller = await mk("Seller", "Sales");
    boss = await mk("Boss", "Admin");
    nobody = await mk("Nobody", "Employee");
  });

  it("are mounted directly after sales.routes.ts, in PR order", () => {
    const stack = (apiRouter as unknown as { stack: Array<{ handle: unknown }> }).stack.map((l) => l.handle);
    const at = stack.indexOf(salesRoutes);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(stack.slice(at, at + 5)).toEqual([salesRoutes, salesAccountsRoutes, salesTallyRoutes, salesImportRoutes, salesBankRoutes]);
  });

  for (const f of FEATURES) {
    it(`${f.name}: view / manage / admin gate like sales.routes.ts`, async () => {
      const url = `/v1${f.path}/__probe`;
      expect((await request(app).get(url)).status).toBe(401);
      expect((await request(app).get(url).set(auth(nobody.token))).status).toBe(403);
      // Staff portal tokens only: an HR or client token is refused even for a person with the role.
      expect((await request(app).get(url).set(auth(generateHrToken(seller.id, "x@test.dev", ["Sales"])))).status).toBe(403);
      expect((await request(app).get(url).set(auth(generateClientToken(seller.id, "x@test.dev")))).status).toBe(403);
      const ok = await request(app).get(url).set(auth(viewer.token));
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ feature: f.name, by: viewer.id });

      expect((await request(app).post(url).set(auth(viewer.token))).status).toBe(403);
      expect((await request(app).post(url).set(auth(seller.token))).status).toBe(200);
      expect((await request(app).delete(url).set(auth(seller.token))).status).toBe(403);
      expect((await request(app).delete(url).set(auth(boss.token))).status).toBe(200);
    });
  }

  it("an existing /sales/*/:id route is not shadowed, and an unknown feature path is a 404", async () => {
    expect((await request(app).get("/v1/sales/invoices").set(auth(viewer.token))).status).toBe(200);
    expect((await request(app).get("/v1/sales/accounts/nothing-here").set(auth(viewer.token))).status).toBe(404);
  });

  it("hasPermission answers what requirePermission would", async () => {
    expect(await hasPermission(boss.id, "sales", "approve")).toBe(true);
    expect(await hasPermission(seller.id, "sales", "approve")).toBe(false);
    expect(await hasPermission(seller.id, "sales", "manage")).toBe(true);
    expect(await hasPermission(nobody.id, "sales", "view")).toBe(false);
    expect(await hasPermission("00000000-0000-0000-0000-000000000000", "sales", "view")).toBe(false);
  });

  it("GET /sales/events accepts every pre-registered entity type", async () => {
    expect(ENTITY_TYPES).toEqual(["quote", "order", "invoice", "payment", "credit_note", "settings", "client", "recurring", "filed_year", "tally_run", "import", "bank_account", "bank_statement", "bank_line"]);
    await logSalesEvent(prisma, { entityType: "bank_line", entityId: "line-1", action: "ignored" });
    const r = await request(app).get("/v1/sales/events?entityType=bank_line&entityId=line-1").set(auth(viewer.token));
    expect(r.status).toBe(200);
    expect(r.body.data.map((e: { action: string }) => e.action)).toEqual(["ignored"]);
    expect((await request(app).get("/v1/sales/events?entityType=widget&entityId=x").set(auth(viewer.token))).status).toBe(400);
  });

  it("the dashboard feed hides the noisy feature events, by (type, action) pair", async () => {
    await prisma.systemSetting.deleteMany({ where: { key: { startsWith: "sales.seller" } } });
    const c = await prisma.client.create({ data: { companyName: "Feed Co", contactName: "F", email: "feed@co.test", passwordHash: "x" } });
    for (const [entityType, action] of [
      ["client", "updated"], ["client", "client_imported"], ["client", "billing_profile_imported"], ["client", "tally_ledger_set"],
      ["tally_run", "built"], ["filed_year", "filed_figures_saved"], ["bank_account", "created"], ["bank_statement", "imported"], ["bank_line", "auto_linked"],
    ] as const) {
      await logSalesEvent(prisma, { entityType, entityId: c.id, action });
    }
    await logSalesEvent(prisma, { entityType: "settings", entityId: "sales.seller", action: "tally_settings_saved" });
    await logSalesEvent(prisma, { entityType: "settings", entityId: "sales.seller", action: "saved" });
    // Bank's rematch writes payment/bank_matched for every receipt it auto-links: hidden. The
    // receipt's own payment/recorded stays visible.
    const pay = await prisma.salesPayment.create({ data: { number: "RC/26-27/0099", companyKey: "dspl", clientId: c.id, amountPaise: 100, mode: "upi", paidOn: new Date("2026-11-01"), recordedById: "system" } });
    await logSalesEvent(prisma, { entityType: "payment", entityId: pay.id, action: "recorded" });
    await logSalesEvent(prisma, { entityType: "payment", entityId: pay.id, action: "bank_matched" });
    const feed = (await request(app).get("/v1/sales/dashboard").set(auth(viewer.token))).body.data.recent as Array<{ entityType: string; action: string }>;
    expect(feed.map((e) => `${e.entityType}/${e.action}`).sort()).toEqual(["client/updated", "payment/recorded", "settings/saved"]);
  });
});

describe("sendDownload", () => {
  it("sets every download header and sends the bytes", async () => {
    const mini = express();
    mini.get("/x", (_req, res) => sendDownload(res, Buffer.from("<ENVELOPE/>"), { contentType: "application/xml", filename: "Tally export #12 / Nov.xml" }));
    mini.get("/y", (_req, res) => sendDownload(res, Buffer.from("%PDF"), { contentType: "application/pdf", filename: "BS 2025-26.pdf", inline: true }));
    const x = await request(mini).get("/x");
    expect(x.headers["content-type"]).toContain("application/xml");
    expect(x.headers["content-disposition"]).toBe('attachment; filename="Tally-export-12-Nov.xml"');
    expect(x.headers["access-control-expose-headers"]).toBe("Content-Disposition");
    expect(x.headers["cache-control"]).toBe("no-store");
    expect(x.headers["x-content-type-options"]).toBe("nosniff");
    expect(x.headers["content-length"]).toBe("11");
    expect(x.text).toBe("<ENVELOPE/>");
    expect((await request(mini).get("/y")).headers["content-disposition"]).toBe('inline; filename="BS-2025-26.pdf"');
  });
});

describe("memoryUpload", () => {
  const mini = express();
  const upload = memoryUpload({
    maxBytes: 1024,
    accept: /\.(csv|xlsx)$/i,
    refuse: (name) => (/\.pdf$/i.test(name) ? new AppError(415, "STATEMENT_PDF", "PDF statements cannot be read") : null),
    wrongType: new AppError(415, "WRONG_TYPE", "CSV or Excel only"),
    tooLarge: new AppError(413, "FILE_TOO_LARGE", "Over 1 KB — this feature's own sentence"),
    fields: 2,
  });
  mini.post("/up", upload, (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: { code: "NO_FILE" } });
    return res.json({ success: true, data: { name: req.file.originalname, size: req.file.size, sha: sha256Hex(req.file.buffer), onDisk: "path" in req.file && !!(req.file as { path?: string }).path, body: req.body } });
  });
  mini.use(errorHandler);

  it("keeps an accepted file in memory only", async () => {
    const r = await request(mini).post("/up").field("company", "dspl").attach("file", Buffer.from("a,b\n1,2\n"), "statement.CSV");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ name: "statement.CSV", size: 8, sha: sha256Hex(Buffer.from("a,b\n1,2\n")), onDisk: false, body: { company: "dspl" } });
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("answers each refusal with the feature's own code and sentence", async () => {
    const big = await request(mini).post("/up").attach("file", Buffer.alloc(2048, 65), "big.csv");
    expect(big.status).toBe(413);
    expect(big.body.error).toMatchObject({ code: "FILE_TOO_LARGE", message: "Over 1 KB — this feature's own sentence" });
    const pdf = await request(mini).post("/up").attach("file", Buffer.from("%PDF"), "may.pdf");
    expect(pdf.status).toBe(415);
    expect(pdf.body.error.code).toBe("STATEMENT_PDF");
    const txt = await request(mini).post("/up").attach("file", Buffer.from("x"), "notes.txt");
    expect(txt.status).toBe(415);
    expect(txt.body.error.code).toBe("WRONG_TYPE");
  });

  it("allows one file and a few small fields; anything else is INVALID_UPLOAD", async () => {
    const two = await request(mini).post("/up").attach("file", Buffer.from("a"), "a.csv").attach("file", Buffer.from("b"), "b.csv");
    expect(two.status).toBe(400);
    expect(two.body.error.code).toBe("INVALID_UPLOAD");
    const otherField = await request(mini).post("/up").attach("upload", Buffer.from("a"), "a.csv");
    expect(otherField.status).toBe(400);
    expect(otherField.body.error.code).toBe("INVALID_UPLOAD");
    const fields = await request(mini).post("/up").field("a", "1").field("b", "2").field("c", "3").attach("file", Buffer.from("a"), "a.csv");
    expect(fields.status).toBe(400);
    expect(fields.body.error.code).toBe("INVALID_UPLOAD");
    const longField = await request(mini).post("/up").field("note", "x".repeat(65 * 1024)).attach("file", Buffer.from("a"), "a.csv");
    expect(longField.status).toBe(400);
    expect(longField.body.error.code).toBe("INVALID_UPLOAD");
    expect((await request(mini).post("/up").field("company", "dspl")).body.error.code).toBe("NO_FILE");
  });

  // PR 0 review: a body cut off mid-upload (a dropped or cancelled browser upload) is the client's
  // mistake — a 400, never a logged 500.
  it("answers a truncated or malformed multipart body with 400 INVALID_UPLOAD", async () => {
    const cut = "--XYZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.csv\"\r\nContent-Type: text/csv\r\n\r\na,b\n1,2\n";
    const r = await request(mini).post("/up").set("Content-Type", "multipart/form-data; boundary=XYZ").send(cut);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: "INVALID_UPLOAD", message: "The upload was incomplete or malformed — try again" });
    const noBoundary = await request(mini).post("/up").set("Content-Type", "multipart/form-data").send("garbage");
    expect(noBoundary.status).toBe(400);
    expect(noBoundary.body.error.code).toBe("INVALID_UPLOAD");
  });
});

describe("portal error sentences (spec-00 §2.12)", () => {
  it("shows the server's INVOICE_LOCKED reason instead of a stale override", () => {
    const why = "INV/26-27/0016 has a receipt on it — cancel the receipt first, or use a credit note";
    expect(errorSentence(new ApiError(why, "INVOICE_LOCKED", undefined, 409))).toBe(why);
    const swipe = "Imported from Swipe — edit it in Swipe, or undo the import";
    expect(errorSentence(new ApiError(swipe, "INVOICE_LOCKED", undefined, 409))).toBe(swipe);
  });

  it("has the smart-invoicing sentences, so a busy bank is not \"Too many attempts\"", () => {
    expect(errorSentence(new ApiError("x", "BANK_BUSY", undefined, 429))).toBe("Another statement is being read — try again in a few seconds");
    expect(errorSentence(new ApiError("x", "BANK_OFF", undefined, 503))).toBe("Bank statement matching is switched off on this server");
    expect(errorSentence(new ApiError("x", "IMPORT_OFF", undefined, 503))).toBe("Importing old invoices is switched off on the server right now");
    expect(errorSentence(new ApiError("x", "PLAN_CHANGED", undefined, 409))).toMatch(/^Someone changed the columns/);
    // Codes several features emit stay un-overridden: the server's sentence is the feature's own.
    expect(errorSentence(new ApiError("The statement is larger than 5 MB", "FILE_TOO_LARGE", undefined, 413))).toBe("The statement is larger than 5 MB");
  });
});
