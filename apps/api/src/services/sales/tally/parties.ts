import { prisma } from "@dashmani/db";
import { type CompanyKey, type TallyPartyApplyInput, type TallyPartyMatchInput, type TallyPartyUpdateInput } from "@dashmani/shared";
import { AppError } from "../../../middleware/error-handler";
import { logSalesEvent, type Tx } from "../common";
import { accountLedgerKeys, ledgerKey, proposeLedgerName } from "./plan";
import { getTallySettings, getTallySettingsRow, lockTallySettings, tallyDefaults } from "./settings";
import { getSellerOrDefaults } from "../settings.service";
import { parseCollection, type TallyLedgerRow } from "./xml-read";

// Client → Tally ledger name, per billing company (spec-tally §2.2, §4.4, §5.5). A mapping is locked
// once a confirmed file or a successful push used it: from then on only an admin may change it, and
// only after renaming the ledger in Tally ("Renamed in Tally" ticked). Two clients may share a name
// only when they have the same GSTIN.

export { ledgerKey, proposeLedgerName };

export interface TallyPartyRow {
  clientId: string; client: string; gstin: string | null; ledgerName: string; proposed: boolean;
  existsInTally: boolean; lockedAt: string | null; lastRunNo: number | null;
}

const clientSelect = {
  id: true, companyName: true,
  billingProfile: { select: { legalName: true, gstin: true, city: true } },
} as const;

/** Clients that have (or may have) Tally documents in this company: any invoice, receipt or mapping there. */
function companyClients(company: CompanyKey, q?: string) {
  return prisma.client.findMany({
    where: {
      OR: [{ salesInvoices: { some: { companyKey: company } } }, { salesPayments: { some: { companyKey: company } } }, { salesTallyParties: { some: { companyKey: company } } }],
      ...(q ? { companyName: { contains: q, mode: "insensitive" as const } } : {}),
    },
    select: clientSelect,
    orderBy: { companyName: "asc" },
    take: 500,
  });
}

async function lastRunNos(company: CompanyKey): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ client_id: string; run_no: number }>>`
    SELECT d.client_id, MAX(r.run_no)::int AS run_no
    FROM sales_tally_items i
    JOIN sales_tally_runs r ON r.id = i.run_id
    JOIN (SELECT id, client_id FROM sales_invoices UNION ALL SELECT id, client_id FROM sales_payments
          UNION ALL SELECT id, client_id FROM sales_credit_notes UNION ALL SELECT id, client_id FROM sales_refunds) d ON d.id = i.doc_id
    WHERE i.company_key = ${company} AND i.outcome IN ('synced', 'adopted')
    GROUP BY d.client_id`;
  return new Map(rows.map((r) => [r.client_id, Number(r.run_no)]));
}

export async function listTallyParties(company: CompanyKey, q?: string, state = "all"): Promise<TallyPartyRow[]> {
  const [clients, mappings, runs, settings, seller] = await Promise.all([
    companyClients(company, q),
    prisma.salesTallyParty.findMany({ where: { companyKey: company } }),
    lastRunNos(company),
    getTallySettings(company),
    getSellerOrDefaults(company),
  ]);
  const accountKeys = accountLedgerKeys(settings ?? tallyDefaults(company, seller));
  const byClient = new Map(mappings.map((m) => [m.clientId, m]));
  const taken = mappings.map((m) => ({ key: m.ledgerKey, gstin: m.gstin, clientId: m.clientId }));
  const rows: TallyPartyRow[] = [];
  for (const c of clients) {
    const m = byClient.get(c.id);
    const gstin = c.billingProfile?.gstin ?? null;
    let name = m?.ledgerName ?? null;
    if (!m) {
      name = proposeLedgerName({ id: c.id, legalName: c.billingProfile?.legalName ?? null, companyName: c.companyName, gstin, city: c.billingProfile?.city ?? null }, taken, accountKeys);
      if (name) taken.push({ key: ledgerKey(name), gstin, clientId: c.id });
    }
    rows.push({
      clientId: c.id, client: c.companyName, gstin, ledgerName: name ?? "", proposed: !m, existsInTally: m?.existsInTally ?? false,
      lockedAt: m?.lockedAt?.toISOString() ?? null, lastRunNo: runs.get(c.id) ?? null,
    });
  }
  if (state === "new") return rows.filter((r) => r.proposed);
  if (state === "mapped") return rows.filter((r) => !r.proposed && !r.lockedAt);
  if (state === "locked") return rows.filter((r) => !!r.lockedAt);
  return rows;
}

