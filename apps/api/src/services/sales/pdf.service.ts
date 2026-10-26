import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { GST_STATE_CODES, TAX_MODE_LABELS, DEFAULT_SAC, rupeesInWords } from "@dashmani/shared";
import type { InvoiceView, SellerSnapshot, BuyerSnapshot } from "./invoices.service";
import type { CreditNoteView } from "./payments.service";

// The printed invoice, drawn with pdfkit (pure JS — no browser on the 2 GB box). Renders from
// the snapshots frozen at issue, so re-downloading an old invoice always prints what the
// client received. Built-in Helvetica has no rupee glyph, so amounts print as "Rs."; the
// portal's on-screen view uses ₹.

const PAGE = { width: 595.28, height: 841.89, margin: 40 }; // A4
const INK = "#111111";
const MUTED = "#666666";
const RULE = "#cccccc";

// Each billing company's logo, printed top-left of its documents when the file exists
// (apps/api/assets/logos/<companyKey>.png; PNG or JPEG only — pdfkit cannot draw SVG/WebP).
const LOGO_DIR = path.resolve(__dirname, "../../../assets/logos");
const logoCache = new Map<string, Buffer | null>();
function logoFor(companyKey: string | null | undefined): Buffer | null {
  const key = /^[a-z]{2,8}$/.test(companyKey ?? "") ? companyKey! : "dspl";
  if (!logoCache.has(key)) {
    const file = path.join(LOGO_DIR, `${key}.png`);
    logoCache.set(key, fs.existsSync(file) ? fs.readFileSync(file) : null);
  }
  return logoCache.get(key) ?? null;
}
const LOGO_W = 66;
const LOGO_H = 56;

/** Draw the logo (if any) and return where the seller's name and address column starts. */
function sellerColumn(doc: PDFKit.PDFDocument, companyKey: string | null | undefined, left: number, width: number): { x: number; w: number; logoBottom: number } {
  const logo = logoFor(companyKey);
  if (!logo) return { x: left, w: width * 0.6, logoBottom: PAGE.margin };
  doc.image(logo, left, PAGE.margin, { fit: [LOGO_W, LOGO_H] });
  return { x: left + LOGO_W + 12, w: width * 0.6 - LOGO_W - 12, logoBottom: PAGE.margin + LOGO_H };
}

