import { normaliseParty } from "./values";

// Swipe import (spec-import §4.7): which portal client each Swipe customer is. GSTIN first, then an
// exact normalised name with no PAN conflict; ties and look-alikes always wait for a person
// (an imported invoice cannot be moved to another client later without undoing the whole import).

export interface ClientIndexRow {
  id: string;
  companyName: string;
  createdAt: Date | string;
  billingProfile: { legalName: string; gstin: string | null; pan: string | null; stateCode: string | null; updatedAt: Date | string } | null;
  _count: { salesInvoices: number };
}

export interface ClientIndex {
  byId: Map<string, ClientIndexRow>;
  byGstin: Map<string, ClientIndexRow[]>;
  byName: Map<string, ClientIndexRow[]>;
  all: ClientIndexRow[];
}

export interface MatchGroup { groupKey: string; name: string; gstin: string | null }

export type MatchDecision =
  | { action: "match"; clientId: string; clientName: string; by: "gstin" | "name" | "user" }
  | { action: "create"; by: "auto" | "user" }
  | { action: "choose" };

export interface MatchCandidate { clientId: string; name: string; gstin: string | null; reason: string }

export interface MatchResult {
  decision: MatchDecision;
  candidates: MatchCandidate[];
  issues: Array<{ code: string; level: "warning" | "info"; message: string }>;
  /** A saved choice pointed at a client that no longer exists (it was dropped). */
  choiceDropped: boolean;
}

const panOfGstin = (g: string | null | undefined) => (g && g.length >= 12 ? g.slice(2, 12).toUpperCase() : null);
const ms = (d: Date | string) => new Date(d).getTime();
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

export function buildClientIndex(rows: ClientIndexRow[]): ClientIndex {
  const idx: ClientIndex = { byId: new Map(), byGstin: new Map(), byName: new Map(), all: rows };
  for (const r of rows) {
    idx.byId.set(r.id, r);
    const g = r.billingProfile?.gstin?.trim().toUpperCase();
    if (g) push(idx.byGstin, g, r);
    const names = new Set([normaliseParty(r.companyName), normaliseParty(r.billingProfile?.legalName)].filter(Boolean));
    for (const n of names) push(idx.byName, n, r);
  }
  return idx;
}

const clientName = (c: ClientIndexRow) => c.billingProfile?.legalName || c.companyName;

