import { BANK_LINK_WINDOW_DAYS, BANK_TOLERANCE_PAISE, MAX_PAISE, TDS_RATES, bankInr, bankPct, netGross, netTaxable, sectionForRate, tdsAt } from "@dashmani/shared";

// The bank matcher (spec-bank §4.3–4.4) — PURE and DETERMINISTIC: no DB, no clock, no randomness,
// and no dependence on the order of its inputs (every input list is sorted by a total order first).
// It never records anything: it proposes. The service (bank.service.ts) stores its output on each
// line, auto-links a credit to a receipt staff already recorded by hand, and creates receipts only
// when a person confirms.
//
// Two stages:
//   1. receipts already recorded — a credit with the same UTR, or the same amount within ±3 days,
//      is that receipt (auto-link), never proposed again;
//   2. invoice candidates — exact balance, balance less a standard TDS (the client's own past rate
//      first), two invoices together, gross-TDS, over-payment with the invoice number, advance —
//      scored by amount fit + identity evidence (name, GSTIN/PAN, invoice number, payer fingerprint).
// Then one global pass so two credits never both claim one invoice.
//
// ⚠️ Linear-time text handling only: tokens come from a character loop; every regex is anchored
// and runs on one short token.

export const MATCHER_VERSION = 1;

export interface MatchLine {
  id: string; txnDate: string; creditPaise: number; remainingPaise: number; narration: string; reference: string | null;
  utr: string | null; possibleDuplicate: boolean; rowNo: number;
}
export interface OpenInvoice {
  id: string; number: string; kind: "tax_invoice" | "proforma"; clientId: string; issueDate: string; dueDate: string | null;
  totalPaise: number; taxablePaise: number; creditedPaise: number; creditedTaxablePaise: number; tdsSoFarPaise: number; balancePaise: number;
}
export interface ClientInfo {
  id: string; names: string[]; gstin: string | null; pan: string | null;
  pastTds: { rateBp: number; base: "taxable" | "gross"; receiptNumber: string } | null;
}
/** `imported`: a Swipe (SW-…) receipt — offered to a person, never auto-linked (spec-00 §6.3). */
export interface UnlinkedReceipt {
  id: string; number: string; clientId: string; amountPaise: number; paidOn: string; reference: string | null; mode: string; imported?: boolean;
  /** A person detached this receipt from a bank line before: offered, never auto-linked again. */
  manualOnly?: boolean;
}
export interface MatchContext {
  /** Our own names (both companies, both seller profiles) — the beneficiary in NEFT narrations, never a client. */
  ownNames: string[];
  /** The OTHER group company's names, for the "own transfer" hint. Optional. */
  otherCompanyNames?: string[];
  invoices: OpenInvoice[]; clients: ClientInfo[]; receipts: UnlinkedReceipt[];
  fingerprints: Array<{ token: string; clientId: string }>;
}
export type Confidence = "high" | "medium" | "low";
export type AmountCode = "A_EXACT" | "A_TDS_OWN" | "A_TDS" | "A_PAIR" | "A_PAIR_TDS" | "A_TDS_GROSS" | "A_OVER" | "A_ADVANCE";
export interface CandidateAllocation { invoiceId: string; number: string; amountPaise: number; tdsPaise: number; balancePaise: number; dueDate: string | null }
export interface Candidate {
  kind: "invoice" | "advance"; codes: string[]; af: number; score: number; confidence: Confidence;
  clientId: string; amountPaise: number; tdsPaise: number; tdsRateBp: number | null; tdsBase: "taxable" | "gross" | null; tdsSection: string | null;
  allocations: CandidateAllocation[]; advancePaise: number; reasons: string[];
}
export interface ReceiptCandidate { paymentId: string; number: string; clientId: string; amountPaise: number; paidOn: string; why: string }
export interface MatchResult {
  v: 1; candidates: Candidate[]; autoLink: { paymentId: string; number: string; why: string } | null;
  receiptCandidates: ReceiptCandidate[];
  conflict: { lineId: string; txnDate: string; invoiceNumber: string } | null; ignoreHint: { reason: string; why: string } | null;
  note: "too_large" | null; bestScore: number | null; confidence: Confidence | null;
}

// ── Text ─────────────────────────────────────────────────────────────────────────

/** Upper-case alphanumeric tokens; `&` reads as AND. A character loop — no regex over the text. */
export function wordTokens(text: string | null | undefined): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of String(text ?? "").slice(0, 2000)) {
    const c = ch.toUpperCase();
    if ((c >= "A" && c <= "Z") || (c >= "0" && c <= "9")) cur += c;
    else {
      if (cur) { out.push(cur); cur = ""; }
      if (c === "&") out.push("AND");
    }
  }
  if (cur) out.push(cur);
  return out;
}
const compact = (s: string | null | undefined) => wordTokens(s).join("");

const NOISE = new Set("NEFT RTGS IMPS UPI CR DR BY TO FROM TRANSFER TRF INF INFT MMT P2A P2M CMS IFT INW NEFTINW CREDIT PAYMENT PYMT PMT REF UTR CHQ CLG INB".split(" "));
const BANK_CODES = new Set("HDFC ICIC ICICI SBIN SBI UTIB AXIS KKBK KOTAK YESB YES IDFB IDFC FIRST PUNB BARB CNRB UBIN INDB BANK".split(" "));
const STOP = new Set("PRIVATE PVT LIMITED LTD LLP LLC INC CO COMPANY CORP CORPORATION THE AND OF M S MS INDIA IND".split(" "));
const WEAK = new Set("MEDIA DIGITAL MARKETING ADVERTISING ADS BRAND BRANDS ENTERTAINMENT FILMS FILM PRODUCTIONS STUDIO STUDIOS SERVICES SOLUTIONS TECHNOLOGIES TECH VENTURES ENTERPRISES INTERNATIONAL GLOBAL GROUP HOLDINGS NETWORK COMMUNICATIONS CREATIONS".split(" "));
const IFSC_TOKEN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const MASKED = /^X{2,}\d+$/;
const DIGITS = /^\d+$/;

