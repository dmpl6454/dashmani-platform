import crypto from "crypto";
import { hash } from "bcrypt";
import { prisma } from "@dashmani/db";
import type { ClientBillingProfileInput } from "@dashmani/shared";
import { receiptBalance } from "./payments.service";
import { AppError } from "../../middleware/error-handler";
import { logSalesEvent, dateToDay } from "./common";
import { deriveInvoice, invoiceSummarySelect } from "./invoices.service";
import { todayIST, type CompanyKey } from "@dashmani/shared";
import * as team from "../client-team.service";

// Clients as the sales team sees them: the existing clients row plus its billing profile and
// money position. Creating a client here never hands out a login — the row gets an unusable
// random password (the Google sign-in path's convention), and the client can still claim the
// account later through invite or "forgot password".

const billingSelect = {
  legalName: true, gstin: true, pan: true, addressLine1: true, addressLine2: true, city: true, state: true,
  stateCode: true, pincode: true, country: true, billingEmail: true, billingPhone: true, notes: true, updatedAt: true,
} as const;

const clientSelect = {
  id: true, companyName: true, contactName: true, email: true, phone: true, status: true, createdAt: true,
  billingProfile: { select: billingSelect },
} as const;

async function outstandingByClient(clientIds?: string[]): Promise<Map<string, number>> {
  const rows = await prisma.salesInvoice.groupBy({
    by: ["clientId"],
    where: { status: "issued", kind: "tax_invoice", ...(clientIds ? { clientId: { in: clientIds } } : {}) },
    _sum: { totalPaise: true, paidPaise: true, tdsPaise: true, creditedPaise: true },
  });
  const m = new Map<string, number>();
  for (const r of rows) {
    m.set(r.clientId, (r._sum.totalPaise ?? 0) - (r._sum.paidPaise ?? 0) - (r._sum.tdsPaise ?? 0) - (r._sum.creditedPaise ?? 0));
  }
  return m;
}

export async function listSalesClients(q?: string) {
  const term = q?.trim();
  const clients = await prisma.client.findMany({
    where: term
      ? {
          OR: [
            { companyName: { contains: term, mode: "insensitive" } },
            { contactName: { contains: term, mode: "insensitive" } },
            { email: { contains: term, mode: "insensitive" } },
            { billingProfile: { legalName: { contains: term, mode: "insensitive" } } },
          ],
        }
      : {},
    orderBy: { companyName: "asc" },
    take: 500,
    select: clientSelect,
  });
  const outstanding = await outstandingByClient(clients.map((c) => c.id));
  return clients.map((c) => ({ ...c, outstandingPaise: outstanding.get(c.id) ?? 0 }));
}

export async function getSalesClient(id: string) {
  const client = await prisma.client.findUnique({ where: { id }, select: clientSelect });
  if (!client) throw new AppError(404, "NOT_FOUND", "Client not found");
  const [quotes, orders, invoices, outstanding] = await Promise.all([
    prisma.salesQuote.count({ where: { clientId: id } }),
    prisma.salesOrder.count({ where: { clientId: id } }),
    prisma.salesInvoice.count({ where: { clientId: id } }),
    outstandingByClient([id]),
  ]);
  return { ...client, counts: { quotes, orders, invoices }, outstandingPaise: outstanding.get(id) ?? 0 };
}

export async function createSalesClient(
  input: { companyName: string; contactName: string; email: string; phone?: string | null },
  actorId: string,
) {
  if (await team.emailInUse(input.email)) throw new AppError(409, "EMAIL_EXISTS", "This email already signs in to the client portal (as a client or a team login)");
  const passwordHash = await hash(crypto.randomBytes(32).toString("hex"), 12);
  const client = await prisma.client.create({
    data: { companyName: input.companyName, contactName: input.contactName, email: input.email, phone: input.phone ?? null, passwordHash, status: "ACTIVE" },
    select: clientSelect,
  });
  await logSalesEvent(prisma, { entityType: "client", entityId: client.id, actorId, action: "client_created" });
  return { ...client, counts: { quotes: 0, orders: 0, invoices: 0 }, outstandingPaise: 0 };
}

export async function upsertClientBilling(clientId: string, input: ClientBillingProfileInput, actorId: string) {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) throw new AppError(404, "NOT_FOUND", "Client not found");
  const data = { ...input, gstin: input.gstin ?? null, pan: input.pan ?? null };
  const profile = await prisma.clientBillingProfile.upsert({
    where: { clientId },
    create: { clientId, ...data },
    update: data,
    select: billingSelect,
  });
  await logSalesEvent(prisma, { entityType: "client", entityId: clientId, actorId, action: "billing_profile_saved" });
  return profile;
}

