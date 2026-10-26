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
} from "@dashmani/shared";
import { authenticate } from "../middleware/auth";
import { requireInternalUser } from "../middleware/require-internal-user";
import { requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/error-handler";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import { listSalesEvents, type SalesEntity } from "../services/sales/common";
import { getSellerProfile, saveSellerProfile, sellerMissingFields, SELLER_FALLBACK } from "../services/sales/settings.service";
import { listInventory } from "../services/sales/inventory.service";
import { createSalesClient, getClientStatement, getSalesClient, listSalesClients, upsertClientBilling } from "../services/sales/clients.service";
import * as docs from "../services/sales/documents.service";
import * as invoices from "../services/sales/invoices.service";
import * as payments from "../services/sales/payments.service";
import { getSalesDashboard } from "../services/sales/dashboard.service";
import { retryEInvoice } from "../services/sales/einvoice.service";
import { renderCreditNotePdf, renderInvoicePdf } from "../services/sales/pdf.service";

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

// ── Dashboard, settings, inventory ─────────────────────────────────────────────

router.get("/sales/dashboard", ...view, asyncHandler(async (_req, res) => success(res, await getSalesDashboard())));

router.get("/sales/settings/seller", ...view, asyncHandler(async (_req, res) => {
  const profile = await getSellerProfile();
  return success(res, { profile: profile ?? SELLER_FALLBACK, saved: !!profile, missing: sellerMissingFields(profile) });
}));

router.put("/sales/settings/seller", ...admin, validate(sellerProfileSchema), asyncHandler(async (req, res) => {
  const profile = await saveSellerProfile(req.body, staffId(req));
  return success(res, { profile, saved: true, missing: sellerMissingFields(profile) });
}));

router.get("/sales/inventory", ...view, asyncHandler(async (_req, res) => success(res, await listInventory())));

// ── Clients ─────────────────────────────────────────────────────────────────────

router.get("/sales/clients", ...view, asyncHandler(async (req, res) => success(res, await listSalesClients(str(req.query.q)))));
router.post("/sales/clients", ...manage, validate(salesClientCreateSchema), asyncHandler(async (req, res) => success(res, await createSalesClient(req.body, staffId(req)), undefined, 201)));
router.get("/sales/clients/:id", ...view, asyncHandler(async (req, res) => success(res, await getSalesClient(req.params.id))));
router.put("/sales/clients/:id/billing", ...manage, validate(clientBillingProfileSchema), asyncHandler(async (req, res) => success(res, await upsertClientBilling(req.params.id, req.body, staffId(req)))));
router.get("/sales/clients/:id/statement", ...view, asyncHandler(async (req, res) => success(res, await getClientStatement(req.params.id))));

// ── Quotes ──────────────────────────────────────────────────────────────────────

router.get("/sales/quotes", ...view, asyncHandler(async (req, res) => success(res, await docs.listQuotes({ status: str(req.query.status), clientId: str(req.query.clientId), q: str(req.query.q) }))));
router.post("/sales/quotes", ...manage, validate(quoteUpsertSchema), asyncHandler(async (req, res) => success(res, await docs.createQuote(req.body, staffId(req)), undefined, 201)));
router.get("/sales/quotes/:id", ...view, asyncHandler(async (req, res) => success(res, await docs.getQuote(req.params.id))));
router.put("/sales/quotes/:id", ...manage, validate(quoteUpsertSchema), asyncHandler(async (req, res) => success(res, await docs.updateQuote(req.params.id, req.body, staffId(req)))));
router.delete("/sales/quotes/:id", ...manage, asyncHandler(async (req, res) => { await docs.deleteQuote(req.params.id); return success(res, { deleted: true }); }));
for (const action of ["send", "accept", "decline", "reopen"] as const) {
  router.post(`/sales/quotes/:id/${action}`, ...manage, asyncHandler(async (req, res) => success(res, await docs.transitionQuote(req.params.id, action, staffId(req)))));
}
router.post("/sales/quotes/:id/convert", ...manage, asyncHandler(async (req, res) => success(res, await docs.convertQuote(req.params.id, staffId(req)), undefined, 201)));

// ── Orders ──────────────────────────────────────────────────────────────────────

router.get("/sales/orders", ...view, asyncHandler(async (req, res) => success(res, await docs.listOrders({ status: str(req.query.status), clientId: str(req.query.clientId), q: str(req.query.q) }))));
router.post("/sales/orders", ...manage, validate(orderUpsertSchema), asyncHandler(async (req, res) => success(res, await docs.createOrder(req.body, staffId(req)), undefined, 201)));
router.get("/sales/orders/:id", ...view, asyncHandler(async (req, res) => success(res, await docs.getOrder(req.params.id))));
router.put("/sales/orders/:id", ...manage, validate(orderUpsertSchema), asyncHandler(async (req, res) => success(res, await docs.updateOrder(req.params.id, req.body, staffId(req)))));
for (const action of ["confirm", "start", "deliver", "close", "cancel"] as const) {
  router.post(`/sales/orders/:id/${action}`, ...manage, asyncHandler(async (req, res) => success(res, await docs.transitionOrder(req.params.id, action, staffId(req), str(req.body?.note)))));
}
router.patch("/sales/orders/:id/items/:itemId", ...manage, validate(orderItemStatusSchema), asyncHandler(async (req, res) => success(res, await docs.updateOrderItem(req.params.id, req.params.itemId, req.body, staffId(req)))));
router.post("/sales/orders/:id/invoice", ...manage, asyncHandler(async (req, res) => success(res, await invoices.createInvoiceFromOrder(req.params.id, staffId(req)), undefined, 201)));

// ── Invoices ────────────────────────────────────────────────────────────────────

router.get("/sales/invoices", ...view, asyncHandler(async (req, res) => success(res, await invoices.listInvoices({ status: str(req.query.status), clientId: str(req.query.clientId), q: str(req.query.q) }))));
router.post("/sales/invoices", ...manage, validate(invoiceUpsertSchema), asyncHandler(async (req, res) => success(res, await invoices.createInvoice(req.body, staffId(req)), undefined, 201)));
router.post("/sales/invoices/from-booking/:bookingId", ...manage, asyncHandler(async (req, res) => success(res, await invoices.createInvoiceFromBooking(req.params.bookingId, staffId(req)), undefined, 201)));
router.get("/sales/invoices/:id", ...view, asyncHandler(async (req, res) => success(res, await invoices.getInvoice(req.params.id))));
router.put("/sales/invoices/:id", ...manage, validate(invoiceUpsertSchema), asyncHandler(async (req, res) => success(res, await invoices.updateInvoice(req.params.id, req.body, staffId(req)))));
router.post("/sales/invoices/:id/issue", ...manage, validate(invoiceIssueSchema), asyncHandler(async (req, res) => success(res, await invoices.issueInvoice(req.params.id, req.body, staffId(req)))));
router.post("/sales/invoices/:id/cancel", ...manage, validate(invoiceCancelSchema), asyncHandler(async (req, res) => success(res, await invoices.cancelInvoice(req.params.id, req.body.reason, staffId(req)))));
// An issued proforma → a draft tax invoice with the same lines; issuing it moves the proforma's payments across.
router.post("/sales/invoices/:id/convert", ...manage, asyncHandler(async (req, res) => success(res, await invoices.convertProforma(req.params.id, staffId(req)), undefined, 201)));
// E-invoice: register again after a failure (asks the IRP first, so it can never double-register).
router.post("/sales/invoices/:id/einvoice", ...manage, asyncHandler(async (req, res) => { await retryEInvoice({ invoiceId: req.params.id }, staffId(req)); return success(res, await invoices.getInvoice(req.params.id)); }));
router.post("/sales/credit-notes/:id/einvoice", ...manage, asyncHandler(async (req, res) => success(res, await retryEInvoice({ creditNoteId: req.params.id }, staffId(req)))));
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

router.get("/sales/payments", ...view, asyncHandler(async (req, res) => success(res, await payments.listPayments({ clientId: str(req.query.clientId), q: str(req.query.q), from: str(req.query.from), to: str(req.query.to) }))));
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
