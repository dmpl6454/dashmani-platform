/**
 * Filed accounts on sales.digitalsukoon.com/accounts (spec-accounts §2, §3.4–3.6, §8.3 tests 28–34):
 * the 12 key figures an admin types from a company's signed balance sheet + P&L for a CLOSED
 * financial year (BIGINT paise), optimistic concurrency, the field-diff events, and the signed PDFs
 * kept as BYTEA in Postgres — never on disk, never in a JSON response.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import crypto from "crypto";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { financialYear, todayIST, FILED_FIGURE_KEYS } from "@dashmani/shared";
import app from "../src/app";
import { UPLOAD_DIR_PATH } from "../src/middleware/upload";
import { createTestRole, createTestUser, generateHrToken, generateToken } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const CLOSED = "2025-26";
const CURRENT = financialYear(todayIST()).label;

const blank = () => Object.fromEntries(FILED_FIGURE_KEYS.map((k) => [k, null])) as Record<string, number | null>;
const body = (over: Record<string, unknown> = {}) => ({ ...blank(), enteredIn: "lakhs", notes: null, baseUpdatedAt: null, ...over });
const pdf = (n = 2048) => Buffer.concat([Buffer.from("%PDF-1.7\n"), crypto.randomBytes(n)]);

describe("filed accounts", () => {
  let salesToken: string;
  let adminToken: string;
  let adminId: string;
  let hrToken: string;
  let employeeToken: string;

  beforeEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: { startsWith: "sales.seller" } } });
    await createTestRole("Sales", ["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Employee", [{ resource: "attendance", action: "view", scope: "own" }]);
    const s = await createTestUser({ roleNames: ["Sales"] });
    const a = await createTestUser({ roleNames: ["Admin"] });
    const e = await createTestUser({ roleNames: ["Employee"] });
    salesToken = generateToken(s.id, s.email, ["Sales"]);
    adminToken = generateToken(a.id, a.email, ["Admin"]);
    adminId = a.id;
    employeeToken = generateToken(e.id, e.email, ["Employee"]);
    hrToken = generateHrToken(a.id, a.email, ["Admin"]);
  });

  const put = (fy: string, b: unknown, t = adminToken, company = "dspl") => request(app).put(`/v1/sales/accounts/filed/${fy}?company=${company}`).set(auth(t)).send(b as object);
  const list = (t = salesToken, company = "dspl") => request(app).get(`/v1/sales/accounts/filed?company=${company}`).set(auth(t));
  const attach = (fy: string, bytes: Buffer, q = "", t = adminToken, type = "application/pdf") =>
    request(app).post(`/v1/sales/accounts/filed/${fy}/files?company=dspl${q}`).set(auth(t)).set("Content-Type", type).send(bytes);

  // 28 ─ BIGINT red-green: > 2^31 paise and negative figures round-trip exactly.
  it("stores BIGINT paise exactly, signed where allowed, and refuses bad input", async () => {
    const r = await put(CLOSED, body({ revenuePaise: 4_821_530_000, profitAfterTaxPaise: -120_000_000, equityPaise: -30_000_000 }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.changed).toBe(true);
    const got = (await list()).body.data[0];
    expect(got.fy).toBe(CLOSED);
    expect(got.figures).toMatchObject({ revenuePaise: 4_821_530_000, profitAfterTaxPaise: -120_000_000, equityPaise: -30_000_000, otherIncomePaise: null });
    expect(got.enteredIn).toBe("lakhs");

    const neg = await put("2024-25", body({ revenuePaise: -1 }));
    expect(neg.status).toBe(400);
    expect(JSON.stringify(neg.body)).toContain("This figure can't be negative");
    expect((await put("2024-25", body({ revenuePaise: 1_000_000_000_000_001 }))).status).toBe(400);
    expect((await put("2024-25", body())).status).toBe(400); // nothing typed, no notes
    const running = await put(CURRENT, body({ revenuePaise: 100 }));
    expect(running.status).toBe(422);
    expect(running.body.error.code).toBe("FY_NOT_CLOSED");
    expect((await put(CLOSED, body({ revenuePaise: 100 }), salesToken)).status).toBe(403);
    expect((await put("2025-27", body({ revenuePaise: 100 }))).body.error.code).toBe("BAD_FY");
  });

  // 29 ─ optimistic concurrency.
  it("refuses a stale save and lets only one of two first saves win", async () => {
    const first = (await put(CLOSED, body({ revenuePaise: 100_00 }))).body.data.filed;
    const stale = await put(CLOSED, body({ revenuePaise: 200_00, baseUpdatedAt: "2020-01-01T00:00:00.000Z" }));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("FILED_CHANGED");
    expect((await list()).body.data[0].figures.revenuePaise).toBe(100_00); // nothing written
    const fresh = await put(CLOSED, body({ revenuePaise: 200_00, baseUpdatedAt: first.updatedAt }));
    expect(fresh.status).toBe(200);

    const [a, b] = await Promise.all([put("2024-25", body({ revenuePaise: 1 })), put("2024-25", body({ revenuePaise: 2 }))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await prisma.financeFiledYear.count({ where: { financialYear: "2024-25" } })).toBe(1);
  });

  // 30 ─ events with a field diff.
  it("logs a field diff on every change and nothing when nothing changed", async () => {
    const s1 = (await put(CLOSED, body({ revenuePaise: 4_821_530_000 }))).body.data.filed;
    const ev = async () => (await request(app).get(`/v1/sales/events?entityType=filed_year&entityId=${s1.id}`).set(auth(salesToken))).body.data;
    let events = await ev();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("filed_figures_saved");
    expect(events[0].note).toContain("Revenue from operations ₹— → ₹4,82,15,300.00");

    const same = await put(CLOSED, body({ revenuePaise: 4_821_530_000, baseUpdatedAt: s1.updatedAt }));
    expect(same.body.data.changed).toBe(false);
    expect(await ev()).toHaveLength(1);

    await put(CLOSED, body({ revenuePaise: 4_821_530_000, profitAfterTaxPaise: -120_000_000, baseUpdatedAt: s1.updatedAt }));
    events = await ev();
    expect(events).toHaveLength(2);
    const note = events.find((e: { note: string }) => e.note.includes("Profit after tax")).note as string;
    expect(note).toBe("Profit after tax ₹— → −₹12,00,000.00");
  });

  // 31 ─ PDF upload rules.
  it("keeps a signed PDF in the database and refuses everything that is not one", async () => {
    const bytes = pdf();
    const up = await attach(CLOSED, bytes, "&name=Signed%20accounts");
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.data).toMatchObject({ duplicate: false, file: { kind: "accounts", fileName: "Signed accounts.pdf", sizeBytes: bytes.length } });
    expect(await prisma.financeFiledYear.count({ where: { companyKey: "dspl", financialYear: CLOSED } })).toBe(1); // first attach made the row
    const id = up.body.data.file.id;

    const dl = await request(app).get(`/v1/sales/accounts/filed/files/${id}`).set(auth(salesToken)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.body as Buffer, bytes)).toBe(0);
    expect(dl.headers["content-type"]).toBe("application/pdf");
    expect(dl.headers["content-disposition"]).toBe('attachment; filename="Signed-accounts.pdf"');
    expect(dl.headers["access-control-expose-headers"]).toBe("Content-Disposition");
    expect(dl.headers["cache-control"]).toBe("no-store");
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
    const inline = await request(app).get(`/v1/sales/accounts/filed/files/${id}?inline=1`).set(auth(salesToken));
    expect(inline.headers["content-disposition"]).toMatch(/^inline;/);

    const again = await attach(CLOSED, bytes);
    expect(again.status).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
    expect(await prisma.financeFiledFile.count()).toBe(1);

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(64)]);
    expect((await attach(CLOSED, png)).body.error.code).toBe("FILE_NOT_PDF");
    expect((await attach(CLOSED, png)).status).toBe(415);
    expect((await attach(CLOSED, pdf(), "", adminToken, "image/png")).status).toBe(415);
    const empty = await attach(CLOSED, Buffer.alloc(0));
    expect([empty.status, empty.body.error.code]).toEqual([400, "FILE_EMPTY"]);
    const big = await attach(CLOSED, Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(10 * 1024 * 1024 - 8)]));
    expect([big.status, big.body.error.code]).toEqual([413, "FILE_TOO_LARGE"]);
    expect((await attach(CLOSED, pdf(), "&kind=bogus")).body.error.code).toBe("BAD_FILE_KIND");

    for (let i = 0; i < 4; i++) expect((await attach(CLOSED, pdf(), "&kind=other")).status).toBe(201);
    const sixth = await attach(CLOSED, pdf());
    expect([sixth.status, sixth.body.error.code]).toEqual([409, "TOO_MANY_FILES"]);

    expect((await attach(CLOSED, pdf(), "", salesToken)).status).toBe(403);
    expect((await attach(CURRENT, pdf())).body.error.code).toBe("FY_NOT_CLOSED");
  });

  // 32 ─ bytes never reach a JSON response.
  it("never sends the PDF bytes in JSON", async () => {
    await attach(CLOSED, pdf(40_000));
    await attach(CLOSED, pdf(40_000));
    for (const r of [await list(), await request(app).get(`/v1/sales/accounts?company=dspl&fy=${CLOSED}`).set(auth(salesToken))]) {
      expect(r.status).toBe(200);
      const s = JSON.stringify(r.body);
      expect(s).not.toContain('"data":{"type":"Buffer"');
      expect(s.length).toBeLessThan(100_000);
      const files = (Array.isArray(r.body.data) ? r.body.data[0] : r.body.data.filed).files;
      expect(files).toHaveLength(2);
      for (const f of files) expect(Object.keys(f).sort()).toEqual(["createdAt", "fileName", "id", "kind", "sha256", "sizeBytes"]);
    }
  });

  // 33 ─ nothing on disk.
  it("writes nothing under the public uploads folder", async () => {
    const snap = () => (fs.existsSync(UPLOAD_DIR_PATH) ? (fs.readdirSync(UPLOAD_DIR_PATH, { recursive: true }) as string[]).sort() : []);
    const before = snap();
    expect((await attach(CLOSED, pdf())).status).toBe(201);
    expect(snap()).toEqual(before);
  });

  // 34 ─ removing a PDF.
  it("removes a PDF, keeps the year and its history", async () => {
    const up = (await attach(CLOSED, pdf(), "&name=signed")).body.data.file;
    expect((await request(app).delete(`/v1/sales/accounts/filed/files/${up.id}`).set(auth(salesToken))).status).toBe(403);
    const del = await request(app).delete(`/v1/sales/accounts/filed/files/${up.id}`).set(auth(adminToken));
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ removed: true });
    const year = await prisma.financeFiledYear.findFirstOrThrow({ where: { financialYear: CLOSED } });
    const events = await prisma.salesEvent.findMany({ where: { entityType: "filed_year", entityId: year.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.action)).toEqual(["filed_document_added", "filed_document_removed"]);
    expect(events[1].note).toContain("signed.pdf");
    expect(events[1].note).toContain(`sha256 ${up.sha256.slice(0, 4)}…${up.sha256.slice(-4)}`);
    expect(events[1].actorId).toBe(adminId);
    const gone = await request(app).get(`/v1/sales/accounts/filed/files/${up.id}`).set(auth(salesToken));
    expect([gone.status, gone.body.error.code]).toEqual([404, "NOT_FOUND"]);
    expect((await request(app).delete(`/v1/sales/accounts/filed/files/${up.id}`).set(auth(adminToken))).status).toBe(404);
  });

  it("is staff-only: employee and HR tokens are refused", async () => {
    expect((await list(employeeToken)).status).toBe(403);
    expect((await list(hrToken)).status).toBe(403);
    expect((await list(salesToken, "xyz")).body.error.code).toBe("BAD_COMPANY");
  });
});
