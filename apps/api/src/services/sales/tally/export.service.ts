import { gzipSync, gunzipSync } from "zlib";
import { prisma, Prisma } from "@dashmani/db";
import { SALES_COMPANIES, todayIST, type CompanyKey, type TallyDocType, type TallyResolveInput, type TallyRunConfirmInput, type TallyRunCreateInput } from "@dashmani/shared";
import { AppError } from "../../../middleware/error-handler";
import { dateToDay, dayToDate, logSalesEvent, toSafeNumber, type SalesEntity, type Tx } from "../common";
import { getSellerOrDefaults } from "../settings.service";
import {
  collectTally, docDay, loadClients, loadDocsByRef, loadLastGood, loadMappings, OPEN_STATUSES, requireSettings, routeOf, stateVersion,
  type Collected, type CollectQuery,
} from "./collect";
import { buildFiles, planTally, renderRow, type Plan, type PlanRow, type TallyIssue } from "./plan";
import { getTallySettingsRow, lockTallySettings, registrationsView } from "./settings";
import { remoteIdOf, sha256 } from "./vouchers";

// Previews, file runs, confirm / discard, manual resolution and a document's Tally state
// (spec-tally §3.5, §4.1, §4.14, §4.15). The preview and the run read the SAME RepeatableRead
// snapshot shape and the run refuses unless its fingerprint equals the preview's (I6). XML is built
// in memory outside any transaction; the run row freezes it as gzip BYTEA + sha256 (I7). Nothing
// here ever writes a sales document (I1).

const MAX_PREVIEW_DOCS = 2000;
const MAX_VIEW_ITEMS = 2000;
const ITEM_ORDER: Record<string, number> = { invoice: 0, credit_note: 1, receipt: 2, refund: 3 };

const companyShort = (c: CompanyKey) => SALES_COMPANIES[c].short;
const periodText = (from: string, to: string) => `${from} – ${to}`;