function removeSequence(tokens: string[], seq: string[]): string[] {
  if (!seq.length || seq.length > tokens.length) return tokens;
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    let hit = true;
    for (let k = 0; k < seq.length; k++) if (tokens[i + k] !== seq[k]) { hit = false; break; }
    if (hit) i += seq.length;
    else out.push(tokens[i++]);
  }
  return out;
}

/** A narration with our own names, rail noise, IFSCs, bank codes, masked accounts and bare numbers taken out. */
export function prepareNarration(narration: string, ownNames: string[]): string[] {
  let toks = wordTokens(narration);
  // Longest first, so "DIGITAL SUKOON PRIVATE LIMITED" goes before "DIGITAL SUKOON".
  const seqs: string[][] = [];
  for (const n of ownNames) {
    const t = wordTokens(n);
    if (t.length) seqs.push(t);
    const core = t.filter((x) => !STOP.has(x));
    if (core.length && core.length !== t.length) seqs.push(core);
  }
  seqs.sort((a, b) => b.length - a.length || a.join(" ").localeCompare(b.join(" ")));
  for (const s of seqs) toks = removeSequence(toks, s);
  return toks.filter((t) => !NOISE.has(t) && !BANK_CODES.has(t) && !IFSC_TOKEN.test(t) && !MASKED.test(t) && !DIGITS.test(t));
}

const VPA = /^[a-z0-9._-]{2,64}@[a-z]{2,32}$/;
/** Payer fingerprints of a line: UPI VPAs and remitter account numbers (9–18 digits, not a 12-digit RRN, not the UTR). */
export function fingerprintTokens(narration: string, utr: string | null): string[] {
  const out = new Set<string>();
  let cur = "";
  const flush = () => { if (cur && cur.length <= 100 && VPA.test(cur)) out.add(cur); cur = ""; };
  for (const ch of String(narration ?? "").slice(0, 2000).toLowerCase()) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "/" || ch === "|") flush();
    else cur += ch;
  }
  flush();
  for (const t of wordTokens(narration)) {
    if (DIGITS.test(t) && t.length >= 9 && t.length <= 18 && t.length !== 12 && t !== utr) out.add(t);
  }
  return [...out].sort();
}

// ── Names ────────────────────────────────────────────────────────────────────────

interface NameEntry { clientId: string; display: string; distinctive: string[]; compactName: string; compactDistinctive: string }

function nameEntry(clientId: string, name: string): NameEntry | null {
  const toks = wordTokens(name);
  const distinctive = toks.filter((t) => !STOP.has(t) && !WEAK.has(t) && t.length >= 3);
  if (!distinctive.length) return null; // a client with no distinctive token never name-matches
  const kept = toks.filter((t) => !STOP.has(t) && (WEAK.has(t) || (t.length >= 3)));
  return { clientId, display: toks.filter((t) => !STOP.has(t)).join(" "), distinctive, compactName: kept.join(""), compactDistinctive: distinctive.join("") };
}

/** 30 (I_NAME), 15 (I_NAME_PART) or 0 for one name against a prepared narration. */
function nameScore(e: NameEntry, narrSet: Set<string>, narrTokens: string[], compactPrepared: string): number {
  const hits = e.distinctive.filter((d) => narrSet.has(d));
  if (hits.length === e.distinctive.length && (e.distinctive.length > 1 || e.distinctive[0].length >= 5)) return 30;
  for (const t of narrTokens) if (t.length >= 8 && e.compactName.startsWith(t)) return 30; // IMPS truncation FILMYBRA ⊂ FILMYBRANDS
  if (e.compactDistinctive.length >= 6 && compactPrepared.includes(e.compactDistinctive)) return 30;
  if (e.compactName.length >= 6 && compactPrepared.includes(e.compactName)) return 30; // FILMYBRANDSPVTLTD ⊃ FILMYBRANDS
  if (hits.length * 2 >= e.distinctive.length && hits.some((h) => h.length >= 5)) return 15;
  for (const t of narrTokens) {
    if (t.length < 6) continue;
    if (e.distinctive.some((d) => d.length >= 6 && d.startsWith(t))) return 15;
    if (e.compactName.startsWith(t)) return 15; // FILMYB ⊂ FILMYBRANDS (a short IMPS truncation)
  }
  return 0;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

const dayNum = (day: string) => Math.round(Date.parse(`${day}T00:00:00.000Z`) / 86_400_000);
const daysApart = (a: string, b: string) => Math.abs(dayNum(a) - dayNum(b));
const shortDay = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
};
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cmpNullsLast = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : cmpStr(a, b));
const invOrder = (a: OpenInvoice, b: OpenInvoice) =>
  cmpNullsLast(a.dueDate, b.dueDate) || cmpStr(a.issueDate, b.issueDate) || cmpStr(a.number, b.number) || cmpStr(a.id, b.id);

