import {
  classifyTds,
  dayAdd,
  dayDiff,
  financialYear,
  fyQuarter,
  normaliseLegalName,
  RECON_REASONS,
  RECON_TOLERANCE_PAISE,
  reconDay,
  reconInr,
  tdsExpectedBy,
  type ReconReasonCode,
  type TdsGroup,
} from "@dashmani/shared";

// TDS vs Form 26AS (spec-reconcile §5.1). PURE: no DB, no clock (asOn is a parameter), no
// randomness, and shuffle-invariant — every sort ends in an id/row comparison. Money is number
// paise. The service loads the inputs (tds.service.ts) and only displays what this returns.

const TOL = RECON_TOLERANCE_PAISE;
type Q = 1 | 2 | 3 | 4;
const QS: Q[] = [1, 2, 3, 4];
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface TdsEntryIn {
  id: string; rowNo: number; tan: string; deductorName: string; section: string | null; txnDate: string; quarter: Q;
  bookingStatus: string | null; amountPaidPaise: number; tdsPaise: number; depositedPaise: number | null;
}

/** One books item: an allocation's TDS (T1) or a receipt's TDS beyond its allocations (T2). */
export interface TdsBookItem {
  key: string; paymentId: string; receiptNumber: string; paidOn: string; clientId: string;
  invoiceId: string | null; invoiceNumber: string | null; invoiceKind: string | null; issueDate: string | null;
  taxablePaise: number | null; totalPaise: number | null; amountPaise: number | null; tdsPaise: number; t2: boolean;
}

export interface TdsClientIn { id: string; name: string; legalName: string | null; pan: string | null; billingEmail: string | null }

export interface TanResolution {
  tan: string; name: string; kind: "client" | "non_sales" | "unknown"; clientId: string | null; label: string | null;
  source: "profile" | "manual" | "auto" | null; entries: number; tdsPaise: number;
  proposal: null | { clientId: string; clientName: string; sure: boolean; why: string[] };
}

interface Derived extends TdsBookItem { homeDay: string; inFy: boolean; nextYear: boolean; winFrom: string; winTo: string; homeQ: Q }

function derive(b: TdsBookItem, fy: string): Derived {
  const homeDay = b.invoiceKind === "tax_invoice" && b.issueDate && !b.t2 ? b.issueDate : b.paidOn;
  const inFy = financialYear(homeDay).label === fy;
  const nextYear = inFy && financialYear(b.paidOn).label > fy;
  const lo = homeDay < b.paidOn ? homeDay : b.paidOn;
  const hi = homeDay > b.paidOn ? homeDay : b.paidOn;
  return { ...b, homeDay, inFy, nextYear, winFrom: dayAdd(lo, -15), winTo: dayAdd(hi, 15), homeQ: fyQuarter(homeDay) };
}

const fits = (e: TdsEntryIn, b: Derived) => Math.abs(e.tdsPaise - b.tdsPaise) <= TOL && e.txnDate >= b.winFrom && e.txnDate <= b.winTo;
const sortEntries = (a: TdsEntryIn, b: TdsEntryIn) => cmpStr(a.txnDate, b.txnDate) || a.rowNo - b.rowNo || cmpStr(a.id, b.id);
const sortItems = (a: { key: string }, b: { key: string }) => cmpStr(a.key, b.key);

/** 0 = 26AS amount ≈ the taxable value (or its share); 1 = ≈ the total incl. GST (on_gross); 2 = neither / a T2 item. */
function amountRank(e: TdsEntryIn, b: Derived): 0 | 1 | 2 {
  if (b.t2 || b.taxablePaise == null || b.totalPaise == null || b.amountPaise == null) return 2;
  const settled = b.amountPaise + b.tdsPaise;
  const taxableShare = b.totalPaise > 0 ? Math.round((b.taxablePaise * settled) / b.totalPaise) : b.taxablePaise;
  const near = (x: number) => Math.abs(e.amountPaidPaise - x) <= TOL;
  if (near(b.taxablePaise) || near(taxableShare)) return 0;
  if (near(b.totalPaise) || near(settled)) return 1;
  return 2;
}