/** Refuse a name another client (with a different GSTIN) already holds. */
async function assertNameFree(tx: Tx, company: CompanyKey, clientId: string, gstin: string | null, name: string) {
  const others = await tx.salesTallyParty.findMany({ where: { companyKey: company, ledgerKey: ledgerKey(name), NOT: { clientId } }, include: { client: { select: { companyName: true } } } });
  const clash = others.find((o) => !(gstin && o.gstin === gstin));
  if (clash) throw new AppError(409, "TALLY_LEDGER_NAME_TAKEN", `${name} is already the Tally ledger of ${clash.client.companyName}${clash.gstin ? ` (GSTIN ${clash.gstin})` : ""}. Only clients with the same GSTIN can share a ledger.`);
}

/** The account-ledger names in this company's Tally settings (a client's receivable must never post into one). */
async function accountNames(tx: Tx, company: CompanyKey): Promise<Set<string>> {
  const row = await getTallySettingsRow(company, tx);
  return row ? accountLedgerKeys(row.settings) : new Set();
}
const accountLedgerError = (name: string) =>
  new AppError(409, "TALLY_LEDGER_NAME_TAKEN", `${name} is one of your account ledgers in Tally settings — a client needs its own ledger.`);

export async function setTallyParty(company: CompanyKey, clientId: string, body: TallyPartyUpdateInput, actor: { id: string; canApprove: boolean }): Promise<TallyPartyRow> {
  await prisma.$transaction(async (tx) => {
    await lockTallySettings(tx, company, false);
    const client = await tx.client.findUnique({ where: { id: clientId }, select: clientSelect });
    if (!client) throw new AppError(404, "NOT_FOUND", "Client not found");
    const m = await tx.salesTallyParty.findUnique({ where: { companyKey_clientId: { companyKey: company, clientId } } });
    const renaming = !m || m.ledgerName !== body.ledgerName;
    if (m?.lockedAt && renaming && !(actor.canApprove && body.confirmRenamedInTally)) {
      throw new AppError(409, "TALLY_LEDGER_LOCKED", `${m.ledgerName} is already used in Tally (since ${m.lockedAt.toISOString().slice(0, 10)}). Rename it in Tally first; then an admin changes it here with 'Renamed in Tally' ticked.`);
    }
    const gstin = client.billingProfile?.gstin ?? null;
    if (renaming) {
      if ((await accountNames(tx, company)).has(ledgerKey(body.ledgerName))) throw accountLedgerError(body.ledgerName);
      await assertNameFree(tx, company, clientId, gstin, body.ledgerName);
    }
    const data = { ledgerName: body.ledgerName, ledgerKey: ledgerKey(body.ledgerName), ...(body.existsInTally !== undefined ? { existsInTally: body.existsInTally } : {}) };
    await tx.salesTallyParty.upsert({
      where: { companyKey_clientId: { companyKey: company, clientId } },
      create: { companyKey: company, clientId, gstin, createdById: actor.id, ...data },
      update: data,
    });
    await logSalesEvent(tx, { entityType: "client", entityId: clientId, actorId: actor.id, action: "tally_ledger_set", note: `${company}: ${body.ledgerName}` });
  });
  const rows = await listTallyParties(company);
  const row = rows.find((r) => r.clientId === clientId);
  if (!row) throw new AppError(404, "NOT_FOUND", "Client not found");
  return row;
}

