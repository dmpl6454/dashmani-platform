import { z } from "zod";
import { safeString, normalizedEmail, isHttpUrl, HTTP_URL_MESSAGE } from "../utils/sanitize";
import { DEFAULT_GST_RATE_BP, DEFAULT_SAC, GST_STATE_CODES, TAX_MODES } from "../sales/gst";
import { COMPANY_KEYS } from "../sales/companies";

// sales.digitalsukoon.com — shared by the API (input validation) and the portal (forms).
// Import BY PATH from the frontend ("@dashmani/shared/src/validators/sales"), never via the barrel.

/** A real calendar day: "2026-13-45" used to reach the database as an Invalid Date (a 500) and "2026-02-31" became 3 March. */
const isRealDay = (s: string) => {
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine(isRealDay, "That date does not exist");

/**
 * A GSTIN's first two digits ARE its state code, and the state code decides CGST+SGST versus
 * IGST. So the two must agree (a 29… GSTIN saved with state 27 billed the wrong tax), and a
 * GSTIN without a state code fills it in.
 */
function checkGstinState(v: { gstin?: string | null; stateCode?: string | null }, ctx: z.RefinementCtx) {
  const fromGstin = v.gstin?.slice(0, 2);
  if (fromGstin && v.stateCode && fromGstin !== v.stateCode) {
    const name = GST_STATE_CODES[fromGstin] ? ` (${GST_STATE_CODES[fromGstin]})` : "";
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stateCode"], message: `The GSTIN is registered in state ${fromGstin}${name}, but the state code says ${v.stateCode} — they must match` });
  }
}
function fillStateFromGstin<T extends { gstin?: string | null; stateCode?: string | null; state?: string | null }>(v: T): T {
  if (!v.gstin || v.stateCode) return v;
  const code = v.gstin.slice(0, 2);
  return { ...v, stateCode: code, state: v.state || GST_STATE_CODES[code] || null };
}
/** The money columns are Postgres INT: ₹2,14,74,836.47 is the most one field can hold. */
export const MAX_PAISE = 2_147_483_647;
const paise = z.number().int().min(0).max(MAX_PAISE, "That amount is too large for one document");
/** Invoice and credit-note prefixes: GST numbers may use only letters, digits, "-" and "/", 16
 * characters at most — PREFIX/26-27/0001 is the prefix + 11, so the prefix gets 5. */
const gstPrefix = (fallback: string) =>
  z.string().trim().regex(/^[A-Za-z0-9-]{1,5}$/, "Use 1–5 letters, digits or hyphens (GST numbers allow 16 characters)").default(fallback);
const optionalText = (max: number) => safeString.pipe(z.string().max(max)).optional().nullable();
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const upper = (s: string) => s.trim().toUpperCase();

export const gstinSchema = z.string().trim().transform(upper).pipe(z.string().regex(GSTIN_RE, "That is not a valid GSTIN (15 characters, e.g. 27AAACD1234E1Z5)"));
export const panSchema = z.string().trim().transform(upper).pipe(z.string().regex(PAN_RE, "That is not a valid PAN (e.g. AAACD1234E)"));
export const stateCodeSchema = z.string().trim().regex(/^\d{2}$/, "GST state code is two digits (27 = Maharashtra)");

export const TAX_MODE_VALUES = TAX_MODES as readonly ["intra", "inter", "none"];
export const SALES_CAMPAIGN_TYPES = ["brand", "entertainment"] as const;
export const LINE_KINDS = ["placement", "custom"] as const;
export const INVOICE_KINDS = ["tax_invoice", "proforma"] as const;
export const PAYMENT_MODES = ["bank_transfer", "upi", "cheque", "cash", "razorpay", "other"] as const;
export const PAYMENT_MODE_LABELS: Record<(typeof PAYMENT_MODES)[number], string> = {
  bank_transfer: "Bank transfer", upi: "UPI", cheque: "Cheque", cash: "Cash", razorpay: "Razorpay", other: "Other",
};
export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined", "expired", "converted"] as const;
export const ORDER_STATUSES = ["draft", "confirmed", "in_progress", "delivered", "closed", "cancelled"] as const;
export const ORDER_ITEM_STATUSES = ["pending", "scheduled", "delivered", "cancelled"] as const;
export const INVOICE_STATUSES = ["draft", "issued", "paid", "cancelled"] as const;

/** An additional GST registration of the same company in another state (its own GSTIN, address and number series). */
export const sellerBranchSchema = z.object({
  label: safeString.pipe(z.string().min(2).max(60)),
  gstin: gstinSchema,
  stateCode: stateCodeSchema.optional().nullable(),
  state: optionalText(60),
  addressLine1: safeString.pipe(z.string().min(3).max(200)),
  addressLine2: optionalText(200),
  city: safeString.pipe(z.string().min(2).max(100)),
  pincode: safeString.pipe(z.string().min(6).max(10)),
  invoicePrefix: gstPrefix("DSH"),
  creditNotePrefix: gstPrefix("CNH"),
}).superRefine(checkGstinState).transform(fillStateFromGstin);

/** Our own GST identity and document defaults (system_settings key "sales.seller"). */
export const sellerProfileSchema = z.object({
  legalName: safeString.pipe(z.string().min(2).max(200)),
  tradeName: optionalText(200),
  gstin: gstinSchema.optional().nullable(),
  pan: panSchema.optional().nullable(),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  state: optionalText(60),
  stateCode: stateCodeSchema.optional().nullable(),
  pincode: optionalText(10),
  email: normalizedEmail.optional().nullable(),
  /** Further billing addresses printed beside `email` (e.g. finance@ next to accounts@). */
  billingEmails: z.array(normalizedEmail).max(4).default([]),
  phone: optionalText(30),
  website: optionalText(200),
  bankName: optionalText(120),
  accountName: optionalText(200),
  accountNumber: optionalText(40),
  ifsc: z.string().trim().transform(upper).pipe(z.string().regex(IFSC_RE, "That is not a valid IFSC")).optional().nullable(),
  upiId: optionalText(80),
  invoicePrefix: gstPrefix("DS"),
  quotePrefix: safeString.pipe(z.string().min(1).max(10)).default("Q"),
  orderPrefix: safeString.pipe(z.string().min(1).max(10)).default("SO"),
  creditNotePrefix: gstPrefix("CN"),
  receiptPrefix: safeString.pipe(z.string().min(1).max(10)).default("RCPT"),
  defaultSac: z.string().trim().regex(/^\d{4,8}$/).default(DEFAULT_SAC),
  defaultGstRateBp: z.number().int().min(0).max(4000).default(DEFAULT_GST_RATE_BP),
  defaultDueDays: z.number().int().min(0).max(180).default(15),
  roundToRupee: z.boolean().default(true),
  /** Email the invoice PDF to the client (and this company's billing addresses) whenever a payment is recorded against it. */
  autoEmailInvoices: z.boolean().default(true),
  terms: optionalText(2000),
  signatory: optionalText(120),
  /** Further GST registrations (e.g. a Haryana GSTIN beside the principal Maharashtra one). */
  branches: z.array(sellerBranchSchema).max(10).default([]),
  /**
   * E-invoicing (IRN) on the government IRP. When on, every B2B / SEZ / export tax invoice and its
   * credit notes dated from `applicableFrom` are registered at issue. `thirtyDayLimit`: AATO of
   * ₹10 crore or more — documents older than 30 days can no longer be reported.
   */
  eInvoicing: z.object({
    enabled: z.boolean().default(false),
    applicableFrom: day.optional().nullable(),
    thirtyDayLimit: z.boolean().default(false),
  }).default({}),
}).superRefine(checkGstinState).superRefine((v, ctx) => {
  // Each registration bills its own state and numbers its own series; numbers are unique
  // platform-wide, so prefixes may not repeat either.
  const states = [v.stateCode ?? v.gstin?.slice(0, 2), ...v.branches.map((b) => b.stateCode)].filter(Boolean);
  if (new Set(states).size !== states.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["branches"], message: "Each GST registration must be in a different state" });
  const gstins = [v.gstin, ...v.branches.map((b) => b.gstin)].filter(Boolean);
  if (new Set(gstins).size !== gstins.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["branches"], message: "The same GSTIN is listed twice" });
  const prefixes = [v.invoicePrefix, v.creditNotePrefix, ...v.branches.flatMap((b) => [b.invoicePrefix, b.creditNotePrefix]), "PI"].map((p) => p.toUpperCase());
  if (new Set(prefixes).size !== prefixes.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["branches"], message: "Every registration needs its own invoice and credit-note prefixes (and PI is taken by proformas)" });
}).transform(fillStateFromGstin);
export type SellerProfileInput = z.infer<typeof sellerProfileSchema>;

