/**
 * The signature image printed above the signatory's name on invoices and credit notes:
 * admin-only upload (PNG/JPEG, sniffed, ≤ 300 KB), stored by content hash, frozen into each
 * document's seller snapshot at issue, and switchable off.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import QRCode from "qrcode";
import { createHash } from "crypto";
import { prisma } from "@dashmani/db";
import app from "../src/app";
import { createTestRole, createTestUser, generateToken } from "./helpers";

const DSPL = {
  legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K", addressLine1: "702, Parinee I, Andheri West",
  city: "Mumbai", stateCode: "27", pincode: "400053", invoicePrefix: "DS", creditNotePrefix: "CN", signatory: "A. Signer",
};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const binary = (res: NodeJS.ReadableStream & { on: (e: string, f: (d?: Buffer) => void) => void }, cb: (err: Error | null, body: Buffer) => void) => {
  const c: Buffer[] = [];
  res.on("data", (d?: Buffer) => d && c.push(d));
  res.on("end", () => cb(null, Buffer.concat(c)));
};
/** Images embedded in a PDF: the company logo is one, the signature another. */
const imageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Subtype \/Image/g) ?? []).length;

describe("Invoice signature", () => {
  let token: string;
  let adminToken: string;
  let clientId: string;
  let png: Buffer;
  let png2: Buffer;

  beforeEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { OR: [{ key: "sales.seller" }, { key: { startsWith: "sales.signature." } }] } });
    await createTestRole("Sales", ["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
    const u = await createTestUser({ roleNames: ["Sales"] });
    const a = await createTestUser({ roleNames: ["Admin"] });
    token = generateToken(u.id, u.email, ["Sales"]);
    adminToken = generateToken(a.id, a.email, ["Admin"]);
    const c = await prisma.client.create({ data: { companyName: "Brand Co", contactName: "X", email: "brand@sig.test", passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: c.id, legalName: "Brand Co Pvt Ltd", gstin: "27AABCU9603R1ZX", stateCode: "27" } });
    clientId = c.id;
    png = await QRCode.toBuffer("signature one", { width: 120 });
    png2 = await QRCode.toBuffer("signature two", { width: 120 });
  });

  const upload = (body: Buffer, type: string, t = adminToken) => request(app).post("/v1/sales/settings/signature").set(auth(t)).set("Content-Type", type).send(body);
  const save = (body: unknown) => request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send(body);
  const post = (path: string, body: unknown) => request(app).post(`/v1${path}`).set(auth(token)).send(body);
  const pdfOf = async (path: string) => {
    const r = await request(app).get(`/v1${path}`).set(auth(token)).buffer(true).parse(binary as never);
    expect(r.status).toBe(200);
    return r.body as Buffer;
  };
  async function issued() {
    const d = await post("/sales/invoices", { companyKey: "dspl", kind: "tax_invoice", clientId, items: [{ description: "Reel", quantity: 1, unitPricePaise: 100_000 }] });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const r = await post(`/sales/invoices/${d.body.data.id}/issue`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  }

  it("accepts only an admin's PNG or JPEG, up to 300 KB, and serves it back", async () => {
    expect((await upload(png, "image/png", token)).status).toBe(403);
    const ok = await upload(png, "image/png");
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data).toMatchObject({ signatureId: createHash("sha256").update(png).digest("hex"), contentType: "image/png" });
    // Same bytes again: same id, still one row.
    expect((await upload(png, "image/png")).body.data.signatureId).toBe(ok.body.data.signatureId);
    expect(await prisma.systemSetting.count({ where: { key: { startsWith: "sales.signature." } } })).toBe(1);

    // The type comes from the bytes, not the header; a broken image is refused before it can break a PDF.
    const fake = await upload(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png");
    expect(fake.status).toBe(400);
    expect(fake.body.error.code).toBe("UNSUPPORTED_IMAGE");
    const broken = await upload(Buffer.concat([png.subarray(0, 8), Buffer.alloc(64, 7)]), "image/png");
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe("UNSUPPORTED_IMAGE");
    const big = await upload(Buffer.concat([png, Buffer.alloc(310 * 1024)]), "image/png");
    expect(big.status).toBe(413);
    expect((await request(app).post("/v1/sales/settings/signature").set(auth(adminToken)).set("Content-Type", "application/pdf").send(Buffer.from("%PDF-1.4"))).status).toBe(400);

    const got = await request(app).get(`/v1/sales/settings/signature/${ok.body.data.signatureId}`).set(auth(token)).buffer(true).parse(binary as never);
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toMatch(/image\/png/);
    expect((got.body as Buffer).equals(png)).toBe(true);
    expect((await request(app).get(`/v1/sales/settings/signature/${"0".repeat(64)}`).set(auth(token))).status).toBe(404);
  });

  it("refuses a profile that points at a signature never uploaded", async () => {
    const r = await save({ ...DSPL, signatureId: "a".repeat(64) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("SIGNATURE_NOT_FOUND");
    expect((await save({ ...DSPL, signatureId: "not-a-hash" })).status).toBe(400);
  });

  it("prints it on invoices and credit notes, frozen at issue, and can be switched off", async () => {
    expect((await save(DSPL)).status).toBe(200);
    const plain = await issued();
    const plainPdf = await pdfOf(`/sales/invoices/${plain.id}/pdf`);
    const base = imageCount(plainPdf); // the logo only

    const id1 = (await upload(png, "image/png")).body.data.signatureId;
    const saved = await save({ ...DSPL, signatureId: id1 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.profile).toMatchObject({ signatureId: id1, printSignature: true });

    const signed = await issued();
    expect(signed.sellerSnapshot).toMatchObject({ signatureId: id1, printSignature: true, signatory: "A. Signer" });
    // A PNG with transparency embeds as an image plus its mask, so compare counts, not +1.
    const withSig = imageCount(await pdfOf(`/sales/invoices/${signed.id}/pdf`));
    expect(withSig).toBeGreaterThan(base);
    // An invoice issued before the signature existed still prints what the client received.
    expect(imageCount(await pdfOf(`/sales/invoices/${plain.id}/pdf`))).toBe(base);

    const cn = await post("/sales/credit-notes", { invoiceId: signed.id, reason: "Not delivered", taxablePaise: 50_000 });
    expect(cn.status, JSON.stringify(cn.body)).toBe(201);
    expect(imageCount(await pdfOf(`/sales/credit-notes/${cn.body.data.id}/pdf`))).toBe(withSig);

    // A new signature, printed off: new invoices carry no signature; the issued one keeps its own.
    const id2 = (await upload(png2, "image/png")).body.data.signatureId;
    expect((await save({ ...DSPL, signatureId: id2, printSignature: false })).status).toBe(200);
    const off = await issued();
    expect(off.sellerSnapshot).toMatchObject({ signatureId: id2, printSignature: false });
    expect(imageCount(await pdfOf(`/sales/invoices/${off.id}/pdf`))).toBe(base);
    expect(imageCount(await pdfOf(`/sales/invoices/${signed.id}/pdf`))).toBe(withSig);
  });
});
