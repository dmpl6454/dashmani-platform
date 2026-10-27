import { prisma } from "@dashmani/db";
import { DEFAULT_COMPANY, todayIST, type CompanyKey } from "@dashmani/shared";
import { logBookingEvent } from "../campaign/booking.service";
import { createInvoiceFromBooking, issueInvoice } from "./invoices.service";
import { createPayment } from "./payments.service";
import { SYSTEM_ACTOR } from "./invoice-email.service";

// A campaign booking paid online (Razorpay) is billed at once: a tax invoice for the booking is
// created and issued — priced so its total, GST included, equals what the client paid — and the
// payment is recorded against it as a receipt, which emails the invoice to the client and to the
// company's billing addresses. Offline bookings are billed by staff in the sales portal, and
// recording the payment there sends the same email.

export async function billOnlineBookingPayment(
  bookingId: string,
  razorpayPaymentId: string,
  amountPaise: number,
  company: CompanyKey = DEFAULT_COMPANY,
): Promise<{ invoiceId: string | null; paymentId: string | null }> {
  // One receipt per Razorpay payment, however often the webhook arrives.
  const dup = await prisma.salesPayment.findFirst({ where: { mode: "razorpay", reference: razorpayPaymentId }, select: { id: true } });
  if (dup) return { invoiceId: null, paymentId: dup.id };
  const booking = await prisma.campaignBooking.findUnique({ where: { id: bookingId }, select: { clientId: true, name: true } });
  if (!booking) return { invoiceId: null, paymentId: null };

  let invoiceId: string | null = null;
  try {
    const existing = await prisma.salesInvoice.findFirst({
      where: { campaignBookingId: bookingId, kind: "tax_invoice", status: { not: "cancelled" } },
      select: { id: true, status: true, companyKey: true },
    });
    if (existing) {
      invoiceId = existing.id;
      company = existing.companyKey as CompanyKey;
      if (existing.status === "draft") await issueInvoice(existing.id, { taxResolution: "keep" }, SYSTEM_ACTOR);
    } else {
      const draft = await createInvoiceFromBooking(bookingId, SYSTEM_ACTOR, company, { gstInclusive: true });
      invoiceId = draft.id;
      await issueInvoice(draft.id, { taxResolution: "keep" }, SYSTEM_ACTOR);
    }
  } catch (err: any) {
    // The money still gets a receipt below; staff finish the invoice (it stays a draft) by hand.
    console.error(`[sales] could not invoice booking ${bookingId} automatically`, err);
    await logBookingEvent(bookingId, { type: "system" }, `Invoice could not be issued automatically: ${err?.message ?? err}. Finish it in the sales portal.`).catch(() => undefined);
  }

  const inv = invoiceId
    ? await prisma.salesInvoice.findUnique({ where: { id: invoiceId }, select: { status: true, totalPaise: true, paidPaise: true, tdsPaise: true, creditedPaise: true } })
    : null;
  const balance = inv && inv.status === "issued" ? Math.max(0, inv.totalPaise - inv.paidPaise - inv.tdsPaise - inv.creditedPaise) : 0;
  const apply = Math.min(balance, amountPaise);
  const payment = await createPayment(
    {
      companyKey: company,
      clientId: booking.clientId,
      amountPaise,
      tdsPaise: 0,
      mode: "razorpay",
      reference: razorpayPaymentId,
      paidOn: todayIST(),
      notes: `Online payment for campaign "${booking.name}"`,
      allocations: apply > 0 && invoiceId ? [{ invoiceId, amountPaise: apply, tdsPaise: 0 }] : [],
    },
    SYSTEM_ACTOR,
  );
  return { invoiceId, paymentId: payment.id };
}