function rs(paise: number): string {
  const rupees = paise / 100;
  const sign = rupees < 0 ? "-" : "";
  return `${sign}Rs. ${Math.abs(rupees).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDay(day: string | null): string {
  if (!day) return "—";
  const [y, m, d] = day.split("-");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

function addressLines(p: { addressLine1?: string | null; addressLine2?: string | null; city?: string | null; state?: string | null; pincode?: string | null; stateCode?: string | null }): string[] {
  const lines = [p.addressLine1, p.addressLine2, [p.city, p.state, p.pincode].filter(Boolean).join(", ")].filter((l): l is string => !!l && l.trim().length > 0);
  if (p.stateCode) lines.push(`State code: ${p.stateCode}${GST_STATE_CODES[p.stateCode] ? ` (${GST_STATE_CODES[p.stateCode]})` : ""}`);
  return lines;
}


type EInvoiceView = { status: string; irn: string | null; ackNo: string | null; ackDate: Date | string | null; signedQrCode: string | null } | null | undefined;

/** The e-invoice block: the signed QR, IRN and acknowledgement — or a warning that it is not registered. */
async function drawEInvoice(doc: PDFKit.PDFDocument, e: EInvoiceView, left: number, width: number): Promise<void> {
  if (!e || e.status === "cancelled") return;
  if (e.status !== "registered" || !e.irn) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#b00020").text("E-INVOICE NOT YET REGISTERED ON THE IRP — not valid as a GST document until registered", left, doc.y, { width });
    doc.y += 8;
    return;
  }
  const top = doc.y;
  if (e.signedQrCode) {
    const png = await QRCode.toBuffer(e.signedQrCode, { errorCorrectionLevel: "M", margin: 1, width: 240 });
    doc.image(png, left + width - 86, top, { width: 86, height: 86 });
  }
  const ack = e.ackDate ? new Date(e.ackDate) : null;
  const ackIst = ack ? new Date(ack.getTime() + 330 * 60_000).toISOString().replace("T", " ").slice(0, 16) : "—";
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK).text("E-INVOICE", left, top, { width: width - 100 });
  doc.font("Helvetica").fontSize(8).fillColor(INK).text(`IRN: ${e.irn}`, { width: width - 100 });
  doc.text(`Ack No.: ${e.ackNo ?? "—"}    Ack Date: ${ackIst}`, { width: width - 100 });
  doc.y = Math.max(doc.y, top + 90) + 6;
}

export async function renderInvoicePdf(inv: InvoiceView): Promise<Buffer> {
  const seller = (inv.sellerSnapshot ?? {}) as Partial<SellerSnapshot>;
  const buyer = (inv.buyerSnapshot ?? {}) as Partial<BuyerSnapshot>;
  const title = inv.kind === "proforma" ? "PROFORMA INVOICE" : "TAX INVOICE";
  const doc = new PDFDocument({ size: "A4", margin: PAGE.margin, info: { Title: `${title} ${inv.number ?? "(draft)"}`, Author: seller.legalName ?? "Digital Sukoon" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const left = PAGE.margin;
  const right = PAGE.width - PAGE.margin;
  const width = right - left;

  // ── Header: seller + document title ────────────────────────────────────────
  const col = sellerColumn(doc, inv.companyKey, left, width);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(16).text(seller.legalName ?? "Digital Sukoon", col.x, PAGE.margin, { width: col.w });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  for (const line of addressLines(seller)) doc.text(line, { width: col.w });
  if (seller.gstin) doc.text(`GSTIN: ${seller.gstin}`, { width: col.w });
  if (seller.pan) doc.text(`PAN: ${seller.pan}`, { width: col.w });
  if (seller.email || seller.phone) doc.text([seller.email, seller.phone].filter(Boolean).join(" · "), { width: col.w });
  const headerBottom = Math.max(doc.y, col.logoBottom);

  doc.font("Helvetica-Bold").fontSize(18).fillColor(INK).text(title, left + width * 0.6, PAGE.margin, { width: width * 0.4, align: "right" });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  const meta: Array<[string, string]> = [
    ["Invoice no.", inv.number ?? "DRAFT"],
    ["Invoice date", fmtDay(inv.issueDate)],
    ["Due date", fmtDay(inv.dueDate)],
    ["Place of supply", inv.placeOfSupplyCode ? `${inv.placeOfSupplyCode} — ${GST_STATE_CODES[inv.placeOfSupplyCode] ?? ""}` : "—"],
    ["Tax", TAX_MODE_LABELS[inv.taxMode as keyof typeof TAX_MODE_LABELS] ?? inv.taxMode],
    // Rule 46(p): a tax invoice states whether tax is payable on reverse charge. A proforma says what it is not.
    inv.kind === "proforma" ? ["Note", "Proforma — not a tax invoice"] : ["Reverse charge", "No"],
  ];
  for (const [k, v] of meta) doc.text(`${k}: ${v}`, left + width * 0.6, doc.y, { width: width * 0.4, align: "right" });
  doc.y = Math.max(headerBottom, doc.y) + 14;
  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(1).stroke();
  doc.y += 12;

  if (inv.kind === "tax_invoice") await drawEInvoice(doc, inv.einvoice, left, width);
  // ── Bill to ─────────────────────────────────────────────────────────────────
  doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("BILL TO", left, doc.y);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(buyer.legalName ?? buyer.companyName ?? "—", { width: width * 0.6 });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  for (const line of addressLines(buyer)) doc.text(line, { width: width * 0.6 });
  doc.text(buyer.gstin ? `GSTIN: ${buyer.gstin}` : "Unregistered (no GSTIN)", { width: width * 0.6 });
  if (buyer.contactName || buyer.email) doc.text([buyer.contactName, buyer.email].filter(Boolean).join(" · "), { width: width * 0.6 });
  doc.y += 14;

  // ── Lines ───────────────────────────────────────────────────────────────────
  const cols = [
    { key: "idx", label: "#", w: 24, align: "left" as const },
    { key: "desc", label: "Description", w: width - 24 - 50 - 36 - 80 - 70 - 90, align: "left" as const },
    { key: "sac", label: "SAC", w: 50, align: "left" as const },
    { key: "qty", label: "Qty", w: 36, align: "right" as const },
    { key: "rate", label: "Rate", w: 80, align: "right" as const },
    { key: "disc", label: "Discount", w: 70, align: "right" as const },
    { key: "amt", label: "Amount", w: 90, align: "right" as const },
  ];
  const drawRow = (cells: string[], bold = false) => {
    const y = doc.y;
    let x = left;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(INK);
    const heights = cells.map((c, i) => doc.heightOfString(c, { width: cols[i].w - 6 }));
    const h = Math.max(...heights, 12);
    if (y + h > PAGE.height - PAGE.margin - 40) {
      doc.addPage();
    }
    const rowY = doc.y;
    cells.forEach((c, i) => {
      doc.text(c, x + 3, rowY, { width: cols[i].w - 6, align: cols[i].align });
      x += cols[i].w;
    });
    doc.y = rowY + h + 6;
    doc.moveTo(left, doc.y - 3).lineTo(right, doc.y - 3).strokeColor(RULE).lineWidth(0.5).stroke();
  };
  drawRow(cols.map((c) => c.label), true);
  inv.items.forEach((it, i) => {
    drawRow([String(i + 1), it.description, it.sac ?? "", String(it.quantity), rs(it.unitPricePaise), it.discountPaise ? rs(it.discountPaise) : "—", rs(it.amountPaise)]);
  });

  // ── Totals ──────────────────────────────────────────────────────────────────
  doc.y += 6;
  const totals: Array<[string, string, boolean]> = [["Subtotal", rs(inv.subtotalPaise), false]];
  if (inv.discountPaise) totals.push(["Discount", `- ${rs(inv.discountPaise)}`, false]);
  totals.push(["Taxable value", rs(inv.taxablePaise), false]);
  const pct = (bp: number) => `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
  if (inv.taxMode === "intra") {
    totals.push([`CGST @ ${pct(inv.gstRateBp / 2)}`, rs(inv.cgstPaise), false], [`SGST @ ${pct(inv.gstRateBp / 2)}`, rs(inv.sgstPaise), false]);
  } else if (inv.taxMode === "inter") {
    totals.push([`IGST @ ${pct(inv.gstRateBp)}`, rs(inv.igstPaise), false]);
  } else {
    totals.push(["GST", "Nil — export of services / SEZ", false]);
  }
  if (inv.roundOffPaise) totals.push(["Round off", rs(inv.roundOffPaise), false]);
  totals.push(["Total", rs(inv.totalPaise), true]);
  const settled = inv.paidPaise + inv.tdsPaise + inv.creditedPaise;
  if (settled > 0 && inv.status !== "cancelled") {
    if (inv.paidPaise) totals.push(["Received", `- ${rs(inv.paidPaise)}`, false]);
    if (inv.tdsPaise) totals.push(["TDS withheld", `- ${rs(inv.tdsPaise)}`, false]);
    if (inv.creditedPaise) totals.push(["Credit notes", `- ${rs(inv.creditedPaise)}`, false]);
    totals.push(["Balance due", rs(inv.balancePaise), true]);
  }
  const labelX = right - 260;
  for (const [k, v, bold] of totals) {
    if (doc.y > PAGE.height - PAGE.margin - 30) doc.addPage();
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(INK);
    doc.text(k, labelX, doc.y, { width: 140, align: "left", continued: false });
    doc.text(v, labelX + 140, doc.y - doc.currentLineHeight(), { width: 120, align: "right" });
    doc.y += 4;
  }
  if (inv.amountInWords) {
    doc.y += 6;
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED).text(`Amount in words: ${inv.amountInWords}`, left, doc.y, { width });
  }
  if (inv.status === "cancelled") {
    doc.y += 8;
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#b00020").text(`CANCELLED${inv.cancelReason ? ` — ${inv.cancelReason}` : ""}`, left, doc.y, { width });
  }

  // ── Bank, terms, signature ──────────────────────────────────────────────────
  doc.y += 16;
  if (seller.bankName || seller.accountNumber || seller.upiId) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("PAYMENT DETAILS", left, doc.y);
    doc.font("Helvetica").fontSize(9).fillColor(INK);
    const bank = [
      seller.accountName ? `Account name: ${seller.accountName}` : null,
      seller.bankName ? `Bank: ${seller.bankName}` : null,
      seller.accountNumber ? `Account no.: ${seller.accountNumber}` : null,
      seller.ifsc ? `IFSC: ${seller.ifsc}` : null,
      seller.upiId ? `UPI: ${seller.upiId}` : null,
    ].filter((l): l is string => !!l);
    for (const l of bank) doc.text(l, { width: width * 0.6 });
    doc.y += 10;
  }
  if (inv.terms) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("TERMS", left, doc.y);
    doc.font("Helvetica").fontSize(8.5).fillColor(INK).text(inv.terms, { width });
    doc.y += 10;
  }
  if (inv.notes) {
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(inv.notes, left, doc.y, { width });
    doc.y += 10;
  }
  doc.y = Math.max(doc.y + 24, Math.min(doc.y + 24, PAGE.height - PAGE.margin - 40));
  doc.font("Helvetica").fontSize(9).fillColor(INK).text(`For ${seller.legalName ?? "Digital Sukoon"}`, right - 200, doc.y, { width: 200, align: "right" });
  doc.y += 28;
  doc.text(seller.signatory ?? "Authorised signatory", right - 200, doc.y, { width: 200, align: "right" });

  doc.end();
  return done;
}

