import { createHash, randomUUID } from "crypto";
import { prisma, Prisma } from "@dashmani/db";
import {
  CONFIRM_OVERDUE_DAYS,
  CONFIRM_STUCK_MINUTES,
  financialYear,
  RECON_TOLERANCE_PAISE,
  reconDay,
  reconDayLong,
  reconInr,
  SALES_COMPANIES,
  type CompanyKey,
  type ConfirmationBatchInput,
  type ConfirmationCreateInput,
  type ConfirmationResponseInput,
} from "@dashmani/shared";
import { AppError } from "../../../middleware/error-handler";
import { sha256Hex } from "../../../middleware/upload-private";
import { sendEmail } from "../../email.service";
import { escapeHtml as esc } from "../../pipeline/email-template";
import { teamEmailRecipients } from "../../client-team.service";
import { getClientStatement } from "../clients.service";
import { dateToDay, dayToDate, inBackground, istDayOf, logSalesEvent, toSafeNumber } from "../common";
import { addressLines } from "../pdf.service";
import { getSellerOrDefaults } from "../settings.service";
import { buildLedger, drCr, type LedgerStatement, type LedgerView } from "./ledger";
import { renderLedgerPdf } from "./recon-pdf";

// Client balance confirmations (spec-reconcile §5.3, §6.6, §8.1–8.2). The ledger is pure
// (ledger.ts); this file loads it, freezes it on the confirmation row, emails it and records the
// client's answer. Writes only sales_balance_confirmations / sales_confirmation_files.

/** Gap between two emails of one batch (the shared Gmail transport). Tests shorten it. */
const sendGapMs = () => {
  const n = Number(process.env.SALES_RECONCILE_SEND_GAP_MS ?? 2000);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const short = (c: CompanyKey) => SALES_COMPANIES[c].short;

export function companyMismatch(rowCompany: string, requested: CompanyKey | undefined) {
  if (requested && requested !== rowCompany) throw new AppError(409, "COMPANY_MISMATCH", `This belongs to ${SALES_COMPANIES[rowCompany as CompanyKey]?.short ?? rowCompany} — switch company at the top.`);
}

/** asOf/to not in the future; from ≤ to; at most three financial years. */
export function checkRange(from: string, to: string, today: string) {
  if (to > today) throw new AppError(422, "AS_OF_IN_FUTURE", "Pick a date up to today.");
  if (from > to) throw new AppError(400, "VALIDATION_ERROR", "The statement must start on or before the 'as of' date");
  const fyFrom = Number(financialYear(from).label.slice(0, 4));
  const fyTo = Number(financialYear(to).label.slice(0, 4));
  if (fyTo - fyFrom + 1 > 3) throw new AppError(422, "RANGE_TOO_LONG", "A statement can cover at most three financial years.");
}

// ─── The live ledger ─────────────────────────────────────────────────────────────────────────

export async function liveLedger(company: CompanyKey, clientId: string, from: string, to: string, today: string): Promise<LedgerView> {
  const st = await getClientStatement(clientId, company);
  const [cancelledInv, extraTans] = await Promise.all([
    prisma.salesInvoice.findMany({ where: { clientId, companyKey: company, status: "cancelled" }, select: { id: true, cancelledAt: true, cancelReason: true } }),
    prisma.salesTdsDeductor.findMany({ where: { clientId, kind: "client" }, select: { tan: true }, orderBy: { tan: "asc" } }),
  ]);
  const cancelInfo: Record<string, { day: string | null; reason: string | null }> = {};
  for (const i of cancelledInv) cancelInfo[i.id] = { day: i.cancelledAt ? istDayOf(i.cancelledAt) : null, reason: i.cancelReason };
  for (const p of st.payments) {
    if (p.status !== "recorded") cancelInfo[p.id] = { day: p.voidedAt ? istDayOf(p.voidedAt) : null, reason: p.voidReason };
    for (const r of p.refunds) if (r.status !== "issued") cancelInfo[r.id] = { day: r.cancelledAt ? istDayOf(r.cancelledAt) : null, reason: null };
  }
  for (const cn of st.creditNotes) if (cn.status !== "issued") cancelInfo[cn.id] = { day: cn.cancelledAt ? istDayOf(cn.cancelledAt) : null, reason: null };
  const seller = await getSellerOrDefaults(company);
  const bp = st.client.billingProfile;
  const tans = [bp?.tan, ...extraTans.map((t) => t.tan)].filter((x): x is string => !!x);
  return buildLedger(st as unknown as LedgerStatement, { from, to }, {
    company,
    seller: { legalName: seller.legalName, gstin: seller.gstin ?? null, pan: seller.pan ?? null, addressLines: addressLines(seller), email: seller.email ?? null },
    today, generatedAt: new Date().toISOString(), cancelInfo, tans,
  });
}

const sha = (l: LedgerView) => createHash("sha256").update(JSON.stringify(l)).digest("hex");
const hasDocs = (l: LedgerView) => l.lines.length > 0 || l.openingPaise !== 0 || l.closingPaise !== 0;

// ─── Recipients and email ────────────────────────────────────────────────────────────────────

export async function confirmationRecipients(clientId: string, company: CompanyKey): Promise<{ to: string[]; cc: string[] }> {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { email: true, billingProfile: { select: { billingEmail: true } } } });
  const team = await teamEmailRecipients(clientId, "invoices").catch(() => [] as string[]);
  const seller = await getSellerOrDefaults(company);
  const norm = (list: Array<string | null | undefined>) => [...new Set(list.map(str).filter((x): x is string => !!x).map((x) => x.toLowerCase()))];
  const to = norm([c?.billingProfile?.billingEmail, c?.email, ...team]);
  const cc = norm([seller.email, ...(seller.billingEmails ?? [])]).filter((e) => !to.includes(e));
  return { to, cc };
}