// ─── Who a TAN is (§5.1.2) ───────────────────────────────────────────────────────────────────

export function resolveTans(input: {
  fy: string;
  entries: TdsEntryIn[];
  items: TdsBookItem[];
  profiles: Array<{ tan: string; clientId: string }>;
  deductors: Array<{ tan: string; kind: string; clientId: string | null; label: string | null; source: string }>;
  clients: Array<{ id: string; companyName: string; legalName: string | null }>;
}): TanResolution[] {
  const items = input.items.map((b) => derive(b, input.fy)).sort(sortItems);
  const clientById = new Map(input.clients.map((c) => [c.id, c]));
  const profileByTan = new Map(input.profiles.map((p) => [p.tan, p.clientId]));
  const rowByTan = new Map(input.deductors.map((d) => [d.tan, d]));
  const byTan = new Map<string, TdsEntryIn[]>();
  for (const e of [...input.entries].sort(sortEntries)) {
    const list = byTan.get(e.tan) ?? [];
    list.push(e);
    byTan.set(e.tan, list);
  }
  const nameIndex = new Map<string, string[]>();
  for (const c of [...input.clients].sort((a, b) => cmpStr(a.id, b.id))) {
    const keys = new Set([normaliseLegalName(c.legalName ?? ""), normaliseLegalName(c.companyName)].filter(Boolean));
    for (const k of keys) nameIndex.set(k, [...(nameIndex.get(k) ?? []), c.id]);
  }
  const out: TanResolution[] = [];
  for (const tan of [...byTan.keys()].sort(cmpStr)) {
    const entries = byTan.get(tan)!;
    const name = entries[0].deductorName;
    const base = { tan, name, entries: entries.length, tdsPaise: entries.reduce((s, e) => s + e.tdsPaise, 0) };
    const prof = profileByTan.get(tan);
    if (prof) { out.push({ ...base, kind: "client", clientId: prof, label: null, source: "profile", proposal: null }); continue; }
    const row = rowByTan.get(tan);
    if (row) {
      out.push({ ...base, kind: row.kind === "non_sales" ? "non_sales" : "client", clientId: row.kind === "non_sales" ? null : row.clientId, label: row.label, source: (row.source === "auto" ? "auto" : "manual"), proposal: null });
      continue;
    }
    // Unknown: name evidence + amount fit.
    const named = nameIndex.get(normaliseLegalName(name)) ?? [];
    const fitWhy = new Map<string, string>();
    for (const e of entries) {
      for (const b of items) {
        if (fitWhy.has(b.clientId) || !fits(e, b)) continue;
        fitWhy.set(b.clientId, `TDS ${reconInr(e.tdsPaise)} on ${reconDay(e.txnDate)} fits ${b.receiptNumber}`);
      }
    }
    let proposal: TanResolution["proposal"] = null;
    const pick = named.length === 1 ? named[0] : named.length === 0 && fitWhy.size === 1 ? [...fitWhy.keys()][0] : null;
    if (pick) {
      const c = clientById.get(pick);
      const why: string[] = [];
      if (named.includes(pick)) why.push(`same name: ${name}`);
      if (fitWhy.has(pick)) why.push(fitWhy.get(pick)!);
      const sure = named.length === 1 && named[0] === pick && fitWhy.has(pick) && fitWhy.size === 1;
      proposal = { clientId: pick, clientName: c?.companyName ?? "", sure, why };
    }
    out.push({ ...base, kind: "unknown", clientId: null, label: null, source: null, proposal });
  }
  return out;
}

// ─── The match ───────────────────────────────────────────────────────────────────────────────