const KIND_RANK: Record<AmountCode, number> = { A_EXACT: 0, A_TDS_OWN: 1, A_TDS: 2, A_PAIR: 3, A_PAIR_TDS: 4, A_TDS_GROSS: 5, A_OVER: 6, A_ADVANCE: 7 };
const AF: Record<AmountCode, number> = { A_EXACT: 50, A_TDS_OWN: 50, A_TDS: 45, A_PAIR: 40, A_PAIR_TDS: 35, A_TDS_GROSS: 30, A_OVER: 20, A_ADVANCE: 10 };
const RATES_BP: number[] = TDS_RATES.map((r) => r.rateBp);
const TOL = BANK_TOLERANCE_PAISE;
const RECEIPT_MODES = new Set(["bank_transfer", "upi", "cheque", "other"]);

/** Invoice number forms a narration may carry: compact full ("INV26270016") and short ("INV0016", "INV16"). */
function numberForms(number: string): { full: string; prefix: string; short: string[] } {
  const full = compact(number);
  const parts = number.split("/");
  if (parts.length < 3) return { full, prefix: "", short: [] };
  const prefix = compact(parts[0]);
  const serial = compact(parts[parts.length - 1]);
  const short: string[] = [];
  if (prefix && DIGITS.test(serial)) {
    short.push(prefix + serial);
    const bare = String(Number(serial));
    if (bare.length >= 2 && bare !== serial) short.push(prefix + bare);
  }
  return { full, prefix, short };
}

/** `needle` in `hay` not followed by another digit (INV16 must not hit INV160). */
function containsWord(hay: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    const next = hay[at + needle.length];
    if (next === undefined || next < "0" || next > "9") return true;
    from = at + 1;
  }
}

// ── Candidate building ───────────────────────────────────────────────────────────

interface Fit {
  code: AmountCode; clientId: string; invoices: OpenInvoice[];
  allocations: CandidateAllocation[]; cash: number; tds: number; rateBp: number | null; base: "taxable" | "gross" | null; advance: number;
  amountReason: string;
  /** A pair fitted at the client's own past rate (AF 38 instead of 35). */
  ownPair?: boolean;
}

interface IndexEntry {
  code: AmountCode; cash: number; tol: number; invoices: OpenInvoice[];
  rateBp: number | null; base: "taxable" | "gross" | null; e: number[];
  own?: boolean;
}

function buildIndex(invoices: OpenInvoice[], clients: Map<string, ClientInfo>): Map<number, IndexEntry[]> {
  const idx = new Map<number, IndexEntry[]>();
  const put = (e: IndexEntry) => {
    const k = Math.round(e.cash / 100);
    const list = idx.get(k);
    if (list) list.push(e); else idx.set(k, [e]);
  };
  const byClient = new Map<string, OpenInvoice[]>();
  for (const inv of invoices) {
    const B = inv.balancePaise;
    if (B <= 0) continue;
    const list = byClient.get(inv.clientId);
    if (list) list.push(inv); else byClient.set(inv.clientId, [inv]);
    put({ code: "A_EXACT", cash: B, tol: 0, invoices: [inv], rateBp: null, base: null, e: [0] });
    const T = netTaxable(inv);
    const G = netGross(inv);
    const s = inv.tdsSoFarPaise;
    const expected = (base: "taxable" | "gross", r: number): number[] => {
      const out = [base === "taxable" ? tdsAt(T, r) - s : tdsAt(G, r) - s];
      if (B > 0 && B < G) out.push(base === "taxable" ? tdsAt(Math.round((T * B) / G), r) : tdsAt(B, r));
      return [...new Set(out)].filter((e) => e > 0 && e < B);
    };
    const own = clients.get(inv.clientId)?.pastTds ?? null;
    if (own) for (const e of expected(own.base, own.rateBp)) put({ code: "A_TDS_OWN", cash: B - e, tol: TOL, invoices: [inv], rateBp: own.rateBp, base: own.base, e: [e] });
    for (const r of RATES_BP) {
      for (const e of expected("taxable", r)) put({ code: "A_TDS", cash: B - e, tol: TOL, invoices: [inv], rateBp: r, base: "taxable", e: [e] });
      if (G !== T) for (const e of expected("gross", r)) put({ code: "A_TDS_GROSS", cash: B - e, tol: TOL, invoices: [inv], rateBp: r, base: "gross", e: [e] });
    }
  }
  // Pairs of one client's invoices (2–40 open). Order inside a pair: earlier due first.
  for (const [clientId, list] of [...byClient.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
    if (list.length < 2 || list.length > 40) continue;
    const sorted = [...list].sort(invOrder);
    const own = clients.get(clientId)?.pastTds ?? null;
    const rates: Array<{ r: number; own: boolean }> = [];
    if (own && own.base === "taxable") rates.push({ r: own.rateBp, own: true });
    for (const r of RATES_BP) if (!rates.some((x) => x.r === r)) rates.push({ r, own: false });
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        put({ code: "A_PAIR", cash: a.balancePaise + b.balancePaise, tol: 0, invoices: [a, b], rateBp: null, base: null, e: [0, 0] });
        for (const { r, own: isOwn } of rates) {
          const ea = tdsAt(netTaxable(a), r) - a.tdsSoFarPaise;
          const eb = tdsAt(netTaxable(b), r) - b.tdsSoFarPaise;
          if (ea <= 0 || eb <= 0) continue;
          put({ code: "A_PAIR_TDS", cash: a.balancePaise - ea + b.balancePaise - eb, tol: 2 * TOL, invoices: [a, b], rateBp: r, base: "taxable", e: [ea, eb], own: isOwn });
        }
      }
    }
  }
  return idx;
}

