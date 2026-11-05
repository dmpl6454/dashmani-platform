import { z } from "zod";
import { safeString, normalizedEmail, isHttpUrl, HTTP_URL_MESSAGE } from "../utils/sanitize";
import { DEFAULT_GST_RATE_BP, DEFAULT_SAC, GST_STATE_CODES, TAX_MODES } from "../sales/gst";
import { COMPANY_KEYS } from "../sales/companies";
import { FILED_FIGURE_KEYS } from "../sales/accounts";

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
/** How many digits an invoice serial is padded to: INV/26-27/059 is 3, DS/26-27/0001 is 4. */
const serialDigits = z.number().int().min(3, "At least 3 digits").max(6, "At most 6 digits").default(4);
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
  serialDigits: serialDigits,
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
  serialDigits: serialDigits,
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
  // Registrations may share an invoice prefix (INV/26-27/0014 in Mumbai, INV/26-27/059 in
  // Gurugram) only when their serials differ in length, so the two series can never print the
  // same number. Credit-note prefixes and PI stay unique and apart from every invoice prefix.
  const invoiceSeries = [{ p: v.invoicePrefix, d: v.serialDigits }, ...v.branches.map((b) => ({ p: b.invoicePrefix, d: b.serialDigits }))].map((x) => `${x.p.toUpperCase()}#${x.d}`);
  if (new Set(invoiceSeries).size !== invoiceSeries.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["branches"], message: "Two registrations use the same invoice prefix with the same number of digits — give one a different prefix or digit count, so their invoice numbers can never repeat" });
  const invoicePrefixes = new Set([v.invoicePrefix, ...v.branches.map((b) => b.invoicePrefix)].map((p) => p.toUpperCase()));
  const others = [v.creditNotePrefix, ...v.branches.map((b) => b.creditNotePrefix), "PI"].map((p) => p.toUpperCase());
  if (new Set(others).size !== others.length || others.some((p) => invoicePrefixes.has(p))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["branches"], message: "Every registration needs its own credit-note prefix, different from the invoice prefixes (and PI is taken by proformas)" });
}).transform(fillStateFromGstin);
export type SellerProfileInput = z.infer<typeof sellerProfileSchema>;

/** A TDS deductor's TAN (Form 26AS): 4 letters, 5 digits, a letter. Reconcile (PR 5) reads it. */
export const tanSchema = z.string().trim().transform(upper)
  .pipe(z.string().regex(/^[A-Z]{4}\d{5}[A-Z]$/, "A TAN is 4 letters, 5 digits and a letter, like MUMF12345A"));

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
  tan: tanSchema.optional().nullable(),
}).superRefine(checkGstinState).transform(fillStateFromGstin);
export type ClientBillingProfileInput = z.infer<typeof clientBillingProfileSchema>;

/** A client created by sales (no portal login needed; the account gets an unusable password). */
export const salesClientCreateSchema = z.object({
  companyName: safeString.pipe(z.string().min(2).max(200)),
  contactName: safeString.pipe(z.string().min(2).max(120)),
  email: normalizedEmail,
  phone: optionalText(30),
  /** Optional: the billing profile (GSTIN, address) saved in the same transaction. */
  billing: clientBillingProfileSchema.optional().nullable(),
});

/** Editing a client's details from sales. The email is NOT here: it is the owner's portal
 *  sign-in, so it changes only through salesClientEmailSchema (sales admins). */
export const salesClientUpdateSchema = z.object({
  companyName: safeString.pipe(z.string().min(2).max(200)).optional(),
  contactName: safeString.pipe(z.string().min(2).max(120)).optional(),
  phone: optionalText(30),
}).refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

export const salesClientEmailSchema = z.object({ email: normalizedEmail });

/** The Edit client profile page: details and billing profile saved together. `billing: null`
 *  leaves an existing profile untouched (it is never deleted — invoices print from it). */