export interface TdsRowItem { key: string; paymentId: string; receiptNumber: string; paidOn: string; invoiceId: string | null; invoiceNumber: string | null; homeDay: string; tdsPaise: number }
export interface TdsRowEntry { id: string; rowNo: number; section: string | null; txnDate: string; bookingStatus: string | null; amountPaidPaise: number; tdsPaise: number; depositedPaise: number | null }
export interface TdsRow {
  key: string; group: TdsGroup; reason: { code: ReconReasonCode; text: string; action: string | null }; flags: string[]; quarter: Q | null;
  clientId: string | null; clientName: string | null; tan: string | null; deductorName: string | null;
  /** always books − 26AS (the CSV's "Difference") */
  booksPaise: number; form26Paise: number; depositedPaise: number | null; differencePaise: number;
  /** chase rows only: the amount to ask the client for (a U/O/short-deposit row's is not books − 26AS) */
  chasePaise?: number;
  items: TdsRowItem[]; entries: TdsRowEntry[];
}
export type CellVerdict = "none" | "matched" | "not_in_26as" | "short" | "extra" | "not_due" | "link_first";

export interface TdsMatchResult {
  rows: TdsRow[];
  totals: { booksPaise: number; deductedPaise: number; depositedPaise: number; matchedPaise: number; chasePaise: number; chaseCount: number;
    extraPaise: number; unknownPaise: number; nonSalesPaise: number; notDuePaise: number; nextYearPaise: number; linkFirstPaise: number };
  clients: Array<{ clientId: string; quarters: Array<{ q: Q; booksPaise: number; form26Paise: number; verdict: CellVerdict; pairedFrom: Q[] }>; verdict: TdsGroup }>;
  expectedBy: Array<{ quarter: Q; day: string; due: boolean }>;
}

const GROUP_ORDER: TdsGroup[] = ["chase", "link_first", "extra", "unknown", "status_p", "not_due", "next_year", "non_sales", "matched"];

const rowItem = (b: Derived): TdsRowItem => ({ key: b.key, paymentId: b.paymentId, receiptNumber: b.receiptNumber, paidOn: b.paidOn, invoiceId: b.invoiceId, invoiceNumber: b.invoiceNumber, homeDay: b.homeDay, tdsPaise: b.tdsPaise });
const rowEntry = (e: TdsEntryIn): TdsRowEntry => ({ id: e.id, rowNo: e.rowNo, section: e.section, txnDate: e.txnDate, bookingStatus: e.bookingStatus, amountPaidPaise: e.amountPaidPaise, tdsPaise: e.tdsPaise, depositedPaise: e.depositedPaise });
const reason = (code: ReconReasonCode, text?: string) => ({ code, text: text ?? RECON_REASONS[code].text, action: RECON_REASONS[code].action });

