import { createHash } from "crypto";
import { IMPORT_FIELDS, type ImportField } from "@dashmani/shared";
import { gstinShapeOk, parseAmount, parseDay, parseQty } from "./values";

// Swipe import (spec-import §4.2–4.3): finding the heading row, matching each column to a field, and
// deciding whether an amount column holds per-item or per-invoice figures. Pure.

/** Normalised heading forms per field (spec-import §4.2 synonym table). */
export const IMPORT_SYNONYMS: Record<ImportField, string[]> = {
  number: ["invoice number", "invoice no", "inv no", "invoice id", "bill no", "bill number", "document number", "doc no", "voucher no", "serial no", "invoice"],
  issueDate: ["invoice date", "inv date", "bill date", "document date", "doc date", "voucher date", "date"],
  dueDate: ["due date", "payment due date", "due on", "due by"],
  docType: ["document type", "doc type", "voucher type", "invoice type", "type"],
  status: ["payment status", "invoice status", "status"],
  sellerGstin: ["company gstin", "seller gstin", "supplier gstin", "your gstin", "business gstin", "gstin of supplier", "from gstin", "billing gstin"],
  placeOfSupply: ["place of supply", "pos", "supply state", "state of supply"],
  poNumber: ["po number", "po no", "purchase order", "purchase order number", "po reference"],
  poDate: ["po date", "purchase order date"],
  notes: ["notes", "remarks", "narration", "comments", "note"],
  irn: ["irn", "e invoice irn", "ack no"],
  customerName: ["customer name", "party name", "client name", "billing name", "buyer name", "bill to", "billed to", "customer", "party", "client", "company name"],
  customerGstin: ["customer gstin", "party gstin", "buyer gstin", "gstin uin", "gst number", "customer gst", "gst no", "gstin no", "gstin"],
  customerAddress: ["billing address", "customer address", "address line 1", "address"],
  customerCity: ["billing city", "customer city", "city"],
  customerState: ["billing state", "customer state", "state"],
  customerPincode: ["pincode", "pin code", "postal code", "zip", "pin"],
  customerEmail: ["customer email", "email id", "email"],
  itemName: ["item name", "product name", "item", "product", "service", "particulars"],
  itemDescription: ["item description", "product description", "description"],
  hsnSac: ["hsn sac", "hsn sac code", "hsn code", "sac code", "hsn", "sac"],
  quantity: ["quantity", "qty", "units", "no of units"],
  rate: ["unit price", "price per unit", "rate per unit", "unit rate", "selling price", "rate", "price"],
  lineDiscount: ["item discount", "discount on item", "line discount"],
  gstRate: ["gst pct", "gst rate", "tax pct", "tax rate", "igst pct", "gst rate pct", "gst"],
  taxable: ["taxable value", "taxable amount", "total taxable value", "item taxable value", "amount before tax", "net amount", "taxable"],
  discount: ["invoice discount", "extra discount", "total discount", "discount amount", "discount"],
  cgst: ["cgst amount", "cgst amt", "central tax", "cgst"],
  sgst: ["sgst amount", "sgst amt", "sgst utgst", "utgst", "state tax", "sgst"],
  igst: ["igst amount", "igst amt", "integrated tax", "igst"],
  totalTax: ["total tax", "tax amount", "gst amount"],
  cess: ["cess amount", "compensation cess", "cess"],
  tcs: ["tcs amount", "tcs"],
  roundOff: ["round off", "round off amount", "rounded off", "rounding"],
  total: ["invoice total", "total amount", "grand total", "invoice amount", "invoice value", "total value", "net payable", "amount payable", "net total", "total", "amount"],
  amountPaid: ["amount paid", "paid amount", "amount received", "received amount", "payment received", "total paid", "paid", "received"],
  tds: ["tds amount", "tds deducted", "tds deduction", "tax deducted at source", "withholding tax", "tds"],
  balance: ["balance due", "amount due", "due amount", "pending amount", "outstanding", "balance"],
  paidOn: ["payment date", "paid on", "paid date", "last payment date", "date of payment", "received on", "payment received on"],
};