function fitsFor(C: number, idx: Map<number, IndexEntry[]>): Fit[] {
  const out: Fit[] = [];
  const k = Math.round(C / 100);
  for (let d = -3; d <= 3; d++) {
    for (const e of idx.get(k + d) ?? []) {
      if (Math.abs(C - e.cash) > e.tol) continue;
      const inv = e.invoices;
      if (e.code === "A_EXACT") {
        if (C !== inv[0].balancePaise) continue;
        out.push({ code: "A_EXACT", clientId: inv[0].clientId, invoices: inv, cash: C, tds: 0, rateBp: null, base: null, advance: 0,
          allocations: [alloc(inv[0], C, 0)], amountReason: `Bank credit equals the balance of ${inv[0].number}` });
      } else if (e.code === "A_TDS" || e.code === "A_TDS_OWN" || e.code === "A_TDS_GROSS") {
        const B = inv[0].balancePaise;
        const tds = B - C;
        if (tds <= 0 || tds >= B) continue;
        const baseAmt = e.base === "taxable" ? netTaxable(inv[0]) : netGross(inv[0]);
        const reason = e.code === "A_TDS_GROSS"
          ? `Client deducted ${bankPct(e.rateBp!)} on the total incl. GST (${bankInr(tds)}) — TDS is due on the value before GST (CBDT circular 23/2017)`
          : `Bank credit = balance − ${bankPct(e.rateBp!)} TDS on the ${e.base === "taxable" ? "taxable value" : "total incl. GST"} ${bankInr(baseAmt)} (${bankInr(tds)})`;
        out.push({ code: e.code, clientId: inv[0].clientId, invoices: inv, cash: C, tds, rateBp: e.rateBp, base: e.base, advance: 0,
          allocations: [alloc(inv[0], C, tds)], amountReason: reason });
      } else if (e.code === "A_PAIR") {
        out.push({ code: "A_PAIR", clientId: inv[0].clientId, invoices: inv, cash: C, tds: 0, rateBp: null, base: null, advance: 0,
          allocations: inv.map((i) => alloc(i, i.balancePaise, 0)), amountReason: `Two invoices together: ${inv[0].number} + ${inv[1].number}` });
      } else if (e.code === "A_PAIR_TDS") {
        const tdsA = e.e[0];
        const tdsB = e.e[1] + (inv[0].balancePaise + inv[1].balancePaise - e.e[0] - e.e[1] - C); // residual on the later-due invoice
        const amtA = inv[0].balancePaise - tdsA;
        const amtB = inv[1].balancePaise - tdsB;
        if (tdsA < 0 || tdsB < 0 || amtA < 0 || amtB < 0 || amtA + amtB !== C) continue;
        const own = e.own === true;
        out.push({ code: "A_PAIR_TDS", clientId: inv[0].clientId, invoices: inv, cash: C, tds: tdsA + tdsB, rateBp: e.rateBp, base: "taxable", advance: 0,
          allocations: [alloc(inv[0], amtA, tdsA), alloc(inv[1], amtB, tdsB)],
          amountReason: `Two invoices together: ${inv[0].number} + ${inv[1].number}, less ${bankPct(e.rateBp!)} TDS on the taxable value${own ? " (the client's usual rate)" : ""}`, ownPair: own });
      }
    }
  }
  return out;
}

const alloc = (inv: OpenInvoice, amountPaise: number, tdsPaise: number): CandidateAllocation =>
  ({ invoiceId: inv.id, number: inv.number, amountPaise, tdsPaise, balancePaise: inv.balancePaise, dueDate: inv.dueDate });

// ── The matcher ──────────────────────────────────────────────────────────────────

interface Identity { name: number; nameDisplay: string | null; taxid: number; fp: number; fpToken: string | null; taxidKind: "GSTIN" | "PAN" | null }

