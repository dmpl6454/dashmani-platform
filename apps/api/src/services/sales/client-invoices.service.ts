import { prisma } from "@dashmani/db";
import { SALES_COMPANIES, todayIST, type CompanyKey } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { deriveInvoice, getInvoice, invoiceSummarySelect } from "./invoices.service";

// The client portal's view of its own bills: issued tax invoices and proformas (never drafts),
// scoped to the signed-in client — another client's invoice is a 404, never a 403.

const VISIBLE = ["issued", "paid", "cancelled"];

export async function listClientInvoices(clientId: string, filter: { bookingId?: string } = {}) {
  const rows = await prisma.salesInvoice.findMany({
    where: { clientId, status: { in: VISIBLE }, ...(filter.bookingId ? { campaignBookingId: filter.bookingId } : {}) },
    select: invoiceSummarySelect,
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
  const today = todayIST();
  return rows.map((r) => {
    const d = deriveInvoice(r, today);
    return {
      id: d.id,
      number: d.number,
      kind: d.kind,
      status: d.derivedStatus,
      company: SALES_COMPANIES[d.companyKey as CompanyKey]?.name ?? d.companyKey,
      issueDate: d.issueDate,
      dueDate: d.dueDate,
      totalPaise: d.totalPaise,
      paidPaise: d.paidPaise + d.tdsPaise + d.creditedPaise,
      balancePaise: d.status === "cancelled" ? 0 : d.balancePaise,
      campaignBookingId: d.campaignBookingId,
    };
  });
}

/** The invoice for the client's own PDF download. */
export async function getClientInvoice(clientId: string, id: string) {
  const owned = await prisma.salesInvoice.findFirst({ where: { id, clientId, status: { in: VISIBLE } }, select: { id: true } });
  if (!owned) throw new AppError(404, "NOT_FOUND", "Invoice not found");
  return getInvoice(id);
}