/** Field labels for the portal and for messages ("Map the column for Invoice number"). */
export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  number: "Invoice number", issueDate: "Invoice date", dueDate: "Due date", docType: "Document type", status: "Status",
  sellerGstin: "Billed-from GSTIN", placeOfSupply: "Place of supply", poNumber: "PO number", poDate: "PO date", notes: "Notes", irn: "IRN",
  customerName: "Customer name", customerGstin: "Customer GSTIN", customerAddress: "Customer address", customerCity: "Customer city",
  customerState: "Customer state", customerPincode: "Customer PIN code", customerEmail: "Customer email",
  itemName: "Item", itemDescription: "Item description", hsnSac: "HSN/SAC", quantity: "Quantity", rate: "Rate", lineDiscount: "Item discount", gstRate: "GST rate",
  taxable: "Taxable value", discount: "Discount", cgst: "CGST", sgst: "SGST", igst: "IGST", totalTax: "Total tax", cess: "Cess", tcs: "TCS",
  roundOff: "Round off", total: "Invoice total", amountPaid: "Amount paid", tds: "TDS", balance: "Balance", paidOn: "Paid on",
};

/** lower-case; & → and, # → no, % → pct; drop ₹ (inr) (rs); everything else non-alphanumeric → space. */
export function normaliseHeader(s: string | null | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/#/g, " no ")
    .replace(/%/g, " pct ")
    .replace(/₹|\(inr\)|\(rs\.?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** How well one normalised heading names a field: exact synonym 100; whole-word contains 60 + min(35, length). */
export function headerScore(field: ImportField, norm: string): number {
  if (!norm) return 0;
  let best = 0;
  const padded = ` ${norm} `;
  for (const syn of IMPORT_SYNONYMS[field]) {
    if (norm === syn) return 100;
    if (padded.includes(` ${syn} `)) best = Math.max(best, 60 + Math.min(35, syn.length));
  }
  return best;
}

/**
 * The 0-based index of the heading row among the first 30: the row with ≥ 3 distinct fields scoring
 * ≥ 70, `number` among them, and the highest total (ties → the earliest). Null when none qualifies.
 */
export function detectHeaderRow(rows: string[][]): number | null {
  let best: { idx: number; total: number } | null = null;
  for (let r = 0; r < Math.min(30, rows.length); r++) {
    const cells = rows[r].map(normaliseHeader);
    const fieldBest = new Map<ImportField, number>();
    for (const f of IMPORT_FIELDS) {
      let b = 0;
      for (const c of cells) b = Math.max(b, headerScore(f, c));
      if (b >= 70) fieldBest.set(f, b);
    }
    if (fieldBest.size < 3 || !fieldBest.has("number")) continue;
    const total = [...fieldBest.values()].reduce((s, v) => s + v, 0);
    if (!best || total > best.total) best = { idx: r, total };
  }
  return best ? best.idx : null;
}

/** sha256 hex of the normalised headings joined by "|" — a later upload with the same columns starts from this mapping. */
export function headerSignature(headers: string[]): string {
  return createHash("sha256").update(headers.map(normaliseHeader).join("|")).digest("hex");
}

export type MappingHow = "auto" | "check" | "user" | "previous" | "missing";
export type ImportMapping = Partial<Record<ImportField, number | null>>;

const DATE_FIELDS = new Set<ImportField>(["issueDate", "dueDate", "poDate", "paidOn"]);
const MONEY_FIELDS = new Set<ImportField>(["taxable", "discount", "cgst", "sgst", "igst", "totalTax", "cess", "tcs", "roundOff", "total", "amountPaid", "tds", "balance", "rate", "lineDiscount"]);
const GSTIN_FIELDS = new Set<ImportField>(["sellerGstin", "customerGstin"]);
const ONE_WORD = new Set(["date", "type", "gst", "state", "amount", "invoice"]);
const PRIORITY: ImportField[] = ["number", "issueDate", "customerName", "total", "customerGstin", "taxable", "cgst", "sgst", "igst", "amountPaid", "tds", "balance", "status", "dueDate", "paidOn", "placeOfSupply", "itemName", "hsnSac", "quantity", "rate", "gstRate", "sellerGstin", "poNumber"];
const priorityOf = (f: ImportField) => { const i = PRIORITY.indexOf(f); return i < 0 ? PRIORITY.length + IMPORT_FIELDS.indexOf(f) : i; };

/** Share of a column's first 200 non-empty values that pass the field's value test; null when the field has none or the column is empty. */
function valuePass(field: ImportField, values: string[]): number | null {
  let test: ((v: string) => boolean) | null = null;
  if (DATE_FIELDS.has(field)) test = (v) => parseDay(v, "dmy") !== null || parseDay(v, "mdy") !== null;
  else if (MONEY_FIELDS.has(field)) test = (v) => !("error" in parseAmount(v));
  else if (GSTIN_FIELDS.has(field)) test = gstinShapeOk;
  else if (field === "quantity") test = (v) => parseQty(v) !== null;
  else if (field === "number") test = (v) => /^[A-Za-z0-9/ -]{1,32}$/.test(v) && /\d/.test(v);
  if (!test || !values.length) return null;
  let ok = 0;
  for (const v of values) if (test(v)) ok++;
  return ok / values.length;
}

/** First 200 non-empty values of each column. */
export function columnSamples(body: string[][], width: number, limit = 200): string[][] {
  const out: string[][] = Array.from({ length: width }, () => []);
  for (const row of body) {
    for (let c = 0; c < width; c++) {
      const v = (row[c] ?? "").trim();
      if (v && out[c].length < limit) out[c].push(v);
    }
  }
  return out;
}

/**
 * Map each field to at most one column (spec-import §4.2): the heading score plus a value test
 * (+20 when ≥ 80% pass, −50 when < 30%), one-word headings capped at 69 unless the values pass;
 * greedy by score (ties → field priority, then column). ≥ 70 = auto, 50–69 = check.
 * When two columns hold GSTINs, the one whose values are all the companies' own GSTINs is the seller's.
 */
export function autoMap(headers: string[], body: string[][], ownGstins: ReadonlySet<string>): { mapping: ImportMapping; how: Partial<Record<ImportField, MappingHow>> } {
  const norms = headers.map(normaliseHeader);
  const samples = columnSamples(body, headers.length);
  const scores: Array<{ f: ImportField; c: number; s: number }> = [];
  const gstinPass = new Map<number, boolean>();
  for (let c = 0; c < headers.length; c++) gstinPass.set(c, (valuePass("customerGstin", samples[c]) ?? 0) >= 0.8);
  const gstinCols = [...gstinPass.entries()].filter(([, p]) => p).map(([c]) => c);
  const ownCols = new Set(gstinCols.filter((c) => samples[c].length > 0 && samples[c].every((v) => ownGstins.has(v.trim().toUpperCase()))));
  for (const f of IMPORT_FIELDS) {
    for (let c = 0; c < headers.length; c++) {
      let s = headerScore(f, norms[c]);
      const pass = valuePass(f, samples[c]);
      if (pass !== null) {
        if (pass >= 0.8) s += 20;
        else if (pass < 0.3) s -= 50;
      }
      if (ONE_WORD.has(norms[c]) && !(pass !== null && pass >= 0.8)) s = Math.min(s, 69);
      if (gstinCols.length >= 2 && ownCols.size) {
        if (ownCols.has(c)) { if (f === "sellerGstin") s = Math.max(s, 100); if (f === "customerGstin") s = 0; }
        else if (gstinPass.get(c) && f === "sellerGstin") s = 0;
      }
      if (s >= 50) scores.push({ f, c, s });
    }
  }
  scores.sort((a, b) => b.s - a.s || priorityOf(a.f) - priorityOf(b.f) || a.c - b.c);
  const mapping: ImportMapping = {};
  const how: Partial<Record<ImportField, MappingHow>> = {};
  const usedCols = new Set<number>();
  for (const { f, c, s } of scores) {
    if (f in mapping || usedCols.has(c)) continue;
    mapping[f] = c;
    how[f] = s >= 70 ? "auto" : "check";
    usedCols.add(c);
  }
  for (const f of IMPORT_FIELDS) if (!(f in mapping)) { mapping[f] = null; how[f] = "missing"; }
  return { mapping, how };
}

export type AmountLevelField = "taxable" | "discount" | "cgst" | "sgst" | "igst" | "totalTax" | "total";
export type Level = "line" | "invoice";
const TAX_SET: AmountLevelField[] = ["taxable", "cgst", "sgst", "igst", "totalTax"];

/**
 * Per amount column: per-item ("line") or one figure repeated per invoice ("invoice") — spec-import §4.3.
 * Groups are the body rows of each invoice. Constancy decides (a figure that varies inside an
 * invoice cannot be the invoice's); for the tax set an arithmetic tie-break catches two equal item lines.
 */
export function amountLevels(
  groups: string[][][],
  mapping: ImportMapping,
  forced: "auto" | "line" | "invoice" = "auto",
): { levels: Partial<Record<AmountLevelField, Level>>; oneRowPerInvoice: boolean } {
  const levels: Partial<Record<AmountLevelField, Level>> = {};
  const multi = groups.filter((g) => g.length >= 2);
  const mapped = (f: AmountLevelField) => mapping[f] !== null && mapping[f] !== undefined;
  const cell = (row: string[], f: AmountLevelField) => row[mapping[f] as number] ?? "";
  const allFields: AmountLevelField[] = ["taxable", "discount", "cgst", "sgst", "igst", "totalTax", "total"];
  if (!multi.length) {
    for (const f of allFields) if (mapped(f)) levels[f] = "invoice";
    return { levels, oneRowPerInvoice: true };
  }
  for (const f of allFields) {
    if (!mapped(f)) continue;
    let constant = 0;
    for (const g of multi) {
      const vals = g.map((r) => cell(r, f).trim()).filter((v) => v !== "" && v !== "-");
      const ps = vals.map((v) => { const a = parseAmount(v); return "paise" in a ? a.paise : v; });
      if (ps.every((p) => p === ps[0])) constant++;
    }
    levels[f] = constant / multi.length < 0.95 ? "line" : "invoice";
  }
  const setMapped = TAX_SET.filter(mapped);
  if (setMapped.length && mapped("total") && setMapped.every((f) => levels[f] === "invoice")) {
    const sumOf = (g: string[][], f: AmountLevelField) => g.reduce((s, r) => s + (amt(cell(r, f)) ?? 0), 0);
    const firstOf = (g: string[][], f: AmountLevelField) => { for (const r of g) { const a = amt(cell(r, f)); if (a !== null) return a; } return 0; };
    const totalOf = (g: string[][]) => (levels.total === "line" ? sumOf(g, "total") : firstOf(g, "total"));
    let lineFits = 0;
    let invFits = 0;
    for (const g of multi) {
      const tol = Math.max(100, g.length);
      const t = totalOf(g);
      const perLine = setMapped.reduce((s, f) => s + sumOf(g, f), 0);
      const perInv = setMapped.reduce((s, f) => s + firstOf(g, f), 0);
      if (Math.abs(perLine - t) <= tol) lineFits++;
      if (Math.abs(perInv - t) <= tol) invFits++;
    }
    if (lineFits > invFits) for (const f of setMapped) levels[f] = "line";
  }
  if (forced !== "auto") {
    for (const f of [...TAX_SET, "discount" as const]) if (mapped(f)) levels[f] = forced;
  }
  return { levels, oneRowPerInvoice: false };
}

const amt = (v: string): number | null => { const a = parseAmount(v); return "paise" in a ? a.paise : null; };