export function matchCredits(linesIn: MatchLine[], ctx: MatchContext): Record<string, MatchResult> {
  const lines = [...linesIn].sort((a, b) => cmpStr(a.id, b.id));
  const invoices = [...ctx.invoices].sort(invOrder);
  const clients = new Map([...ctx.clients].sort((a, b) => cmpStr(a.id, b.id)).map((c) => [c.id, c]));
  const receipts = [...ctx.receipts].sort((a, b) => cmpStr(a.id, b.id));
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));

  // Fingerprints: a token seen with two clients says nothing.
  const fpOwner = new Map<string, string | null>();
  for (const f of [...ctx.fingerprints].sort((a, b) => cmpStr(a.token, b.token) || cmpStr(a.clientId, b.clientId))) {
    const had = fpOwner.get(f.token);
    if (had === undefined) fpOwner.set(f.token, f.clientId);
    else if (had !== f.clientId) fpOwner.set(f.token, null);
  }

  // Name index: distinctive token → entries; first 6 chars of the compact name → entries; first 3
  // chars of the compact distinctive name → entries (for the "contains" rule).
  const byToken = new Map<string, NameEntry[]>();
  const byPrefix6 = new Map<string, NameEntry[]>();
  const byTri = new Map<string, NameEntry[]>();
  const push = (m: Map<string, NameEntry[]>, k: string, e: NameEntry) => { const l = m.get(k); if (l) l.push(e); else m.set(k, [e]); };
  for (const c of clients.values()) {
    const seen = new Set<string>();
    for (const n of c.names) {
      const e = nameEntry(c.id, n);
      if (!e || seen.has(e.compactName)) continue;
      seen.add(e.compactName);
      for (const d of e.distinctive) push(byToken, d, e);
      if (e.compactName.length >= 6) push(byPrefix6, e.compactName.slice(0, 6), e);
      for (const d of e.distinctive) if (d.length >= 6) push(byPrefix6, d.slice(0, 6), e);
      if (e.compactDistinctive.length >= 6) push(byTri, e.compactDistinctive.slice(0, 3), e);
      if (e.compactName.length >= 6 && e.compactName.slice(0, 3) !== e.compactDistinctive.slice(0, 3)) push(byTri, e.compactName.slice(0, 3), e);
    }
  }
  const taxIds = new Map<string, Array<{ clientId: string; kind: "GSTIN" | "PAN" }>>();
  for (const c of clients.values()) {
    if (c.gstin) { const l = taxIds.get(c.gstin.toUpperCase()) ?? []; l.push({ clientId: c.id, kind: "GSTIN" }); taxIds.set(c.gstin.toUpperCase(), l); }
    if (c.pan) { const l = taxIds.get(c.pan.toUpperCase()) ?? []; l.push({ clientId: c.id, kind: "PAN" }); taxIds.set(c.pan.toUpperCase(), l); }
  }

  // Invoice numbers, grouped by their compact prefix (a narration without "INV" skips that group).
  const numberGroups = new Map<string, Array<{ inv: OpenInvoice; forms: ReturnType<typeof numberForms> }>>();
  for (const inv of invoices) {
    const forms = numberForms(inv.number);
    const key = forms.prefix || forms.full.slice(0, 3);
    if (forms.full.length < 6) continue;
    const l = numberGroups.get(key);
    if (l) l.push({ inv, forms }); else numberGroups.set(key, [{ inv, forms }]);
  }

  const idx = buildIndex(invoices, clients);

  // Per-line text facts.
  const facts = new Map<string, { tokens: string[]; set: Set<string>; compactPrepared: string; compactRaw: string; rawTokens: Set<string>; utrTokens: string[]; fps: string[] }>();
  for (const l of lines) {
    const tokens = prepareNarration(`${l.narration} ${l.reference ?? ""}`, ctx.ownNames);
    const raw = wordTokens(`${l.narration} ${l.reference ?? ""}`);
    const utrTokens = new Set<string>();
    if (l.utr && l.utr.length >= 10) utrTokens.add(l.utr.toUpperCase());
    for (const t of raw) if (t.length >= 10 && /\d/.test(t) && !IFSC_TOKEN.test(t)) utrTokens.add(t);
    facts.set(l.id, {
      tokens, set: new Set(tokens), compactPrepared: tokens.join(""), compactRaw: raw.join(""), rawTokens: new Set(raw),
      utrTokens: [...utrTokens].sort(), fps: fingerprintTokens(l.narration, l.utr),
    });
  }

  function identities(l: MatchLine): Map<string, Identity> {
    const f = facts.get(l.id)!;
    const out = new Map<string, Identity>();
    const get = (id: string) => {
      let x = out.get(id);
      if (!x) { x = { name: 0, nameDisplay: null, taxid: 0, fp: 0, fpToken: null, taxidKind: null }; out.set(id, x); }
      return x;
    };
    const cands = new Set<NameEntry>();
    for (const t of f.tokens) {
      for (const e of byToken.get(t) ?? []) cands.add(e);
      if (t.length >= 6) for (const e of byPrefix6.get(t.slice(0, 6)) ?? []) cands.add(e);
    }
    for (let i = 0; i + 3 <= f.compactPrepared.length && i < 400; i++) for (const e of byTri.get(f.compactPrepared.slice(i, i + 3)) ?? []) cands.add(e);
    for (const e of [...cands].sort((a, b) => cmpStr(a.clientId, b.clientId) || cmpStr(a.compactName, b.compactName))) {
      const s = nameScore(e, f.set, f.tokens, f.compactPrepared);
      if (s > get(e.clientId).name) { get(e.clientId).name = s; get(e.clientId).nameDisplay = e.display; }
      if (!out.get(e.clientId)!.name && !out.get(e.clientId)!.taxid && !out.get(e.clientId)!.fp) out.delete(e.clientId);
    }
    for (const t of f.rawTokens) for (const x of taxIds.get(t) ?? []) { const i = get(x.clientId); i.taxid = 35; i.taxidKind = x.kind; }
    for (const t of f.fps) {
      const owner = fpOwner.get(t);
      if (owner) { const i = get(owner); i.fp = 35; i.fpToken = t; }
    }
    return out;
  }

  const identityTotal = (i: Identity | undefined) => (i ? i.name + i.taxid + i.fp : 0);

  // ── Stage 1: receipts already recorded ──
  type Hit = { r: UnlinkedReceipt; ref: boolean; amt: boolean; days: number };
  const hits = new Map<string, Hit[]>();
  const nearRef = new Map<string, ReceiptCandidate[]>();
  const refLines = new Map<string, string[]>();
  const anyLines = new Map<string, string[]>();
  const ids = new Map<string, Map<string, Identity>>();
  for (const l of lines) ids.set(l.id, identities(l));
  for (const l of lines) {
    const f = facts.get(l.id)!;
    const C = l.remainingPaise;
    const cashOk = f.rawTokens.has("CASH");
    const list: Hit[] = [];
    for (const r of receipts) {
      if (r.mode === "razorpay") continue;
      if (!RECEIPT_MODES.has(r.mode) && !(r.mode === "cash" && cashOk)) continue;
      const rRef = compact(r.reference);
      const refHit = (rRef.length > 0 && f.utrTokens.some((u) => rRef.includes(u))) || (!!l.reference && compact(l.reference).length >= 6 && compact(l.reference) === rRef);
      const diff = Math.abs(r.amountPaise - C);
      const days = daysApart(r.paidOn, l.txnDate);
      const ref = refHit && diff <= TOL;
      const amt = diff <= TOL && days <= BANK_LINK_WINDOW_DAYS;
      if (ref || amt) {
        list.push({ r, ref, amt, days });
        if (ref) refLines.set(r.id, [...(refLines.get(r.id) ?? []), l.id]);
        anyLines.set(r.id, [...(anyLines.get(r.id) ?? []), l.id]);
      } else if (refHit && r.amountPaise < C) {
        const nr = nearRef.get(l.id) ?? [];
        nr.push({ paymentId: r.id, number: r.number, clientId: r.clientId, amountPaise: r.amountPaise, paidOn: r.paidOn, why: `same UTR, differs by ${bankInr(C - r.amountPaise)}` });
        nearRef.set(l.id, nr);
      }
    }
    hits.set(l.id, list);
  }

  const autoLink = new Map<string, { paymentId: string; number: string; why: string }>();
  const claimedReceipts = new Set<string>();
  // P_REF: exactly one, and that receipt is the UTR of no other line.
  for (const l of lines) {
    if (l.possibleDuplicate) continue;
    const refs = hits.get(l.id)!.filter((h) => h.ref);
    if (refs.length !== 1) continue;
    const r = refs[0].r;
    if (r.imported || r.manualOnly || (refLines.get(r.id) ?? []).length !== 1 || claimedReceipts.has(r.id)) continue;
    const utr = facts.get(l.id)!.utrTokens.find((u) => compact(r.reference).includes(u));
    autoLink.set(l.id, { paymentId: r.id, number: r.number, why: utr ? `same UTR ${utr}` : "same reference" });
    claimedReceipts.add(r.id);
  }
  // P_AMT: no ref hit, exactly one same-amount receipt within the window, the receipt no other
  // line's UTR, and nothing in the narration naming another client. Two identical credits and one
  // receipt: the closest (then earliest) credit links; the other stays open.
  const amtCandidates = new Map<string, Array<{ line: MatchLine; days: number }>>();
  for (const l of lines) {
    if (l.possibleDuplicate || autoLink.has(l.id)) continue;
    const h = hits.get(l.id)!;
    if (h.some((x) => x.ref)) continue;
    const amts = h.filter((x) => x.amt);
    if (amts.length !== 1) continue;
    const r = amts[0].r;
    if (r.imported || r.manualOnly || claimedReceipts.has(r.id) || (refLines.get(r.id) ?? []).length) continue;
    const idsL = ids.get(l.id)!;
    const otherNamed = [...idsL.entries()].some(([cid, i]) => cid !== r.clientId && identityTotal(i) >= 30);
    if (otherNamed) continue;
    const list = amtCandidates.get(r.id) ?? [];
    list.push({ line: l, days: amts[0].days });
    amtCandidates.set(r.id, list);
  }
  for (const [rid, list] of [...amtCandidates.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
    list.sort((a, b) => a.days - b.days || cmpStr(a.line.txnDate, b.line.txnDate) || a.line.rowNo - b.line.rowNo || cmpStr(a.line.id, b.line.id));
    const win = list[0];
    const r = receipts.find((x) => x.id === rid)!;
    autoLink.set(win.line.id, { paymentId: r.id, number: r.number, why: `same amount, ${win.days === 0 ? "same day" : `${win.days} day${win.days === 1 ? "" : "s"} apart`}` });
    claimedReceipts.add(rid);
  }

  // ── Stage 2: invoice candidates ──
  const results: Record<string, MatchResult> = {};
  const prelim = new Map<string, Candidate[]>();
  for (const l of lines) {
    const C = l.remainingPaise;
    const receiptCandidates: ReceiptCandidate[] = [];
    if (!autoLink.has(l.id)) {
      for (const h of hits.get(l.id)!) {
        if (claimedReceipts.has(h.r.id)) continue;
        receiptCandidates.push({ paymentId: h.r.id, number: h.r.number, clientId: h.r.clientId, amountPaise: h.r.amountPaise, paidOn: h.r.paidOn,
          why: `${h.ref ? "same UTR" : h.days === 0 ? "same amount, same day" : `same amount, ${h.days} day${h.days === 1 ? "" : "s"} apart`}${h.r.imported ? " · Swipe import" : ""}` });
      }
      for (const n of nearRef.get(l.id) ?? []) if (!claimedReceipts.has(n.paymentId) && !receiptCandidates.some((x) => x.paymentId === n.paymentId)) receiptCandidates.push(n);
    }
    receiptCandidates.sort((a, b) => cmpStr(a.number, b.number) || cmpStr(a.paymentId, b.paymentId));
    const base: MatchResult = {
      v: 1, candidates: [], autoLink: autoLink.get(l.id) ?? null, receiptCandidates, conflict: null,
      ignoreHint: ignoreHintFor(l.narration, ctx.otherCompanyNames ?? []), note: null, bestScore: null, confidence: null,
    };
    results[l.id] = base;
    if (base.autoLink || C <= 0) continue;
    if (C > MAX_PAISE) { base.note = "too_large"; continue; }

    const f = facts.get(l.id)!;
    const idsL = ids.get(l.id)!;
    // Invoice numbers in the narration.
    const invno = new Map<string, { score: number; number: string }>();
    for (const [key, group] of numberGroups) {
      if (!key || !f.compactRaw.includes(key)) continue;
      for (const { inv, forms } of group) {
        if (containsWord(f.compactRaw, forms.full)) invno.set(inv.id, { score: 40, number: inv.number });
        else if (forms.short.some((s) => containsWord(f.compactRaw, s))) invno.set(inv.id, { score: 25, number: inv.number });
      }
    }
    const fits = fitsFor(C, idx);
    // A_OVER: the narration names the invoice and the credit is more than its balance.
    for (const [invId] of [...invno.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
      const inv = invoiceById.get(invId)!;
      if (C > inv.balancePaise && inv.balancePaise > 0) {
        fits.push({ code: "A_OVER", clientId: inv.clientId, invoices: [inv], cash: C, tds: 0, rateBp: null, base: null, advance: C - inv.balancePaise,
          allocations: [alloc(inv, inv.balancePaise, 0)], amountReason: `${bankInr(C - inv.balancePaise)} more than the balance — the rest stays as an advance` });
      }
    }
    // A_ADVANCE: an identified client with no amount fit.
    const fitClients = new Set(fits.map((x) => x.clientId));
    for (const [cid, i] of [...idsL.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
      if (identityTotal(i) >= 30 && !fitClients.has(cid) && clients.has(cid)) {
        fits.push({ code: "A_ADVANCE", clientId: cid, invoices: [], cash: C, tds: 0, rateBp: null, base: null, advance: C, allocations: [],
          amountReason: "No open invoice of this client matches the amount — record it as an advance" });
      }
    }

    const cands: Candidate[] = [];
    for (const x of fits) {
      const i = idsL.get(x.clientId);
      const codes: string[] = [x.code];
      const reasons: string[] = [x.amountReason];
      const client = clients.get(x.clientId);
      if (x.code === "A_TDS_OWN" && client?.pastTds) {
        reasons.push(`${client.names[0] ?? "This client"} deducted ${bankPct(client.pastTds.rateBp)} on the ${client.pastTds.base === "taxable" ? "taxable value" : "total incl. GST"} last time (${client.pastTds.receiptNumber})`);
      }
      if ((x.code === "A_TDS" || x.code === "A_TDS_OWN") && x.rateBp === 100) reasons.push("1% is the 194C rate for an individual/HUF — a company payee should suffer 2%");
      let ident = 0;
      if (i?.name) { ident += i.name; codes.push(i.name >= 30 ? "I_NAME" : "I_NAME_PART"); reasons.push(`Narration names ${i.nameDisplay}`); }
      if (i?.taxid) { ident += i.taxid; codes.push("I_TAXID"); reasons.push(`Client's ${i.taxidKind} is in the narration`); }
      if (i?.fp) { ident += i.fp; codes.push("I_FP"); reasons.push(`This payer (${i.fpToken}) paid ${client?.names[0] ?? "this client"} before`); }
      let bestNo: { score: number; number: string } | null = null;
      for (const inv of x.invoices) { const n = invno.get(inv.id); if (n && (!bestNo || n.score > bestNo.score)) bestNo = n; }
      if (bestNo) { ident += bestNo.score; codes.push(bestNo.score === 40 ? "I_INVNO" : "I_INVNO_SHORT"); reasons.push(`Narration carries ${bestNo.number}`); }
      ident = Math.min(50, ident);
      let j = 0;
      if (x.invoices.some((inv) => l.txnDate < inv.issueDate)) { j -= 20; codes.push("J_BEFORE_ISSUE"); reasons.push("Credit is dated before the invoice was issued"); }
      if (x.invoices.some((inv) => inv.kind === "proforma")) { j -= 5; codes.push("J_PROFORMA"); }
      const af = AF[x.code] + (x.ownPair ? 3 : 0);
      const score = Math.max(0, Math.min(100, af + ident + j));
      if (score < 20) continue;
      const tdsRateBp = x.tds > 0 ? x.rateBp : null;
      cands.push({
        kind: x.code === "A_ADVANCE" ? "advance" : "invoice", codes, af, score, confidence: "low", clientId: x.clientId,
        amountPaise: x.cash, tdsPaise: x.tds, tdsRateBp, tdsBase: x.tds > 0 ? x.base : null, tdsSection: tdsRateBp ? sectionForRate(tdsRateBp) : null,
        allocations: x.allocations, advancePaise: x.advance, reasons,
      });
    }
    // Collapse duplicates on (client, invoices, TDS), keeping the better one; order; top 5.
    cands.sort(candidateOrder);
    const seen = new Set<string>();
    const kept: Candidate[] = [];
    for (const c of cands) {
      const key = `${c.clientId}|${c.allocations.map((a) => a.invoiceId).sort().join(",")}|${c.tdsPaise}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(c);
      if (kept.length === 5) break;
    }
    for (const c of kept) c.confidence = c.score >= 45 ? "medium" : "low";
    prelim.set(l.id, kept);
  }

  // ── Global assignment: one invoice, one credit ──
  const order = lines
    .filter((l) => prelim.has(l.id))
    .sort((a, b) => (prelim.get(b.id)![0]?.score ?? -1) - (prelim.get(a.id)![0]?.score ?? -1) || cmpStr(a.txnDate, b.txnDate) || a.rowNo - b.rowNo || cmpStr(a.id, b.id));
  const claimedBy = new Map<string, MatchLine>();
  for (const l of order) {
    const cands = prelim.get(l.id)!;
    const r = results[l.id];
    let takenAt = -1;
    let conflict: MatchResult["conflict"] = null;
    for (let k = 0; k < cands.length; k++) {
      const taken = cands[k].allocations.map((a) => claimedBy.get(a.invoiceId)).find(Boolean);
      if (taken) {
        if (!conflict) {
          const inv = cands[k].allocations.find((a) => claimedBy.get(a.invoiceId) === taken)!;
          conflict = { lineId: taken.id, txnDate: taken.txnDate, invoiceNumber: inv.number };
        }
        continue;
      }
      takenAt = k;
      break;
    }
    let final = cands;
    if (takenAt > 0) final = [cands[takenAt], ...cands.filter((_, k) => k !== takenAt)];
    if (takenAt >= 0 && final[0].confidence !== "low") for (const a of final[0].allocations) claimedBy.set(a.invoiceId, l);
    r.conflict = conflict;
    // Confidence, now that conflicts are known.
    for (const c of final) {
      const rival = final.some((o) => o !== c && o.clientId !== c.clientId && o.score >= c.score - 15);
      const sure = c.score >= 75 && c.af >= 45 && !rival && !conflict && r.receiptCandidates.length === 0 && !l.possibleDuplicate && !c.codes.includes("J_BEFORE_ISSUE");
      c.confidence = sure ? "high" : c.score >= 45 ? "medium" : "low";
    }
    r.candidates = final;
    r.bestScore = final[0]?.score ?? null;
    r.confidence = final[0]?.confidence ?? null;
  }
  return results;
}

function candidateOrder(a: Candidate, b: Candidate): number {
  const firstDue = (c: Candidate) => c.allocations.map((x) => x.dueDate).filter((d): d is string => !!d).sort()[0] ?? null;
  const kindA = KIND_RANK[a.codes[0] as AmountCode] ?? 9;
  const kindB = KIND_RANK[b.codes[0] as AmountCode] ?? 9;
  const proA = a.codes.includes("J_PROFORMA") ? 1 : 0;
  const proB = b.codes.includes("J_PROFORMA") ? 1 : 0;
  return (
    b.score - a.score || b.af - a.af || kindA - kindB || a.allocations.length - b.allocations.length || proA - proB ||
    cmpNullsLast(firstDue(a), firstDue(b)) ||
    cmpStr(a.allocations.map((x) => x.number).join(","), b.allocations.map((x) => x.number).join(",")) ||
    cmpStr(a.clientId, b.clientId) || a.tdsPaise - b.tdsPaise
  );
}

/** A one-tap suggestion for credits that are not sales; never applied automatically. */
export function ignoreHintFor(narration: string, otherCompanyNames: string[]): { reason: string; why: string } | null {
  const t = wordTokens(narration);
  const set = new Set(t);
  const seq = (a: string, b: string) => t.some((x, i) => x === a && t[i + 1] === b);
  if (seq("INT", "PD") || seq("INT", "CR") || set.has("INTEREST")) return { reason: "interest", why: "Narration reads like bank interest" };
  for (const g of ["RAZORPAY", "CASHFREE", "PAYU", "CCAVENUE", "STRIPE", "PAYPAL"]) if (set.has(g) || t.some((x) => x.startsWith(g))) return { reason: "gateway", why: `Narration names ${g}` };
  for (const n of otherCompanyNames) {
    const core = wordTokens(n).filter((x) => !STOP.has(x));
    if (core.length && removeSequence(t, core).length !== t.length) return { reason: "own_transfer", why: `Narration names ${core.join(" ")}` };
  }
  if (set.has("SELF") || seq("OWN", "AC")) return { reason: "own_transfer", why: "Narration reads like a transfer between our own accounts" };
  if (seq("GST", "REFUND") || set.has("CBIC")) return { reason: "gst_refund", why: "Narration reads like a GST refund" };
  if (set.has("CPC") || set.has("ITD") || seq("TAX", "REFUND")) return { reason: "tax_refund", why: "Narration reads like an income-tax refund" };
  if (set.has("RETURN") || set.has("RTN") || set.has("REVERSAL") || set.has("REV")) return { reason: "reversal", why: "Narration reads like a reversal or return" };
  return null;
}

/** Flags on withdrawals: a refund we issued, or the reversal of a credit that carries a receipt. */
export function matchDebits(
  debitsIn: Array<{ id: string; txnDate: string; debitPaise: number; narration: string }>,
  ctx: { refunds: Array<{ id: string; number: string; amountPaise: number; refundedOn: string }>; matchedCredits: Array<{ lineId: string; txnDate: string; creditPaise: number; receiptNumbers: string[] }> },
): Record<string, { refund?: { id: string; number: string }; reversalOf?: { lineId: string; txnDate: string; receiptNumbers: string[] } }> {
  const out: Record<string, { refund?: { id: string; number: string }; reversalOf?: { lineId: string; txnDate: string; receiptNumbers: string[] } }> = {};
  const refunds = [...ctx.refunds].sort((a, b) => cmpStr(a.id, b.id));
  const credits = [...ctx.matchedCredits].sort((a, b) => cmpStr(a.lineId, b.lineId));
  for (const d of [...debitsIn].sort((a, b) => cmpStr(a.id, b.id))) {
    const hint: (typeof out)[string] = {};
    const rf = refunds
      .filter((r) => Math.abs(r.amountPaise - d.debitPaise) <= TOL && daysApart(r.refundedOn, d.txnDate) <= 3)
      .sort((a, b) => daysApart(a.refundedOn, d.txnDate) - daysApart(b.refundedOn, d.txnDate) || cmpStr(a.id, b.id))[0];
    if (rf) hint.refund = { id: rf.id, number: rf.number };
    const toks = new Set(wordTokens(d.narration));
    if (["RETURN", "RTN", "BOUNCE", "REVERSAL", "REV"].some((x) => toks.has(x))) {
      const c = credits
        .filter((x) => x.creditPaise === d.debitPaise && dayNum(d.txnDate) - dayNum(x.txnDate) >= 0 && dayNum(d.txnDate) - dayNum(x.txnDate) <= 10)
        .sort((a, b) => cmpStr(b.txnDate, a.txnDate) || cmpStr(a.lineId, b.lineId))[0];
      if (c) hint.reversalOf = { lineId: c.lineId, txnDate: c.txnDate, receiptNumbers: c.receiptNumbers };
    }
    if (hint.refund || hint.reversalOf) out[d.id] = hint;
  }
  return out;
}

export { shortDay };