export const clientBillingProfileSchema = z.object({
  legalName: safeString.pipe(z.string().min(2).max(200)),
  gstin: gstinSchema.optional().nullable(),
  pan: panSchema.optional().nullable(),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  state: optionalText(60),
  stateCode: stateCodeSchema.optional().nullable(),
  pincode: optionalText(10),
  country: z.string().trim().length(2).transform(upper).default("IN"),
  billingEmail: normalizedEmail.optional().nullable(),
  billingPhone: optionalText(30),
  notes: optionalText(2000),
}).superRefine(checkGstinState).transform(fillStateFromGstin);
export type ClientBillingProfileInput = z.infer<typeof clientBillingProfileSchema>;

/** A client created by sales (no portal login needed; the account gets an unusable password). */
export const salesClientCreateSchema = z.object({
  companyName: safeString.pipe(z.string().min(2).max(200)),
  contactName: safeString.pipe(z.string().min(2).max(120)),
  email: normalizedEmail,
  phone: optionalText(30),
});

export const lineItemSchema = z.object({
  kind: z.enum(LINE_KINDS).default("placement"),
  targetType: z.enum(["meta_asset", "social_account"]).optional().nullable(),
  targetId: z.string().uuid().optional().nullable(),
  platform: optionalText(16),
  format: optionalText(24),
  description: safeString.pipe(z.string().min(1).max(300)),
  accountName: optionalText(200),
  accountHandle: optionalText(100),
  quantity: z.number().int().min(1).max(10_000).default(1),
  unitPricePaise: paise,
  discountPaise: paise.default(0),
  sac: z.string().trim().regex(/^\d{4,8}$/).optional().nullable(),
  scheduledOn: day.optional().nullable(),
  rateCardId: z.string().uuid().optional().nullable(),
});
export type LineItemInput = z.infer<typeof lineItemSchema>;

