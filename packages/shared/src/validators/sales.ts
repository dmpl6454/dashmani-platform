import { z } from "zod";
import { safeString, normalizedEmail } from "../utils/sanitize";
import { DEFAULT_GST_RATE_BP, DEFAULT_SAC, TAX_MODES } from "../sales/gst";

// sales.digitalsukoon.com — shared by the API (input validation) and the portal (forms).
// Import BY PATH from the frontend ("@dashmani/shared/src/validators/sales"), never via the barrel.

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const paise = z.number().int().min(0).max(100_000_000_000); // ₹1,00,00,00,000 cap keeps int4 safe
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
  phone: optionalText(30),
  website: optionalText(200),
  bankName: optionalText(120),
  accountName: optionalText(200),
  accountNumber: optionalText(40),
  ifsc: z.string().trim().transform(upper).pipe(z.string().regex(IFSC_RE, "That is not a valid IFSC")).optional().nullable(),
  upiId: optionalText(80),
  invoicePrefix: safeString.pipe(z.string().min(1).max(10)).default("DS"),
  quotePrefix: safeString.pipe(z.string().min(1).max(10)).default("Q"),
  orderPrefix: safeString.pipe(z.string().min(1).max(10)).default("SO"),
  creditNotePrefix: safeString.pipe(z.string().min(1).max(10)).default("CN"),
  receiptPrefix: safeString.pipe(z.string().min(1).max(10)).default("RCPT"),
  defaultSac: z.string().trim().regex(/^\d{4,8}$/).default(DEFAULT_SAC),
  defaultGstRateBp: z.number().int().min(0).max(4000).default(DEFAULT_GST_RATE_BP),
  defaultDueDays: z.number().int().min(0).max(180).default(15),
  roundToRupee: z.boolean().default(true),
  terms: optionalText(2000),
  signatory: optionalText(120),
});
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
});
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

const documentBase = {
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
  permalink: z.string().trim().url().max(500).optional().nullable(),
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
});

export const invoiceCancelSchema = z.object({ reason: safeString.pipe(z.string().min(3).max(300)) });

export const paymentCreateSchema = z
  .object({
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
  .refine((p) => p.allocations.reduce((s, a) => s + a.tdsPaise, 0) <= p.tdsPaise, { message: "Allocated more TDS than was withheld", path: ["allocations"] });
export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>;

export const creditNoteCreateSchema = z.object({
  invoiceId: z.string().uuid(),
  reason: safeString.pipe(z.string().min(3).max(300)),
  taxablePaise: z.number().int().min(1).max(100_000_000_000),
  issueDate: day.optional(),
});
export type CreditNoteCreateInput = z.infer<typeof creditNoteCreateSchema>;
