import PDFDocument from "pdfkit";
import { CONFIRMATION_REQUEST_TEXT, SALES_COMPANIES, type CompanyKey } from "@dashmani/shared";
import { INK, MUTED, PAGE, RULE, drawDraftMark, fmtDay, sellerColumn } from "../pdf.service";
import type { LedgerView } from "./ledger";
import type { BrsCore, BrsGroup } from "./brs";

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

// ─── BRS (spec-reconcile §8.3, PR 6) ─────────────────────────────────────────────────────────

const BRS_GROUP_TITLE: Record<BrsGroup, string> = {
  not_credited: "Recorded in the month, not credited in the month",
  credited_other_month: "Credited in the month for receipts dated in other months",
  unmatched: "Credits not yet matched to a receipt",
  ignored: "Credits ignored on Bank",
  rounding: "Rounding on matched credits",
  over_matched: "Credits carrying more receipts than their amount",
  duplicate: "Stored twice — not counted",
};
const signed = (p: number) => (p < 0 ? `(${rupees(p)})` : rupees(p));
const istStamp = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000).toISOString();
  return `${dmy(d.slice(0, 10))} ${d.slice(11, 16)} IST`;
};

/** A BRS from a view: live (watermarked NOT RECONCILED) or a version's frozen snapshot. Helvetica only — "Rs.", no glyphs. */
export async function renderBrsPdf(v: BrsCore, opts: {
  frozen: boolean; redactDebits: boolean;
  seller: { legalName: string; gstins: string[]; address: string };
  signoff: null | { version: number; byName: string; at: string; note: string | null; accepted: string[]; fingerprint: string };
}): Promise<Buffer> {
  const company = (v.company in SALES_COMPANIES ? v.company : "dspl") as CompanyKey;
  const created = opts.signoff ? new Date(opts.signoff.at) : new Date();
  const doc = new PDFDocument({ size: "A4", margin: PAGE.margin, bufferPages: true, info: { Title: `Bank reconciliation statement — ${v.account.label} ${v.month.label}`, Author: opts.seller.legalName, CreationDate: created } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  const left = PAGE.margin;
  const width = PAGE.width - PAGE.margin * 2;
  const ensure = (h: number) => { if (doc.y + h > PAGE.height - PAGE.margin - 30) { doc.addPage(); doc.y = PAGE.margin; } };
  const heading = (t: string) => { ensure(40); doc.y += 8; doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(t, left, doc.y, { width }); doc.y += 3; };
  const pair = (label: string, value: string, bold = false) => {
    ensure(14);
    const y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(INK).text(label, left, y, { width: width - 120 });
    const h = doc.y - y;
    doc.text(value, left + width - 120, y, { width: 120, align: "right" });
    doc.y = y + Math.max(h, 11) + 1;
  };

  // 1. Header
  const col = sellerColumn(doc, company, left, width);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(opts.seller.legalName, col.x, PAGE.margin, { width: col.w });
  doc.font("Helvetica").fontSize(8).fillColor(MUTED);
  if (opts.seller.gstins.length) doc.text(`GSTIN: ${opts.seller.gstins.join(", ")}`, col.x, doc.y, { width: col.w });
  if (opts.seller.address) doc.text(opts.seller.address, col.x, doc.y, { width: col.w });
  const leftBottom = Math.max(doc.y, col.logoBottom);
  const rx = left + width * 0.55;
  const rw = width * 0.45;
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text("BANK RECONCILIATION STATEMENT", rx, PAGE.margin, { width: rw, align: "right" });
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED);
  doc.text("Receipts side — prepared from sales.digitalsukoon.com", rx, doc.y, { width: rw, align: "right" });
  doc.text(`${v.account.label} ••${v.account.last4}${v.account.ifsc ? ` · IFSC ${v.account.ifsc}` : ""}`, rx, doc.y, { width: rw, align: "right" });
  doc.text(`${v.month.label} (${dmy(v.month.from)} to ${dmy(v.month.to)})`, rx, doc.y, { width: rw, align: "right" });
  doc.y = Math.max(doc.y, leftBottom) + 12;

  // 2. Status box
  const top = doc.y;
  const status = opts.frozen && opts.signoff
    ? [`RECONCILED · version ${opts.signoff.version} · ${opts.signoff.byName} · ${istStamp(opts.signoff.at)}`, opts.signoff.note ?? "", opts.signoff.accepted.length ? `Acknowledged: ${opts.signoff.accepted.join(", ").replace(/_/g, " ")}` : ""].filter(Boolean)
    : [`NOT RECONCILED — figures as on ${istStamp(new Date().toISOString())}`];
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK);
  const h = status.reduce((s, t) => s + doc.heightOfString(t, { width: width - 16 }) + 2, 0);
  doc.rect(left, top, width, h + 12).strokeColor(RULE).stroke();
  let yy = top + 6;
  status.forEach((t, i) => { doc.font(i === 0 ? "Helvetica-Bold" : "Helvetica").text(t, left + 8, yy, { width: width - 16 }); yy = doc.y + 2; });
  doc.y = top + h + 18;

  // 3. A — balance as per bank
  const b = v.balances;
  heading("A — Balance as per bank statement");
  pair(`Opening balance${b.source === "typed" ? " (worked back from the typed closing)" : ""}`, b.openingPaise === null ? "unknown" : signed(b.openingPaise));
  pair(`+ Credits (${b.creditCount})`, rupees(b.creditsPaise));
  pair(`- Withdrawals (${b.debitCount})`, rupees(b.debitsPaise));
  pair(`= Closing balance${b.source === "typed" ? " (typed from the bank's statement)" : ""}`, b.closingPaise === null ? "unknown" : signed(b.closingPaise), true);
  doc.font("Helvetica").fontSize(8).fillColor(MUTED);
  if (b.agreesWith) doc.text(`Agrees with ${b.agreesWith}`, left, doc.y, { width });
  for (const br of b.breaks) doc.fillColor("#b00020").text(br.text.replace(/₹/g, "Rs. "), left, doc.y, { width });
  doc.fillColor(MUTED).text(`Statements: ${v.coverage.statements.map((s) => `${s.fileName} (${dmy(s.periodFrom)} to ${dmy(s.periodTo)})`).join("; ") || "none"}`, left, doc.y, { width });

  // 4. B — reconciliation of receipts
  heading("B — Reconciliation of receipts");
  for (const f of v.formula) {
    const sign = f.key === "not_credited" ? "- " : f.key === "books" || f.key === "credits" ? "" : "+ ";
    pair(`${f.key === "credits" ? "= " : sign}${f.label.replace(/₹/g, "Rs. ")}${f.count ? ` (${f.count})` : ""}`, signed(f.paise), f.key === "credits" || f.key === "books");
  }
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(v.ties ? INK : "#b00020").text(v.ties ? "AGREES with credits as per bank" : "DOES NOT AGREE — do not rely on this statement", left, doc.y, { width });

  // 5. C — items per group
  const cols = [{ t: "Date", w: 58 }, { t: "Reference", w: 110 }, { t: "Description", w: width - 58 - 110 - 140 - 70 }, { t: "Reason", w: 140 }, { t: "Amount", w: 70 }];
  const row = (cells: string[], bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(7.5).fillColor(INK);
    const hh = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: cols[i].w - 4 })));
    ensure(hh + 4);
    const y = doc.y;
    let x = left;
    cells.forEach((c, i) => { doc.text(c, x + 2, y, { width: cols[i].w - 4, align: i === 4 ? "right" : "left" }); x += cols[i].w; });
    doc.y = y + hh + 3;
  };
  const groups = [...new Set(v.items.map((i) => i.group))];
  if (groups.length) heading("C — Items");
  for (const g of groups) {
    const items = v.items.filter((i) => i.group === g);
    ensure(30);
    doc.y += 4;
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK).text(BRS_GROUP_TITLE[g], left, doc.y, { width });
    row(cols.map((c) => c.t), true);
    for (const it of items) {
      const ref = it.receipt ? it.receipt.number : it.line ? `row ${it.line.rowNo} of ${it.line.fileName}` : "";
      const desc = it.line ? it.line.narration.slice(0, 60) : it.receipt ? `${it.receipt.clientName} · ${it.receipt.mode.replace(/_/g, " ")}` : "";
      row([dmy(it.day), ref, desc, it.reason.text.replace(/₹/g, "Rs. "), signed(it.amountPaise)]);
    }
    row(["", "", "", "Total", signed(items.reduce((s, i) => s + i.amountPaise, 0))], true);
  }

  // 6. D — withdrawals
  heading("D — Withdrawals");
  pair(`Total (${v.debits.lines.length})`, rupees(v.debits.totalPaise), true);
  const refunds = v.debits.lines.filter((l) => l.refund);
  const reversals = v.debits.lines.filter((l) => !l.refund && l.reversalOf);
  const others = v.debits.lines.filter((l) => !l.refund && !l.reversalOf);
  for (const l of refunds) pair(`${dmy(l.day)} · refund ${l.refund!.number}`, rupees(l.amountPaise));
  for (const l of reversals) pair(`${dmy(l.day)} · ${l.reversalOf}`, rupees(l.amountPaise));
  if (opts.redactDebits) pair(`Other withdrawals (${others.length}) — details are visible to admins`, rupees(others.reduce((s, l) => s + l.amountPaise, 0)));
  else for (const l of others) pair(`${dmy(l.day)} · ${l.narration.slice(0, 70)}`, rupees(l.amountPaise));

  // 7. E — not included
  const ex = v.books.excluded;
  heading("E — Not included in this statement");
  pair(`Razorpay receipts (${ex.razorpayCount}) — settled by Razorpay in batches net of fees`, rupees(ex.razorpayPaise));
  pair(`Cash receipts (${ex.cashCount})`, rupees(ex.cashPaise));
  pair(`Receipts on other accounts (${ex.otherAccountsCount})`, rupees(ex.otherAccountsPaise));

  // 8. Sign block
  ensure(50);
  doc.y += 16;
  doc.font("Helvetica").fontSize(8.5).fillColor(INK).text(`Prepared by ${opts.signoff?.byName ?? "—"}`, left, doc.y, { width: width / 2 });
  doc.text("Reviewed by: ____________________   Date: __________", left + width / 2, doc.y - 11, { width: width / 2, align: "right" });

  const range = doc.bufferedPageRange();
  const ref = opts.signoff ? ` · v${opts.signoff.version} · ref ${opts.signoff.fingerprint.slice(0, 8)}` : "";
  const mon = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(v.month.key.slice(5, 7)) - 1]} ${v.month.key.slice(0, 4)}`;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (!opts.frozen) drawDraftMark(doc, "NOT RECONCILED");
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(7).fillColor(MUTED).text(
      `${opts.seller.legalName} · BRS ••${v.account.last4} · ${mon}${ref} · Page ${i - range.start + 1} of ${range.count}`,
      left, PAGE.height - PAGE.margin + 10, { width, align: "center", lineBreak: false },
    );
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}