/**
 * A GST credit note (CGST Rules, rule 53): the supplier and recipient as printed on the original
 * invoice (its frozen snapshots), the note's own serial and date, the invoice it reduces with that
 * invoice's date, the taxable value credited, the tax by type and rate, the total, and a signature.
 */
export async function renderCreditNotePdf(cn: CreditNoteView): Promise<Buffer> {
  const seller = (cn.invoice.sellerSnapshot ?? {}) as Partial<SellerSnapshot>;
  const buyer = (cn.invoice.buyerSnapshot ?? {}) as Partial<BuyerSnapshot>;
  const doc = new PDFDocument({ size: "A4", margin: PAGE.margin, info: { Title: `CREDIT NOTE ${cn.number}`, Author: seller.legalName ?? "Digital Sukoon" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const left = PAGE.margin;
  const right = PAGE.width - PAGE.margin;
  const width = right - left;

  const col = sellerColumn(doc, cn.invoice.companyKey, left, width);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(16).text(seller.legalName ?? "Digital Sukoon", col.x, PAGE.margin, { width: col.w });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  for (const line of addressLines(seller)) doc.text(line, { width: col.w });
  if (seller.gstin) doc.text(`GSTIN: ${seller.gstin}`, { width: col.w });
  if (seller.pan) doc.text(`PAN: ${seller.pan}`, { width: col.w });
  const headerBottom = Math.max(doc.y, col.logoBottom);

  doc.font("Helvetica-Bold").fontSize(18).fillColor(INK).text("CREDIT NOTE", left + width * 0.6, PAGE.margin, { width: width * 0.4, align: "right" });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  const pos = cn.invoice.placeOfSupplyCode;
  const meta: Array<[string, string]> = [
    ["Credit note no.", cn.number],
    ["Date", fmtDay(cn.issueDate)],
    ["Against invoice", cn.invoice.number ?? "—"],
    ["Invoice date", fmtDay(cn.invoice.issueDate)],
    ["Place of supply", pos ? `${pos} — ${GST_STATE_CODES[pos] ?? ""}` : "—"],
    ["Reverse charge", "No"],
  ];
  for (const [k, v] of meta) doc.text(`${k}: ${v}`, left + width * 0.6, doc.y, { width: width * 0.4, align: "right" });
  doc.y = Math.max(headerBottom, doc.y) + 14;
  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(1).stroke();
  doc.y += 12;

  await drawEInvoice(doc, cn.einvoice, left, width);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("ISSUED TO", left, doc.y);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(buyer.legalName ?? buyer.companyName ?? cn.client.companyName, { width: width * 0.6 });
  doc.font("Helvetica").fontSize(9).fillColor(INK);
  for (const line of addressLines(buyer)) doc.text(line, { width: width * 0.6 });
  doc.text(buyer.gstin ? `GSTIN: ${buyer.gstin}` : "Unregistered (no GSTIN)", { width: width * 0.6 });
  doc.y += 14;

  // One line: what is credited and why.
  const cols = [
    { label: "#", w: 24, align: "left" as const },
    { label: "Description", w: width - 24 - 60 - 110, align: "left" as const },
    { label: "SAC", w: 60, align: "left" as const },
    { label: "Taxable value", w: 110, align: "right" as const },
  ];
  const headY = doc.y;
  doc.rect(left, headY - 3, width, 18).fill("#f2f2f2");
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(8.5);
  let x = left;
  for (const c of cols) { doc.text(c.label, x + 3, headY + 1, { width: c.w - 6, align: c.align }); x += c.w; }
  doc.y = headY + 20;
  doc.font("Helvetica").fontSize(9);
  const rowY = doc.y;
  const cells = ["1", `${cn.reason} (against ${cn.invoice.number ?? "the invoice"})`, cn.invoice.items[0]?.sac ?? DEFAULT_SAC, rs(cn.taxablePaise)];
  x = left;
  cells.forEach((c, i) => { doc.text(c, x + 3, rowY, { width: cols[i].w - 6, align: cols[i].align }); x += cols[i].w; });
  doc.y = Math.max(doc.y, rowY + 14) + 6;
  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
  doc.y += 10;

  const pct = (bp: number) => `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
  const totals: Array<[string, string, boolean]> = [["Taxable value", rs(cn.taxablePaise), false]];
  if (cn.taxMode === "intra") totals.push([`CGST @ ${pct(cn.gstRateBp / 2)}`, rs(cn.cgstPaise), false], [`SGST @ ${pct(cn.gstRateBp / 2)}`, rs(cn.sgstPaise), false]);
  else if (cn.taxMode === "inter") totals.push([`IGST @ ${pct(cn.gstRateBp)}`, rs(cn.igstPaise), false]);
  else totals.push(["GST", "Nil — export of services / SEZ", false]);
  const roundOff = cn.totalPaise - (cn.taxablePaise + cn.cgstPaise + cn.sgstPaise + cn.igstPaise);
  if (roundOff) totals.push(["Round off", rs(roundOff), false]);
  totals.push(["Total credited", rs(cn.totalPaise), true]);
  const labelX = right - 260;
  for (const [k, v, bold] of totals) {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(INK);
    doc.text(k, labelX, doc.y, { width: 140, align: "left" });
    doc.text(v, labelX + 140, doc.y - doc.currentLineHeight(), { width: 120, align: "right" });
    doc.y += 4;
  }
  doc.y += 6;
  doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED).text(`Amount in words: ${rupeesInWords(cn.totalPaise)}`, left, doc.y, { width });
  if (cn.status === "cancelled") {
    doc.y += 8;
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#b00020").text("CANCELLED", left, doc.y, { width });
  }
  doc.y = Math.max(doc.y + 40, Math.min(doc.y + 40, PAGE.height - PAGE.margin - 40));
  doc.font("Helvetica").fontSize(9).fillColor(INK).text(`For ${seller.legalName ?? "Digital Sukoon"}`, right - 200, doc.y, { width: 200, align: "right" });
  doc.y += 28;
  doc.text(seller.signatory ?? "Authorised signatory", right - 200, doc.y, { width: 200, align: "right" });
  doc.end();
  return done;
}