export interface EmailResult { sent: boolean; to: string[]; cc: string[] }

const CONF_SELECT = {
  id: true, companyKey: true, clientId: true, asOf: true, fromDay: true, status: true, ourBalancePaise: true, ledger: true, ledgerSha256: true, theirBalancePaise: true,
  responseNote: true, respondedOn: true, respondedById: true, sentCount: true, queuedAt: true, lastSentAt: true, lastSentTo: true, lastSendError: true, createdAt: true, updatedAt: true,
  client: { select: { companyName: true } }, file: { select: { id: true, fileName: true, sizeBytes: true, contentType: true } },
} as const;
type ConfRow = Prisma.SalesBalanceConfirmationGetPayload<{ select: typeof CONF_SELECT }>;

/** Email one confirmation from its FROZEN ledger. Throws CONFIRM_NO_EMAIL / CONFIRM_SEND_FAILED. */
async function sendOne(id: string, actorId: string): Promise<EmailResult> {
  const row = await prisma.salesBalanceConfirmation.findUniqueOrThrow({ where: { id }, select: CONF_SELECT });
  const company = row.companyKey as CompanyKey;
  const name = row.client.companyName;
  const { to, cc } = await confirmationRecipients(row.clientId, company);
  if (!to.length) {
    await prisma.salesBalanceConfirmation.update({ where: { id }, data: { queuedAt: null, lastSendError: "No email address on the client" } });
    throw new AppError(409, "CONFIRM_NO_EMAIL", `${name} has no email address — add a billing email on the client, or download the PDF and send it yourself.`);
  }
  const ledger = row.ledger as unknown as LedgerView;
  const pdf = await renderLedgerPdf(ledger, { request: true, confirmationId: id });
  const seller = await getSellerOrDefaults(company);
  const legal = seller.legalName || SALES_COMPANIES[company].name;
  const asOfLong = reconDayLong(ledger.to);
  const bal = ledger.closingPaise;
  const balanceText = bal >= 0 ? `<strong>${esc(reconInr(bal))} receivable from you</strong>` : `<strong>${esc(reconInr(-bal))} held as an advance from you</strong>`;
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5">
<p>Dear ${esc(name)},</p>
<p>Our books show ${balanceText} as on ${esc(asOfLong)} (statement attached, ${esc(reconDay(ledger.from))} – ${esc(reconDay(ledger.to))}).</p>
<p>Please reply to confirm, or send us the balance in your books and the entries that differ.</p>
<p>Regards,<br/>Accounts, ${esc(legal)}</p></body></html>`;
  const filename = `statement-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${company}-${ledger.to}.pdf`;
  const result = await sendEmail({
    to: to.join(", "), cc: cc.join(", ") || undefined, subject: `Balance confirmation as on ${reconDay(ledger.to)} — ${legal}`, html,
    replyTo: cc[0], fromName: legal, attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
  }).catch(() => null);
  if (!result) {
    await prisma.salesBalanceConfirmation.update({ where: { id }, data: { queuedAt: null, lastSendError: "The email could not be sent" } });
    await logSalesEvent(prisma, { entityType: "confirmation", entityId: id, actorId, action: "send_failed", note: `→ ${to.join(", ")}`.slice(0, 500) });
    throw new AppError(502, "CONFIRM_SEND_FAILED", "The email could not be sent — try again in a minute, or download the PDF.");
  }
  const sentTo = `${to.join(", ")}${cc.length ? ` (cc ${cc.join(", ")})` : ""}`;
  await prisma.salesBalanceConfirmation.update({ where: { id }, data: { sentCount: { increment: 1 }, lastSentAt: new Date(), lastSentTo: sentTo.slice(0, 1000), queuedAt: null, lastSendError: null } });
  await logSalesEvent(prisma, { entityType: "confirmation", entityId: id, actorId, action: "sent", note: `→ ${sentTo} · ${drCr(bal)} · pdf sha256 ${sha256Hex(pdf).slice(0, 12)}`.slice(0, 1000) });
  return { sent: true, to, cc };
}

// ─── State ───────────────────────────────────────────────────────────────────────────────────

export interface ConfirmationState {
  id: string; status: "pending" | "confirmed" | "disputed"; asOf: string; from: string; ourBalancePaise: number; theirBalancePaise: number | null; differencePaise: number | null;
  sentCount: number; lastSentAt: string | null; lastSentTo: string | null; lastSendError: string | null; sending: boolean;
  respondedOn: string | null; responseNote: string | null; hasFile: boolean; file: { fileName: string; sizeBytes: number; contentType: string } | null;
  stale: boolean; overdue: boolean; stuck: boolean; liveBalancePaise: number | null;
}
function stateOf(r: ConfRow, live: number | null, now = Date.now()): ConfirmationState {
  const our = toSafeNumber(r.ourBalancePaise);
  const theirs = r.theirBalancePaise === null ? null : toSafeNumber(r.theirBalancePaise);
  const stuck = !!r.queuedAt && now - r.queuedAt.getTime() > CONFIRM_STUCK_MINUTES * 60_000;
  return {
    id: r.id, status: r.status as ConfirmationState["status"], asOf: dateToDay(r.asOf)!, from: dateToDay(r.fromDay)!, ourBalancePaise: our, theirBalancePaise: theirs,
    differencePaise: theirs === null ? null : our - theirs, sentCount: r.sentCount, lastSentAt: r.lastSentAt?.toISOString() ?? null, lastSentTo: r.lastSentTo, lastSendError: r.lastSendError,
    sending: !!r.queuedAt && !stuck, respondedOn: dateToDay(r.respondedOn), responseNote: r.responseNote, hasFile: !!r.file,
    file: r.file ? { fileName: r.file.fileName, sizeBytes: r.file.sizeBytes, contentType: r.file.contentType } : null,
    stale: r.status === "pending" && live !== null && live !== our,
    overdue: r.status === "pending" && r.sentCount > 0 && !!r.lastSentAt && now - r.lastSentAt.getTime() > CONFIRM_OVERDUE_DAYS * 86_400_000,
    stuck, liveBalancePaise: live,
  };
}

// ─── Balances list ───────────────────────────────────────────────────────────────────────────

interface BalRow { client_id: string; balance: bigint; docs_in_range: number; last_day: Date | null }
export async function balanceRows(company: CompanyKey, asOf: string, from: string, clientId?: string): Promise<BalRow[]> {
  return prisma.$queryRaw<BalRow[]>(Prisma.sql`
    WITH d AS (
      SELECT i.client_id, i.issue_date AS day, i.total_paise::bigint AS amt FROM sales_invoices i
       WHERE i.company_key = ${company} AND i.kind = 'tax_invoice' AND i.status IN ('issued','paid') AND i.issue_date <= ${asOf}::date
      UNION ALL SELECT p.client_id, p.paid_on, -(p.amount_paise::bigint + p.tds_paise) FROM sales_payments p
       WHERE p.company_key = ${company} AND p.status = 'recorded' AND p.paid_on <= ${asOf}::date
      UNION ALL SELECT cn.client_id, cn.issue_date, -cn.total_paise::bigint FROM sales_credit_notes cn JOIN sales_invoices i ON i.id = cn.invoice_id
       WHERE i.company_key = ${company} AND cn.status = 'issued' AND cn.issue_date <= ${asOf}::date
      UNION ALL SELECT r.client_id, r.refunded_on, r.amount_paise::bigint FROM sales_refunds r JOIN sales_payments p ON p.id = r.payment_id
       WHERE p.company_key = ${company} AND p.status = 'recorded' AND r.status = 'issued' AND r.refunded_on <= ${asOf}::date)
    SELECT client_id, SUM(amt)::bigint AS balance, COUNT(*) FILTER (WHERE day >= ${from}::date)::int AS docs_in_range, MAX(day) AS last_day
    FROM d ${clientId ? Prisma.sql`WHERE client_id = ${clientId}` : Prisma.empty} GROUP BY client_id LIMIT 5001`);
}

export interface ConfirmationsView {
  company: CompanyKey; asOf: string; from: string;
  counts: { clients: number; withBalance: number; notSent: number; pending: number; overdue: number; stale: number; confirmed: number; disputed: number; noEmail: number; drPaise: number; crPaise: number; disputedPaise: number };
  rows: Array<{ clientId: string; name: string; legalName: string; email: string | null; balancePaise: number; side: "Dr" | "Cr"; docsInRange: number; lastDay: string | null; confirmation: ConfirmationState | null; lastConfirmed: string | null }>;
  todo: Array<{ code: string; sentence: string; count: number; paise: number | null; href: string | null }>;
}

export async function listConfirmations(company: CompanyKey, asOf: string, from: string, today: string): Promise<ConfirmationsView> {
  checkRange(from, asOf, today);
  const bals = await balanceRows(company, asOf, from);
  const confs = await prisma.salesBalanceConfirmation.findMany({ where: { companyKey: company, asOf: dayToDate(asOf) }, select: CONF_SELECT });
  const lastConf = await prisma.salesBalanceConfirmation.groupBy({ by: ["clientId"], where: { companyKey: company, status: "confirmed" }, _max: { asOf: true } });
  const balBy = new Map(bals.map((b) => [b.client_id, b]));
  const confBy = new Map(confs.map((c) => [c.clientId, c]));
  const ids = [...new Set([...bals.filter((b) => toSafeNumber(b.balance) !== 0 || b.docs_in_range > 0).map((b) => b.client_id), ...confs.map((c) => c.clientId)])];
  const clients = ids.length ? await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, companyName: true, email: true, billingProfile: { select: { legalName: true, billingEmail: true } } } }) : [];
  const lastBy = new Map(lastConf.map((l) => [l.clientId, dateToDay(l._max.asOf)]));
  const rows: ConfirmationsView["rows"] = clients.map((c) => {
    const b = balBy.get(c.id);
    const balance = b ? toSafeNumber(b.balance) : 0;
    const conf = confBy.get(c.id);
    return {
      clientId: c.id, name: c.companyName, legalName: c.billingProfile?.legalName ?? c.companyName, email: str(c.billingProfile?.billingEmail) ?? str(c.email),
      balancePaise: balance, side: balance >= 0 ? "Dr" : "Cr", docsInRange: b?.docs_in_range ?? 0, lastDay: dateToDay(b?.last_day ?? null),
      confirmation: conf ? stateOf(conf, balance) : null, lastConfirmed: lastBy.get(c.id) ?? null,
    };
  });
  const rank = (r: ConfirmationsView["rows"][number]) => {
    const s = r.confirmation;
    if (s?.status === "disputed") return 0;
    if (s?.stale) return 1;
    if (s?.overdue) return 2;
    if (s?.stuck) return 3;
    if ((!s || s.sentCount === 0) && r.balancePaise !== 0) return 4;
    if (s?.status === "pending") return 5;
    if (s?.status === "confirmed") return 6;
    return 7;
  };
  rows.sort((a, b) => rank(a) - rank(b) || Math.abs(b.balancePaise) - Math.abs(a.balancePaise) || a.name.localeCompare(b.name));
  const counts = { clients: rows.length, withBalance: 0, notSent: 0, pending: 0, overdue: 0, stale: 0, confirmed: 0, disputed: 0, noEmail: 0, drPaise: 0, crPaise: 0, disputedPaise: 0 };
  for (const r of rows) {
    const s = r.confirmation;
    if (r.balancePaise !== 0) counts.withBalance++;
    if (r.balancePaise > 0) counts.drPaise += r.balancePaise; else counts.crPaise += -r.balancePaise;
    if (!s || s.sentCount === 0) { if (r.balancePaise !== 0) counts.notSent++; }
    else if (s.status === "pending") counts.pending++;
    if (s?.overdue) counts.overdue++;
    if (s?.stale) counts.stale++;
    if (s?.status === "confirmed") counts.confirmed++;
    if (s?.status === "disputed") { counts.disputed++; counts.disputedPaise += Math.abs(s.differencePaise ?? 0); }
    if (!r.email) counts.noEmail++;
  }
  const todo: ConfirmationsView["todo"] = [];
  if (counts.notSent) todo.push({ code: "send", sentence: `Send the statement to ${counts.notSent} client${counts.notSent === 1 ? "" : "s"} with a balance`, count: counts.notSent, paise: null, href: null });
  if (counts.overdue) todo.push({ code: "overdue", sentence: `${counts.overdue} ha${counts.overdue === 1 ? "s" : "ve"} not replied in over ${CONFIRM_OVERDUE_DAYS} days — resend`, count: counts.overdue, paise: null, href: null });
  if (counts.disputed) todo.push({ code: "disputed", sentence: `${counts.disputed} disputed (${reconInr(counts.disputedPaise)})`, count: counts.disputed, paise: counts.disputedPaise, href: null });
  if (counts.stale) todo.push({ code: "stale", sentence: `Our figures changed for ${counts.stale} client${counts.stale === 1 ? "" : "s"} since sending — send again`, count: counts.stale, paise: null, href: null });
  return { company, asOf, from, counts, rows, todo };
}

// ─── Create / refresh / send ─────────────────────────────────────────────────────────────────

/**
 * Create the row, or (refresh) re-freeze a pending one. A row already SENT is the record of what
 * the client received (D10): it is only re-frozen when the same call sends the new statement
 * (willSend), and the replaced ledger's sha + balance stay in the "refreshed" event.
 */
async function freeze(input: { company: CompanyKey; clientId: string; asOf: string; from: string; refresh: boolean; willSend: boolean; actorId: string; today: string }): Promise<{ row: ConfRow; created: boolean; refreshed: boolean }> {
  const { company, clientId, asOf, from, actorId } = input;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { companyName: true } });
  if (!client) throw new AppError(404, "NOT_FOUND", "Client not found");
  const ledger = await liveLedger(company, clientId, from, asOf, input.today);
  const ledgerHash = sha(ledger);
  return prisma.$transaction(async (tx) => {
    const id = randomUUID();
    const inserted = hasDocs(ledger) ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO sales_balance_confirmations (id, company_key, client_id, as_of, from_day, status, our_balance_paise, ledger, ledger_sha256, sent_count, created_by_id, created_at, updated_at)
      VALUES (${id}, ${company}, ${clientId}, ${asOf}::date, ${from}::date, 'pending', ${BigInt(ledger.closingPaise)}, ${JSON.stringify(ledger)}::jsonb, ${ledgerHash}, 0, ${actorId}, now(), now())
      ON CONFLICT (company_key, client_id, as_of) DO NOTHING RETURNING id`) : [];
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM sales_balance_confirmations WHERE company_key = ${company} AND client_id = ${clientId} AND as_of = ${asOf}::date FOR UPDATE`);
    if (!locked) throw new AppError(409, "CONFIRM_NOTHING", `${client.companyName} has no documents with ${short(company)} up to ${reconDay(asOf)}.`);
    if (inserted.length) {
      await logSalesEvent(tx, { entityType: "confirmation", entityId: id, actorId, action: "created", note: `${drCr(ledger.closingPaise)} as of ${reconDay(asOf)}` });
      return { row: await tx.salesBalanceConfirmation.findUniqueOrThrow({ where: { id }, select: CONF_SELECT }), created: true, refreshed: false };
    }
    const row = await tx.salesBalanceConfirmation.findUniqueOrThrow({ where: { id: locked.id }, select: CONF_SELECT });
    if (!input.refresh) return { row, created: false, refreshed: false };
    if (row.status !== "pending") throw answered(client.companyName, row);
    if (!hasDocs(ledger)) throw new AppError(409, "CONFIRM_NOTHING", `${client.companyName} has no documents with ${short(company)} up to ${reconDay(asOf)}.`);
    if (row.sentCount > 0 && !input.willSend) throw new AppError(409, "CONFIRM_ALREADY_SENT", `The statement was already sent to ${client.companyName} — refresh and resend together, so the record matches what they received.`);
    await tx.salesBalanceConfirmation.update({ where: { id: row.id }, data: { fromDay: dayToDate(from), ourBalancePaise: BigInt(ledger.closingPaise), ledger: ledger as unknown as Prisma.InputJsonValue, ledgerSha256: ledgerHash } });
    await logSalesEvent(tx, { entityType: "confirmation", entityId: row.id, actorId, action: "refreshed", note: `${drCr(ledger.closingPaise)} as of ${reconDay(asOf)} · was ${drCr(toSafeNumber(row.ourBalancePaise))} · ledger sha256 ${row.ledgerSha256.slice(0, 12)} → ${ledgerHash.slice(0, 12)}${row.sentCount > 0 ? ` · sent ${row.sentCount}×` : ""}` });
    return { row: await tx.salesBalanceConfirmation.findUniqueOrThrow({ where: { id: row.id }, select: CONF_SELECT }), created: false, refreshed: true };
  });
}

function answered(name: string, row: ConfRow) {
  return new AppError(409, "CONFIRM_ANSWERED", `${name} already ${row.status === "confirmed" ? "confirmed" : "disputed"} this balance${row.respondedOn ? ` on ${reconDay(dateToDay(row.respondedOn))}` : ""} — record a new "as of" date instead.`);
}

async function liveBalance(company: CompanyKey, clientId: string, asOf: string): Promise<number> {
  const [b] = await balanceRows(company, asOf, asOf, clientId);
  return b ? toSafeNumber(b.balance) : 0;
}

export async function createConfirmation(body: ConfirmationCreateInput, actorId: string, today: string): Promise<{ status: number; result: { confirmation: ConfirmationState; email: EmailResult | null } }> {
  checkRange(body.from, body.asOf, today);
  const { row, created, refreshed } = await freeze({ company: body.companyKey, clientId: body.clientId, asOf: body.asOf, from: body.from, refresh: body.refresh, willSend: body.send, actorId, today });
  let email: EmailResult | null = null;
  // Send a new or refreshed row, or a pending one never sent (e.g. the first send failed).
  if (body.send && (created || refreshed || (row.status === "pending" && row.sentCount === 0))) email = await sendOne(row.id, actorId);
  const fresh = await prisma.salesBalanceConfirmation.findUniqueOrThrow({ where: { id: row.id }, select: CONF_SELECT });
  return { status: created ? 201 : 200, result: { confirmation: stateOf(fresh, await liveBalance(body.companyKey, body.clientId, body.asOf)), email } };
}

export async function sendConfirmation(id: string, body: { refresh: boolean }, actorId: string, requested: CompanyKey | undefined, today: string) {
  const row = await prisma.salesBalanceConfirmation.findUnique({ where: { id }, select: CONF_SELECT });
  if (!row) throw new AppError(404, "NOT_FOUND", "Confirmation not found");
  companyMismatch(row.companyKey, requested);
  if (row.status !== "pending") throw answered(row.client.companyName, row);
  if (body.refresh) await freeze({ company: row.companyKey as CompanyKey, clientId: row.clientId, asOf: dateToDay(row.asOf)!, from: dateToDay(row.fromDay)!, refresh: true, willSend: true, actorId, today });
  const email = await sendOne(id, actorId);
  const fresh = await prisma.salesBalanceConfirmation.findUniqueOrThrow({ where: { id }, select: CONF_SELECT });
  return { confirmation: stateOf(fresh, await liveBalance(row.companyKey as CompanyKey, row.clientId, dateToDay(row.asOf)!)), email };
}

export async function sendBatch(body: ConfirmationBatchInput, actorId: string, today: string) {
  checkRange(body.from, body.asOf, today);
  const company = body.companyKey;
  const queued: Array<{ clientId: string; name: string }> = [];
  const skipped: Array<{ clientId: string; name: string; reason: string }> = [];
  const toSend: string[] = [];
  for (const clientId of [...new Set(body.clientIds)]) {
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { companyName: true } });
    if (!client) { skipped.push({ clientId, name: "—", reason: "Client not found" }); continue; }
    const name = client.companyName;
    const { to } = await confirmationRecipients(clientId, company);
    if (!to.length) { skipped.push({ clientId, name, reason: `${name} has no email address — add a billing email on the client.` }); continue; }
    const existing = await prisma.salesBalanceConfirmation.findUnique({ where: { companyKey_clientId_asOf: { companyKey: company, clientId, asOf: dayToDate(body.asOf) } }, select: CONF_SELECT });
    if (existing && existing.status !== "pending") { skipped.push({ clientId, name, reason: answered(name, existing).message }); continue; }
    if (existing && existing.sentCount > 0 && !body.resend) { skipped.push({ clientId, name, reason: `Already sent to ${name} — tick Resend to send it again.` }); continue; }
    try {
      const { row } = await freeze({ company, clientId, asOf: body.asOf, from: body.from, refresh: !!existing, willSend: true, actorId, today });
      await prisma.salesBalanceConfirmation.update({ where: { id: row.id }, data: { queuedAt: new Date(), lastSendError: null } });
      queued.push({ clientId, name });
      toSend.push(row.id);
    } catch (err) {
      skipped.push({ clientId, name, reason: err instanceof AppError ? err.message : "Could not prepare the statement" });
    }
  }
  if (toSend.length) {
    inBackground(`balance confirmations ${company} ${body.asOf}`, async () => {
      for (let i = 0; i < toSend.length; i++) {
        if (i > 0) await sleep(sendGapMs());
        await sendOne(toSend[i], actorId).catch(async (err) => {
          await prisma.salesBalanceConfirmation.update({ where: { id: toSend[i] }, data: { queuedAt: null, lastSendError: (err instanceof AppError ? err.message : "The email could not be sent").slice(0, 300) } }).catch(() => undefined);
        });
      }
    });
  }
  return { queued, skipped };
}

// ─── Read one / respond / files ──────────────────────────────────────────────────────────────

export async function getConfirmation(id: string, requested: CompanyKey | undefined) {
  const row = await prisma.salesBalanceConfirmation.findUnique({ where: { id }, select: CONF_SELECT });
  if (!row) throw new AppError(404, "NOT_FOUND", "Confirmation not found");
  companyMismatch(row.companyKey, requested);
  const live = await liveBalance(row.companyKey as CompanyKey, row.clientId, dateToDay(row.asOf)!);
  return { ...stateOf(row, live), companyKey: row.companyKey, clientId: row.clientId, clientName: row.client.companyName, ledgerAsSent: row.ledger as unknown as LedgerView };
}

export async function recordResponse(id: string, body: ConfirmationResponseInput, actorId: string, requested: CompanyKey | undefined, today: string) {
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM sales_balance_confirmations WHERE id = ${id} FOR UPDATE`);
    if (!locked) throw new AppError(404, "NOT_FOUND", "Confirmation not found");
    const row = await tx.salesBalanceConfirmation.findUniqueOrThrow({ where: { id }, select: CONF_SELECT });
    companyMismatch(row.companyKey, requested);
    const ours = toSafeNumber(row.ourBalancePaise);
    const theirs = body.theirBalancePaise ?? null;
    if (body.status === "confirmed" && theirs !== null && Math.abs(theirs - ours) > RECON_TOLERANCE_PAISE) {
      throw new AppError(422, "CONFIRM_FIGURE_DIFFERS", `That is not our figure (${drCr(ours)}) — record it as Disputed.`);
    }
    const respondedOn = body.status === "pending" ? null : body.respondedOn ?? today;
    if (respondedOn && respondedOn > today) throw new AppError(422, "AS_OF_IN_FUTURE", "Pick a date up to today.");
    await tx.salesBalanceConfirmation.update({ where: { id }, data: {
      status: body.status, theirBalancePaise: theirs === null ? null : BigInt(theirs), responseNote: body.note ?? null,
      respondedOn: respondedOn ? dayToDate(respondedOn) : null, respondedById: body.status === "pending" ? null : actorId,
    } });
    const note = body.status === "disputed" ? `disputed · their figure ${drCr(theirs!)} · difference ${reconInr(Math.abs(ours - theirs!))}`
      : body.status === "confirmed" ? `confirmed · ${drCr(ours)}` : "no reply yet";
    await logSalesEvent(tx, { entityType: "confirmation", entityId: id, actorId, action: "response_recorded", note });
    const fresh = await tx.salesBalanceConfirmation.findUniqueOrThrow({ where: { id }, select: CONF_SELECT });
    return { confirmation: stateOf(fresh, null) };
  });
}

