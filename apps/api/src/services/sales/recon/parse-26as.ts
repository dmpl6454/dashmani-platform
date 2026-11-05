import { fyQuarter, RECON_MAX_ROWS, reconInr } from "@dashmani/shared";
import { emptyReport, govPaise, norm, parseGovDay, pushError, type ParseReport } from "./read";

// Form 26AS Part I (TRACES "Export as Text") and its CSV / AIS-TDS cousins (spec-reconcile §4.2,
// §4.3). Pure: text or a grid in, a ParseReport out. Fields are found BY HEADING TEXT AND SHAPE,
// never by position — TRACES versions pad and reorder columns. Parsed objects are built field by
// field (never spread), so a "__proto__" key in any input is inert.

export interface TdsItem {
  rowNo: number;
  tan: string;
  deductorName: string;
  section: string | null;
  txnDate: string;
  quarter: 1 | 2 | 3 | 4;
  bookingStatus: string | null;
  bookingDate: string | null;
  remarks: string | null;
  amountPaidPaise: number;
  tdsPaise: number;
  depositedPaise: number | null;
}

const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/;
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const SECTION_RE = /^(19[2-6][A-Z0-9]{0,6}|206[A-Z0-9]*)$/;
const INT_RE = /^\d+$/;
const AMOUNT_RE = /^[\d,]+(\.\d+)?$/;