/** Candidate order: same GSTIN as the row, more invoices, most recently updated profile, oldest client, smaller id. */
function order(rowGstin: string | null) {
  return (a: ClientIndexRow, b: ClientIndexRow) => {
    const ga = rowGstin && a.billingProfile?.gstin?.toUpperCase() === rowGstin ? 1 : 0;
    const gb = rowGstin && b.billingProfile?.gstin?.toUpperCase() === rowGstin ? 1 : 0;
    if (ga !== gb) return gb - ga;
    if (a._count.salesInvoices !== b._count.salesInvoices) return b._count.salesInvoices - a._count.salesInvoices;
    const ua = a.billingProfile ? ms(a.billingProfile.updatedAt) : 0;
    const ub = b.billingProfile ? ms(b.billingProfile.updatedAt) : 0;
    if (ua !== ub) return ub - ua;
    if (ms(a.createdAt) !== ms(b.createdAt)) return ms(a.createdAt) - ms(b.createdAt);
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

function tokens(s: string): Set<string> {
  return new Set(s.split(" ").filter(Boolean));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Decide one Swipe customer (all its invoices resolve together). `choice` = a person's saved decision. */
export function matchGroup(index: ClientIndex, group: MatchGroup, choice?: string | null): MatchResult {
  const rowGstin = group.gstin?.toUpperCase() ?? null;
  const rowPan = panOfGstin(rowGstin);
  const norm = normaliseParty(group.name);
  const issues: MatchResult["issues"] = [];
  const candidates: MatchCandidate[] = [];
  const seen = new Set<string>();
  const addCand = (c: ClientIndexRow, reason: string) => {
    if (seen.has(c.id) || candidates.length >= 5) return;
    seen.add(c.id);
    candidates.push({ clientId: c.id, name: clientName(c), gstin: c.billingProfile?.gstin ?? null, reason });
  };

  const gstinHits = rowGstin ? [...(index.byGstin.get(rowGstin) ?? [])].sort(order(rowGstin)) : [];
  const nameAll = norm ? [...(index.byName.get(norm) ?? [])].sort(order(rowGstin)) : [];
  const panConflict = (c: ClientIndexRow) => {
    const theirs = c.billingProfile?.gstin ? panOfGstin(c.billingProfile.gstin) : null;
    return !!(rowPan && theirs && theirs !== rowPan);
  };
  const nameHits = nameAll.filter((c) => !panConflict(c));
  const differentFirms = nameAll.filter(panConflict);

  for (const c of gstinHits) addCand(c, "Same GSTIN");
  for (const c of nameHits) addCand(c, "Same name");
  for (const c of differentFirms) addCand(c, "Same name, different PAN — a different firm");
  if (rowPan) {
    const samePan = index.all
      .filter((c) => !seen.has(c.id) && (panOfGstin(c.billingProfile?.gstin) === rowPan || c.billingProfile?.pan?.toUpperCase() === rowPan))
      .sort(order(rowGstin));
    for (const c of samePan) addCand(c, "Same PAN — another state registration of the same firm");
  }
  if (norm && candidates.length < 5) {
    const mine = tokens(norm);
    const fuzzy = index.all
      .filter((c) => !seen.has(c.id))
      .map((c) => ({ c, j: Math.max(jaccard(mine, tokens(normaliseParty(c.companyName))), jaccard(mine, tokens(normaliseParty(c.billingProfile?.legalName)))) }))
      .filter((x) => x.j >= 0.8)
      .sort((a, b) => b.j - a.j || order(rowGstin)(a.c, b.c));
    for (const { c } of fuzzy) addCand(c, `Did you mean ${clientName(c)}?`);
  }
  if (differentFirms.length && !gstinHits.length) {
    issues.push({ code: "NAME_GSTIN_DIFFER", level: "warning", message: `${clientName(differentFirms[0])} in the portal has the same name but a different PAN — treated as a different firm` });
  }

  // Rule 0: a person's decision.
  if (choice === "new") return { decision: { action: "create", by: "user" }, candidates, issues, choiceDropped: false };
  if (choice) {
    const c = index.byId.get(choice);
    if (c) return { decision: { action: "match", clientId: c.id, clientName: clientName(c), by: "user" }, candidates, issues, choiceDropped: false };
  }
  const dropped = !!choice;
  // Rule 1: GSTIN.
  if (gstinHits.length === 1) return { decision: { action: "match", clientId: gstinHits[0].id, clientName: clientName(gstinHits[0]), by: "gstin" }, candidates, issues, choiceDropped: dropped };
  if (gstinHits.length > 1) return { decision: { action: "choose" }, candidates, issues, choiceDropped: dropped };
  // Rule 2: exact normalised name, no PAN conflict.
  if (nameHits.length === 1) {
    const c = nameHits[0];
    const theirs = c.billingProfile?.gstin?.toUpperCase();
    if (rowGstin && theirs && theirs !== rowGstin) {
      issues.push({ code: "OTHER_STATE_REGISTRATION", level: "info", message: `Matched ${clientName(c)} (${theirs}) — the file bills its other state registration ${rowGstin}` });
    }
    return { decision: { action: "match", clientId: c.id, clientName: clientName(c), by: "name" }, candidates, issues, choiceDropped: dropped };
  }
  if (nameHits.length > 1) return { decision: { action: "choose" }, candidates, issues, choiceDropped: dropped };
  // Rule 3: a new client.
  return { decision: { action: "create", by: "auto" }, candidates, issues, choiceDropped: dropped };
}