/** The reply file's type from its magic bytes — never its name. */
export function replyContentType(buf: Buffer): string | null {
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return null;
}

export async function attachReply(id: string, file: { buffer: Buffer; originalname: string; size: number } | undefined, actorId: string, requested: CompanyKey | undefined) {
  if (!file) throw new AppError(400, "NO_FILE", "Choose the file to upload.");
  const contentType = replyContentType(file.buffer);
  if (!contentType) throw new AppError(415, "REPLY_FILE_TYPE", "Attach the client's reply as a PDF, PNG or JPEG.");
  const name = (file.originalname.split(/[\\/]/).pop() ?? "reply").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "reply";
  const hash = sha256Hex(file.buffer);
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string; company_key: string }>>(Prisma.sql`SELECT id, company_key FROM sales_balance_confirmations WHERE id = ${id} FOR UPDATE`);
    if (!locked) throw new AppError(404, "NOT_FOUND", "Confirmation not found");
    companyMismatch(locked.company_key, requested);
    const data = { fileName: name, contentType, sizeBytes: file.size, sha256: hash, data: file.buffer, uploadedById: actorId };
    await tx.salesConfirmationFile.upsert({ where: { confirmationId: id }, create: { confirmationId: id, ...data }, update: data, select: { id: true } });
    await logSalesEvent(tx, { entityType: "confirmation", entityId: id, actorId, action: "file_attached", note: `${name} · ${(file.size / 1024 / 1024).toFixed(1)} MB · sha256 ${hash.slice(0, 12)}` });
    const fresh = await tx.salesBalanceConfirmation.findUniqueOrThrow({ where: { id }, select: CONF_SELECT });
    return { confirmation: stateOf(fresh, null) };
  });
}

