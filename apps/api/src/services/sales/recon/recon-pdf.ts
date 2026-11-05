import PDFDocument from "pdfkit";
import { CONFIRMATION_REQUEST_TEXT, SALES_COMPANIES, type CompanyKey } from "@dashmani/shared";
import { INK, MUTED, PAGE, RULE, fmtDay, sellerColumn } from "../pdf.service";
import type { LedgerView } from "./ledger";

// The statement of account / balance-confirmation PDF (spec-reconcile §8.1). pdfkit + Helvetica
// (no ₹ glyph → "Rs."; negatives in parentheses), drawn from a LedgerView — for a confirmation,
// the FROZEN one, so the PDF is exactly what the client was sent.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dmy = (day: string) => `${day.slice(8, 10)}-${MONTHS[Number(day.slice(5, 7)) - 1]}-${day.slice(0, 4)}`;

/** Indian grouping without a locale: 5623400 → "56,234.00". */
function rupees(paise: number): string {
  const abs = Math.abs(paise);
  const whole = String(Math.floor(abs / 100));
  const last3 = whole.slice(-3);
  let rest = whole.slice(0, -3);
  const g: string[] = [];
  while (rest.length > 2) { g.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
  if (rest) g.unshift(rest);
  return `${g.length ? `${g.join(",")},${last3}` : last3}.${String(abs % 100).padStart(2, "0")}`;
}
const money = (p: number) => (p ? rupees(p) : "");
const bal = (p: number) => `${rupees(p)} ${p >= 0 ? "Dr" : "Cr"}`;

export async function renderLedgerPdf(l: LedgerView, opts: { request: boolean; confirmationId?: string }): Promise<Buffer> {
  const company = (l.company in SALES_COMPANIES ? l.company : "dspl") as CompanyKey;
  const doc = new PDFDocument({ size: "A4", margin: PAGE.margin, bufferPages: true, info: { Title: `Statement of account — ${l.client.name}`, Author: l.seller.legalName, CreationDate: new Date(l.generatedAt) } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  const left = PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;

  // Seller block + title
  const col = sellerColumn(doc, company, left, width);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(l.seller.legalName, col.x, PAGE.margin, { width: col.w });
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED);
  for (const a of l.seller.addressLines) doc.text(a, col.x, doc.y, { width: col.w });
  if (l.seller.gstin) doc.text(`GSTIN: ${l.seller.gstin}`, col.x, doc.y, { width: col.w });
  if (l.seller.pan) doc.text(`PAN: ${l.seller.pan}`, col.x, doc.y, { width: col.w });
  if (l.seller.email) doc.text(l.seller.email, col.x, doc.y, { width: col.w });
  const leftBottom = Math.max(doc.y, col.logoBottom);
  const rx = left + width * 0.6;
  const rw = width * 0.4;
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(13).text("STATEMENT OF ACCOUNT", rx, PAGE.margin, { width: rw, align: "right" });
  if (opts.request) doc.font("Helvetica").fontSize(9).text("and request for balance confirmation", rx, doc.y, { width: rw, align: "right" });
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED);
  doc.text(`Period: ${dmy(l.from)} to ${dmy(l.to)}`, rx, doc.y + 4, { width: rw, align: "right" });
  doc.text(`Generated: ${fmtDay(l.generatedAt.slice(0, 10))}`, rx, doc.y, { width: rw, align: "right" });
  if (opts.confirmationId) doc.text(`Reference: ${opts.confirmationId.slice(0, 8)}`, rx, doc.y, { width: rw, align: "right" });
  doc.y = Math.max(doc.y, leftBottom) + 14;

  // Client block
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(RULE).stroke();
  doc.y += 6;
  doc.fillColor(MUTED).fontSize(8).text("ACCOUNT OF", left, doc.y);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(l.client.legalName, left, doc.y);
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED);
  for (const a of l.client.addressLines) doc.text(a, left, doc.y);
  const ids = [l.client.gstin ? `GSTIN: ${l.client.gstin}` : null, l.client.pan ? `PAN: ${l.client.pan}` : null, l.client.tans.length ? `TAN: ${l.client.tans.join(", ")}` : null].filter(Boolean).join("   ");
  if (ids) doc.text(ids, left, doc.y);
  doc.y += 10;

  // Table
  const cols = [
    { k: "date", t: "Date", w: 62, a: "left" as const },
    { k: "doc", t: "Document", w: 90, a: "left" as const },
    { k: "part", t: "Particulars", w: width - 62 - 90 - 72 - 72 - 84, a: "left" as const },
    { k: "dr", t: "Debit (Rs.)", w: 72, a: "right" as const },
    { k: "cr", t: "Credit (Rs.)", w: 72, a: "right" as const },
    { k: "bal", t: "Balance (Rs.)", w: 84, a: "right" as const },
  ];
  const header = () => {
    let x = left;
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(INK);
    for (const c of cols) { doc.text(c.t, x + 2, y, { width: c.w - 4, align: c.a }); x += c.w; }
    doc.y = y + 12;
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(RULE).stroke();
    doc.y += 3;
  };
  const row = (cells: Record<string, string>, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8).fillColor(INK);
    const h = Math.max(...cols.map((c) => doc.heightOfString(cells[c.k] ?? "", { width: c.w - 4 })));
    if (doc.y + h + 4 > PAGE.height - PAGE.margin - 30) { doc.addPage(); doc.y = PAGE.margin; header(); doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8); }
    const y = doc.y;
    let x = left;
    for (const c of cols) { doc.text(cells[c.k] ?? "", x + 2, y, { width: c.w - 4, align: c.a }); x += c.w; }
    doc.y = y + h + 3;
  };
  header();
  row({ date: dmy(l.from), doc: "", part: "Opening balance", dr: "", cr: "", bal: bal(l.openingPaise) }, true);
  for (const x of l.lines) row({ date: dmy(x.day), doc: x.number, part: x.particulars, dr: money(x.debitPaise), cr: money(x.creditPaise), bal: bal(x.balancePaise) });
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(RULE).stroke();
  doc.y += 3;
  row({ date: dmy(l.to), doc: "", part: "Closing balance", dr: rupees(l.totals.debitPaise), cr: rupees(l.totals.creditPaise), bal: bal(l.closingPaise) }, true);
  doc.y += 8;
  const owe = l.closingPaise >= 0 ? `payable by you to ${l.seller.legalName}` : `held by ${l.seller.legalName} as an advance from you`;
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text(`Balance as on ${dmy(l.to)}: Rs. ${bal(l.closingPaise)} (${owe})`, left, doc.y, { width });
  doc.y += 6;

  if (l.excluded.length) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("Not included (cancelled or voided):", left, doc.y, { width });
    doc.font("Helvetica").fontSize(7.5);
    for (const e of l.excluded) doc.text(`${e.number} of ${dmy(e.day)} — Rs. ${rupees(e.amountPaise)}${e.changedOn ? `, cancelled ${dmy(e.changedOn)}` : ""}${e.reason ? ` (${e.reason})` : ""}`, left, doc.y, { width });
    doc.y += 4;
  }
  doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
  for (const n of l.notes) doc.text(n.replace(/₹/g, "Rs. "), left, doc.y, { width });

  if (opts.request) {
    doc.y += 10;
    if (doc.y > PAGE.height - PAGE.margin - 150) { doc.addPage(); doc.y = PAGE.margin; }
    const replyTo = l.seller.email ?? "our accounts team";
    const text = CONFIRMATION_REQUEST_TEXT.replace("{asOf}", dmy(l.to)).replace("{replyTo}", replyTo);
    const top = doc.y;
    doc.font("Helvetica").fontSize(8.5).fillColor(INK);
    const h = doc.heightOfString(text, { width: width - 16 });
    doc.rect(left, top, width, h + 16).strokeColor(RULE).stroke();
    doc.text(text, left + 8, top + 8, { width: width - 16 });
    doc.y = top + h + 26;
    doc.font("Helvetica").fontSize(8.5).text(`We confirm the balance of Rs. ____________ Dr / Cr as on ${dmy(l.to)}   [ ] which agrees with yours   [ ] which differs (details attached).`, left, doc.y, { width });
    doc.y += 18;
    doc.text("For ______________________     Authorised signatory     Name ______________     Date ________     Seal", left, doc.y, { width });
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing below the bottom margin would make pdfkit open a new page.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(7).fillColor(MUTED).text(
      `${l.seller.legalName} · Statement of account · ${l.client.name} · Generated ${fmtDay(l.generatedAt.slice(0, 10))} — documents as they stand on that day · Page ${i - range.start + 1} of ${range.count}`,
      left, PAGE.height - PAGE.margin + 10, { width, align: "center", lineBreak: false },
    );
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}
