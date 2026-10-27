import { prisma } from "@dashmani/db";
import { SALES_COMPANIES, type CompanyKey } from "@dashmani/shared";
import { sendEmail } from "../email.service";
import { escapeHtml as esc } from "../pipeline/email-template";
import { getInvoice } from "./invoices.service";
import { renderInvoicePdf } from "./pdf.service";
import { getSellerOrDefaults } from "./settings.service";
import { inBackground, logSalesEvent } from "./common";

// Invoice emails: when a payment is recorded against an issued invoice, the invoice PDF goes to the
// client (To) and to the billing company's own addresses (Cc) — at once, after the payment is
// committed, never on the request path. Each (invoice, payment) pair is emailed once; staff can
// resend by hand. Every attempt is written to the invoice's history ("emailed" / "email_failed").

/** recordedById / createdById for work done by the platform itself (e.g. an online payment). */
export const SYSTEM_ACTOR = "system";

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Fire-and-forget: email each invoice a payment was just allocated to. Never throws. */
export function queueInvoiceEmails(invoiceIds: string[], paymentId: string, actorId: string | null): void {
  for (const id of new Set(invoiceIds)) inBackground(`invoice email for ${id}`, () => emailInvoice(id, { paymentId, actorId }));
}

type Snapshot = Record<string, unknown> | null;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The client's addresses (frozen billing email first) and the company's own billing addresses. */
export async function invoiceRecipients(inv: Awaited<ReturnType<typeof getInvoice>>) {
  const buyer = inv.buyerSnapshot as Snapshot;
  const client = [str(buyer?.email), str(inv.client?.billingProfile?.billingEmail), str(inv.client?.email)];
  const seller = await getSellerOrDefaults(inv.companyKey as CompanyKey);
  const internal = [str(seller.email), ...(seller.billingEmails ?? []).map(str)];
  const norm = (list: Array<string | null>) => [...new Set(list.filter((x): x is string => !!x).map((x) => x.toLowerCase()))];
  const to = norm(client);
  const cc = norm(internal).filter((e) => !to.includes(e));
  return { to, cc, seller };
}

export type InvoiceEmailResult = { sent: boolean; to: string[]; cc: string[]; skipped?: string };

export async function emailInvoice(
  invoiceId: string,
  opts: { paymentId?: string | null; actorId?: string | null; manual?: boolean } = {},
): Promise<InvoiceEmailResult> {
  const inv = await getInvoice(invoiceId);
  const none = (skipped: string): InvoiceEmailResult => ({ sent: false, to: [], cc: [], skipped });
  if (inv.status !== "issued" && inv.status !== "paid") return none(`a ${inv.status} invoice is not emailed`);
  const key = opts.paymentId ? `payment:${opts.paymentId}` : null;
  if (!opts.manual) {
    if (!key) return none("no payment");
    const seller = await getSellerOrDefaults(inv.companyKey as CompanyKey);
    if (!seller.autoEmailInvoices) return none("automatic invoice emails are off");
    const already = await prisma.salesEvent.findFirst({ where: { entityType: "invoice", entityId: invoiceId, action: "emailed", note: { startsWith: key } }, select: { id: true } });
    if (already) return none("already emailed for this payment");
  }

  const { to, cc, seller } = await invoiceRecipients(inv);
  if (!to.length && !cc.length) return none("no email address on the client or the company");
  const payment = opts.paymentId ? inv.allocations.find((a) => a.paymentId === opts.paymentId) : undefined;
  const company = (str((inv.sellerSnapshot as Snapshot)?.legalName) ?? SALES_COMPANIES[inv.companyKey as CompanyKey]?.name ?? seller.legalName) as string;
  const docLabel = inv.kind === "proforma" ? "Proforma invoice" : "Tax invoice";
  const number = inv.number ?? "invoice";
  const paidInFull = inv.balancePaise === 0;
  const subject = payment
    ? `${docLabel} ${number} — payment of ${rs(payment.amountPaise + payment.tdsPaise)} received${paidInFull ? " (paid in full)" : ""}`
    : `${docLabel} ${number} from ${company}`;
  const buyerName = str((inv.buyerSnapshot as Snapshot)?.contactName) ?? str(inv.client?.contactName) ?? "there";
  const portal = (process.env.CLIENT_APP_URL || "https://client.digitalsukoon.com").replace(/\/+$/, "");
  const rows: Array<[string, string]> = [
    [docLabel, number],
    ["Issue date", inv.issueDate ?? "—"],
    ["Invoice total", rs(inv.totalPaise)],
    ...(payment ? ([["Payment received", `${rs(payment.amountPaise + payment.tdsPaise)}${payment.payment.number ? ` · receipt ${payment.payment.number}` : ""}`]] as Array<[string, string]>) : []),
    ["Balance due", paidInFull ? "Nil — paid in full" : rs(inv.balancePaise)],
  ];
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;margin:0;padding:24px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden">
<div style="background:#111;color:#fff;padding:20px 28px;font-size:18px;font-weight:600">${esc(company)}</div>
<div style="padding:24px 28px;font-size:14px;color:#222;line-height:1.5">
<p>Hello ${esc(buyerName)},</p>
<p>${payment ? `Thank you — we have received your payment. Your ${docLabel.toLowerCase()} is attached as a PDF.` : `Your ${docLabel.toLowerCase()} is attached as a PDF.`}</p>
<table style="width:100%;border-collapse:collapse;margin:12px 0">${rows.map(([k, v]) => `<tr><td style="padding:8px 10px;border-bottom:1px solid #eee;color:#555;width:160px">${esc(k)}</td><td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:600">${esc(v)}</td></tr>`).join("")}</table>
<p>You can also download all your invoices any time from <a href="${esc(portal)}/invoices">your client portal</a>.</p>
<p style="color:#777;font-size:12px">Questions about this invoice? Just reply to this email.</p>
</div></div></body></html>`;

  const pdf = await renderInvoicePdf(inv);
  const filename = `${number.replace(/[^\w.-]+/g, "-")}.pdf`;
  const replyTo = cc[0] ?? undefined;
  const result = await sendEmail({
    to: (to.length ? to : cc).join(", "),
    cc: to.length && cc.length ? cc.join(", ") : undefined,
    subject,
    html,
    replyTo,
    fromName: company,
    attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
  });
  if (result) await prisma.salesInvoice.updateMany({ where: { id: invoiceId, sentAt: null }, data: { sentAt: new Date() } });
  const recipients = `${[...to, ...cc].join(", ")}`;
  await logSalesEvent(prisma, {
    entityType: "invoice",
    entityId: invoiceId,
    actorId: opts.actorId ?? null,
    action: result ? "emailed" : "email_failed",
    note: `${key ?? "manual"} → ${recipients}`.slice(0, 500),
  });
  return { sent: !!result, to, cc, skipped: result ? undefined : "the email could not be sent (SMTP)" };
}