/** Every money document for one client, with balances — the account statement. */
/** The client's account with one company (both, when no company is given — each row says whose). */
export async function getClientStatement(clientId: string, company?: CompanyKey) {
  const c = company ? { companyKey: company } : {};
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: clientSelect });
  if (!client) throw new AppError(404, "NOT_FOUND", "Client not found");
  const today = todayIST();
  const [invoices, payments, creditNotes] = await Promise.all([
    prisma.salesInvoice.findMany({ where: { ...c, clientId, status: { not: "draft" } }, orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }], select: invoiceSummarySelect }),
    prisma.salesPayment.findMany({ where: { ...c, clientId }, orderBy: { paidOn: "desc" }, include: { allocations: { select: { invoiceId: true, amountPaise: true, tdsPaise: true } }, refunds: true } }),
    prisma.salesCreditNote.findMany({ where: { clientId, ...(company ? { invoice: c } : {}) }, orderBy: { issueDate: "desc" }, include: { invoice: { select: { companyKey: true } } } }),
  ]);
  const derived = invoices.map((i) => deriveInvoice(i, today));
  const live = payments.filter((p) => p.status === "recorded");
  const refundedPaise = live.flatMap((p) => p.refunds).filter((r) => r.status === "issued").reduce((s, r) => s + r.amountPaise, 0);
  const totals = {
    invoicedPaise: derived.filter((i) => i.kind === "tax_invoice" && i.status !== "cancelled").reduce((s, i) => s + i.totalPaise, 0),
    // Voided receipts never happened; refunds are money that went back out.
    collectedPaise: live.reduce((s, p) => s + p.amountPaise, 0) - refundedPaise,
    tdsPaise: live.reduce((s, p) => s + p.tdsPaise, 0),
    refundedPaise,
    /** Money received but on no invoice and not refunded (advances, credit released by credit notes): apply it or refund it. */
    unappliedPaise: live.reduce((s, p) => { const b = receiptBalance(p); return s + b.unallocatedPaise + b.unallocatedTdsPaise; }, 0),
    creditedPaise: creditNotes.filter((c) => c.status === "issued").reduce((s, c) => s + c.totalPaise, 0),
    // Proformas are not receivables (the client list's outstanding never counted them either).
    outstandingPaise: derived.filter((i) => i.kind === "tax_invoice" && (i.derivedStatus === "issued" || i.derivedStatus === "partially_paid" || i.derivedStatus === "overdue")).reduce((s, i) => s + i.balancePaise, 0),
    overduePaise: derived.filter((i) => i.kind === "tax_invoice" && i.derivedStatus === "overdue").reduce((s, i) => s + i.balancePaise, 0),
  };
  return {
    client,
    invoices: derived,
    payments: payments.map((p) => ({ ...p, paidOn: dateToDay(p.paidOn), refunds: p.refunds.map((r) => ({ ...r, refundedOn: dateToDay(r.refundedOn) })), ...receiptBalance(p) })),
    creditNotes,
    totals,
  };
}

// ── Portal logins (team) ──
// Staff can add, re-invite, switch off and remove further logins for a client company — the
// same operations the company's owner has under Team on the client portal.

async function staffLabel(actorId: string) {
  const u = await prisma.user.findUnique({ where: { id: actorId }, select: { name: true } });
  return `${u?.name ?? "Our team"} (Digital Sukoon)`;
}

export async function listClientLogins(clientId: string) {
  return team.listTeam(clientId);
}

export async function inviteClientLogin(clientId: string, input: { email: string; name: string }, actorId: string) {
  const r = await team.inviteMember(clientId, input, await staffLabel(actorId));
  await logSalesEvent(prisma, { entityType: "client", entityId: clientId, actorId, action: "login_added", note: input.email });
  return r;
}

export async function resendClientLogin(clientId: string, memberId: string, actorId: string) {
  return team.resendInvite(clientId, memberId, await staffLabel(actorId));
}

export async function setClientLoginEnabled(clientId: string, memberId: string, enabled: boolean, actorId: string) {
  const m = enabled ? await team.enableMember(clientId, memberId) : await team.disableMember(clientId, memberId);
  await logSalesEvent(prisma, { entityType: "client", entityId: clientId, actorId, action: enabled ? "login_enabled" : "login_disabled", note: m.email });
  return m;
}

export async function removeClientLogin(clientId: string, memberId: string, actorId: string) {
  const r = await team.removeMember(clientId, memberId);
  await logSalesEvent(prisma, { entityType: "client", entityId: clientId, actorId, action: "login_removed" });
  return r;
}