/** The ONLY query that selects the reply bytes. */
export async function getReplyFile(id: string, requested: CompanyKey | undefined) {
  const row = await prisma.salesBalanceConfirmation.findUnique({ where: { id }, select: { companyKey: true } });
  if (!row) throw new AppError(404, "NOT_FOUND", "Confirmation not found");
  companyMismatch(row.companyKey, requested);
  const f = await prisma.salesConfirmationFile.findUnique({ where: { confirmationId: id }, select: { fileName: true, contentType: true, data: true } });
  if (!f) throw new AppError(404, "NOT_FOUND", "No reply file attached");
  return { fileName: f.fileName, contentType: f.contentType, data: Buffer.from(f.data) };
}

export async function removeReply(id: string, actorId: string, requested: CompanyKey | undefined) {
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string; company_key: string }>>(Prisma.sql`SELECT id, company_key FROM sales_balance_confirmations WHERE id = ${id} FOR UPDATE`);
    if (!locked) throw new AppError(404, "NOT_FOUND", "Confirmation not found");
    companyMismatch(locked.company_key, requested);
    const f = await tx.salesConfirmationFile.findUnique({ where: { confirmationId: id }, select: { fileName: true } });
    if (f) {
      await tx.salesConfirmationFile.delete({ where: { confirmationId: id }, select: { id: true } });
      await logSalesEvent(tx, { entityType: "confirmation", entityId: id, actorId, action: "file_removed", note: f.fileName });
    }
    const fresh = await tx.salesBalanceConfirmation.findUniqueOrThrow({ where: { id }, select: CONF_SELECT });
    return { confirmation: stateOf(fresh, null) };
  });
}

