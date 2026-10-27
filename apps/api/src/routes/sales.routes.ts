import { Router, Request } from "express";
import {
  clientBillingProfileSchema,
  creditNoteCreateSchema,
  invoiceCancelSchema,
  invoiceIssueSchema,
  invoiceUpsertSchema,
  orderItemStatusSchema,
  orderUpsertSchema,
  paymentAllocateSchema,
  paymentCreateSchema,
  paymentVoidSchema,
  refundCreateSchema,
  quoteUpsertSchema,
  salesClientCreateSchema,
  sellerProfileSchema,
  DEFAULT_COMPANY,
  isCompanyKey,
  type CompanyKey,
  clientValidators,
} from "@dashmani/shared";
import { authenticate } from "../middleware/auth";
import { requireInternalUser } from "../middleware/require-internal-user";
import { requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/error-handler";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import { listSalesEvents, type SalesEntity } from "../services/sales/common";
import { getSellerProfile, saveSellerProfile, sellerFallback, sellerMissingFields } from "../services/sales/settings.service";
import { listInventory } from "../services/sales/inventory.service";
import {
  createSalesClient, getClientStatement, getSalesClient, inviteClientLogin, listClientLogins, listSalesClients,
  removeClientLogin, resendClientLogin, setClientLoginEnabled, upsertClientBilling,
} from "../services/sales/clients.service";
import * as docs from "../services/sales/documents.service";
import * as invoices from "../services/sales/invoices.service";
import * as payments from "../services/sales/payments.service";
import { getSalesDashboard } from "../services/sales/dashboard.service";
import { getBooking, listBookings } from "../services/sales/bookings.service";
import { retryEInvoice } from "../services/sales/einvoice.service";
import { renderCreditNotePdf, renderInvoicePdf } from "../services/sales/pdf.service";
import { emailInvoice } from "../services/sales/invoice-email.service";

// sales.digitalsukoon.com — staff only. `sales.view` reads; `sales.manage` writes (the Sales
// role and both admin roles hold both, see packages/db/prisma/seed.ts). Every money action is
// logged to sales_events by the service it lives in.

const router = Router();
const view = [authenticate, requireInternalUser, requirePermission("sales", "view")];
const manage = [authenticate, requireInternalUser, requirePermission("sales", "manage")];
// The company's own GST identity and BANK DETAILS print on every invoice; a changed account number
// is how invoice fraud starts. Only Admin / Super Admin (who hold sales:approve) may change them.
const admin = [authenticate, requireInternalUser, requirePermission("sales", "approve")];
const staffId = (req: Request) => req.user!.userId;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** ?company=dspl|dmpl. Lists without it show both companies; settings and the dashboard default to Digital Sukoon. */
const companyQuery = (req: Request): CompanyKey | undefined => {
  const v = str(req.query.company);
  if (v === undefined) return undefined;
  if (!isCompanyKey(v)) throw new AppError(400, "BAD_COMPANY", "Unknown company");
  return v;
};
const companyOf = (req: Request): CompanyKey => companyQuery(req) ?? DEFAULT_COMPANY;

// ── Dashboard, settings, inventory ─────────────────────────────────────────────

router.get("/sales/dashboard", ...view, asyncHandler(async (req, res) => success(res, await getSalesDashboard(companyOf(req)))));

router.get("/sales/settings/seller", ...view, asyncHandler(async (req, res) => {
  const company = companyOf(req);
  const profile = await getSellerProfile(company);
  return success(res, { company, profile: profile ?? sellerFallback(company), saved: !!profile, missing: sellerMissingFields(profile) });
}));

router.put("/sales/settings/seller", ...admin, validate(sellerProfileSchema), asyncHandler(async (req, res) => {
  const company = companyOf(req);
  const profile = await saveSellerProfile(req.body, staffId(req), company);
  return success(res, { company, profile, saved: true, missing: sellerMissingFields(profile) });
}));

router.get("/sales/inventory", ...view, asyncHandler(async (_req, res) => success(res, await listInventory())));

// ── Clients ─────────────────────────────────────────────────────────────────────

router.get("/sales/clients", ...view, asyncHandler(async (req, res) => success(res, await listSalesClients(str(req.query.q)))));
router.post("/sales/clients", ...manage, validate(salesClientCreateSchema), asyncHandler(async (req, res) => success(res, await createSalesClient(req.body, staffId(req)), undefined, 201)));
router.get("/sales/clients/:id", ...view, asyncHandler(async (req, res) => success(res, await getSalesClient(req.params.id))));
router.put("/sales/clients/:id/billing", ...manage, validate(clientBillingProfileSchema), asyncHandler(async (req, res) => success(res, await upsertClientBilling(req.params.id, req.body, staffId(req)))));
// Portal logins: further people who sign in to the client portal as this company.
router.get("/sales/clients/:id/logins", ...view, asyncHandler(async (req, res) => success(res, await listClientLogins(req.params.id))));
router.post("/sales/clients/:id/logins", ...manage, validate(clientValidators.clientTeamInviteSchema), asyncHandler(async (req, res) => success(res, await inviteClientLogin(req.params.id, req.body, staffId(req)), undefined, 201)));
router.post("/sales/clients/:id/logins/:memberId/resend", ...manage, asyncHandler(async (req, res) => success(res, await resendClientLogin(req.params.id, req.params.memberId, staffId(req)))));
router.post("/sales/clients/:id/logins/:memberId/disable", ...manage, asyncHandler(async (req, res) => success(res, await setClientLoginEnabled(req.params.id, req.params.memberId, false, staffId(req)))));
router.post("/sales/clients/:id/logins/:memberId/enable", ...manage, asyncHandler(async (req, res) => success(res, await setClientLoginEnabled(req.params.id, req.params.memberId, true, staffId(req)))));
router.delete("/sales/clients/:id/logins/:memberId", ...manage, asyncHandler(async (req, res) => success(res, await removeClientLogin(req.params.id, req.params.memberId, staffId(req)))));
router.get("/sales/clients/:id/statement", ...view, asyncHandler(async (req, res) => success(res, await getClientStatement(req.params.id, companyQuery(req)))));

// ── Campaign bookings (client self-serve, reviewed in the staff portal) — read-only here ──

router.get("/sales/bookings", ...view, asyncHandler(async (req, res) => success(res, await listBookings({ stage: str(req.query.stage), q: str(req.query.q), clientId: str(req.query.clientId) }))));
router.get("/sales/bookings/:id", ...view, asyncHandler(async (req, res) => success(res, await getBooking(req.params.id))));

// ── Quotes ──────────────────────────────────────────────────────────────────────

router.get("/sales/quotes", ...view, asyncHandler(async (req, res) => success(res, await docs.listQuotes({ status: str(req.query.status), clientId: str(req.query.clientId), q: str(req.query.q), companyKey: companyQuery(req) }))));
router.post("/sales/quotes", ...manage, validate(quoteUpsertSchema), asyncHandler(async (req, res) => success(res, await docs.createQuote(req.body, staffId(req)), undefined, 201)));
router.get("/sales/quotes/:id", ...view, asyncHandler(async (req, res) => success(res, await docs.getQuote(req.params.id))));
router.put("/sales/quotes/:id", ...manage, validate(quoteUpsertSchema), asyncHandler(async (req, res) => success(res, await docs.updateQuote(req.params.id, req.body, staffId(req)))));
router.delete("/sales/quotes/:id", ...manage, asyncHandler(async (req, res) => { await docs.deleteQuote(req.params.id); return success(res, { deleted: true }); }));
for (const action of ["send", "accept", "decline", "reopen"] as const) {
  router.post(`/sales/quotes/:id/${action}`, ...manage, asyncHandler(async (req, res) => success(res, await docs.transitionQuote(req.params.id, action, staffId(req)))));
}
router.post("/sales/quotes/:id/convert", ...manage, asyncHandler(async (req, res) => success(res, await docs.convertQuote(req.params.id, staffId(req)), undefined, 201)));

// ── Orders ──────────────────────────────────────────────────────────────────────

router.get("/sales/orders", ...view, asyncHandler(async (req, res) => success(res, await docs.listOrders({ status: str(req.query.status), clientId: str(req.query.clientId), q: str(req.query.q), companyKey: companyQuery(req) }))));
router.post("/sales/orders", ...manage, validate(orderUpsertSchema), asyncHandler(async (req, res) => success(res, await docs.createOrder(req.body, staffId(req)), undefined, 201)));
router.get("/sales/orders/:id", ...view, asyncHandler(async (req, res) => success(res, await docs.getOrder(req.params.id))));
router.put("/sales/orders/:id", ...manage, validate(orderUpsertSchema), asyncHandler(async (req, res) => success(res, await docs.updateOrder(req.params.id, req.body, staffId(req)))));
for (const action of ["confirm", "start", "deliver", "close", "cancel"] as const) {
  router.post(`/sales/orders/:id/${action}`, ...manage, asyncHandler(async (req, res) => success(res, await docs.transitionOrder(req.params.id, action, staffId(req), str(req.body?.note)))));
}
router.patch("/sales/orders/:id/items/:itemId", ...manage, validate(orderItemStatusSchema), asyncHandler(async (req, res) => success(res, await docs.updateOrderItem(req.params.id, req.params.itemId, req.body, staffId(req)))));
router.post("/sales/orders/:id/invoice", ...manage, asyncHandler(async (req, res) => success(res, await invoices.createInvoiceFromOrder(req.params.id, staffId(req)), undefined, 201)));

// ── Invoices ────────────────────────────────────────────────────────────────────

router.get("/sales/invoices", ...view, asyncHandler(async (req, res) => success(res, await invoices.listInvoices({ status: str(req.query.status), clientId: str(req.query.clientId), q: str(req.query.q), companyKey: companyQuery(req) }))));
router.post("/sales/invoices", ...manage, validate(invoiceUpsertSchema), asyncHandler(async (req, res) => success(res, await invoices.createInvoice(req.body, staffId(req)), undefined, 201)));
router.post("/sales/invoices/from-booking/:bookingId", ...manage, asyncHandler(async (req, res) => success(res, await invoices.createInvoiceFromBooking(req.params.bookingId, staffId(req), companyOf(req)), undefined, 201)));
router.get("/sales/invoices/:id", ...view, asyncHandler(async (req, res) => success(res, await invoices.getInvoice(req.params.id))));
router.put("/sales/invoices/:id", ...manage, validate(invoiceUpsertSchema), asyncHandler(async (req, res) => success(res, await invoices.updateInvoice(req.params.id, req.body, staffId(req)))));
router.post("/sales/invoices/:id/issue", ...manage, validate(invoiceIssueSchema), asyncHandler(async (req, res) => success(res, await invoices.issueInvoice(req.params.id, req.body, staffId(req)))));
router.post("/sales/invoices/:id/cancel", ...manage, validate(invoiceCancelSchema), asyncHandler(async (req, res) => success(res, await invoices.cancelInvoice(req.params.id, req.body.reason, staffId(req)))));
// An issued proforma → a draft tax invoice with the same lines; issuing it moves the proforma's payments across.
router.post("/sales/invoices/:id/convert", ...manage, asyncHandler(async (req, res) => success(res, await invoices.convertProforma(req.params.id, staffId(req)), undefined, 201)));
// E-invoice: register again after a failure (asks the IRP first, so it can never double-register).
router.post("/sales/invoices/:id/einvoice", ...manage, asyncHandler(async (req, res) => { await retryEInvoice({ invoiceId: req.params.id }, staffId(req)); return success(res, await invoices.getInvoice(req.params.id)); }));
router.post("/sales/credit-notes/:id/einvoice", ...manage, asyncHandler(async (req, res) => success(res, await retryEInvoice({ creditNoteId: req.params.id }, staffId(req)))));
// Email the invoice PDF to the client (To) and the company's billing addresses (Cc) now.
router.post("/sales/invoices/:id/email", ...manage, asyncHandler(async (req, res) => {
  const r = await emailInvoice(req.params.id, { manual: true, actorId: staffId(req) });
  if (!r.sent) throw new AppError(r.skipped?.startsWith("the email") ? 502 : 409, "EMAIL_NOT_SENT", `Not emailed: ${r.skipped}`);
  return success(res, r);
}));
router.post("/sales/invoices/:id/sent", ...manage, asyncHandler(async (req, res) => success(res, await invoices.markInvoiceSent(req.params.id, staffId(req)))));
router.get("/sales/invoices/:id/pdf", ...view, asyncHandler(async (req, res) => {
  const inv = await invoices.getInvoice(req.params.id);
  const pdf = await renderInvoicePdf(inv);
  const name = `${(inv.number ?? `draft-${inv.id.slice(0, 8)}`).replace(/[^\w.-]+/g, "-")}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${req.query.inline === "1" ? "inline" : "attachment"}; filename="${name}"`);
  res.setHeader("Cache-Control", "no-store");
  return res.send(pdf);
}));

