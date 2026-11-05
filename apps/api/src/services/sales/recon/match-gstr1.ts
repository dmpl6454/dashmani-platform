import { dayDiff, GST_STATUS_ORDER, normaliseDocNumber, RECON_REASONS, RECON_TOLERANCE_PAISE, reconDay, reconInr, type GstStatus } from "@dashmani/shared";
import type { FiledDoc, SectionTotals } from "./parse-gstr1";

// GST books vs the filed GSTR-1 (spec-reconcile §5.2). PURE and shuffle-invariant. The books are
// ONE registration's documents only — the caller scopes them by seller GSTIN, so no number key
// ever crosses GSTINs (Mumbai INV/26-27/0016 and Gurugram INV/26-27/016 share key1 and are never
// compared). Passes on key0 (exact) → key1 (owner's rule) → key2 (separators), then pass 3.

const TOL = RECON_TOLERANCE_PAISE;
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface Heads { valuePaise: number; taxablePaise: number; igstPaise: number | null; cgstPaise: number | null; sgstPaise: number | null; cessPaise: number | null }

export interface BookDoc {
  id: string; kind: "invoice" | "credit_note"; number: string; status: string; date: string; cancelledOn: string | null; cancelReason?: string | null;
  buyerGstin: string | null; buyerName: string | null; pos: string | null; section: string;
  valuePaise: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; ratesBp: number[];
  /** credit note: its invoice's number and id */
  invoiceNumber: string | null; invoiceId: string | null;
}
export interface FiledIn extends FiledDoc { id: string; uploadId: string }
export interface ElsewhereDoc { key0: string; kind: "registration" | "company" | "proforma"; number: string; invoiceId: string; companyKey: string; gstin: string | null; label: string }
export interface OtherPeriodKey { period: string; label: string; section: "b2b" | "cdnr"; numberKey: string }

export type GstIssue = { code: string; message: string; differencePaise?: number };
export interface GstRow {
  key: string; section: "b2b" | "cdnr"; status: GstStatus; issues: GstIssue[];
  books: null | (Heads & { id: string; kind: "invoice" | "credit_note"; number: string; date: string; status: string; buyerGstin: string | null; buyerName: string | null; ratesBp: number[]; pos: string | null; section: string });
  filed: null | (Heads & { id: string; rowRef: string; number: string; date: string | null; ctin: string | null; receiverName: string | null; ratesBp: number[]; pos: string | null; invType: string | null; uploadId: string });
  diff: Heads | null;
  hint: null | { text: string; invoiceId?: string; companyKey?: string; gstin?: string; period?: string; importable?: boolean };
  action: string;
}
export interface GstSectionRow { section: "b2b" | "sez" | "cdnr" | "b2cl" | "b2cs" | "exp"; books: Heads; filed: Heads | null; comparedItemwise: boolean; differs: boolean; note: string | null }
export interface GstMatchResult { rows: GstRow[]; counts: Record<GstStatus, number> & { cancelledNotFiled: number }; sections: GstSectionRow[]; importable: boolean }

const zeroHeads = (): Heads => ({ valuePaise: 0, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 });
const SECTION_LABEL: Record<GstSectionRow["section"], string> = { b2b: "B2B", sez: "SEZ", cdnr: "Credit notes (CDNR)", b2cl: "B2C large", b2cs: "B2C small", exp: "Exports" };
const HEAD_LABEL: Array<[keyof Heads, string]> = [["taxablePaise", "Taxable"], ["igstPaise", "IGST"], ["cgstPaise", "CGST"], ["sgstPaise", "SGST"], ["valuePaise", "Value"]];
const signed = (p: number) => `${p >= 0 ? "+" : "−"}${reconInr(Math.abs(p))}`;