export const salesClientProfileSchema = z.object({
  companyName: safeString.pipe(z.string().min(2).max(200)),
  contactName: safeString.pipe(z.string().min(2).max(120)),
  phone: optionalText(30),
  billing: clientBillingProfileSchema.optional().nullable(),
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
  /** The client's purchase order number and date, printed on the invoice. */
  poNumber: optionalText(60),
  poDate: day.optional().nullable(),
  placeOfSupplyCode: stateCodeSchema.optional().nullable(),
  taxMode: z.enum(TAX_MODE_VALUES).optional(),
  gstRateBp: z.number().int().min(0).max(4000).optional(),
  discountPaise: paise.default(0),
  notes: optionalText(4000),
  terms: optionalText(4000),
  internalNotes: optionalText(4000),
  /** Bill from this GST registration (one of the company's GSTINs). Null / absent = automatic. */
  sellerGstin: gstinSchema.optional().nullable(),
  items: z.array(invoiceLineSchema).min(1).max(200),
});
export type InvoiceUpsertInput = z.infer<typeof invoiceUpsertSchema>;

// ── Recurring / retainer invoices ──
export const RECURRING_FREQUENCIES = ["monthly", "quarterly", "yearly"] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];
export const RECURRING_FREQUENCY_LABELS: Record<RecurringFrequency, string> = { monthly: "Every month", quarterly: "Every 3 months", yearly: "Every year" };
export const RECURRING_MODES = ["draft", "issue"] as const;
export const RECURRING_MODE_LABELS: Record<(typeof RECURRING_MODES)[number], string> = {
  draft: "Create a draft for us to check",
  issue: "Issue it and email it to the client",
};
export const RECURRING_STATUSES = ["active", "paused", "ended"] as const;

export const recurringLineSchema = z.object({
  description: safeString.pipe(z.string().min(1).max(300)),
  sac: z.string().trim().regex(/^\d{4,8}$/).optional().nullable(),
  quantity: z.number().int().min(1).max(10_000).default(1),
  unitPricePaise: paise,
  discountPaise: paise.default(0),
});
export type RecurringLineInput = z.infer<typeof recurringLineSchema>;