/** Which of our companies bills the document (fixed once the document exists). */
export const companyKeySchema = z.enum(COMPANY_KEYS).default("dspl");

const documentBase = {
  companyKey: companyKeySchema,
  clientId: z.string().uuid(),
  title: safeString.pipe(z.string().min(2).max(200)),
  campaignType: z.enum(SALES_CAMPAIGN_TYPES).default("brand"),
  placeOfSupplyCode: stateCodeSchema.optional().nullable(),
  taxMode: z.enum(TAX_MODE_VALUES).optional(),
  gstRateBp: z.number().int().min(0).max(4000).optional(),
  discountPaise: paise.default(0),
  notes: optionalText(4000),
  internalNotes: optionalText(4000),
  items: z.array(lineItemSchema).min(1).max(200),
};

export const quoteUpsertSchema = z.object({ ...documentBase, validUntil: day.optional().nullable() });
export type QuoteUpsertInput = z.infer<typeof quoteUpsertSchema>;

export const orderUpsertSchema = z.object({
  ...documentBase,
  poNumber: optionalText(60),
  startDate: day.optional().nullable(),
  endDate: day.optional().nullable(),
  campaignBookingId: z.string().uuid().optional().nullable(),
});
export type OrderUpsertInput = z.infer<typeof orderUpsertSchema>;

export const orderItemStatusSchema = z.object({
  status: z.enum(ORDER_ITEM_STATUSES),
  permalink: z.string().trim().url().max(500).refine(isHttpUrl, HTTP_URL_MESSAGE).optional().nullable(),
  deliveredOn: day.optional().nullable(),
});

export const invoiceLineSchema = z.object({
  description: safeString.pipe(z.string().min(1).max(300)),
  sac: z.string().trim().regex(/^\d{4,8}$/).optional().nullable(),
  quantity: z.number().int().min(1).max(10_000).default(1),
  unitPricePaise: paise,
  discountPaise: paise.default(0),
  orderItemId: z.string().uuid().optional().nullable(),
});