async function planFor(q: CollectQuery): Promise<{ col: Collected; plan: Plan }> {
  const seller = await getSellerOrDefaults(q.company);
  return prisma.$transaction(async (tx) => {
    const col = await collectTally(tx, q, seller, todayIST());
    return { col, plan: planTally(col.input) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000, maxWait: 5_000 });
}

function docRow(r: PlanRow) {
  return {
    docType: r.docType, docId: r.docId, number: r.number, date: r.date, party: r.party, partyAmountPaise: r.partyAmountPaise,
    action: r.action, reason: r.reason, issueIds: r.issueIds, lastSent: r.lastSent,
  };
}

function previewOf(col: Collected, plan: Plan) {
  const blocks = plan.issues.filter((i) => i.severity === "block").length;
  return {
    company: col.input.company, tallyCompany: col.tallyCompany, scopeGstin: col.scopeGstin, release: col.input.release,
    period: { from: col.input.from, to: col.input.to, effectiveFrom: col.input.effectiveFrom, booksFrom: col.input.booksFrom },
    mode: col.input.mode, openRun: col.openRun,
    counts: plan.counts, totals: plan.totals, tallyShouldShow: plan.tallyShouldShow, ledgers: plan.ledgers, issues: plan.issues,
    documents: plan.rows.slice(0, MAX_PREVIEW_DOCS).map(docRow), documentsTruncated: plan.rows.length > MAX_PREVIEW_DOCS,
    previewHash: plan.previewHash,
    canExport: !col.openRun && plan.counts.vouchers > 0 && blocks === 0,
  };
}
export type TallyPreview = ReturnType<typeof previewOf>;

export async function previewTally(q: CollectQuery): Promise<TallyPreview> {
  const { col, plan } = await planFor(q);
  return previewOf(col, plan);
}

const runOpenError = (r: { runNo: number; periodFrom: Date; periodTo: Date; channel: string }) =>
  new AppError(409, "TALLY_RUN_OPEN", `Export #${r.runNo} (${periodText(dateToDay(r.periodFrom)!, dateToDay(r.periodTo)!)}) is still open — ${r.channel === "push" ? "retry or close its send" : "mark it as imported or discard it"} before starting another.`);
const stale = () => new AppError(409, "TALLY_PREVIEW_STALE", "Something changed since this preview. Check the new preview before exporting.");

/** What a push needs per document beyond the frozen XML (party, ledgers, dependencies, the cancelled-create form). */
function pushPlanOf(plan: Plan, release: "prime3" | "legacy") {
  const items: Record<string, { party: string; ledgers: string[]; dependsOn: string[]; altCreate?: string }> = {};
  const parties: Record<string, { clientId: string; gstin: string | null }> = {};
  for (const r of plan.runRows) {
    const v = r.voucher!;
    items[r.docId] = {
      party: v.partyLedger,
      ledgers: [...new Set(v.entries.filter((e) => !e.party).map((e) => e.ledger))],
      dependsOn: r.dependsOn,
      ...(r.action === "cancel" && (r.docType === "invoice" || r.docType === "credit_note") ? { altCreate: renderRow({ ...r, action: "create" }, release) } : {}),
    };
  }
  return { items, parties };
}

export async function createTallyRun(body: TallyRunCreateInput, channel: "file" | "push", actorId: string, extra: { pushTarget?: string } = {}) {
  const q: CollectQuery = { company: body.companyKey, from: body.from, to: body.to, gstin: body.gstin ?? null, mode: body.mode };
  const { col, plan } = await planFor(q);
  if (col.openRun) {
    const r = await prisma.salesTallyRun.findUnique({ where: { id: col.openRun.id } });
    if (r) throw runOpenError(r);
  }
  if (plan.previewHash !== body.previewHash) throw stale();
  if (plan.counts.vouchers === 0) {
    throw new AppError(409, "TALLY_NOTHING_TO_EXPORT", `Nothing to send for ${periodText(body.from, body.to)} — everything in it is already in Tally. Choose 'Everything in the period' to send it again.`);
  }
  const blocked = plan.rows.filter((r) => r.action === "blocked");
  if (blocked.length && !body.allowPartial) {
    throw new AppError(409, "TALLY_BLOCKED", `${blocked.length} document${blocked.length === 1 ? "" : "s"} can't go to Tally yet. Fix them, or tick 'Leave them out' to export the rest.`);
  }
  const acks = plan.issues.filter((i) => i.severity === "ack");
  const unticked = acks.filter((i) => !body.acknowledge.includes(i.id));
  if (unticked.length) throw new AppError(409, "TALLY_ACK_REQUIRED", `${unticked.length} warning${unticked.length === 1 ? "" : "s"} need a tick before exporting.`);

  // Build outside any transaction (CPU only).
  const release = col.input.release;
  const files = buildFiles(plan, col.tallyCompany, release);
  const vouchersGz = gzipSync(Buffer.from(files.vouchers, "ascii"));
  const mastersGz = files.masters ? gzipSync(Buffer.from(files.masters, "ascii")) : null;
  const preview = previewOf(col, plan);
  const { documents: _d, documentsTruncated: _t, ...summary } = preview;
  const s = col.settings;
  const usedClientIds = [...new Set(plan.runRows.map((r) => r.clientId))];
  const partyNames: Record<string, string> = {};
  for (const id of usedClientIds) { const p = plan.parties.get(id); if (p) partyNames[id] = p.name; }
  const ledgerMap = { partyGroup: s.partyGroup, salesLedgers: s.salesLedgers, ledgers: s.ledgers, voucherTypes: s.voucherTypes, parties: partyNames };
  const clientGstin = new Map([...col.input.clients.values()].map((c) => [c.id, c.gstin]));

  const runId = await prisma.$transaction(async (tx) => {
    await lockTallySettings(tx, body.companyKey);
    if ((await stateVersion(tx, body.companyKey)) !== col.input.stateVersion) throw stale();
    const open = await tx.salesTallyRun.findFirst({ where: { companyKey: body.companyKey, tallyCompany: col.tallyCompany, status: { in: OPEN_STATUSES } } });
    if (open) throw runOpenError(open);
    // Party names: new ones are saved now (ON CONFLICT DO NOTHING) and every name re-read — a name
    // someone changed since the preview makes the preview stale.
    const fresh = usedClientIds.filter((id) => plan.parties.get(id)?.proposed);
    if (fresh.length) {
      await tx.salesTallyParty.createMany({
        data: fresh.map((id) => { const n = plan.parties.get(id)!.name; return { companyKey: body.companyKey, clientId: id, ledgerName: n, ledgerKey: n.toLowerCase().replace(/\s+/g, " ").trim(), gstin: clientGstin.get(id) ?? null, createdById: actorId }; }),
        skipDuplicates: true,
      });
    }
    const now = await tx.salesTallyParty.findMany({ where: { companyKey: body.companyKey, clientId: { in: usedClientIds } } });
    for (const m of now) if (partyNames[m.clientId] !== m.ledgerName) throw stale();
    const [{ n }] = await tx.$queryRaw<Array<{ n: number }>>`SELECT COALESCE(MAX(run_no), 0)::int + 1 AS n FROM sales_tally_runs WHERE company_key = ${body.companyKey}`;
    const run = await tx.salesTallyRun.create({
      data: {
        companyKey: body.companyKey, runNo: Number(n), tallyCompany: col.tallyCompany, scopeGstin: col.scopeGstin,
        periodFrom: dayToDate(body.from), periodTo: dayToDate(body.to), mode: body.mode, channel, status: channel === "push" ? "queued" : "open",
        tallyRelease: release, previewHash: plan.previewHash, voucherCount: plan.runRows.length, masterCount: files.masterCount,
        blockedCount: blocked.length, controlTotalPaise: BigInt(plan.controlTotalPaise),
        summary: summary as unknown as Prisma.InputJsonValue, ledgerMap: ledgerMap as unknown as Prisma.InputJsonValue,
        acknowledged: acks.map((i) => ({ id: i.id, byId: actorId, at: new Date().toISOString() })) as unknown as Prisma.InputJsonValue,
        mastersXmlGz: mastersGz, vouchersXmlGz: vouchersGz,
        mastersSha256: files.masters ? sha256(files.masters) : null, vouchersSha256: sha256(files.vouchers),
        pushTarget: extra.pushTarget ?? null,
        pushResult: channel === "push" ? ({ plan: pushPlanOf(plan, release), masters: null, error: null } as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        createdById: actorId,
      },
    });
    const itemRows = [...plan.runRows, ...blocked].map((r) => ({
      runId: run.id, companyKey: body.companyKey, docType: r.docType, docId: r.docId, docNumber: r.number.slice(0, 32), docDate: dayToDate(r.date),
      voucherType: (r.voucher?.voucherType ?? "").slice(0, 100) || defaultVoucherType(s, r.docType), remoteId: remoteIdOf(r.docType, r.docId),
      action: r.action === "blocked" ? "none" : r.action, contentHash: r.hash, partyAmountPaise: BigInt(r.partyAmountPaise),
      outcome: r.action === "blocked" ? "blocked" : "pending", issueCode: r.action === "blocked" ? r.blockCode : null,
      error: r.action === "blocked" ? r.blockMessage : null,
    }));
    for (let i = 0; i < itemRows.length; i += 500) await tx.salesTallyItem.createMany({ data: itemRows.slice(i, i + 500) });
    await logSalesEvent(tx, {
      entityType: "tally_run", entityId: run.id, actorId, action: "built", toStatus: run.status,
      note: `${plan.runRows.length} voucher${plan.runRows.length === 1 ? "" : "s"} · ${periodText(body.from, body.to)} · ${col.tallyCompany}`,
    });
    return run.id;
  }, { timeout: 30_000, maxWait: 5_000 });
  return getTallyRun(runId);
}

function defaultVoucherType(s: Collected["settings"], t: TallyDocType) {
  return t === "invoice" ? s.voucherTypes.sales : t === "credit_note" ? s.voucherTypes.creditNote : t === "receipt" ? s.voucherTypes.receipt : s.voucherTypes.payment;
}

// ── Views ─────────────────────────────────────────────────────────────────────────

type RunRow = Prisma.SalesTallyRunGetPayload<object>;
const RUN_ROW_SELECT = {
  id: true, companyKey: true, runNo: true, tallyCompany: true, scopeGstin: true, periodFrom: true, periodTo: true, mode: true, channel: true, status: true,
  voucherCount: true, masterCount: true, blockedCount: true, controlTotalPaise: true, createdById: true, createdAt: true, closedAt: true, updatedAt: true,
} as const;
type RunLite = Prisma.SalesTallyRunGetPayload<{ select: typeof RUN_ROW_SELECT }>;
const activePushes = new Set<string>();
export const pushRegistry = activePushes;
const STALE_MS = 2 * 60_000;
export const isStale = (r: { status: string; id: string; updatedAt: Date }) => r.status === "pushing" && !activePushes.has(r.id) && Date.now() - r.updatedAt.getTime() > STALE_MS;

async function names(ids: string[]) {
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

function rowView(r: RunLite, who: Map<string, string>) {
  return {
    id: r.id, companyKey: r.companyKey as CompanyKey, runNo: r.runNo, tallyCompany: r.tallyCompany, scopeGstin: r.scopeGstin,
    periodFrom: dateToDay(r.periodFrom)!, periodTo: dateToDay(r.periodTo)!, mode: r.mode, channel: r.channel, status: r.status,
    voucherCount: r.voucherCount, masterCount: r.masterCount, blockedCount: r.blockedCount, controlTotalPaise: toSafeNumber(r.controlTotalPaise),
    createdBy: who.has(r.createdById) ? { id: r.createdById, name: who.get(r.createdById)! } : r.createdById === "system" ? { id: "system", name: "System" } : null,
    createdAt: r.createdAt.toISOString(), closedAt: r.closedAt?.toISOString() ?? null,
  };
}

export async function listTallyRuns(company: CompanyKey) {
  const runs = await prisma.salesTallyRun.findMany({ where: { companyKey: company }, orderBy: { runNo: "desc" }, take: 100, select: RUN_ROW_SELECT });
  const who = await names(runs.map((r) => r.createdById));
  return runs.map((r) => rowView(r, who));
}

export async function getTallyRun(id: string) {
  const r = await prisma.salesTallyRun.findUnique({ where: { id } });
  if (!r) throw new AppError(404, "NOT_FOUND", "Export not found");
  const items = await prisma.salesTallyItem.findMany({ where: { runId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: MAX_VIEW_ITEMS + 1 });
  const who = await names([r.createdById]);
  const counts = r.channel === "push" ? await prisma.salesTallyItem.groupBy({ by: ["outcome"], where: { runId: id }, _count: { _all: true } }) : [];
  const n = (o: string[]) => counts.filter((c) => o.includes(c.outcome)).reduce((s, c) => s + c._count._all, 0);
  const pushResult = r.pushResult as Record<string, unknown> | null;
  const { plan: _p, ...pushShown } = pushResult ?? {};
  return {
    ...rowView(r, who),
    summary: r.summary, acknowledged: r.acknowledged, pushTarget: r.pushTarget, pushResult: pushResult ? pushShown : null,
    tallyReported: r.tallyReported, statusNote: r.statusNote, previewHash: r.previewHash, tallyRelease: r.tallyRelease,
    // File order: Sales, Credit Notes, Receipts, Payments; cancels last; by date then number.
    items: items.slice(0, MAX_VIEW_ITEMS).sort((a, b) => ITEM_ORDER[a.docType] - ITEM_ORDER[b.docType] || Number(a.action === "cancel") - Number(b.action === "cancel")
      || a.docDate.getTime() - b.docDate.getTime() || (a.docNumber < b.docNumber ? -1 : a.docNumber > b.docNumber ? 1 : 0)).map((i) => ({
      id: i.id, docType: i.docType, docId: i.docId, docNumber: i.docNumber, docDate: dateToDay(i.docDate)!, voucherType: i.voucherType,
      action: i.action, outcome: i.outcome, partyAmountPaise: toSafeNumber(i.partyAmountPaise), issueCode: i.issueCode, error: i.error,
      tallyVchId: i.tallyVchId, attempts: i.attempts,
    })),
    itemsTruncated: items.length > MAX_VIEW_ITEMS,
    progress: r.channel === "push" ? { done: n(["synced", "adopted"]), failed: n(["failed"]), waiting: n(["pending", "sending", "unknown"]), total: n(["synced", "adopted", "failed", "pending", "sending", "unknown", "superseded"]) } : null,
    stale: isStale(r),
    files: { masters: !!r.mastersXmlGz, vouchers: !!r.vouchersXmlGz },
  };
}
export type TallyRunView = Awaited<ReturnType<typeof getTallyRun>>;

/** The stored XML, verified against its sha256 (I7). A mismatch is never served. */
export async function tallyRunFile(id: string, part: "masters" | "vouchers") {
  const r = await prisma.salesTallyRun.findUnique({ where: { id } });
  if (!r) throw new AppError(404, "NOT_FOUND", "Export not found");
  const gz = part === "masters" ? r.mastersXmlGz : r.vouchersXmlGz;
  const sum = part === "masters" ? r.mastersSha256 : r.vouchersSha256;
  if (!gz || !sum) throw new AppError(404, "NOT_FOUND", part === "masters" ? "This export has no new ledgers" : "Export not found");
  let bytes: Buffer;
  try {
    bytes = gunzipSync(Buffer.from(gz));
  } catch {
    bytes = Buffer.alloc(0);
  }
  if (sha256(bytes) !== sum) {
    console.error(`[tally] export ${r.companyKey} #${r.runNo} ${part}: stored file failed its sha256 check`);
    throw new AppError(500, "TALLY_FILE_CORRUPT", "This export's stored file failed its checksum. Discard it and export again.");
  }
  const filename = `tally-${r.companyKey}-${dateToDay(r.periodFrom)}_${dateToDay(r.periodTo)}-export${r.runNo}-${part}.xml`.replace(/[^\w.-]+/g, "-");
  return { bytes, filename };
}

// ── Confirm / discard / manual resolution ─────────────────────────────────────────

async function lockRun(tx: Tx, id: string) {
  const owner = await tx.salesTallyRun.findUnique({ where: { id }, select: { companyKey: true } });
  if (!owner) throw new AppError(404, "NOT_FOUND", "Export not found");
  await lockTallySettings(tx, owner.companyKey as CompanyKey, false);
  await tx.$queryRaw`SELECT id FROM sales_tally_runs WHERE id = ${id} FOR UPDATE`;
  return (await tx.salesTallyRun.findUnique({ where: { id } }))!;
}
const stateError = (r: { runNo: number; status: string }, action: string) => new AppError(409, "TALLY_RUN_STATE", `Export #${r.runNo} is ${r.status}; it can't be ${action}.`);

/** Per-document tally_synced events + lock the party mappings a successful run used. */
export async function markSynced(tx: Tx, run: RunRow, actorId: string, docIds?: string[]) {
  const items = await tx.salesTallyItem.findMany({ where: { runId: run.id, outcome: { in: ["synced", "adopted"] }, ...(docIds ? { docId: { in: docIds } } : {}) } });
  const refunds = await tx.salesRefund.findMany({ where: { id: { in: items.filter((i) => i.docType === "refund").map((i) => i.docId) } }, select: { id: true, paymentId: true } });
  const refundPayment = new Map(refunds.map((f) => [f.id, f.paymentId]));
  const events = items.map((i) => {
    const entityType: SalesEntity = i.docType === "invoice" ? "invoice" : i.docType === "credit_note" ? "credit_note" : "payment";
    const entityId = i.docType === "refund" ? refundPayment.get(i.docId) ?? i.docId : i.docId;
    const note = i.docType === "refund" ? `Export #${run.runNo} · refund ${i.docNumber} · ${i.action}` : `Export #${run.runNo} · ${i.action}`;
    return { entityType, entityId, actorId, action: "tally_synced", note };
  });
  for (let k = 0; k < events.length; k += 500) await tx.salesEvent.createMany({ data: events.slice(k, k + 500) });
  const parties = ((run.ledgerMap as { parties?: Record<string, string> } | null)?.parties) ?? {};
  const ids = Object.keys(parties);
  if (ids.length) await tx.salesTallyParty.updateMany({ where: { companyKey: run.companyKey, clientId: { in: ids }, lockedAt: null }, data: { lockedAt: new Date() } });
}

export async function confirmTallyRun(id: string, body: TallyRunConfirmInput, actorId: string) {
  await prisma.$transaction(async (tx) => {
    const r = await lockRun(tx, id);
    if (r.channel !== "file" || r.status !== "open") throw stateError(r, "marked as imported");
    if (body.errors > 0) throw new AppError(409, "TALLY_IMPORT_HAD_ERRORS", `Tally reported ${body.errors} error(s). Fix them in Tally and import the same file again, or discard this export.`);
    const sum = body.created + body.altered + body.cancelled;
    if (sum !== r.voucherCount) {
      throw new AppError(409, "TALLY_COUNT_MISMATCH", `Export #${r.runNo} has ${r.voucherCount} vouchers but you entered ${body.created} created + ${body.altered} altered + ${body.cancelled} cancelled. Check Tally's import summary — don't confirm until they agree.`);
    }
    const now = new Date();
    await tx.salesTallyItem.updateMany({ where: { runId: id, outcome: "pending" }, data: { outcome: "synced", resolvedAt: now } });
    const run = await tx.salesTallyRun.update({
      where: { id },
      data: { status: "confirmed", tallyReported: { created: body.created, altered: body.altered, cancelled: body.cancelled, errors: body.errors }, statusNote: body.note, closedAt: now, closedById: actorId },
    });
    await markSynced(tx, run, actorId);
    await logSalesEvent(tx, { entityType: "tally_run", entityId: id, actorId, action: "confirmed", fromStatus: "open", toStatus: "confirmed", note: body.note });
  }, { timeout: 30_000 });
  return getTallyRun(id);
}

export async function discardTallyRun(id: string, reason: string, actorId: string) {
  await prisma.$transaction(async (tx) => {
    const r = await lockRun(tx, id);
    if (r.channel !== "file" || r.status !== "open") throw stateError(r, "discarded");
    await tx.salesTallyItem.updateMany({ where: { runId: id, outcome: { in: ["pending", "blocked"] } }, data: { outcome: "superseded" } });
    await tx.salesTallyRun.update({ where: { id }, data: { status: "discarded", statusNote: reason, closedAt: new Date(), closedById: actorId } });
    await logSalesEvent(tx, { entityType: "tally_run", entityId: id, actorId, action: "discarded", fromStatus: "open", toStatus: "discarded", note: reason });
  });
  return getTallyRun(id);
}

/** "Tally already matches the portal for these documents" — a manual, confirmed run with no XML. */
export async function resolveByHand(body: TallyResolveInput, actorId: string) {
  const company = body.companyKey;
  const seller = await getSellerOrDefaults(company);
  const runId = await prisma.$transaction(async (tx) => {
    const settingsRow = await requireSettings(tx, company, seller);
    await lockTallySettings(tx, company);
    const open = await tx.salesTallyRun.findFirst({ where: { companyKey: company, status: { in: OPEN_STATUSES } } });
    if (open) throw runOpenError(open);
    const docs = await loadDocsByRef(tx, company, body.docs);
    if (docs.length !== new Set(body.docs.map((d) => d.docId)).size) throw new AppError(404, "NOT_FOUND", "A document was not found in this company");
    const s = settingsRow.settings;
    const routing = new Map(s.registrations.map((r) => [r.gstin, r.tallyCompany]));
    const clients = await loadClients(tx, docs.map((d) => d.doc.clientId));
    const plan = planTally({
      company, tallyCompany: "", scopeGstin: null, scopeGstins: [], registrations: registrationsView(seller), release: s.release, mode: "everything",
      from: "", to: "", effectiveFrom: "", booksFrom: s.booksFrom!, today: todayIST(), settings: s, defaultSac: seller.defaultSac,
      docs: docs.map((d) => ({ d, routeGstin: routeOf(d, seller.gstin ?? null), tallyCompany: null, origin: "period" as const })),
      lastGood: new Map(), mappings: await loadMappings(tx, company), clients, beforeBooks: 0, openRun: null, firstExport: false,
      settingsUpdatedAt: "", stateVersion: "",
    });
    const days = docs.map(docDay).sort();
    const tallyCompany = routing.get(routeOf(docs[0], seller.gstin ?? null) ?? "") ?? s.registrations[0]?.tallyCompany ?? SALES_COMPANIES[company].name;
    const [{ n }] = await tx.$queryRaw<Array<{ n: number }>>`SELECT COALESCE(MAX(run_no), 0)::int + 1 AS n FROM sales_tally_runs WHERE company_key = ${company}`;
    const now = new Date();
    const run = await tx.salesTallyRun.create({
      data: {
        companyKey: company, runNo: Number(n), tallyCompany, scopeGstin: null, periodFrom: dayToDate(days[0]), periodTo: dayToDate(days[days.length - 1]),
        mode: "everything", channel: "manual", status: "confirmed", tallyRelease: s.release,
        previewHash: sha256(body.docs.map((d) => `${d.docType}:${d.docId}`).sort().join(",")), voucherCount: docs.length, masterCount: 0,
        controlTotalPaise: BigInt(0), summary: {}, ledgerMap: { parties: {} }, statusNote: body.note, createdById: actorId, closedAt: now, closedById: actorId,
      },
    });
    const byId = new Map(plan.rows.map((r) => [r.docId, r]));
    await tx.salesTallyItem.createMany({
      data: docs.map((d) => {
        const r = byId.get(d.doc.id)!;
        const cancelled = r.voucher ? r.voucher.cancelled : r.action === "skip";
        return {
          runId: run.id, companyKey: company, docType: d.docType, docId: d.doc.id, docNumber: r.number.slice(0, 32), docDate: dayToDate(r.date),
          voucherType: r.voucher?.voucherType ?? defaultVoucherType(s, d.docType), remoteId: remoteIdOf(d.docType, d.doc.id),
          action: cancelled ? "cancel" : "alter", contentHash: r.hash, partyAmountPaise: BigInt(r.partyAmountPaise), outcome: "synced", resolvedAt: now,
        };
      }),
    });
    await markSynced(tx, run, actorId);
    await logSalesEvent(tx, { entityType: "tally_run", entityId: run.id, actorId, action: "resolved_by_hand", toStatus: "confirmed", note: `${docs.length} document${docs.length === 1 ? "" : "s"} · ${body.note}` });
    return run.id;
  }, { timeout: 30_000 });
  return getTallyRun(runId);
}

// ── One document's state in Tally (route 18) ──────────────────────────────────────

export async function tallyDocStatus(docType: TallyDocType, docId: string) {
  const none = { runId: null, runNo: null, at: null, error: null };
  const company = await companyOfDoc(docType, docId);
  if (!company) throw new AppError(404, "NOT_FOUND", "Document not found");
  const settingsRow = await getTallySettingsRow(company);
  if (!settingsRow?.settings.booksFrom) return { state: "not_set_up" as const, ...none };
  const seller = await getSellerOrDefaults(company);
  return prisma.$transaction(async (tx) => {
    const docs = await loadDocsByRef(tx, company, [{ docType, docId }]);
    if (!docs.length) return { state: "never" as const, ...none };
    if (docDay(docs[0]) < settingsRow.settings.booksFrom!) return { state: "before_books" as const, ...none };
    const newest = await tx.salesTallyItem.findFirst({ where: { docId }, orderBy: { createdAt: "desc" }, include: { run: { select: { runNo: true, status: true } } } });
    if (!newest) return { state: "never" as const, ...none };
    if ((newest.outcome === "pending" || newest.outcome === "sending") && OPEN_STATUSES.includes(newest.run.status)) {
      return { state: "pending" as const, runId: newest.runId, runNo: newest.run.runNo, at: newest.createdAt.toISOString(), error: null };
    }
    const last = (await loadLastGood(tx, company, [docId])).get(docId);
    if (last) {
      if (last.action === "cancel") return { state: "cancelled_in_tally" as const, runId: last.runId, runNo: last.runNo, at: last.at, error: null };
      const plan = planTally({
        company, tallyCompany: "", scopeGstin: null, scopeGstins: [], registrations: [], release: settingsRow.settings.release, mode: "new_only",
        from: "", to: "", effectiveFrom: "", booksFrom: settingsRow.settings.booksFrom!, today: todayIST(), settings: settingsRow.settings,
        defaultSac: seller.defaultSac, docs: [{ d: docs[0], routeGstin: null, tallyCompany: null, origin: "period" }],
        lastGood: new Map([[docId, last]]), mappings: await loadMappings(tx, company), clients: await loadClients(tx, [docs[0].doc.clientId]),
        beforeBooks: 0, openRun: null, firstExport: false, settingsUpdatedAt: "", stateVersion: "",
      });
      const row = plan.rows[0];
      const changed = row && (row.action === "alter" || row.action === "cancel");
      return { state: changed ? ("changed" as const) : ("synced" as const), runId: last.runId, runNo: last.runNo, at: last.at, error: null };
    }
    if (newest.outcome === "failed" || newest.outcome === "unknown") {
      return { state: "failed" as const, runId: newest.runId, runNo: newest.run.runNo, at: newest.updatedAt.toISOString(), error: newest.error };
    }
    return { state: "never" as const, ...none };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 });
}

async function companyOfDoc(docType: TallyDocType, id: string): Promise<CompanyKey | null> {
  if (docType === "invoice") return ((await prisma.salesInvoice.findUnique({ where: { id }, select: { companyKey: true } }))?.companyKey as CompanyKey) ?? null;
  if (docType === "receipt") return ((await prisma.salesPayment.findUnique({ where: { id }, select: { companyKey: true } }))?.companyKey as CompanyKey) ?? null;
  if (docType === "credit_note") return ((await prisma.salesCreditNote.findUnique({ where: { id }, select: { invoice: { select: { companyKey: true } } } }))?.invoice.companyKey as CompanyKey) ?? null;
  return ((await prisma.salesRefund.findUnique({ where: { id }, select: { payment: { select: { companyKey: true } } } }))?.payment.companyKey as CompanyKey) ?? null;
}

export type { TallyIssue };
export { companyShort };
