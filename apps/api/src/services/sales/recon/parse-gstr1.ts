import { normaliseDocNumber, RECON_MAX_ROWS } from "@dashmani/shared";
import { emptyReport, govPaise, jsonPaise, norm, parseGovDay, pushError, type ParseReport } from "./read";

// GSTR-1 as filed (spec-reconcile §4.5, §4.6): the portal / offline-tool JSON, or the Excel/CSV
// b2b and cdnr sheets (also the ones Accounts builds). Pure. Fields are read BY NAME only and
// parsed objects are never spread or merged, so a "__proto__" key is inert.

export const GSTR1_SECTIONS = ["b2b", "cdnr", "b2cl", "b2cs", "exp", "cdnur"] as const;
export type Gstr1Section = (typeof GSTR1_SECTIONS)[number];
export const TOTALS_ONLY_SECTIONS = ["b2cl", "b2cs", "exp", "cdnur"] as const;

export interface FiledDoc {
  section: "b2b" | "cdnr";
  rowRef: string;
  ctin: string | null;
  receiverName: string | null;
  number: string;
  numberKey: string;
  docDate: string | null;
  noteType: string | null;
  origNumber: string | null;
  invType: string | null;
  pos: string | null;
  reverseCharge: boolean;
  valuePaise: number;
  taxablePaise: number;
  igstPaise: number | null;
  cgstPaise: number | null;
  sgstPaise: number | null;
  cessPaise: number | null;
  ratesBp: number[];
}

export interface SectionTotals { docs: number; valuePaise: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number }
const zeroTotals = (): SectionTotals => ({ docs: 0, valuePaise: 0, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 });

export interface Gstr1Report extends ParseReport<FiledDoc> {
  gstin: string | null;
  returnPeriod: string | null;
  sections: Gstr1Section[];
  otherSections: Partial<Record<(typeof TOTALS_ONLY_SECTIONS)[number], SectionTotals>>;
  taxColumns: boolean;
}

const tooManyBlocker = { code: "TOO_MANY_ROWS", message: "That file has more than 20,000 entries — download a shorter period (one quarter of 26AS, one month of GSTR-1)." };
const unreadable = { code: "RECON_FILE_UNREADABLE", message: "No GSTR-1 invoices or notes were found — is this the GSTR-1 JSON or its b2b/cdnr sheet?" };