// ─── Ledger page ─────────────────────────────────────────────────────────────────────────────

export async function getLedger(company: CompanyKey, clientId: string, from: string, to: string, today: string) {
  checkRange(from, to, today);
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) throw new AppError(404, "NOT_FOUND", "Client not found");
  const ledger = await liveLedger(company, clientId, from, to, today);
  const recipients = await confirmationRecipients(clientId, company);
  const conf = await prisma.salesBalanceConfirmation.findUnique({ where: { companyKey_clientId_asOf: { companyKey: company, clientId, asOf: dayToDate(to) } }, select: CONF_SELECT });
  return { ledger, recipients, confirmation: conf ? { ...stateOf(conf, ledger.closingPaise), ledgerAsSent: conf.ledger as unknown as LedgerView } : null };
}

export async function ledgerPdf(company: CompanyKey, clientId: string, from: string, to: string, today: string) {
  checkRange(from, to, today);
  const ledger = await liveLedger(company, clientId, from, to, today);
  const pdf = await renderLedgerPdf(ledger, { request: false });
  return { pdf, filename: `statement-${ledger.client.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${company}-${to}.pdf` };
}

export async function confirmationPdf(id: string, requested: CompanyKey | undefined) {
  const row = await prisma.salesBalanceConfirmation.findUnique({ where: { id }, select: { companyKey: true, ledger: true, client: { select: { companyName: true } } } });
  if (!row) throw new AppError(404, "NOT_FOUND", "Confirmation not found");
  companyMismatch(row.companyKey, requested);
  const ledger = row.ledger as unknown as LedgerView;
  const pdf = await renderLedgerPdf(ledger, { request: true, confirmationId: id });
  return { pdf, filename: `statement-${row.client.companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${row.companyKey}-${ledger.to}.pdf` };
}