/** Split text into lines without a regex over the whole text. */
function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) {
      out.push(text.slice(start, i));
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

function cleanSection(raw: string): string | null | "bad" {
  const s = raw.toUpperCase().replace(/[-\s]/g, "").slice(0, 12);
  if (!s) return null;
  return SECTION_RE.test(s) ? s : "bad";
}

function cleanBooking(raw: string): string | null | "bad" {
  const s = raw.trim();
  if (!s || s === "-") return null;
  const c = s[0].toUpperCase();
  return "FUPO".includes(c) ? c : "bad";
}

const dash = (s: string | undefined) => {
  const t = (s ?? "").trim();
  return t === "" || t === "-" ? null : t;
};

/**
 * The 26AS text layout uses this delimiter when ≥ 30% of non-empty lines contain it and a Part I
 * heading exists — "^" (TRACES), or a tab (the same file pasted through a spreadsheet).
 */
export function detect26asDelimiter(text: string): "^" | "\t" | null {
  const lines = splitLines(text.length > 2_000_000 ? text.slice(0, 2_000_000) : text);
  let nonEmpty = 0;
  let caret = 0;
  let tab = 0;
  let part1 = false;
  for (const l of lines) {
    if (!l.trim()) continue;
    nonEmpty++;
    if (l.includes("^")) caret++;
    if (l.includes("\t")) tab++;
    if (!part1 && /PART[\s-]*I\b(?![IVX])/i.test(l.slice(0, 400)) && /tax deducted at source/i.test(l.slice(0, 400))) part1 = true;
  }
  if (!nonEmpty || !part1) return null;
  if (caret / nonEmpty >= 0.3) return "^";
  if (tab / nonEmpty >= 0.3) return "\t";
  return null;
}

/** TRACES "Export as Text" (Part I only). */
export function parse26asText(text: string, delimiter: "^" | "\t" = "^"): ParseReport<TdsItem> {
  const r = emptyReport<TdsItem>("26as_text");
  const lines = splitLines(text);
  let headerCols: string[] | null = null;
  let headerDone = false;
  let inPart1 = false;
  let sawPart1 = false;
  let noTx = false;
  let otherPartRows = 0;
  let updatedTill: string | null = null;
  let headingMap: Record<string, number> | null = null;
  type Ded = { tan: string; name: string; stated: number[]; sums: [number, number, number]; depositedKnown: boolean };
  let ded: Ded | null = null;
  const deductors: Ded[] = [];
  const tooMany = () => r.items.length > RECON_MAX_ROWS;

  for (let i = 0; i < lines.length && !tooMany(); i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const lineNo = i + 1;
    const cells = line.split(delimiter).map((c) => c.trim());
    const joined = cells.filter(Boolean).join(" ");

    const du = /data updated till\s*:?\s*([0-9A-Za-z\-/. ]{8,20})/i.exec(joined.slice(0, 500));
    if (du) {
      const d = parseGovDay(du[1].trim());
      if (d && (!updatedTill || d > updatedTill)) updatedTill = d;
    }
    if (!headerCols && cells.some((c) => norm(c) === "permanent account number pan")) {
      headerCols = cells;
      continue;
    }
    if (headerCols && !headerDone) {
      headerDone = true;
      for (let k = 0; k < headerCols.length; k++) {
        const h = norm(headerCols[k]);
        const v = (cells[k] ?? "").trim();
        if (h === "permanent account number pan" && PAN_RE.test(v.toUpperCase())) r.facts.pan = v.toUpperCase();
        else if (h === "financial year" && /^\d{4}-\d{2}$/.test(v)) r.facts.financialYear = v;
        else if (h === "assessment year" && /^\d{4}-\d{2}$/.test(v)) r.facts.assessmentYear = v;
        else if (h === "name of assessee") r.facts.name = v.slice(0, 200) || null;
        else if (h === "file creation date") r.facts.fileCreated = parseGovDay(v);
      }
      continue;
    }

    // Parts
    const head = joined.slice(0, 400);
    if (/PART[\s-]*[IVX]+\b/i.test(head) && cells.filter(Boolean).length <= 3) {
      const isPart1 = /PART[\s-]*I\b(?![IVX])/i.test(head) && /tax deducted at source/i.test(head) && !/15G|15H/i.test(head);
      inPart1 = isPart1;
      if (isPart1) sawPart1 = true;
      ded = null;
      headingMap = null;
      continue;
    }
    if (!inPart1) {
      if (sawPart1 || headerDone) otherPartRows++;
      continue;
    }
    if (/no transactions present/i.test(joined)) {
      noTx = true;
      continue;
    }

    const firstNonEmpty = cells.find((c) => c !== "") ?? "";
    // Deductor row: first cell an integer and a TAN-shaped cell.
    const tanIdx = cells.findIndex((c) => TAN_RE.test(c.toUpperCase()));
    if (cells[0] !== "" && INT_RE.test(cells[0]) && tanIdx > 0) {
      let name = "";
      for (let k = tanIdx - 1; k >= 0; k--) {
        const c = cells[k];
        if (c && !INT_RE.test(c) && !AMOUNT_RE.test(c)) { name = c; break; }
      }
      const amounts = cells.slice(tanIdx + 1).filter((c) => AMOUNT_RE.test(c));
      const stated = amounts.slice(-3).map((a) => govPaise(a)).map((p) => (typeof p === "number" ? p : 0));
      ded = { tan: cells[tanIdx].toUpperCase(), name: name.slice(0, 200), stated, sums: [0, 0, 0], depositedKnown: false };
      deductors.push(ded);
      continue;
    }
    // Heading row
    if (cells[0] === "" && cells.some((c) => norm(c) === "section") && cells.some((c) => norm(c).startsWith("transaction date"))) {
      const map: Record<string, number> = {};
      const roles: Array<[string, string]> = [
        ["section", "section"], ["transaction date", "date"], ["status of booking", "booking"], ["date of booking", "bookingDate"],
        ["remarks", "remarks"], ["amount paid credited", "amount"], ["tax deducted", "tds"], ["tds deposited", "deposited"],
      ];
      cells.forEach((c, k) => {
        const n = norm(c);
        for (const [prefix, role] of roles) if (n.startsWith(prefix) && map[role] === undefined) map[role] = k;
      });
      headingMap = map;
      continue;
    }
    // Transaction row
    if (cells[0] === "" && INT_RE.test(firstNonEmpty) && ded && headingMap) {
      const m = headingMap;
      const get = (role: string) => (m[role] === undefined ? "" : cells[m[role]] ?? "");
      const dateRaw = get("date");
      const txnDate = parseGovDay(dateRaw);
      if (!txnDate) {
        pushError(r, `line ${lineNo}`, `line ${lineNo}: the date '${dateRaw.slice(0, 30)}' is not a real day`);
        continue;
      }
      const amt = govPaise(get("amount"));
      const tds = govPaise(get("tds"));
      const dep = m.deposited === undefined ? null : govPaise(get("deposited"));
      if (amt === "error" || tds === "error" || dep === "error" || tds === null) {
        const bad = amt === "error" ? get("amount") : tds === "error" || tds === null ? get("tds") : get("deposited");
        pushError(r, `line ${lineNo}`, `line ${lineNo}: the amount '${bad.slice(0, 30)}' is not a number`);
        continue;
      }
      const sec = cleanSection(get("section"));
      if (sec === "bad") r.warnings.push(`line ${lineNo}: section '${get("section").slice(0, 20)}' is not a TDS section — shown without one.`);
      const bk = cleanBooking(get("booking"));
      if (bk === "bad") r.warnings.push(`line ${lineNo}: booking status '${get("booking").slice(0, 10)}' is not F, U, P or O — shown without a status.`);
      const item: TdsItem = {
        rowNo: lineNo,
        tan: ded.tan,
        deductorName: ded.name,
        section: sec === "bad" ? null : sec,
        txnDate,
        quarter: fyQuarter(txnDate),
        bookingStatus: bk === "bad" ? null : bk,
        bookingDate: parseGovDay(dash(get("bookingDate"))),
        remarks: dash(get("remarks"))?.slice(0, 100) ?? null,
        amountPaidPaise: amt ?? 0,
        tdsPaise: tds,
        depositedPaise: dep,
      };
      r.items.push(item);
      ded.sums[0] += item.amountPaidPaise;
      ded.sums[1] += item.tdsPaise;
      if (dep !== null) { ded.sums[2] += dep; ded.depositedKnown = true; }
    }
  }

  if (r.items.length > RECON_MAX_ROWS) {
    r.blockers.push({ code: "TOO_MANY_ROWS", message: "That file has more than 20,000 entries — download a shorter period (one quarter of 26AS, one month of GSTR-1)." });
    return r;
  }
  if (!sawPart1) {
    r.blockers.push({ code: "TDS_NO_PART1", message: "No \"Part I — Details of Tax Deducted at Source\" was found in this file." });
    return r;
  }
  for (const d of deductors) {
    if (d.stated.length < 2) continue;
    const [sa, st, sd] = d.stated;
    const differs = sa !== d.sums[0] || st !== d.sums[1] || (sd !== undefined && d.depositedKnown && sd !== d.sums[2]);
    if (differs) {
      r.warnings.push(`${d.name} (${d.tan}): lines add up to ${reconInr(d.sums[0])} / ${reconInr(d.sums[1])}, 26AS says ${reconInr(sa)} / ${reconInr(st)}.`);
    }
  }
  if (noTx && r.items.length === 0) r.warnings.push("Part I has no transactions.");
  r.facts.noTransactions = noTx ? "yes" : null;
  r.facts.otherPartRows = String(otherPartRows);
  if (r.facts.financialYear && r.facts.assessmentYear) {
    const y = Number(r.facts.financialYear.slice(0, 4));
    if (Number(r.facts.assessmentYear.slice(0, 4)) !== y + 1) r.warnings.push(`The file says FY ${r.facts.financialYear} but AY ${r.facts.assessmentYear} — check it is the right year.`);
  }
  const created = r.facts.fileCreated ?? null;
  r.facts.asOn = created && updatedTill ? (updatedTill > created ? updatedTill : created) : created ?? updatedTill;
  r.facts.deductorCount = String(new Set(r.items.map((x) => x.tan)).size);
  return r;
}

// ─── 26AS / AIS as a sheet (§4.3) ───────────────────────────────────────────────────────────

const SHEET_SYNONYMS: Record<string, string[]> = {
  tan: ["tan", "tan of deductor", "deductor tan"],
  source: ["information source", "name of deductor", "deductor name", "deductor"],
  section: ["section", "information code"],
  date: ["transaction date", "date of payment credit", "date of credit", "payment date"],
  amount: ["amount paid credited", "amount paid", "amount credited"],
  tds: ["tax deducted", "tds deducted", "tds amount"],
  deposited: ["tds deposited", "tax deposited"],
  booking: ["status of booking", "booking status"],
  bookingDate: ["date of booking"],
  status: ["status"],
};

/** A heading normalised and with a trailing "rs" / "in rs" / "inr" unit dropped. */
const headNorm = (c: string) => norm(c).replace(/\s+(in\s+)?(rs|inr)$/, "");

function mapSheetHeading(row: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  row.forEach((c, k) => {
    const n = headNorm(c);
    if (!n) return;
    for (const [role, syns] of Object.entries(SHEET_SYNONYMS)) {
      if (out[role] === undefined && syns.includes(n)) { out[role] = k; break; }
    }
  });
  return out;
}

const TAN_IN_PARENS = /\(([A-Z]{4}\d{5}[A-Z])\)\s*$/;

/** 26AS flattened to CSV/XLSX, or the AIS TDS CSV. `rows` from parseDelimited / openWorkbook. */
export function parseTdsSheet(rows: string[][]): ParseReport<TdsItem> {
  const r = emptyReport<TdsItem>("ais_csv");
  let headIdx = -1;
  let map: Record<string, number> = {};
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const m = mapSheetHeading(rows[i]);
    const hasTan = m.tan !== undefined || m.source !== undefined;
    if (hasTan && m.date !== undefined && m.tds !== undefined && m.amount !== undefined) { headIdx = i; map = m; break; }
  }
  // PAN in the preamble
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = rows[i];
    const joined = row.join(" ");
    if (!/\bPAN\b|permanent account number/i.test(joined)) continue;
    for (const c of row) {
      const mm = /\b([A-Z]{5}\d{4}[A-Z])\b/.exec(c.toUpperCase());
      if (mm) { r.facts.pan = mm[1]; break; }
    }
    if (r.facts.pan) break;
  }
  if (headIdx < 0) {
    r.blockers.push({ code: "RECON_FILE_UNREADABLE", message: "No TDS entries were found — is this Form 26AS (TRACES 'Export as Text') or the AIS TDS CSV?" });
    return r;
  }
  r.format = map.booking !== undefined ? "26as_csv" : "ais_csv";
  let skippedCodes = 0;
  let inactive = 0;
  for (let i = headIdx + 1; i < rows.length; i++) {
    if (r.items.length > RECON_MAX_ROWS) break;
    const row = rows[i];
    if (!row.some((c) => c.trim() !== "")) continue;
    const rowNo = i + 1;
    const get = (role: string) => (map[role] === undefined ? "" : (row[map[role]] ?? "").trim());
    if (map.status !== undefined && /^inactive$/i.test(get("status"))) { inactive++; continue; }
    let sectionRaw = get("section");
    if (sectionRaw && /^[A-Z]{2,5}-/i.test(sectionRaw)) {
      if (!/^TDS-/i.test(sectionRaw)) { skippedCodes++; continue; }
      sectionRaw = sectionRaw.slice(4);
    }
    const source = get("source");
    let tan = get("tan").toUpperCase();
    let name = source;
    const pm = TAN_IN_PARENS.exec(source.toUpperCase());
    if (pm) {
      if (!tan) tan = pm[1];
      name = source.slice(0, source.length - pm[0].length).trim();
    }
    if (!TAN_RE.test(tan)) { pushError(r, `row ${rowNo}`, `row ${rowNo}: no deductor TAN`); continue; }
    const dateRaw = get("date");
    const txnDate = parseGovDay(dateRaw);
    if (!txnDate) { pushError(r, `row ${rowNo}`, `row ${rowNo}: the date '${dateRaw.slice(0, 30)}' is not a real day`); continue; }
    const amt = govPaise(get("amount"));
    const tds = govPaise(get("tds"));
    const dep = map.deposited === undefined ? null : govPaise(get("deposited"));
    if (amt === "error" || tds === "error" || dep === "error" || tds === null) {
      pushError(r, `row ${rowNo}`, `row ${rowNo}: an amount is not a number`);
      continue;
    }
    const sec = cleanSection(sectionRaw);
    const bk = map.booking === undefined ? null : cleanBooking(get("booking"));
    if (bk === "bad") r.warnings.push(`row ${rowNo}: booking status '${get("booking").slice(0, 10)}' is not F, U, P or O — shown without a status.`);
    r.items.push({
      rowNo, tan, deductorName: (name || tan).slice(0, 200), section: sec === "bad" ? null : sec, txnDate, quarter: fyQuarter(txnDate),
      bookingStatus: bk === "bad" ? null : bk, bookingDate: map.bookingDate === undefined ? null : parseGovDay(dash(get("bookingDate"))),
      remarks: null, amountPaidPaise: amt ?? 0, tdsPaise: tds, depositedPaise: dep,
    });
  }
  if (r.items.length > RECON_MAX_ROWS) {
    r.blockers.push({ code: "TOO_MANY_ROWS", message: "That file has more than 20,000 entries — download a shorter period (one quarter of 26AS, one month of GSTR-1)." });
    return r;
  }
  if (skippedCodes) r.facts.skippedRows = String(skippedCodes);
  if (skippedCodes) r.warnings.push(`${skippedCodes} SFT/TCS row${skippedCodes === 1 ? "" : "s"} skipped — only TDS is compared.`);
  if (inactive) r.warnings.push(`${inactive} inactive row${inactive === 1 ? "" : "s"} skipped.`);
  if (map.deposited === undefined) r.warnings.push("AIS does not show whether the TDS was deposited.");
  r.facts.deductorCount = String(new Set(r.items.map((x) => x.tan)).size);
  return r;
}