export const recurringUpsertSchema = z
  .object({
    companyKey: companyKeySchema,
    clientId: z.string().uuid(),
    title: safeString.pipe(z.string().min(2).max(200)),
    kind: z.enum(INVOICE_KINDS).default("tax_invoice"),
    frequency: z.enum(RECURRING_FREQUENCIES),
    dayOfMonth: z.number().int().min(1, "Pick a day from 1 to 28").max(28, "Pick a day from 1 to 28 (every month has it)"),
    startDate: day,
    endDate: day.optional().nullable(),
    mode: z.enum(RECURRING_MODES).default("draft"),
    placeOfSupplyCode: stateCodeSchema.optional().nullable(),
    taxMode: z.enum(TAX_MODE_VALUES).optional().nullable(),
    gstRateBp: z.number().int().min(0).max(4000).optional().nullable(),
    sellerGstin: gstinSchema.optional().nullable(),
    discountPaise: paise.default(0),
    dueDays: z.number().int().min(0).max(365).optional().nullable(),
    notes: optionalText(4000),
    lines: z.array(recurringLineSchema).min(1).max(50),
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, { message: "The end date is before the start date", path: ["endDate"] });
export type RecurringUpsertInput = z.infer<typeof recurringUpsertSchema>;

export const invoiceIssueSchema = z.object({
  /** Typed by hand at Issue; blank = the next number of the registration's series. GST: ≤ 16 characters, letters, digits, "/" and "-". */
  number: z.string().trim().max(16, "GST invoice numbers are at most 16 characters").regex(/^[A-Za-z0-9/-]*$/, "Use only letters, digits, / and -").optional().nullable().transform((v) => (v ? v : null)),
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

// ─── smart-invoicing: accounts (PR 1) ───
// Filed accounts (sales.digitalsukoon.com/accounts): the 12 key figures typed from a company's
// signed balance sheet + P&L for one closed FY. BIGINT paise, bounded so Number() stays exact.
export const FILED_MAX_PAISE = 1_000_000_000_000_000;
export const FILED_ENTRY_UNITS = ["rupees", "thousands", "lakhs", "crores"] as const;
export const FILED_FILE_KINDS = ["accounts", "audit_report", "other"] as const;
const filedAmount = (signed: boolean) => z.number().int()
  .min(signed ? -FILED_MAX_PAISE : 0, signed ? "That figure is too large — check the unit (rupees, lakhs, crores)" : "This figure can't be negative")
  .max(FILED_MAX_PAISE, "That figure is too large — check the unit (rupees, lakhs, crores)")
  .nullable();
export const filedYearSchema = z.object({
  revenuePaise: filedAmount(false), otherIncomePaise: filedAmount(false), totalExpensesPaise: filedAmount(false),
  profitBeforeTaxPaise: filedAmount(true), taxExpensePaise: filedAmount(true), profitAfterTaxPaise: filedAmount(true),
  totalAssetsPaise: filedAmount(false), totalLiabilitiesPaise: filedAmount(false), equityPaise: filedAmount(true),
  cashAndBankPaise: filedAmount(false), tradeReceivablesPaise: filedAmount(false), tradePayablesPaise: filedAmount(false),
  enteredIn: z.enum(FILED_ENTRY_UNITS).default("rupees"),
  notes: optionalText(4000),
  /** updatedAt of the row the form loaded; null when the form started from no row. */
  baseUpdatedAt: z.string().datetime().nullable(),
}).refine((v) => FILED_FIGURE_KEYS.some((k) => v[k] != null) || !!v.notes,
  { message: "Type at least one figure, or a note", path: ["revenuePaise"] });
export type FiledYearInput = z.infer<typeof filedYearSchema>;

// smart-invoicing: reconcile (PR 5)
// The /reconcile page (spec-reconcile §6.3): Form 26AS / GSTR-1 uploads, TAN mapping, balance
// confirmations. Module-private names are recon-prefixed (this file is shared by six PRs).
const reconFy = z.string().regex(/^\d{4}-\d{2}$/, "Pick a financial year like 2025-26");
/** Multipart text flag — the portal sends "true"; the same encoding as bank's upload flag. */
const reconFormFlag = z.enum(["true", "false"]).optional().transform((v) => v === "true");
/** An empty multipart field is "not sent". */
const reconBlank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
export const tdsUploadSchema = z.object({ fy: reconFy, acceptWarnings: reconFormFlag });
export const gstUploadSchema = z.object({
  gstin: z.preprocess(reconBlank, gstinSchema.optional()),
  period: z.string().trim().max(10),
  acceptWarnings: reconFormFlag,
});
export const tdsDeductorSchema = z.object({
  kind: z.enum(["client", "non_sales"]),
  clientId: z.string().uuid().nullable().default(null),
  label: optionalText(120),
  nameSeen: optionalText(200),
}).superRefine((v, ctx) => {
  if (v.kind === "client" && !v.clientId) ctx.addIssue({ code: "custom", path: ["clientId"], message: "Pick the client this TAN belongs to" });
  if (v.kind === "non_sales" && (v.clientId || (v.label ?? "").length < 2)) ctx.addIssue({ code: "custom", path: ["label"], message: "Say what this deductor is, e.g. Bank interest — HDFC FD" });
});
const reconSignedPaise = z.number().int().min(-FILED_MAX_PAISE, "That figure is too large").max(FILED_MAX_PAISE, "That figure is too large");
export const confirmationCreateSchema = z.object({
  companyKey: z.enum(COMPANY_KEYS), clientId: z.string().uuid(), asOf: day, from: day,
  send: z.boolean().default(false), refresh: z.boolean().default(false),
}).refine((v) => v.from <= v.asOf, { path: ["from"], message: "The statement must start on or before the 'as of' date" });
export type ConfirmationCreateInput = z.infer<typeof confirmationCreateSchema>;
export const confirmationBatchSchema = z.object({
  companyKey: z.enum(COMPANY_KEYS), asOf: day, from: day,
  clientIds: z.array(z.string().uuid()).min(1).max(25, "Send to at most 25 clients at a time"),
  resend: z.boolean().default(false),
}).refine((v) => v.from <= v.asOf, { path: ["from"], message: "The statement must start on or before the 'as of' date" });
export type ConfirmationBatchInput = z.infer<typeof confirmationBatchSchema>;
export const confirmationSendSchema = z.object({ refresh: z.boolean().default(false) });
export const confirmationResponseSchema = z.object({
  status: z.enum(["pending", "confirmed", "disputed"]),
  theirBalancePaise: reconSignedPaise.nullable().optional(),
  respondedOn: day.nullable().optional(),
  note: optionalText(1000),
}).superRefine((v, ctx) => {
  if (v.status === "disputed") {
    if (v.theirBalancePaise == null) ctx.addIssue({ code: "custom", path: ["theirBalancePaise"], message: "Type the balance the client's books show" });
    if ((v.note ?? "").length < 3) ctx.addIssue({ code: "custom", path: ["note"], message: "Say what the client disputes" });
  }
});
export type ConfirmationResponseInput = z.infer<typeof confirmationResponseSchema>;

// smart-invoicing: reconcile BRS (PR 6)

// ─── smart-invoicing: tally (PR 2) ───
// Tally XML export and Send to Tally (spec-tally.md §3.2). Settings live under their own
// system_settings keys (sales.tally / sales.tally.dmpl) — never inside the seller profile, which
// is frozen into every issued invoice.

/** Whole days from a to b (YYYY-MM-DD), UTC arithmetic: daysBetween("2026-11-01", "2026-11-30") = 29. Private: validators/campaign.ts already exports a daysBetween through the barrel. */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000);

export const TALLY_RELEASES = ["prime3", "legacy"] as const; // TallyPrime 3.0+ | ERP 9 / TallyPrime 1–2
export const TALLY_MODES = ["new_only", "everything"] as const;
export const TALLY_DOC_TYPES = ["invoice", "credit_note", "receipt", "refund"] as const;
export type TallyRelease = (typeof TALLY_RELEASES)[number];
export type TallyMode = (typeof TALLY_MODES)[number];
export type TallyDocType = (typeof TALLY_DOC_TYPES)[number];

/** A Tally ledger / group / voucher-type / registration name: trimmed, single-spaced, 1–100 chars, no control chars. */
const tallyName = safeString
  .pipe(z.string().min(1, "Enter the name exactly as in Tally").max(100, "Tally names are at most 100 characters"))
  .transform((s) => s.replace(/\s+/g, " "))
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Remove control characters");
const tallyCompanyName = safeString.pipe(z.string().min(2, "Enter the company name exactly as in Tally").max(120));

export const tallyRegistrationSchema = z.object({
  gstin: gstinSchema,
  tallyCompany: tallyCompanyName, // SVCURRENTCOMPANY for this registration's documents
  registrationName: tallyName.nullable().default(null), // prime3, 2+ registrations in one Tally company
  salesVoucherType: tallyName.nullable().default(null), // null = voucherTypes.sales
  creditNoteVoucherType: tallyName.nullable().default(null), // null = voucherTypes.creditNote
});

/** The account-ledger roles of tallySettingsSchema.ledgers, in the order the settings page shows them. */
export const TALLY_LEDGER_ROLES = ["outputCgst", "outputSgst", "outputIgst", "roundOff", "tdsReceivable", "bank", "cash", "gateway", "other", "zeroRatedSales"] as const;

export const tallySettingsSchema = z.object({
  release: z.enum(TALLY_RELEASES).default("prime3"),
  booksFrom: day.nullable().default(null), // REQUIRED to export: "Tally already has everything before"
  registrations: z.array(tallyRegistrationSchema).max(11).default([]),
  gstr1Filing: z.enum(["monthly", "quarterly"]).default("monthly"),
  partyGroup: tallyName.default("Sundry Debtors"),
  salesLedgers: z.array(z.object({
    name: tallyName,
    sac: z.string().trim().regex(/^\d{4,8}$/, "SAC is 4–8 digits"),
    gstRateBp: z.number().int().min(0).max(4000),
  })).min(1, "Add at least one sales ledger").max(20)
    .default([{ name: "Sales - Advertising Services", sac: "998365", gstRateBp: 1800 }]),
  ledgers: z.object({
    outputCgst: tallyName.default("Output CGST"),
    outputSgst: tallyName.default("Output SGST"),
    outputIgst: tallyName.default("Output IGST"),
    roundOff: tallyName.default("Round Off"),
    tdsReceivable: tallyName.default("TDS Receivable"), // "{fy}" → "2026-27"
    bank: tallyName.nullable().default(null), // bank_transfer | upi | cheque
    cash: tallyName.default("Cash"), // cash
    gateway: tallyName.nullable().default(null), // razorpay
    other: tallyName.nullable().default(null), // other
    /** Owner 2026-11-05: "No GST" invoices are SEZ / export and billed regularly. null = held back (ZERO_RATED_UNSUPPORTED). */
    zeroRatedSales: tallyName.nullable().default(null),
  }).default({}),
  voucherTypes: z.object({
    sales: tallyName.default("Sales"),
    creditNote: tallyName.default("Credit Note"),
    receipt: tallyName.default("Receipt"),
    payment: tallyName.default("Payment"),
  }).default({}),
  createAccountLedgers: z.boolean().default(false), // also write the account ledgers into masters (new Tally company)
  bankAllocations: z.boolean().default(true), // BANKALLOCATIONS.LIST on bank lines (C9)
  ledgersConfirmed: z.boolean().default(false), // "These names match our Tally" — server resets on any name change
  pushUrl: z.string().trim().max(200).url("Enter an address like http://100.101.102.103:9000").nullable().default(null),
}).superRefine((s, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  // 1. each registration once
  const gstins = new Set<string>();
  s.registrations.forEach((r, i) => {
    if (gstins.has(r.gstin)) issue(["registrations", i, "gstin"], "That GSTIN is listed twice");
    gstins.add(r.gstin);
  });
  // 2. ledger names distinct across roles (case-insensitive); a sales ledger may repeat across its own rows
  const key = (n: string) => n.toLowerCase().replace(/\s+/g, " ").trim();
  const seen = new Map<string, { label: string; kind: string }>();
  const take = (name: string | null, label: string, kind: string, path: (string | number)[]) => {
    if (!name) return;
    const k = key(name);
    const prev = seen.get(k);
    if (prev && !(prev.kind === "sales" && kind === "sales")) issue(path, `${prev.label} and ${label} are the same Tally ledger — use different names`);
    else if (!prev) seen.set(k, { label, kind });
  };
  s.salesLedgers.forEach((l, i) => take(l.name, l.name, "sales", ["salesLedgers", i, "name"]));
  for (const role of TALLY_LEDGER_ROLES) take(s.ledgers[role], s.ledgers[role] ?? role, role, ["ledgers", role]);
  // 3. (sac, rate) once
  const pairs = new Set<string>();
  s.salesLedgers.forEach((l, i) => {
    const p = `${l.sac}:${l.gstRateBp}`;
    if (pairs.has(p)) issue(["salesLedgers", i, "sac"], `SAC ${l.sac} at ${l.gstRateBp / 100}% is listed twice`);
    pairs.add(p);
  });
  // 4. legacy releases hold one GSTIN per company
  if (s.release === "legacy") {
    const names = new Set<string>();
    s.registrations.forEach((r, i) => {
      if (names.has(key(r.tallyCompany))) issue(["registrations", i, "tallyCompany"], "Tally ERP 9 and TallyPrime before 3.0 keep one GSTIN per company — give each registration its own Tally company");
      names.add(key(r.tallyCompany));
    });
  }
  // 5. equal company names must be equal exactly (one routing group, never two by case)
  const exact = new Map<string, string>();
  s.registrations.forEach((r, i) => {
    const k = key(r.tallyCompany);
    const prev = exact.get(k);
    if (prev !== undefined && prev !== r.tallyCompany) issue(["registrations", i, "tallyCompany"], `Write the company name exactly as "${prev}" — Tally company names must match`);
    else if (prev === undefined) exact.set(k, r.tallyCompany);
  });
});
export type TallySettingsInput = z.infer<typeof tallySettingsSchema>;

const tallyPeriodRules = <T extends z.ZodTypeAny>(schema: T) => schema
  .refine((q: { from: string; to: string }) => q.from <= q.to, { path: ["to"], message: "The period ends before it starts" })
  .refine((q: { from: string; to: string }) => daysBetween(q.from, q.to) <= 366, { path: ["to"], message: "Export at most one year at a time" });

export const tallyPreviewQuerySchema = tallyPeriodRules(z.object({
  company: companyKeySchema,
  from: day,
  to: day,
  gstin: gstinSchema.optional(),
  mode: z.enum(TALLY_MODES).default("new_only"),
}));
export type TallyPreviewQuery = z.infer<typeof tallyPreviewQuerySchema>;

export const tallyRunCreateSchema = tallyPeriodRules(z.object({
  companyKey: companyKeySchema,
  from: day,
  to: day,
  gstin: gstinSchema.nullable().optional(),
  mode: z.enum(TALLY_MODES),
  previewHash: z.string().regex(/^[0-9a-f]{64}$/),
  acknowledge: z.array(z.string().max(120)).max(500).default([]),
  allowPartial: z.boolean().default(false),
}));
export type TallyRunCreateInput = z.infer<typeof tallyRunCreateSchema>;

export const tallyRunConfirmSchema = z.object({
  created: z.number().int().min(0),
  altered: z.number().int().min(0).default(0),
  cancelled: z.number().int().min(0).default(0),
  errors: z.number().int().min(0),
  note: safeString.pipe(z.string().min(3, "Say who imported it and when").max(500)),
});
export type TallyRunConfirmInput = z.infer<typeof tallyRunConfirmSchema>;
export const tallyReasonSchema = z.object({ reason: safeString.pipe(z.string().min(3, "Give a reason").max(300)) });
export const tallyPartyUpdateSchema = z.object({
  ledgerName: tallyName,
  existsInTally: z.boolean().optional(),
  confirmRenamedInTally: z.boolean().default(false),
});
export type TallyPartyUpdateInput = z.infer<typeof tallyPartyUpdateSchema>;
export const tallyPartyMatchSchema = z.object({
  companyKey: companyKeySchema,
  source: z.enum(["push", "xml"]),
  xml: z.string().max(5_000_000, "That file is over 5 MB — export only the ledgers").optional(),
}).refine((b) => b.source === "push" || !!b.xml, { path: ["xml"], message: "Attach Tally's ledger export" });
export type TallyPartyMatchInput = z.infer<typeof tallyPartyMatchSchema>;
export const tallyPartyApplySchema = z.object({
  companyKey: companyKeySchema,
  mappings: z.array(z.object({ clientId: z.string().uuid(), ledgerName: tallyName, existsInTally: z.boolean() })).min(1).max(600),
});
export type TallyPartyApplyInput = z.infer<typeof tallyPartyApplySchema>;
export const tallyResolveSchema = z.object({
  companyKey: companyKeySchema,
  docs: z.array(z.object({ docType: z.enum(TALLY_DOC_TYPES), docId: z.string().uuid() })).min(1).max(200),
  note: safeString.pipe(z.string().min(3).max(500)),
  /** the export the documents were picked from — it may be the open one (its unsent items) */
  fromRunId: z.string().uuid().optional(),
});
export type TallyResolveInput = z.infer<typeof tallyResolveSchema>;

// ─── smart-invoicing: import (PR 3) ───

// ─── smart-invoicing: bank (PR 4) ───