/** Suggest mappings from Tally's own ledger list (pasted XML or read live). Nothing is saved. */
export async function matchTallyParties(body: TallyPartyMatchInput, readLive: (company: CompanyKey) => Promise<TallyLedgerRow[]>) {
  const company = body.companyKey;
  let ledgers: TallyLedgerRow[];
  if (body.source === "xml") {
    try {
      ledgers = parseCollection(body.xml!, "ledgers");
    } catch {
      throw new AppError(400, "BAD_TALLY_XML", "That file isn't a Tally ledger export — in TallyPrime use Export → Masters → Ledgers → XML.");
    }
  } else {
    ledgers = await readLive(company);
  }
  const byGstin = new Map<string, TallyLedgerRow[]>();
  const byName = new Map<string, TallyLedgerRow>();
  for (const l of ledgers) {
    if (l.gstin) byGstin.set(l.gstin, [...(byGstin.get(l.gstin) ?? []), l]);
    byName.set(ledgerKey(l.name), l);
  }
  const rows = await listTallyParties(company);
  const suggestions: Array<{ clientId: string; client: string; gstin: string | null; tallyName: string; by: "gstin" | "name" }> = [];
  const conflicts: Array<{ tallyName: string; gstins: string[] }> = [];
  let unmatched = 0;
  for (const r of rows) {
    if (r.lockedAt) continue;
    const g = r.gstin ? byGstin.get(r.gstin) : undefined;
    if (g?.length === 1) { suggestions.push({ clientId: r.clientId, client: r.client, gstin: r.gstin, tallyName: g[0].name, by: "gstin" }); continue; }
    if (g && g.length > 1) { conflicts.push({ tallyName: g.map((x) => x.name).join(" / "), gstins: [r.gstin!] }); continue; }
    const n = r.ledgerName ? byName.get(ledgerKey(r.ledgerName)) : undefined;
    if (n) {
      if (n.gstin && r.gstin && n.gstin !== r.gstin) conflicts.push({ tallyName: n.name, gstins: [n.gstin, r.gstin] });
      else suggestions.push({ clientId: r.clientId, client: r.client, gstin: r.gstin, tallyName: n.name, by: "name" });
      continue;
    }
    unmatched += 1;
  }
  suggestions.sort((a, b) => (a.by === b.by ? (a.client < b.client ? -1 : 1) : a.by === "gstin" ? -1 : 1));
  return { suggestions, unmatched, conflicts };
}

/**
 * Save matched mappings. Each saved one is a client/tally_ledger_set event (the client's history);
 * a match that can't be applied (locked, a name another client holds, an account ledger) is skipped
 * and returned so the dialog can say which.
 */
export async function applyTallyParties(body: TallyPartyApplyInput, actorId: string): Promise<{ saved: number; skipped: Array<{ clientId: string; ledgerName: string; reason: string }> }> {
  const company = body.companyKey;
  let saved = 0;
  const skipped: Array<{ clientId: string; ledgerName: string; reason: string }> = [];
  await prisma.$transaction(async (tx) => {
    await lockTallySettings(tx, company, false);
    const accounts = await accountNames(tx, company);
    const events: Array<{ entityType: "client"; entityId: string; actorId: string; action: string; note: string }> = [];
    for (const m of body.mappings) {
      const skip = (reason: string) => skipped.push({ clientId: m.clientId, ledgerName: m.ledgerName, reason });
      const client = await tx.client.findUnique({ where: { id: m.clientId }, select: clientSelect });
      if (!client) { skip("client not found"); continue; }
      const cur = await tx.salesTallyParty.findUnique({ where: { companyKey_clientId: { companyKey: company, clientId: m.clientId } } });
      if (cur?.lockedAt && cur.ledgerName !== m.ledgerName) { skip(`${cur.ledgerName} is already used in Tally`); continue; }
      const gstin = client.billingProfile?.gstin ?? null;
      const renaming = !cur || cur.ledgerName !== m.ledgerName;
      if (renaming && accounts.has(ledgerKey(m.ledgerName))) { skip("it is one of your account ledgers"); continue; }
      try {
        if (renaming) await assertNameFree(tx, company, m.clientId, gstin, m.ledgerName);
      } catch {
        skip("another client already has this ledger");
        continue;
      }
      const data = { ledgerName: m.ledgerName, ledgerKey: ledgerKey(m.ledgerName), existsInTally: m.existsInTally };
      await tx.salesTallyParty.upsert({
        where: { companyKey_clientId: { companyKey: company, clientId: m.clientId } },
        create: { companyKey: company, clientId: m.clientId, gstin, createdById: actorId, ...data },
        update: data,
      });
      saved += 1;
      events.push({ entityType: "client", entityId: m.clientId, actorId, action: "tally_ledger_set", note: `${company}: ${m.ledgerName} (matched from Tally)` });
    }
    for (let k = 0; k < events.length; k += 500) await tx.salesEvent.createMany({ data: events.slice(k, k + 500) });
  }, { timeout: 30_000 });
  return { saved, skipped };
}