export function matchTds(input: {
  fy: string;
  asOn: string;
  ourPan: string | null;
  entries: TdsEntryIn[];
  items: TdsBookItem[];
  tans: TanResolution[];
  clients: TdsClientIn[];
  /** false = no Form 26AS uploaded for the FY: nothing can be chased, linked or called extra */
  hasUpload: boolean;
}): TdsMatchResult {
  const { fy, asOn } = input;
  const items = input.items.map((b) => derive(b, fy)).sort(sortItems);
  const entries = [...input.entries].sort(sortEntries);
  const tanInfo = new Map(input.tans.map((t) => [t.tan, t]));
  const clientInfo = new Map(input.clients.map((c) => [c.id, c]));
  const clientName = (id: string | null) => (id ? clientInfo.get(id)?.name ?? null : null);
  const expectedBy = QS.map((q) => { const day = tdsExpectedBy(fy, q); return { quarter: q, day, due: asOn >= day }; });
  const due = (q: Q) => expectedBy[q - 1].due;
  const ourPan = input.ourPan ?? "our PAN";

  // Clients that are the proposal of an unknown TAN (link first).
  const proposedFor = new Map<string, TanResolution>();
  for (const t of input.tans) if (t.kind === "unknown" && t.proposal) if (!proposedFor.has(t.proposal.clientId)) proposedFor.set(t.proposal.clientId, t);

  const rows: TdsRow[] = [];
  const totals = { booksPaise: 0, deductedPaise: 0, depositedPaise: 0, matchedPaise: 0, chasePaise: 0, chaseCount: 0, extraPaise: 0, unknownPaise: 0, nonSalesPaise: 0, notDuePaise: 0, nextYearPaise: 0, linkFirstPaise: 0 };
  for (const e of entries) { totals.deductedPaise += e.tdsPaise; totals.depositedPaise += e.depositedPaise ?? 0; }
  for (const b of items) if (b.inFy) totals.booksPaise += b.tdsPaise;
  // Without a 26AS every books item would read "not in 26AS" — show the books total only (§7.3.9).
  if (!input.hasUpload) return { rows: [], totals, clients: [], expectedBy };

  // Entries per resolved client; unknown / non-sales listed per TAN.
  const entriesByClient = new Map<string, TdsEntryIn[]>();
  for (const e of entries) {
    const t = tanInfo.get(e.tan);
    if (t && t.kind === "client" && t.clientId) entriesByClient.set(t.clientId, [...(entriesByClient.get(t.clientId) ?? []), e]);
  }
  for (const t of [...input.tans].sort((a, b) => cmpStr(a.tan, b.tan))) {
    if (t.kind === "client") continue;
    const es = entries.filter((e) => e.tan === t.tan);
    const sum = es.reduce((s, e) => s + e.tdsPaise, 0);
    const dep = es.every((e) => e.depositedPaise != null) ? es.reduce((s, e) => s + (e.depositedPaise ?? 0), 0) : null;
    if (t.kind === "non_sales") {
      totals.nonSalesPaise += sum;
      rows.push({ key: `non_sales:${t.tan}`, group: "non_sales", reason: reason("non_sales", `${t.label ?? t.name} (${t.tan}) — not sales money, shown and never chased.`), flags: [], quarter: null,
        clientId: null, clientName: null, tan: t.tan, deductorName: t.name, booksPaise: 0, form26Paise: sum, depositedPaise: dep, differencePaise: -sum, items: [], entries: es.map(rowEntry) });
    } else {
      totals.unknownPaise += sum;
      const proposal = t.proposal ? ` Perhaps ${t.proposal.clientName}?` : "";
      rows.push({ key: `unknown:${t.tan}`, group: "unknown", reason: reason("unknown", `Unknown deductor ${t.name} (${t.tan}) — say which client this is, or mark it as not a sales client.${proposal}`), flags: [], quarter: null,
        clientId: t.proposal?.clientId ?? null, clientName: t.proposal?.clientName ?? null, tan: t.tan, deductorName: t.name, booksPaise: 0, form26Paise: sum, depositedPaise: dep, differencePaise: -sum, items: [], entries: es.map(rowEntry) });
    }
  }

  const itemsByClient = new Map<string, Derived[]>();
  for (const b of items) itemsByClient.set(b.clientId, [...(itemsByClient.get(b.clientId) ?? []), b]);
  const clientIds = [...new Set([...entriesByClient.keys(), ...itemsByClient.keys()])].sort(cmpStr);
  const clientOut: TdsMatchResult["clients"] = [];

  for (const cid of clientIds) {
    const ces = entriesByClient.get(cid) ?? [];
    const cbs = itemsByClient.get(cid) ?? [];
    const cname = clientName(cid);
    const pan = clientInfo.get(cid)?.pan ?? null;
    const pairedE = new Set<string>();
    const pairedB = new Set<string>();
    const pairs: Array<{ es: TdsEntryIn[]; bs: Derived[]; flags: string[] }> = [];

    // Stage 1 — rank every candidate, keep a pair when both sides are free.
    type Cand = { e: TdsEntryIn; b: Derived; k: Array<number | string> };
    const cands: Cand[] = [];
    for (const e of ces) for (const b of cbs) {
      if (!fits(e, b)) continue;
      const ar = amountRank(e, b);
      cands.push({ e, b, k: [ar, Math.abs(e.tdsPaise - b.tdsPaise), Math.min(Math.abs(dayDiff(e.txnDate, b.homeDay)), Math.abs(dayDiff(e.txnDate, b.paidOn))), b.inFy ? 0 : 1, e.txnDate, e.rowNo, b.homeDay, b.key, e.id] });
    }
    cands.sort((x, y) => {
      for (let i = 0; i < x.k.length; i++) {
        const a = x.k[i], b = y.k[i];
        if (a === b) continue;
        return typeof a === "number" && typeof b === "number" ? a - b : cmpStr(String(a), String(b));
      }
      return 0;
    });
    for (const c of cands) {
      if (pairedE.has(c.e.id) || pairedB.has(c.b.key)) continue;
      pairedE.add(c.e.id); pairedB.add(c.b.key);
      pairs.push({ es: [c.e], bs: [c.b], flags: c.k[0] === 1 ? ["on_gross"] : [] });
    }
    // Stage 1b — one entry against part receipts of the same invoice.
    for (const e of ces) {
      if (pairedE.has(e.id)) continue;
      const byInv = new Map<string, Derived[]>();
      for (const b of cbs) if (!pairedB.has(b.key) && b.invoiceId && e.txnDate >= b.winFrom && e.txnDate <= b.winTo) byInv.set(b.invoiceId, [...(byInv.get(b.invoiceId) ?? []), b]);
      const groups = [...byInv.entries()].filter(([, g]) => g.length >= 2 && Math.abs(g.reduce((s, b) => s + b.tdsPaise, 0) - e.tdsPaise) <= TOL * g.length)
        .map(([inv, g]) => ({ inv, g, first: g.reduce((m, b) => (b.paidOn < m ? b.paidOn : m), g[0].paidOn) }))
        .sort((a, b) => cmpStr(a.first, b.first) || cmpStr(a.inv, b.inv));
      if (!groups.length) continue;
      pairedE.add(e.id);
      for (const b of groups[0].g) pairedB.add(b.key);
      pairs.push({ es: [e], bs: groups[0].g, flags: ["many_receipts"] });
    }
    for (const p of pairs) {
      const e = p.es[0];
      const bTds = p.bs.reduce((s, b) => s + b.tdsPaise, 0);
      totals.matchedPaise += e.tdsPaise;
      const flags = [...p.flags];
      const b0 = p.bs[0];
      if (e.section && b0.taxablePaise != null && b0.totalPaise != null && !b0.t2) {
        const k = classifyTds(bTds, b0.taxablePaise, b0.totalPaise, pan);
        if (k.section && !e.section.startsWith(k.section)) flags.push("section_hint");
      }
      const shifted = p.bs.some((b) => b.homeQ !== e.quarter) ? `matched with books of Q${b0.homeQ} ↔ Q${e.quarter}` : "";
      rows.push({ key: `pair:${e.id}`, group: "matched", reason: reason("matched", `Form 26AS agrees with ${p.bs.map((b) => b.receiptNumber).join(", ")}${shifted ? ` (${shifted})` : ""}.`), flags,
        quarter: e.quarter, clientId: cid, clientName: cname, tan: e.tan, deductorName: e.deductorName, booksPaise: bTds, form26Paise: e.tdsPaise, depositedPaise: e.depositedPaise,
        differencePaise: bTds - e.tdsPaise, items: p.bs.map(rowItem), entries: [rowEntry(e)] });
    }

    // Stage 2 — leftovers per quarter.
    const leftE = ces.filter((e) => !pairedE.has(e.id));
    const leftB = cbs.filter((b) => !pairedB.has(b.key));
    const cellVerdict = new Map<Q, CellVerdict>();
    for (const q of QS) {
      const es = leftE.filter((e) => e.quarter === q);
      const bs = leftB.filter((b) => b.inFy && !b.nextYear && b.homeQ === q);
      const L26 = es.reduce((s, e) => s + e.tdsPaise, 0);
      const LB = bs.reduce((s, b) => s + b.tdsPaise, 0);
      if (L26 === 0 && LB === 0) continue;
      const tol = TOL * Math.max(1, es.length, bs.length);
      let v: CellVerdict;
      if (L26 > 0 && LB > 0 && Math.abs(L26 - LB) <= tol) v = "matched";
      else if (L26 === 0 && LB > 0) v = "not_in_26as";
      else if (L26 < LB - tol) v = "short";
      else v = "extra";
      if ((v === "not_in_26as" || v === "short") && !due(q)) v = "not_due";
      if ((v === "not_in_26as" || v === "short") && proposedFor.has(cid)) v = "link_first";
      cellVerdict.set(q, v);
      const dep = es.length && es.every((e) => e.depositedPaise != null) ? es.reduce((s, e) => s + (e.depositedPaise ?? 0), 0) : es.length ? null : 0;
      const base = { quarter: q, clientId: cid, clientName: cname, tan: es[0]?.tan ?? null, deductorName: es[0]?.deductorName ?? null, booksPaise: LB, form26Paise: L26,
        depositedPaise: dep, differencePaise: LB - L26, items: bs.map(rowItem), entries: es.map(rowEntry), flags: [] as string[] };
      if (v === "matched") {
        totals.matchedPaise += L26;
        rows.push({ ...base, key: `cell:${cid}:${q}`, group: "matched", reason: reason("matched_split", `Same total for Q${q}, split differently (ours ${reconInr(LB)}, 26AS ${reconInr(L26)}).`) });
      } else if (v === "not_in_26as") {
        totals.chasePaise += LB; totals.chaseCount++;
        const b = bs[0];
        const text = bs.length === 1
          ? `TDS ${reconInr(b.tdsPaise)} deducted on ${b.invoiceNumber ?? b.receiptNumber} (${b.receiptNumber}, ${reconDay(b.paidOn)}, Q${q}) is not in our Form 26AS. Please deposit it and file or revise your Q${q} TDS return with our PAN ${ourPan}.`
          : `TDS ${reconInr(LB)} on ${bs.length} receipts of Q${q} (${bs.map((x) => x.receiptNumber).join(", ")}) is not in our Form 26AS. Please deposit it and file or revise your Q${q} TDS return with our PAN ${ourPan}.`;
        rows.push({ ...base, key: `cell:${cid}:${q}`, group: "chase", reason: reason("not_in_26as", text), chasePaise: LB });
      } else if (v === "short") {
        totals.chasePaise += LB - L26; totals.chaseCount++;
        rows.push({ ...base, key: `cell:${cid}:${q}`, group: "chase", chasePaise: LB - L26, reason: reason("short", `Our receipts show ${reconInr(LB)} TDS for Q${q}; Form 26AS shows ${reconInr(L26)} — please revise your Q${q} return for the ${reconInr(LB - L26)} difference, or pay it to us.`) });
      } else if (v === "not_due") {
        totals.notDuePaise += LB - L26;
        rows.push({ ...base, key: `cell:${cid}:${q}`, group: "not_due", reason: reason("not_due", `Q${q}'s TDS return is not expected in 26AS before ${reconDay(expectedBy[q - 1].day)} — ${reconInr(LB - L26)} is not due yet.`) });
      } else if (v === "link_first") {
        totals.linkFirstPaise += LB - L26;
        const t = proposedFor.get(cid)!;
        rows.push({ ...base, key: `cell:${cid}:${q}`, group: "link_first", reason: reason("link_first", `26AS has entries from ${t.name} (${t.tan}) not linked yet — link them first; they may be this client's.`) });
      } else {
        totals.extraPaise += L26 - LB;
        const e = es[0];
        const text = LB === 0
          ? `Form 26AS shows ${reconInr(L26)} TDS from ${cname ?? e?.deductorName ?? "this client"}${es.length === 1 ? ` (${reconDay(e.txnDate)})` : ` in Q${q}`} but no receipt in the portal carries it — record the payment with its TDS, or import the Swipe invoice if it is older.`
          : `Form 26AS shows ${reconInr(L26)} TDS for Q${q}; our receipts show ${reconInr(LB)} — ${reconInr(L26 - LB)} more in 26AS than in our books.`;
        rows.push({ ...base, key: `cell:${cid}:${q}`, group: "extra", reason: reason("extra", text) });
      }
    }
    // Next-year items (paid in the next FY, not paired).
    for (const b of leftB) {
      if (!b.nextYear) continue;
      totals.nextYearPaise += b.tdsPaise;
      rows.push({ key: `next:${b.key}`, group: "next_year", reason: reason("next_year", `Paid on ${reconDay(b.paidOn)} — the client may have deducted on payment; check ${financialYear(b.paidOn).label}'s 26AS.`), flags: [],
        quarter: b.homeQ, clientId: cid, clientName: cname, tan: null, deductorName: null, booksPaise: b.tdsPaise, form26Paise: 0, depositedPaise: null, differencePaise: b.tdsPaise, items: [rowItem(b)], entries: [] });
    }
    // Entry flags (paired or not): U / O / short deposited → chase; P → shown.
    for (const e of ces) {
      const st = e.bookingStatus;
      const shortDep = e.depositedPaise != null && e.depositedPaise < e.tdsPaise - TOL;
      const flags: string[] = [];
      if (st === "U") flags.push("status_U");
      if (st === "O") flags.push("status_O");
      if (shortDep) flags.push("short_deposited");
      const base = { quarter: e.quarter, clientId: cid, clientName: cname, tan: e.tan, deductorName: e.deductorName, booksPaise: 0, form26Paise: e.tdsPaise, depositedPaise: e.depositedPaise, items: [] as TdsRowItem[], entries: [rowEntry(e)] };
      if (flags.length) {
        const amount = st === "U" || st === "O" ? e.tdsPaise : e.tdsPaise - (e.depositedPaise ?? 0);
        totals.chasePaise += amount; totals.chaseCount++;
        const text = st === "U"
          ? `Deducted ${reconInr(e.tdsPaise)} on ${reconDay(e.txnDate)} but the deposit is not matched to your return (status U) — please correct the challan details in your Q${e.quarter} return.`
          : st === "O"
            ? `Your Q${e.quarter} return claims more than you deposited (status O) — please pay the difference or correct the return.`
            : `Deducted ${reconInr(e.tdsPaise)} but deposited ${reconInr(e.depositedPaise ?? 0)} — ${reconInr(e.tdsPaise - (e.depositedPaise ?? 0))} is not credited to us until you pay it.`;
        rows.push({ ...base, key: `flag:${e.id}`, group: "chase", reason: reason(st === "U" ? "status_U" : st === "O" ? "status_O" : "short_deposited", text), flags, differencePaise: -e.tdsPaise, chasePaise: amount });
      } else if (st === "P") {
        rows.push({ ...base, key: `p:${e.id}`, group: "status_p", reason: reason("status_P"), flags: ["status_P"], differencePaise: -e.tdsPaise });
      }
    }
    // Per-quarter grid
    const quarters = QS.map((q) => {
      const booksQ = cbs.filter((b) => b.inFy && b.homeQ === q).reduce((s, b) => s + b.tdsPaise, 0);
      const f26Q = ces.filter((e) => e.quarter === q).reduce((s, e) => s + e.tdsPaise, 0);
      const pairedFrom = [...new Set(pairs.filter((p) => p.bs.some((b) => b.homeQ === q) && p.es[0].quarter !== q).map((p) => p.es[0].quarter))].sort();
      const verdict: CellVerdict = cellVerdict.get(q) ?? (booksQ > 0 || f26Q > 0 ? "matched" : "none");
      return { q, booksPaise: booksQ, form26Paise: f26Q, verdict, pairedFrom };
    });
    const own = rows.filter((r) => r.clientId === cid && r.group !== "unknown");
    // Only boundary items (homed outside the FY) and no 26AS entry: nothing to show for this FY.
    if (!ces.length && !cbs.some((b) => b.inFy) && !own.length) continue;
    const groups = new Set(own.map((r) => r.group));
    const verdict = GROUP_ORDER.find((g) => groups.has(g)) ?? "matched";
    clientOut.push({ clientId: cid, quarters, verdict });
  }

  rows.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || cmpStr(a.clientName ?? a.deductorName ?? "", b.clientName ?? b.deductorName ?? "") || (a.quarter ?? 0) - (b.quarter ?? 0) || cmpStr(a.key, b.key));
  return { rows, totals, clients: clientOut, expectedBy };
}