function booksView(b: BookDoc): NonNullable<GstRow["books"]> {
  return { id: b.id, kind: b.kind, number: b.number, date: b.date, status: b.status, buyerGstin: b.buyerGstin, buyerName: b.buyerName, ratesBp: b.ratesBp, pos: b.pos, section: b.section,
    valuePaise: b.valuePaise, taxablePaise: b.taxablePaise, igstPaise: b.igstPaise, cgstPaise: b.cgstPaise, sgstPaise: b.sgstPaise, cessPaise: 0 };
}
function filedView(f: FiledIn): NonNullable<GstRow["filed"]> {
  return { id: f.id, rowRef: f.rowRef, number: f.number, date: f.docDate, ctin: f.ctin, receiverName: f.receiverName, ratesBp: f.ratesBp, pos: f.pos, invType: f.invType, uploadId: f.uploadId,
    valuePaise: f.valuePaise, taxablePaise: f.taxablePaise, igstPaise: f.igstPaise, cgstPaise: f.cgstPaise, sgstPaise: f.sgstPaise, cessPaise: f.cessPaise };
}

export function matchGstr1(input: {
  gstin: string;
  period: { key: string; label: string; from: string; toExclusive: string };
  books: BookDoc[];
  filed: FiledIn[];
  elsewhere: ElsewhereDoc[];
  otherPeriods: OtherPeriodKey[];
  nextPeriod: { label: string; uploaded: boolean };
  filedOther: Partial<Record<"b2cl" | "b2cs" | "exp" | "cdnur", SectionTotals>>;
}): GstMatchResult {
  const { period } = input;
  const inPeriod = (d: string | null) => !!d && d >= period.from && d < period.toExclusive;
  const rows: GstRow[] = [];
  const claimed = new Set<string>();
  const books = [...input.books].sort((a, b) => cmpStr(a.id, b.id));
  const elsewhereByKey0 = new Map<string, ElsewhereDoc[]>();
  for (const e of [...input.elsewhere].sort((a, b) => cmpStr(a.kind, b.kind) || cmpStr(a.invoiceId, b.invoiceId))) elsewhereByKey0.set(e.key0, [...(elsewhereByKey0.get(e.key0) ?? []), e]);
  const otherKeys = new Map<string, OtherPeriodKey>();
  for (const o of [...input.otherPeriods].sort((a, b) => cmpStr(a.period, b.period))) {
    const k = `${o.section}|${o.numberKey}`;
    if (!otherKeys.has(k)) otherKeys.set(k, o);
  }
  let importable = false;

  for (const section of ["b2b", "cdnr"] as const) {
    const kind = section === "b2b" ? "invoice" : "credit_note";
    const filedAll = input.filed.filter((f) => f.section === section).sort((a, b) => cmpStr(a.rowRef, b.rowRef) || cmpStr(a.id, b.id));
    const pool = books.filter((b) => b.kind === kind);
    const keysOf = new Map(pool.map((b) => [b.id, normaliseDocNumber(b.number)]));
    const unmatched: FiledIn[] = [];
    const notInBooks: Array<{ f: FiledIn; issue?: GstIssue }> = [];

    // 1. duplicates in the file, debit notes
    const seenKey1 = new Map<string, FiledIn>();
    for (const f of filedAll) {
      if (section === "cdnr" && f.noteType === "D") { notInBooks.push({ f, issue: { code: "debit_note", message: "A debit note — the portal has no debit notes." } }); continue; }
      const k1 = normaliseDocNumber(f.number).key1;
      const first = seenKey1.get(k1);
      if (first) { notInBooks.push({ f, issue: { code: "filed_twice", message: `Filed twice — same number as ${first.rowRef}.` } }); continue; }
      seenKey1.set(k1, f);
      unmatched.push(f);
    }

    // 2. passes 0 / 1 / 2 within this registration's books
    const pairs: Array<{ f: FiledIn; b: BookDoc; pass: number }> = [];
    for (const [pass, which] of [[0, "key0"], [1, "key1"], [2, "key2"]] as const) {
      const ordered = unmatched.filter((f) => !pairs.some((p) => p.f.id === f.id))
        .map((f) => ({ f, k: normaliseDocNumber(f.number)[which] }))
        .sort((a, b) => cmpStr(a.k, b.k) || cmpStr(a.f.rowRef, b.f.rowRef));
      for (const { f, k } of ordered) {
        const cands = pool.filter((b) => !claimed.has(b.id) && keysOf.get(b.id)![which] === k);
        if (!cands.length) continue;
        cands.sort((a, b) =>
          (a.buyerGstin === f.ctin ? 0 : 1) - (b.buyerGstin === f.ctin ? 0 : 1)
          || (inPeriod(a.date) ? 0 : 1) - (inPeriod(b.date) ? 0 : 1)
          || (f.docDate ? Math.abs(dayDiff(a.date, f.docDate)) - Math.abs(dayDiff(b.date, f.docDate)) : 0)
          || Math.abs(a.valuePaise - f.valuePaise) - Math.abs(b.valuePaise - f.valuePaise)
          || cmpStr(a.id, b.id));
        claimed.add(cands[0].id);
        pairs.push({ f, b: cands[0], pass });
      }
    }
    // 3. pass 3 — same recipient, same day, same value, a differently-written number
    for (const f of unmatched) {
      if (pairs.some((p) => p.f.id === f.id)) continue;
      const cands = pool.filter((b) => !claimed.has(b.id) && f.ctin && b.buyerGstin === f.ctin && b.date === f.docDate && Math.abs(b.valuePaise - f.valuePaise) <= TOL);
      if (cands.length === 1) { claimed.add(cands[0].id); pairs.push({ f, b: cands[0], pass: 3 }); continue; }
      notInBooks.push({ f });
    }

    // 4. issues of each pair
    for (const { f, b, pass } of pairs) {
      const issues: GstIssue[] = [];
      let money = false;
      if (b.status === "cancelled") issues.push({ code: "cancelled_but_filed", message: `Cancelled here on ${reconDay(b.cancelledOn)}${b.cancelReason ? ` (${b.cancelReason})` : ""} but filed.` });
      if (pass === 3) { issues.push({ code: "number_differs", message: `Filed as ${f.number}; the portal number is ${b.number}.` }); money = true; }
      else if (normaliseDocNumber(f.number).key0 !== keysOf.get(b.id)!.key0) issues.push({ code: "number_written_differently", message: `Filed as ${f.number}.` });
      let wrongRecipient = false;
      if (f.ctin !== b.buyerGstin) {
        wrongRecipient = true;
        issues.push({ code: "wrong_recipient", message: b.buyerGstin ? `Filed against ${f.ctin ?? "no GSTIN"}; the invoice's buyer is ${b.buyerGstin}.` : "Filed as B2B, the invoice has no buyer GSTIN." });
      }
      const late = !inPeriod(b.date);
      if (late) issues.push({ code: "late_reported", message: `Dated ${reconDay(b.date)} — outside ${period.label}.` });
      if (f.docDate && f.docDate !== b.date) { issues.push({ code: "date_differs", message: `Filed with date ${reconDay(f.docDate)}; the portal date is ${reconDay(b.date)}.` }); money = true; }
      const diff = zeroHeads();
      for (const [h, label] of HEAD_LABEL) {
        const fv = f[h as keyof FiledIn] as number | null;
        const bv = booksView(b)[h] as number | null;
        if (fv === null || bv === null) { (diff as unknown as Record<string, number | null>)[h] = null; continue; }
        const d = fv - bv;
        (diff as unknown as Record<string, number>)[h] = d;
        if (Math.abs(d) > TOL) { issues.push({ code: "value_mismatch", message: `${label}: portal ${reconInr(bv)}, filed ${reconInr(fv)} (${signed(d)})`, differencePaise: d }); money = true; }
      }
      diff.cessPaise = f.cessPaise;
      if (f.ratesBp.length && (f.ratesBp.length !== b.ratesBp.length || f.ratesBp.some((r) => !b.ratesBp.includes(r)))) {
        issues.push({ code: "rate_differs", message: `Filed at ${f.ratesBp.map((r) => `${r / 100}%`).join(" + ")}; the portal rate is ${b.ratesBp.map((r) => `${r / 100}%`).join(" + ")}.` }); money = true;
      }
      if (f.pos && b.pos && f.pos !== b.pos) { issues.push({ code: "pos_differs", message: `Place of supply filed ${f.pos}, portal ${b.pos}.` }); money = true; }
      const sezFiled = f.invType === "SEWP" || f.invType === "SEWOP";
      if ((b.section === "sez" && f.invType === "R") || (b.section === "b2b" && sezFiled)) {
        issues.push({ code: "type_differs", message: b.section === "sez" ? "An SEZ supply in the portal, filed as a regular B2B invoice." : `A regular invoice in the portal, filed as ${f.invType}.` }); money = true;
      }
      if (f.reverseCharge) { issues.push({ code: "reverse_charge", message: "Filed under reverse charge." }); money = true; }
      if ((f.cessPaise ?? 0) > 0) { issues.push({ code: "cess_filed", message: `Cess ${reconInr(f.cessPaise!)} filed; the portal charges none.` }); money = true; }
      if (section === "cdnr" && f.origNumber && b.invoiceNumber && normaliseDocNumber(f.origNumber).key1 !== normaliseDocNumber(b.invoiceNumber).key1) {
        issues.push({ code: "orig_invoice_differs", message: `Filed against invoice ${f.origNumber}; the note is on ${b.invoiceNumber}.` }); money = true;
      }
      const status: GstStatus = b.status === "cancelled" ? "cancelled_but_filed" : wrongRecipient ? "wrong_recipient" : money ? "value_mismatch" : late ? "wrong_period"
        : issues.some((i) => i.code === "number_written_differently") ? "matched_note" : "matched";
      rows.push({ key: `pair:${f.id}`, section, status, issues, books: booksView(b), filed: filedView(f), diff, hint: null, action: actionFor(status) });
    }

    // 5. filed, not in this registration's books
    for (const { f, issue } of notInBooks) {
      const k0 = normaliseDocNumber(f.number).key0;
      const els = issue?.code === "debit_note" ? [] : elsewhereByKey0.get(k0) ?? [];
      let hint: GstRow["hint"];
      if (issue?.code === "filed_twice" || issue?.code === "debit_note") hint = null;
      else if (els.length) {
        const e = els[0];
        hint = e.kind === "registration"
          ? { text: `Issued from ${e.label} (${e.gstin}) — filed under the wrong registration.`, invoiceId: e.invoiceId, gstin: e.gstin ?? undefined }
          : e.kind === "company" ? { text: `Issued by ${e.label}.`, invoiceId: e.invoiceId, companyKey: e.companyKey }
            : { text: "A proforma — proformas are not filed.", invoiceId: e.invoiceId };
      } else {
        hint = { text: "Not in the portal — if it is an old Swipe invoice, import it; otherwise find out who issued it.", importable: true };
        importable = true;
      }
      rows.push({ key: `filed:${f.id}`, section, status: "not_in_books", issues: issue ? [issue] : [], books: null, filed: filedView(f), diff: null, hint, action: actionFor("not_in_books") });
    }
  }

  // 6. books that should be in this period's return
  let cancelledNotFiled = 0;
  const invSection = new Map(books.filter((b) => b.kind === "invoice").map((b) => [b.id, b.section]));
  for (const b of books) {
    if (claimed.has(b.id) || !inPeriod(b.date)) continue;
    const sec = b.kind === "invoice" ? b.section : b.section;
    if (sec !== "b2b" && sec !== "sez") continue;
    if (b.status === "cancelled") { cancelledNotFiled++; continue; }
    if (b.kind === "invoice" && b.status !== "issued" && b.status !== "paid") continue;
    if (b.kind === "credit_note" && b.status !== "issued") continue;
    const section = b.kind === "invoice" ? "b2b" : "cdnr";
    const other = otherKeys.get(`${section}|${normaliseDocNumber(b.number).key1}`);
    if (other) {
      rows.push({ key: `books:${b.id}`, section, status: "wrong_period", issues: [{ code: "filed_other_period", message: `Filed in ${other.label}'s GSTR-1.` }], books: booksView(b), filed: null, diff: null,
        hint: { text: `Filed in ${other.label}'s GSTR-1.`, period: other.period }, action: actionFor("wrong_period") });
    } else {
      const msg = input.nextPeriod.uploaded
        ? `Not in ${period.label}'s GSTR-1 — report it in the next GSTR-1 (Table ${section === "b2b" ? "4A" : "9B"}); interest may apply.`
        : `Not in ${period.label}'s GSTR-1. ${input.nextPeriod.label}'s GSTR-1 is not uploaded here — it may be there.`;
      rows.push({ key: `books:${b.id}`, section, status: "not_filed", issues: [{ code: "not_filed", message: msg }], books: booksView(b), filed: null, diff: null, hint: null, action: actionFor("not_filed") });
    }
  }
  void invSection;

  // 7. section totals
  const sum = (list: Heads[]): Heads => list.reduce<Heads>((a, h) => ({
    valuePaise: a.valuePaise + h.valuePaise, taxablePaise: a.taxablePaise + h.taxablePaise,
    igstPaise: a.igstPaise === null || h.igstPaise === null ? null : a.igstPaise + h.igstPaise,
    cgstPaise: a.cgstPaise === null || h.cgstPaise === null ? null : a.cgstPaise + h.cgstPaise,
    sgstPaise: a.sgstPaise === null || h.sgstPaise === null ? null : a.sgstPaise + h.sgstPaise,
    cessPaise: (a.cessPaise ?? 0) + (h.cessPaise ?? 0),
  }), zeroHeads());
  const live = books.filter((b) => inPeriod(b.date) && (b.kind === "invoice" ? b.status === "issued" || b.status === "paid" : b.status === "issued"));
  const booksBy = (pred: (b: BookDoc) => boolean) => sum(live.filter(pred).map((b) => booksView(b)));
  const filedB2b = input.filed.filter((f) => f.section === "b2b");
  const filedHeads = (list: FiledIn[]): Heads | null => (list.length ? sum(list.map((f) => filedView(f))) : zeroHeads());
  const fromTotals = (t: SectionTotals | undefined): Heads | null => (t ? { valuePaise: t.valuePaise, taxablePaise: t.taxablePaise, igstPaise: t.igstPaise, cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise, cessPaise: t.cessPaise } : null);
  const sections: GstSectionRow[] = [
    { section: "b2b", books: booksBy((b) => b.kind === "invoice" && b.section === "b2b"), filed: filedHeads(filedB2b.filter((f) => f.invType !== "SEWP" && f.invType !== "SEWOP")), comparedItemwise: true, differs: false, note: null },
    { section: "sez", books: booksBy((b) => b.kind === "invoice" && b.section === "sez"), filed: filedHeads(filedB2b.filter((f) => f.invType === "SEWP" || f.invType === "SEWOP")), comparedItemwise: true, differs: false, note: null },
    { section: "cdnr", books: booksBy((b) => b.kind === "credit_note" && (b.section === "b2b" || b.section === "sez")), filed: filedHeads(input.filed.filter((f) => f.section === "cdnr" && f.noteType !== "D")), comparedItemwise: true, differs: false, note: null },
    { section: "b2cl", books: booksBy((b) => b.kind === "invoice" && b.section === "b2cl"), filed: fromTotals(input.filedOther.b2cl), comparedItemwise: false, differs: false, note: null },
    { section: "b2cs", books: booksBy((b) => b.kind === "invoice" && b.section === "b2cs"), filed: fromTotals(input.filedOther.b2cs), comparedItemwise: false, differs: false, note: null },
    { section: "exp", books: booksBy((b) => b.kind === "invoice" && b.section === "exp"), filed: fromTotals(input.filedOther.exp), comparedItemwise: false, differs: false, note: null },
  ];
  for (const s of sections) {
    if (!s.filed) continue;
    const dt = s.filed.taxablePaise - s.books.taxablePaise;
    const dv = s.filed.valuePaise - s.books.valuePaise;
    if (Math.abs(dt) > TOL || Math.abs(dv) > TOL) {
      s.differs = true;
      s.note = `${SECTION_LABEL[s.section]}: filed ${reconInr(s.filed.taxablePaise)} taxable, portal ${reconInr(s.books.taxablePaise)}.`;
    }
  }

  const counts = Object.fromEntries(GST_STATUS_ORDER.map((s) => [s, 0])) as Record<GstStatus, number> & { cancelledNotFiled: number };
  for (const r of rows) counts[r.status]++;
  counts.cancelledNotFiled = cancelledNotFiled;
  rows.sort((a, b) => GST_STATUS_ORDER.indexOf(a.status) - GST_STATUS_ORDER.indexOf(b.status) || cmpStr(a.section, b.section)
    || cmpStr(a.books?.number ?? a.filed?.number ?? "", b.books?.number ?? b.filed?.number ?? "") || cmpStr(a.key, b.key));
  return { rows, counts, sections, importable };
}

function actionFor(s: GstStatus): string {
  if (s === "matched" || s === "matched_note") return "";
  return RECON_REASONS[s].action ?? "";
}