export const invoiceUpsertSchema = z.object({
  companyKey: companyKeySchema,
  clientId: z.string().uuid(),
  kind: z.enum(INVOICE_KINDS).default("tax_invoice"),
  orderId: z.string().uuid().optional().nullable(),
  campaignBookingId: z.string().uuid().optional().nullable(),
  issueDate: day.optional().nullable(),
  dueDate: day.optional().nullable(),
  placeOfSupplyCode: stateCodeSchema.optional().nullable(),
  taxMode: z.enum(TAX_MODE_VALUES).optional(),
  gstRateBp: z.number().int().min(0).max(4000).optional(),
  discountPaise: paise.default(0),
  notes: optionalText(4000),
  terms: optionalText(4000),
  internalNotes: optionalText(4000),
  items: z.array(invoiceLineSchema).min(1).max(200),
});
export type InvoiceUpsertInput = z.infer<typeof invoiceUpsertSchema>;

export const invoiceIssueSchema = z.object({
  issueDate: day.optional(),
  dueDate: day.optional().nullable(),
  /** When the GST type the draft was saved with no longer matches the seller and buyer: update it, or keep it on purpose. */
  taxResolution: z.enum(["recompute", "keep"]).optional(),
});

export const invoiceCancelSchema = z.object({ reason: safeString.pipe(z.string().min(3).max(300)) });

export const paymentCreateSchema = z
  .object({
    companyKey: companyKeySchema,
    clientId: z.string().uuid(),
    amountPaise: paise,
    tdsPaise: paise.default(0),
    mode: z.enum(PAYMENT_MODES),
    reference: optionalText(120),
    paidOn: day,
    bankName: optionalText(120),
    notes: optionalText(2000),
    allocations: z
      .array(z.object({ invoiceId: z.string().uuid(), amountPaise: paise.default(0), tdsPaise: paise.default(0) }))
      .max(50)
      .default([]),
  })
  .refine((p) => p.amountPaise + p.tdsPaise > 0, { message: "Enter an amount received or TDS withheld", path: ["amountPaise"] })
  .refine((p) => p.allocations.reduce((s, a) => s + a.amountPaise, 0) <= p.amountPaise, { message: "Allocated more than was received", path: ["allocations"] })
  .refine((p) => p.allocations.reduce((s, a) => s + a.tdsPaise, 0) <= p.tdsPaise, { message: "Allocated more TDS than was withheld", path: ["allocations"] })
  .refine((p) => new Set(p.allocations.map((a) => a.invoiceId)).size === p.allocations.length, { message: "List each invoice once in a payment", path: ["allocations"] });
export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>;

/** Apply the unallocated part of a recorded receipt (an advance) to invoices later. */
export const paymentAllocateSchema = z
  .object({
    allocations: z.array(z.object({ invoiceId: z.string().uuid(), amountPaise: paise.default(0), tdsPaise: paise.default(0) })).min(1).max(50),
  })
  .refine((p) => new Set(p.allocations.map((a) => a.invoiceId)).size === p.allocations.length, { message: "List each invoice once", path: ["allocations"] });
export type PaymentAllocateInput = z.infer<typeof paymentAllocateSchema>;

/** Void a receipt recorded by mistake (a bounced cheque, a wrong amount): it keeps its number; its allocations stop counting. */
export const paymentVoidSchema = z.object({ reason: safeString.pipe(z.string().min(3).max(300)) });

/** Money paid back to the client out of a receipt's unallocated cash. */
export const refundCreateSchema = z.object({
  amountPaise: paise.refine((v) => v > 0, "Enter the amount refunded"),
  mode: z.enum(PAYMENT_MODES),
  reference: optionalText(120),
  refundedOn: day,
  notes: optionalText(2000),
});
export type RefundCreateInput = z.infer<typeof refundCreateSchema>;

export const creditNoteCreateSchema = z.object({
  invoiceId: z.string().uuid(),
  reason: safeString.pipe(z.string().min(3).max(300)),
  taxablePaise: z.number().int().min(1).max(MAX_PAISE),
  issueDate: day.optional(),
});
export type CreditNoteCreateInput = z.infer<typeof creditNoteCreateSchema>;