function emptyGstr1(format: string): Gstr1Report {
  return { ...emptyReport<FiledDoc>(format), gstin: null, returnPeriod: null, sections: [], otherSections: {}, taxColumns: true };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const own = (o: Record<string, unknown> | null, k: string): unknown => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

const posCode = (v: string | null): string | null => {
  if (!v) return null;
  const m = /^(\d{1,2})/.exec(v.trim());
  return m ? m[1].padStart(2, "0") : null;
};

/** Σ the rate lines of one JSON invoice/note: taxable, heads, distinct rates. "error" on a bad amount or rate. */
function sumItems(itms: unknown[]): { taxable: number; igst: number; cgst: number; sgst: number; cess: number; rates: number[] } | string {
  let taxable = 0, igst = 0, cgst = 0, sgst = 0, cess = 0;
  const rates = new Set<number>();
  for (const it of itms) {
    const det = obj(own(obj(it), "itm_det")) ?? obj(it);
    const vals = [jsonPaise(own(det, "txval")), jsonPaise(own(det, "iamt")), jsonPaise(own(det, "camt")), jsonPaise(own(det, "samt")), jsonPaise(own(det, "csamt"))];
    if (vals.includes("error")) return "an amount is not a number";
    const [t, i, c, s, cs] = vals as number[];
    taxable += t; igst += i; cgst += c; sgst += s; cess += cs;
    const rt = own(det, "rt");
    if (rt !== undefined && rt !== null) {
      const bp = Math.round(Number(rt) * 100);
      if (!Number.isFinite(bp) || bp < 0 || bp > 4000) return `the rate '${String(rt).slice(0, 10)}' is not a GST rate`;
      rates.add(bp);
    }
  }
  return { taxable, igst, cgst, sgst, cess, rates: [...rates].sort((a, b) => a - b) };
}

/** The GSTR-1 JSON (all six sections stated; a missing key means none were filed). */
export function parseGstr1Json(input: unknown): Gstr1Report {
  const r = emptyGstr1("json");
  const root = obj(input);
  if (!root) { r.blockers.push(unreadable); return r; }
  r.gstin = str(own(root, "gstin"))?.toUpperCase() ?? null;
  const fp = str(own(root, "fp")) ?? str(own(root, "ret_period")) ?? str(own(root, "ret_prd"));
  r.returnPeriod = fp && /^\d{6}$/.test(fp) ? fp : null;
  r.sections = [...GSTR1_SECTIONS];

  const addDoc = (section: "b2b" | "cdnr", ref: string, ctin: string | null, d: Record<string, unknown>) => {
    const number = section === "b2b" ? str(own(d, "inum")) : str(own(d, "nt_num"));
    if (!number) { pushError(r, ref, `${ref}: no document number`); return; }
    const sums = sumItems(arr(own(d, "itms")));
    if (typeof sums === "string") { pushError(r, ref, `${ref} (${number}): ${sums}`); return; }
    const val = jsonPaise(own(d, "val"));
    if (val === "error") { pushError(r, ref, `${ref} (${number}): the value is not a number`); return; }
    const dateRaw = section === "b2b" ? str(own(d, "idt")) : str(own(d, "nt_dt"));
    const ntty = section === "cdnr" ? (str(own(d, "ntty")) ?? "").toUpperCase().slice(0, 1) || null : null;
    r.items.push({
      section, rowRef: ref.slice(0, 40), ctin, receiverName: null, number: number.slice(0, 40), numberKey: normaliseDocNumber(number).key1.slice(0, 40),
      docDate: parseGovDay(dateRaw), noteType: ntty, origNumber: section === "cdnr" ? str(own(d, "inum"))?.slice(0, 40) ?? null : null,
      invType: str(own(d, "inv_typ"))?.toUpperCase().slice(0, 8) ?? null, pos: posCode(str(own(d, "pos"))),
      reverseCharge: (str(own(d, "rchrg")) ?? "").toUpperCase() === "Y",
      valuePaise: val, taxablePaise: sums.taxable, igstPaise: sums.igst, cgstPaise: sums.cgst, sgstPaise: sums.sgst, cessPaise: sums.cess, ratesBp: sums.rates,
    });
  };

  arr(own(root, "b2b")).forEach((g, i) => {
    const go = obj(g);
    const ctin = str(own(go, "ctin"))?.toUpperCase() ?? null;
    arr(own(go, "inv")).forEach((inv, j) => { const d = obj(inv); if (d) addDoc("b2b", `b2b[${i}].inv[${j}]`, ctin, d); });
  });
  arr(own(root, "cdnr")).forEach((g, i) => {
    const go = obj(g);
    const ctin = str(own(go, "ctin"))?.toUpperCase() ?? null;
    arr(own(go, "nt")).forEach((nt, j) => { const d = obj(nt); if (d) addDoc("cdnr", `cdnr[${i}].nt[${j}]`, ctin, d); });
  });

  // Totals-only sections
  const totalOf = (docs: Array<Record<string, unknown>>, perDoc: boolean): SectionTotals | string => {
    const t = zeroTotals();
    for (const d of docs) {
      const sums = sumItems(arr(own(d, "itms")).length ? arr(own(d, "itms")) : [d]);
      if (typeof sums === "string") return sums;
      const val = jsonPaise(own(d, "val"));
      if (val === "error") return "a value is not a number";
      t.docs += perDoc ? 1 : 1;
      t.valuePaise += val || (sums.taxable + sums.igst + sums.cgst + sums.sgst + sums.cess);
      t.taxablePaise += sums.taxable; t.igstPaise += sums.igst; t.cgstPaise += sums.cgst; t.sgstPaise += sums.sgst; t.cessPaise += sums.cess;
    }
    return t;
  };
  const invList = (key: string) => arr(own(root, key)).flatMap((g) => arr(own(obj(g), "inv")).map(obj).filter((x): x is Record<string, unknown> => !!x));
  const blocks: Array<[(typeof TOTALS_ONLY_SECTIONS)[number], Array<Record<string, unknown>>]> = [
    ["b2cl", invList("b2cl")],
    ["exp", invList("exp")],
    ["b2cs", arr(own(root, "b2cs")).map(obj).filter((x): x is Record<string, unknown> => !!x)],
    ["cdnur", arr(own(root, "cdnur")).map(obj).filter((x): x is Record<string, unknown> => !!x)],
  ];
  for (const [sec, docs] of blocks) {
    const t = totalOf(docs, true);
    if (typeof t === "string") { pushError(r, sec, `${sec}: ${t}`); continue; }
    r.otherSections[sec] = t;
  }
  let amendments = 0;
  const amendLabels: string[] = [];
  for (const k of ["b2ba", "cdnra", "b2cla", "expa", "cdnura"]) {
    const n = arr(own(root, k)).reduce<number>((s, g) => s + Math.max(1, arr(own(obj(g), "inv")).length + arr(own(obj(g), "nt")).length), 0);
    if (n) { amendments += n; amendLabels.push(k.toUpperCase()); }
  }
  if (amendments) r.warnings.push(`This return carries ${amendments} amendment${amendments === 1 ? "" : "s"} (${amendLabels.join(", ")}) — they are listed, not compared invoice by invoice.`);
  if (r.items.length > RECON_MAX_ROWS) { r.items = []; r.blockers.push(tooManyBlocker); }
  return r;
}

// ─── Sheets (portal Excel, offline template, Accounts' CSVs) ─────────────────────────────────

const ROLE_SYNONYMS: Array<[string, string[]]> = [
  ["ctin", ["gstin uin of recipient", "gstin of recipient", "recipient gstin", "customer gstin"]],
  ["receiver", ["receiver name", "trade legal name", "recipient name", "name of recipient"]],
  ["number", ["invoice number", "invoice no"]],
  ["noteNumber", ["note number", "note no", "debit note credit note no", "note refund voucher number"]],
  ["date", ["invoice date", "note date", "note refund voucher date"]],
  ["value", ["invoice value", "note value", "note refund voucher value"]],
  ["noteType", ["note type", "document type"]],
  ["pos", ["place of supply"]],
  ["rchrg", ["reverse charge"]],
  ["invType", ["invoice type", "note supply type"]],
  ["rate", ["rate"]],
  ["taxable", ["taxable value"]],
  ["igst", ["integrated tax", "integrated tax amount", "igst"]],
  ["cgst", ["central tax", "central tax amount", "cgst"]],
  ["sgst", ["state ut tax", "state ut tax amount", "sgst"]],
  ["cess", ["cess amount", "cess"]],
];

/** One heading row → role → column. Exact (normalised) equality only. */
export function mapGstr1Heading(row: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  row.forEach((c, k) => {
    const n = norm(c).replace(/\s+(in\s+)?(rs|inr)$/, "");
    if (!n) return;
    for (const [role, syns] of ROLE_SYNONYMS) {
      if (out[role] === undefined && syns.includes(n)) { out[role] = k; break; }
    }
  });
  return out;
}

const INV_TYPE: Record<string, string> = {
  "regular b2b": "R", regular: "R", r: "R", "sez supplies with payment": "SEWP", sewp: "SEWP",
  "sez supplies without payment": "SEWOP", sewop: "SEWOP", "deemed exp": "DE", de: "DE", cbw: "CBW",
  "intra state supplies attracting igst": "CBW",
};

function sheetSection(name: string): Gstr1Section | null {
  const n = norm(name).replace(/\s+/g, "");
  if (n.startsWith("b2ba") || n.startsWith("cdnra") || n.startsWith("b2cla") || n.startsWith("cdnura")) return null;
  if (n.startsWith("b2cl")) return "b2cl";
  if (n.startsWith("b2cs")) return "b2cs";
  if (n.startsWith("b2b")) return "b2b";
  if (n.startsWith("cdnur")) return "cdnur";
  if (n.startsWith("cdnr")) return "cdnr";
  if (n.startsWith("exp")) return "exp";
  return null;
}

/**
 * The b2b/cdnr/b2cl/b2cs/exp sheets of a workbook, or one CSV (name "" — its section comes from
 * its headings: a note-number column → cdnr, else b2b). A multi-rate invoice spans rows: grouped
 * by (section, key1(number), date, ctin), value from the first row, taxable/taxes summed.
 */
export function parseGstr1Sheets(sheets: Array<{ name: string; rows: string[][] }>, format: string): Gstr1Report {
  const r = emptyGstr1(format);
  let allTaxCols = true;
  for (const sh of sheets) {
    let sec = sh.name ? sheetSection(sh.name) : null;
    if (sh.name && !sec) continue;
    let headIdx = -1;
    let map: Record<string, number> = {};
    for (let i = 0; i < Math.min(sh.rows.length, 15); i++) {
      const m = mapGstr1Heading(sh.rows[i]);
      const hasNumber = m.number !== undefined || m.noteNumber !== undefined;
      if (hasNumber && m.taxable !== undefined && Object.keys(m).length >= 4) { headIdx = i; map = m; break; }
      // b2cs has no number column: rate + taxable + place of supply is enough
      if (sec === "b2cs" && m.taxable !== undefined && m.pos !== undefined) { headIdx = i; map = m; break; }
    }
    if (headIdx < 0) continue;
    if (!sec) sec = map.noteNumber !== undefined ? "cdnr" : "b2b";
    if (!r.sections.includes(sec)) r.sections.push(sec);
    const taxCols = map.igst !== undefined || map.cgst !== undefined || map.sgst !== undefined;
    const numCol = map.number ?? map.noteNumber;
    const get = (row: string[], role: string) => (map[role] === undefined ? "" : (row[map[role]] ?? "").trim());

    if (sec === "b2b" || sec === "cdnr") {
      allTaxCols = allTaxCols && taxCols;
      const groups = new Map<string, FiledDoc>();
      for (let i = headIdx + 1; i < sh.rows.length; i++) {
        const row = sh.rows[i];
        if (!row.some((c) => c.trim() !== "")) continue;
        const ref = `${sec}!${i + 1}`;
        const number = (row[numCol!] ?? "").trim();
        if (!number) continue; // summary / total rows
        const ctin = get(row, "ctin").toUpperCase() || null;
        const dateRaw = get(row, "date");
        const docDate = parseGovDay(dateRaw);
        const key = `${normaliseDocNumber(number).key1}|${docDate ?? dateRaw}|${ctin ?? ""}`;
        const taxable = govPaise(get(row, "taxable"));
        const heads = [govPaise(get(row, "igst")), govPaise(get(row, "cgst")), govPaise(get(row, "sgst")), govPaise(get(row, "cess"))];
        if (taxable === "error" || taxable === null || heads.includes("error")) { pushError(r, ref, `${ref} (${number}): an amount is not a number`); continue; }
        const [ig, cg, sg, cs] = heads as Array<number | null>;
        const rateRaw = get(row, "rate").replace("%", "").trim();
        let rateBp: number | null = null;
        if (rateRaw) {
          const n = Number(rateRaw);
          if (!Number.isFinite(n) || n < 0 || n > 40) { pushError(r, ref, `${ref} (${number}): the rate '${rateRaw.slice(0, 10)}' is not a GST rate`); continue; }
          rateBp = Math.round(n * 100);
        }
        const valueRaw = govPaise(get(row, "value"));
        if (valueRaw === "error") { pushError(r, ref, `${ref} (${number}): the value is not a number`); continue; }
        const existing = groups.get(key);
        if (existing) {
          if (valueRaw !== null && valueRaw !== existing.valuePaise) r.warnings.push(`${number}: the invoice value differs between its rows.`);
          existing.taxablePaise += taxable;
          if (taxCols) {
            existing.igstPaise = (existing.igstPaise ?? 0) + (ig ?? 0);
            existing.cgstPaise = (existing.cgstPaise ?? 0) + (cg ?? 0);
            existing.sgstPaise = (existing.sgstPaise ?? 0) + (sg ?? 0);
          }
          if (map.cess !== undefined) existing.cessPaise = (existing.cessPaise ?? 0) + (cs ?? 0);
          if (rateBp !== null && !existing.ratesBp.includes(rateBp)) existing.ratesBp = [...existing.ratesBp, rateBp].sort((a, b) => a - b);
          continue;
        }
        if (valueRaw === null) { pushError(r, ref, `${ref} (${number}): no invoice value`); continue; }
        const nt = get(row, "noteType").toUpperCase();
        const invTypeRaw = get(row, "invType");
        const invType = invTypeRaw ? (INV_TYPE[norm(invTypeRaw)] ?? invTypeRaw.toUpperCase().slice(0, 8)) : null;
        groups.set(key, {
          section: sec, rowRef: ref.slice(0, 40), ctin, receiverName: get(row, "receiver").slice(0, 200) || null,
          number: number.slice(0, 40), numberKey: normaliseDocNumber(number).key1.slice(0, 40), docDate,
          noteType: sec === "cdnr" ? (nt.startsWith("D") ? "D" : nt ? "C" : null) : null, origNumber: null, invType,
          pos: posCode(get(row, "pos")), reverseCharge: get(row, "rchrg").toUpperCase().startsWith("Y"),
          valuePaise: valueRaw, taxablePaise: taxable,
          igstPaise: taxCols ? ig ?? 0 : null, cgstPaise: taxCols ? cg ?? 0 : null, sgstPaise: taxCols ? sg ?? 0 : null,
          cessPaise: map.cess !== undefined ? cs ?? 0 : null, ratesBp: rateBp === null ? [] : [rateBp],
        });
        if (groups.size > RECON_MAX_ROWS) break;
      }
      for (const d of groups.values()) r.items.push(d);
    } else {
      const t = zeroTotals();
      const seen = new Set<string>();
      for (let i = headIdx + 1; i < sh.rows.length; i++) {
        const row = sh.rows[i];
        if (!row.some((c) => c.trim() !== "")) continue;
        const number = numCol === undefined ? "" : (row[numCol] ?? "").trim();
        const taxable = govPaise(get(row, "taxable"));
        if (taxable === "error" || taxable === null) continue;
        const heads = [govPaise(get(row, "igst")), govPaise(get(row, "cgst")), govPaise(get(row, "sgst")), govPaise(get(row, "cess"))].map((h) => (typeof h === "number" ? h : 0));
        const val = govPaise(get(row, "value"));
        if (number) { if (!seen.has(number)) { seen.add(number); t.docs++; if (typeof val === "number") t.valuePaise += val; } }
        else { t.docs++; t.valuePaise += taxable + heads[0] + heads[1] + heads[2] + heads[3]; }
        t.taxablePaise += taxable; t.igstPaise += heads[0]; t.cgstPaise += heads[1]; t.sgstPaise += heads[2]; t.cessPaise += heads[3];
      }
      r.otherSections[sec as (typeof TOTALS_ONLY_SECTIONS)[number]] = t;
    }
  }
  // false = some b2b/cdnr sheet had no IGST/CGST/SGST columns: its tax fields are null (never computed).
  r.taxColumns = r.sections.some((s) => s === "b2b" || s === "cdnr") ? allTaxCols : true;
  if (r.items.length > RECON_MAX_ROWS) { r.items = []; r.blockers.push(tooManyBlocker); }
  if (!r.sections.length) r.blockers.push(unreadable);
  return r;
}