// ── Payments & credit notes ─────────────────────────────────────────────────────

router.get("/sales/payments", ...view, asyncHandler(async (req, res) => success(res, await payments.listPayments({ clientId: str(req.query.clientId), q: str(req.query.q), from: str(req.query.from), to: str(req.query.to), companyKey: companyQuery(req) }))));
router.post("/sales/payments", ...manage, validate(paymentCreateSchema), asyncHandler(async (req, res) => success(res, await payments.createPayment(req.body, staffId(req)), undefined, 201)));
router.post("/sales/payments/:id/allocations", ...manage, validate(paymentAllocateSchema), asyncHandler(async (req, res) => success(res, await payments.allocatePayment(req.params.id, req.body, staffId(req)))));
router.post("/sales/payments/:id/void", ...manage, validate(paymentVoidSchema), asyncHandler(async (req, res) => success(res, await payments.voidPayment(req.params.id, req.body.reason, staffId(req)))));
router.post("/sales/payments/:id/refunds", ...manage, validate(refundCreateSchema), asyncHandler(async (req, res) => success(res, await payments.createRefund(req.params.id, req.body, staffId(req)), undefined, 201)));
router.post("/sales/refunds/:id/cancel", ...manage, asyncHandler(async (req, res) => success(res, await payments.cancelRefund(req.params.id, staffId(req)))));
router.get("/sales/payments/:id", ...view, asyncHandler(async (req, res) => success(res, await payments.getPayment(req.params.id))));
router.get("/sales/credit-notes/:id/pdf", ...view, asyncHandler(async (req, res) => {
  const cn = await payments.getCreditNote(req.params.id);
  const pdf = await renderCreditNotePdf(cn);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${req.query.inline === "1" ? "inline" : "attachment"}; filename="${cn.number.replace(/[^\w.-]+/g, "-")}.pdf"`);
  res.setHeader("Cache-Control", "no-store");
  return res.send(pdf);
}));
router.get("/sales/credit-notes", ...view, asyncHandler(async (req, res) => success(res, await payments.listCreditNotes({ invoiceId: str(req.query.invoiceId), clientId: str(req.query.clientId) }))));
router.post("/sales/credit-notes", ...manage, validate(creditNoteCreateSchema), asyncHandler(async (req, res) => success(res, await payments.createCreditNote(req.body, staffId(req)), undefined, 201)));
router.post("/sales/credit-notes/:id/cancel", ...manage, asyncHandler(async (req, res) => { await payments.cancelCreditNote(req.params.id, staffId(req)); return success(res, { cancelled: true }); }));

// ── Audit trail ─────────────────────────────────────────────────────────────────

const ENTITY_TYPES: SalesEntity[] = ["quote", "order", "invoice", "payment", "credit_note", "settings", "client"];
router.get("/sales/events", ...view, asyncHandler(async (req, res) => {
  const entityType = str(req.query.entityType) as SalesEntity | undefined;
  const entityId = str(req.query.entityId);
  if (!entityType || !ENTITY_TYPES.includes(entityType) || !entityId) throw new AppError(400, "BAD_QUERY", "entityType and entityId are required");
  return success(res, await listSalesEvents(entityType, entityId));
}));

export default router;
