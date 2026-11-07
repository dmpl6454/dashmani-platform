// Shapes of the /v1/sales/* responses the pages read. Money is integer paise.
export type TaxMode = "intra" | "inter" | "none";

export interface SellerProfile {
  legalName: string; tradeName?: string | null; gstin?: string | null; pan?: string | null;
  addressLine1?: string | null; addressLine2?: string | null; city?: string | null; state?: string | null; stateCode?: string | null; pincode?: string | null;
  email?: string | null; billingEmails?: string[]; phone?: string | null; website?: string | null;
  bankName?: string | null; accountName?: string | null; accountNumber?: string | null; ifsc?: string | null; upiId?: string | null;
  invoicePrefix: string; quotePrefix: string; orderPrefix: string; creditNotePrefix: string; receiptPrefix: string;
  /** Zero-padded length of the invoice serial (INV/26-27/0014 = 4, INV/26-27/059 = 3). */
  serialDigits?: number;
  defaultSac: string; defaultGstRateBp: number; defaultDueDays: number; roundToRupee: boolean; autoEmailInvoices?: boolean; terms?: string | null; signatory?: string | null;
  /** Additional GST registrations in other states; a client in that state is billed from it. */
  branches: SellerBranch[];
  eInvoicing: { enabled: boolean; applicableFrom?: string | null; thirtyDayLimit: boolean };
}
export interface SellerBranch {
  label: string; gstin: string; stateCode?: string | null; state?: string | null; addressLine1: string; addressLine2?: string | null; city: string; pincode: string;
  invoicePrefix: string; creditNotePrefix: string; serialDigits?: number;
}
export interface EInvoiceBrief { status: "pending" | "registering" | "registered" | "failed" | "cancelled"; irn: string | null; ackNo: string | null; ackDate: string | null; lastError: string | null }
export interface SellerSettings { company: string; profile: SellerProfile; saved: boolean; missing: string[] }

export interface InventoryOffer { rateCardId: string; format: string; pricePaise: number; entertainmentPricePaise: number | null; audioAddonPaise: number | null; active: boolean }
export interface InventoryChannel {
  targetType: "meta_asset" | "social_account"; targetId: string; platform: string; name: string; handle: string | null; pictureUrl: string | null;
  followers: number | null; views28d: number | null; engagements28d: number | null; engagementRatePct: number | null; category: string | null;
  profileUrl: string | null; bookable: boolean; inCatalogue: boolean; offers: InventoryOffer[];
}

export interface BillingProfile {
  legalName: string; gstin: string | null; pan: string | null; addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null;
  stateCode: string | null; pincode: string | null; country: string; billingEmail: string | null; billingPhone: string | null; notes: string | null;
  /** The client's TAN as a TDS deductor (reconcile, PR 5). Learned from Form 26AS or typed. */
  tan?: string | null;
}
export interface ClientRow {
  id: string; companyName: string; contactName: string; email: string; phone: string | null; status: string; createdAt: string;
  billingProfile: BillingProfile | null; outstandingPaise: number; counts?: { quotes: number; orders: number; invoices: number };
}
export interface ClientBrief { id: string; companyName: string; contactName?: string; email?: string; billingProfile?: { legalName: string; gstin?: string | null; stateCode?: string | null } | null }

export interface LineItem {
  id?: string; position?: number; kind: "placement" | "custom"; targetType?: string | null; targetId?: string | null; platform?: string | null; format?: string | null;
  description: string; accountName?: string | null; accountHandle?: string | null; quantity: number; unitPricePaise: number; discountPaise: number;
  amountPaise?: number; sac?: string | null; scheduledOn?: string | null; rateCardId?: string | null; status?: string; permalink?: string | null; deliveredOn?: string | null;
}
interface DocumentTotals { subtotalPaise: number; discountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number }
export interface Quote extends DocumentTotals {
  id: string; companyKey: string; number: string; clientId: string; title: string; status: string; campaignType: string; validUntil: string | null; expired: boolean;
  placeOfSupplyCode: string | null; taxMode: TaxMode; gstRateBp: number; notes: string | null; internalNotes: string | null;
  sentAt: string | null; acceptedAt: string | null; convertedOrderId: string | null; createdAt: string; client: ClientBrief; items: LineItem[]; itemCount?: number;
}
export interface Order extends DocumentTotals {
  id: string; companyKey: string; number: string; clientId: string; quoteId: string | null; campaignBookingId: string | null; title: string; status: string; campaignType: string;
  poNumber: string | null; startDate: string | null; endDate: string | null; placeOfSupplyCode: string | null; taxMode: TaxMode; gstRateBp: number;
  notes: string | null; internalNotes: string | null; createdAt: string; client: ClientBrief; items: LineItem[]; itemCount?: number; deliveredCount?: number;
  invoices: Array<{ id: string; number: string | null; kind?: string; status: string; totalPaise: number; paidPaise?: number; tdsPaise?: number; creditedPaise?: number; issueDate?: string | null; dueDate?: string | null }>;
}
export type DerivedInvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "overdue" | "cancelled";
export interface InvoiceItem { id?: string; description: string; sac: string | null; quantity: number; unitPricePaise: number; discountPaise: number; amountPaise?: number; orderItemId?: string | null }
export interface Invoice extends DocumentTotals {
  id: string; companyKey: string; number: string | null; kind: "tax_invoice" | "proforma"; status: string; derivedStatus: DerivedInvoiceStatus; clientId: string; orderId: string | null;
  campaignBookingId: string | null; issueDate: string | null; dueDate: string | null; taxMode: TaxMode; gstRateBp: number; placeOfSupplyCode: string | null;
  /** The GST registration picked by hand (null = automatic), and the recurring invoice that made it. */
  sellerGstin: string | null; recurringId: string | null;
  /** The client's purchase order, printed on the invoice. */
  poNumber: string | null; poDate: string | null;
  roundOffPaise: number; paidPaise: number; tdsPaise: number; creditedPaise: number; balancePaise: number; amountInWords: string | null;
  notes: string | null; terms: string | null; internalNotes: string | null; cancelReason: string | null; issuedAt: string | null; sentAt: string | null; paidAt: string | null; createdAt: string;
  sellerSnapshot: Record<string, string | null> | null; buyerSnapshot: Record<string, string | null> | null;
  client: ClientBrief & { phone?: string | null; billingProfile?: BillingProfile | null }; order: { id: string; number: string; title: string } | null; items: InvoiceItem[];
  allocations: Array<{ id: string; amountPaise: number; tdsPaise: number; payment: { id: string; number: string; mode: string; reference: string | null; paidOn: string | null; status: string } }>;
  /** The proforma this tax invoice was converted from, and the tax invoices made from this proforma. */
  convertedFrom: { id: string; number: string | null } | null;
  conversions: Array<{ id: string; number: string | null; status: string }>;
  creditNotes: Array<{ id: string; number: string; status: string; issueDate: string | null; reason: string; totalPaise: number; taxablePaise: number; einvoice: EInvoiceBrief | null }>;
  /** The IRP registration, when this document needs one. */
  einvoice: (EInvoiceBrief & { id: string; docType: string; gstin: string; attempts: number }) | null;
  // smart-invoicing: import (PR 3)
  /** portal | swipe — an imported (swipe) invoice keeps Swipe's figures and is never edited or cancelled here. */
  source: InvoiceSource; importId: string | null;
  salesImport: { id: string; fileName: string; appliedAt: string | null } | null;
}
export interface InvoiceRow extends DocumentTotals {
  id: string; companyKey: string; number: string | null; kind: string; status: string; derivedStatus: DerivedInvoiceStatus; issueDate: string | null; dueDate: string | null;
  paidPaise: number; tdsPaise: number; creditedPaise: number; balancePaise: number; clientId: string; client?: { id: string; companyName: string; billingProfile?: { legalName: string } | null };
  // smart-invoicing: import (PR 3)
  source: InvoiceSource; importId: string | null;
}
export interface Refund {
  id: string; number: string; paymentId: string; amountPaise: number; mode: string; reference: string | null; refundedOn: string | null; notes: string | null;
  status: "issued" | "cancelled"; cancelledAt: string | null; createdAt: string;
}
export interface Payment {
  id: string; companyKey: string; number: string; clientId: string; amountPaise: number; tdsPaise: number; mode: string; reference: string | null; paidOn: string | null; bankName: string | null; notes: string | null;
  createdAt: string; client: { id: string; companyName: string }; allocations: Array<{ invoiceId: string; amountPaise: number; tdsPaise: number; invoice: { id: string; number: string | null; totalPaise: number } }>;
  /** recorded | voided — a voided receipt keeps its number; its allocations stop counting. */
  status: "recorded" | "voided"; voidReason: string | null; voidedAt: string | null;
  refunds: Refund[];
  /** Computed by the API: on invoices, refunded, and what is left to apply or refund. */
  allocatedPaise: number; allocatedTdsPaise: number; refundedPaise: number; unallocatedPaise: number; unallocatedTdsPaise: number;
  // smart-invoicing: import (PR 3)
  /** The Swipe import that recorded this receipt (SW-<invoice number>), else null. */
  importId: string | null;

  // smart-invoicing: bank (PR 4)
  /** The bank statement credit this receipt is matched to (account number cut to its last 4). */
  bankLine?: { id: string; txnDate: string | null; rowNo: number; statement: { fileName: string }; bankAccount: { label: string; last4: string } } | null;
  tdsRateBp?: number | null; tdsSection?: string | null;
}
export interface CreditNote { id: string; number: string; invoiceId: string; status: string; issueDate: string | null; reason: string; taxablePaise: number; totalPaise: number; invoice?: { id: string; number: string | null }; client?: { id: string; companyName: string } }
export interface Statement { client: ClientRow; invoices: InvoiceRow[]; payments: Payment[]; creditNotes: CreditNote[]; totals: { invoicedPaise: number; collectedPaise: number; tdsPaise: number; creditedPaise: number; outstandingPaise: number; overduePaise: number; refundedPaise: number; unappliedPaise: number } }
export interface SalesEvent { id: string; entityType: string; entityId: string; actorId: string | null; action: string; fromStatus: string | null; toStatus: string | null; note: string | null; createdAt: string; label?: string | null }
export interface BookingInvoice { id: string; number: string | null; kind: string; status: string; companyKey: string; totalPaise: number }
export interface BookingRow {
  id: string; name: string; brand: string; status: string; statusLabel: string; format: string | null; campaignType: string; totalPaise: number | null;
  launchFrom: string | null; launchTo: string | null; submittedAt: string | null; paidOnline: boolean; approvedAt: string | null; createdAt: string;
  client: { id: string; companyName: string; billingProfile?: { legalName: string } | null };
  itemCount: number; liveCount: number; billablePaise: number; billable: boolean; invoiced: boolean; invoices: BookingInvoice[];
}
export interface BookingDetail {
  id: string; name: string; brand: string; objective: string | null; status: string; statusLabel: string; format: string | null; campaignType: string;
  audioIntegration: boolean; audioTrack: string | null; totalPaise: number | null; launchFrom: string | null; launchTo: string | null;
  submittedAt: string | null; paidOnline: boolean; approvedAt: string | null; deliveredAt: string | null; createdAt: string; reviewNote: string | null;
  client: { id: string; companyName: string; contactName: string | null; email: string; billingProfile?: { legalName: string; gstin: string | null; stateCode: string | null } | null };
  items: Array<{
    id: string; platform: string; format: string; accountName: string; accountHandle: string | null; pricePaise: number; audioAddonPaise: number; status: string; permalink: string | null; postedAt: string | null; live: boolean; billed: boolean;
    /** null = the booking's caption; "" on superTextOverride = no overlay on this account. */
    captionOverride: string | null; hashtagsOverride: string[]; superTextOverride: string | null;
  }>;
  billable: boolean; billablePaise: number; invoices: BookingInvoice[];
  caption: string | null; hashtags: string[]; userTags: string[]; collaborators: string[]; superText: string | null; superTextStyle: string | null;
  media: Array<{ id: string; kind: string; role: string; originalName: string; durationMs: number | null; width: number | null; height: number | null; renderStatus: string }>;
}
/** GET /sales/bookings/:id/media-urls — signed, short-lived (4 h) paths under the API origin. */
export interface BookingMediaUrls {
  media: Array<{ id: string; kind: string; role: string; renderStatus: string; preview: string; original: string }>;
  items: Array<{ itemId: string; custom: boolean; files: Array<{ mediaId: string; kind: string; role: string; status: string; url: string | null }> }>;
}
export interface BookingsSummary {
  review: { count: number; totalPaise: number }; active: { count: number; totalPaise: number }; live: { count: number; totalPaise: number };
  toInvoice: { count: number; totalPaise: number };
  recentToInvoice: Array<{ id: string; name: string; brand: string; status: string; statusLabel: string; client: string; billablePaise: number }>;
}
export interface Dashboard {
  /** Bank (PR 4): null when the company has no bank account. */
  bank?: BankSummary | null;
  company: string; today: string; bookings?: BookingsSummary; financialYear: string; ordersByFy: Array<{ financialYear: string; count: number; totalPaise: number; closedPaise: number }>; invoicedFyPaise: number; invoicedFyCount: number; invoicedMonthPaise: number; collectedFyPaise: number; tdsFyPaise: number; collectedMonthPaise: number;
  outstandingPaise: number; outstandingCount: number; overduePaise: number; overdueCount: number;
  openQuotes: { count: number; totalPaise: number }; acceptedQuotes: { count: number; totalPaise: number }; activeOrders: { count: number; totalPaise: number }; deliveredOrders: { count: number; totalPaise: number };
  topClients: Array<{ clientId: string; name: string; invoicedPaise: number }>; byPlatform: Array<{ platform: string; lines: number; amountPaise: number }>; recent: SalesEvent[];
}

/** A recurring (retainer) invoice template. Dates are IST days. */
export interface RecurringLine { description: string; sac?: string | null; quantity: number; unitPricePaise: number; discountPaise: number }
export interface Recurring {
  id: string; companyKey: string; client: { id: string; companyName: string }; title: string; kind: "tax_invoice" | "proforma";
  frequency: "monthly" | "quarterly" | "yearly"; dayOfMonth: number; startDate: string; endDate: string | null; nextRunDate: string; nextPeriodLabel: string;
  mode: "draft" | "issue"; placeOfSupplyCode: string | null; taxMode: TaxMode | null; gstRateBp: number | null; sellerGstin: string | null;
  discountPaise: number; dueDays: number | null; notes: string | null; lines: RecurringLine[]; status: "active" | "paused" | "ended";
  lastInvoiceId: string | null; lastRunAt: string | null; lastError: string | null; createdAt: string; updatedAt: string;
  lastInvoice?: { id: string; number: string | null; status: string; totalPaise: number } | null;
  invoices?: Array<{ id: string; number: string | null; kind: string; status: string; issueDate: string | null; totalPaise: number; notes: string | null }>;
}

// ─── smart-invoicing: accounts (PR 1) ───
// GET /sales/accounts (spec-accounts §3.2). Money = integer paise; days YYYY-MM-DD (IST); months YYYY-MM.
export type { EntryUnit, FiledFigureKey, GstSection, AgeKey } from "@dashmani/shared/src/sales/accounts";
export type { TdsRateLabel } from "@dashmani/shared/src/sales/tds";
type AcctTds = import("@dashmani/shared/src/sales/tds").TdsRateLabel;
type AcctUnit = import("@dashmani/shared/src/sales/accounts").EntryUnit;
type AcctFigure = import("@dashmani/shared/src/sales/accounts").FiledFigureKey;
type AcctAge = import("@dashmani/shared/src/sales/accounts").AgeKey;
export type Money4 = { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number };
export type Money5 = Money4 & { totalPaise: number };
export interface FiledFile { id: string; kind: string; fileName: string; sizeBytes: number; sha256: string; createdAt: string }
/** A filed year as the API sends it — the PDF list NEVER carries the bytes. */
export interface FiledYearView { id: string; fy: string; enteredIn: AcctUnit; notes: string | null; updatedAt: string; updatedById: string; figures: Record<AcctFigure, number | null>; files: FiledFile[] }
export interface GstMonth { month: string; invoices: Money5 & { count: number }; creditNotes: Money5 & { count: number }; net: Money5; b2cTaxablePaise: number; gstr3b: { a: Money4; b: { taxablePaise: number; igstPaise: number } } }
export interface AccountsView {
  company: "dspl" | "dmpl";
  fy: { label: string; startDay: string; endDay: string; closed: boolean };
  today: string; computedAt: string;
  years: Array<{ fy: string; closed: boolean; liveInvoices: number; liveNetTaxablePaise: number; filed: FiledYearView | null; gapPaise: number | null }>;
  registrations: Array<{ gstin: string; label: string; current: boolean }>;
  invoiced: { gross: Money5 & { count: number; roundOffPaise: number }; creditNotes: Money5 & { count: number; onEarlierYearInvoices: number }; net: Money5; cancelled: { count: number; totalPaise: number } };
  collected: { receipts: number; receivedPaise: number; refundedPaise: number; netPaise: number; tdsPaise: number; byMode: Array<{ mode: string; receipts: number; receivedPaise: number; refundedPaise: number; netPaise: number }> };
  months: Array<{ month: string; invoicedPaise: number; collectedPaise: number; tdsPaise: number; future: boolean }>;
  gst: {
    byRegistration: Array<{ gstin: string; months: GstMonth[]; totals: { invoices: Money5; creditNotes: Money5; net: Money5 } }>;
    documents: Array<{ month: string; gstin: string; doc: "invoice" | "credit_note"; series: string; first: string; last: string; total: number; cancelled: number }>;
    warnings: Array<{ code: "CHANGED_AFTER_DUE" | "CREDIT_NOTE_LATE" | "NO_SELLER_GSTIN" | "SECTION_CHECK"; count: number; message: string; documents: Array<{ id: string; kind: "invoice" | "credit_note"; number: string }> }>;
  };
  tds: { totalPaise: number; receipts: number; byQuarter: [number, number, number, number]; clients: Array<{ clientId: string; name: string; pan: string | null; panSource: "profile" | "gstin" | null; gstin: string | null; quarters: [number, number, number, number]; totalPaise: number; receipts: number; rates: AcctTds[] }> };
  receivables: { asOf: string; totalPaise: number; invoices: number; overduePaise: number; fromThisFyPaise: number; buckets: Array<{ key: AcctAge; label: string; paise: number; invoices: number }>; topDebtors: Array<{ clientId: string; name: string; balancePaise: number; overduePaise: number; invoices: number; oldestDue: string }> };
  unapplied: { cashPaise: number; tdsPaise: number; receipts: number; clients: number; top: Array<{ clientId: string; name: string; paise: number }> };
  bank: null | { unmatchedCount: number; unmatchedPaise: number; lastStatementDay: string | null };
  filed: FiledYearView | null;
  comparison: { state: "current" | "closed_filed" | "closed_not_filed"; filedRevenuePaise: number | null; liveNetTaxablePaise: number; gapPaise: number | null; gapBp: number | null };
}

// ─── smart-invoicing: reconcile (PR 5) ───
// GET /sales/reconcile/… (spec-reconcile §6.4). Money = integer paise as JSON numbers; days YYYY-MM-DD.
export type ReconTodo = { code: string; sentence: string; count: number; paise: number | null; href: string | null };
export type ReconReason = { code: string; text: string; action: string | null };
export type TdsGroup = import("@dashmani/shared/src/sales/recon").TdsGroup;
export type GstStatus = import("@dashmani/shared/src/sales/recon").GstStatus;
export type TdsCellVerdict = "none" | "matched" | "not_in_26as" | "short" | "extra" | "not_due" | "link_first";
export interface TdsUploadRow {
  id: string; format: string; fileName: string; fileSha256: string; fileBytes: number; pan: string | null; asOn: string | null; entryCount: number; deductorCount: number;
  totals: { amountPaidPaise: number; tdsPaise: number; depositedPaise: number }; warnings: string[]; errorRows: Array<{ ref: string; message: string }>; errorCount: number;
  current: boolean; uploadedByName: string | null; createdAt: string; currentSince: string;
}
export interface TdsUploadResult { upload: TdsUploadRow; duplicate: boolean; madeCurrent: boolean; learned: Array<{ tan: string; clientId: string; clientName: string; where: "profile" | "deductors" }> }
export interface TdsRow {
  key: string; group: TdsGroup; reason: ReconReason; flags: string[]; quarter: 1 | 2 | 3 | 4 | null;
  clientId: string | null; clientName: string | null; tan: string | null; deductorName: string | null;
  /** differencePaise = books − 26AS; chasePaise = the amount to ask for (chase rows) */
  booksPaise: number; form26Paise: number; depositedPaise: number | null; differencePaise: number; chasePaise?: number;
  items: Array<{ key: string; paymentId: string; receiptNumber: string; paidOn: string; invoiceId: string | null; invoiceNumber: string | null; homeDay: string; tdsPaise: number }>;
  entries: Array<{ id: string; rowNo: number; section: string | null; txnDate: string; bookingStatus: string | null; amountPaidPaise: number; tdsPaise: number; depositedPaise: number | null }>;
}
export interface TdsDeductor {
  tan: string; name: string; kind: "client" | "non_sales" | "unknown"; clientId: string | null; clientName: string | null; label: string | null;
  source: "profile" | "manual" | "auto" | null; entries: number; tdsPaise: number; proposal: null | { clientId: string; clientName: string; sure: boolean; why: string[] };
}
export interface TdsReconView {
  company: "dspl" | "dmpl"; fy: { label: string; startDay: string; endDay: string }; pan: { company: string | null; file: string | null };
  upload: TdsUploadRow | null; history: TdsUploadRow[]; historyCount: number;
  totals: { booksPaise: number; booksByReceiptDatePaise: number; deductedPaise: number; depositedPaise: number; matchedPaise: number; chasePaise: number; chaseCount: number;
    extraPaise: number; unknownPaise: number; nonSalesPaise: number; notDuePaise: number; nextYearPaise: number; linkFirstPaise: number };
  deductors: TdsDeductor[];
  clients: Array<{ clientId: string; name: string; pan: string | null; tans: string[]; billingEmail: string | null; verdict: TdsGroup;
    quarters: Array<{ q: 1 | 2 | 3 | 4; booksPaise: number; form26Paise: number; verdict: TdsCellVerdict; pairedFrom: number[] }> }>;
  rows: TdsRow[]; expectedBy: Array<{ quarter: 1 | 2 | 3 | 4; day: string; due: boolean }>; fyOptions: string[]; todo: ReconTodo[];
}
export type GstHeads = { valuePaise: number; taxablePaise: number; igstPaise: number | null; cgstPaise: number | null; sgstPaise: number | null; cessPaise: number | null };
export interface GstRow {
  key: string; section: "b2b" | "cdnr"; status: GstStatus; issues: Array<{ code: string; message: string; differencePaise?: number }>;
  books: null | (GstHeads & { id: string; kind: "invoice" | "credit_note"; number: string; date: string; status: string; buyerGstin: string | null; buyerName: string | null; ratesBp: number[]; pos: string | null; section: string });
  filed: null | (GstHeads & { id: string; rowRef: string; number: string; date: string | null; ctin: string | null; receiverName: string | null; ratesBp: number[]; pos: string | null; invType: string | null; uploadId: string });
  diff: GstHeads | null; hint: null | { text: string; invoiceId?: string; companyKey?: string; gstin?: string; period?: string; importable?: boolean }; action: string;
}
export interface GstUploadRow { id: string; format: string; fileName: string; fileSha256: string; sections: string[]; counts: Record<string, number>; taxColumns: boolean; warnings: string[]; errorCount: number; current: string[]; uploadedByName: string | null; createdAt: string }
export interface GstUploadResult { upload: GstUploadRow; duplicate: boolean; madeCurrent: boolean }
export interface GstReconView {
  company: "dspl" | "dmpl"; gstin: string; registrationLabel: string; registrations: Array<{ gstin: string; label: string }>;
  period: { key: string; label: string; from: string; toExclusive: string; fy: string; kind: "month" | "quarter" }; periodOptions: Array<{ key: string; label: string }>;
  uploads: GstUploadRow[]; periodsWithUploads: string[]; taxColumns: boolean;
  counts: Record<GstStatus, number> & { cancelledNotFiled: number; lateCreditNotes: number };
  sections: Array<{ section: "b2b" | "sez" | "cdnr" | "b2cl" | "b2cs" | "exp" | "cdnur"; books: GstHeads; filed: GstHeads | null; comparedItemwise: boolean; differs: boolean; note: string | null }>;
  rows: GstRow[]; importLink: boolean; todo: ReconTodo[];
}
export type LedgerLine = { day: string; kind: "invoice" | "refund" | "credit_note" | "receipt" | "tds"; docId: string; number: string; particulars: string; debitPaise: number; creditPaise: number; balancePaise: number };
export interface LedgerView {
  v: 1; company: string; clientId: string; from: string; to: string; generatedAt: string;
  seller: { legalName: string; gstin: string | null; pan: string | null; addressLines: string[]; email: string | null };
  client: { name: string; legalName: string; gstin: string | null; pan: string | null; tans: string[]; addressLines: string[] };
  openingPaise: number; lines: LedgerLine[]; totals: { debitPaise: number; creditPaise: number }; closingPaise: number; side: "Dr" | "Cr";
  excluded: Array<{ kind: "cancelled_invoice" | "voided_receipt" | "cancelled_credit_note" | "cancelled_refund"; number: string; day: string; changedOn: string | null; reason: string | null; amountPaise: number }>;
  notes: string[]; checks: { identityOk: boolean | null };
}
export interface ConfirmationState {
  id: string; status: "pending" | "confirmed" | "disputed"; asOf: string; from: string; ourBalancePaise: number; theirBalancePaise: number | null; differencePaise: number | null;
  sentCount: number; lastSentAt: string | null; lastSentTo: string | null; lastSendError: string | null; sending: boolean;
  respondedOn: string | null; responseNote: string | null; hasFile: boolean; file: { fileName: string; sizeBytes: number; contentType: string } | null;
  stale: boolean; overdue: boolean; stuck: boolean; liveBalancePaise: number | null;
}
export interface ConfirmationsView {
  company: "dspl" | "dmpl"; asOf: string; from: string;
  counts: { clients: number; withBalance: number; notSent: number; pending: number; overdue: number; stale: number; confirmed: number; disputed: number; noEmail: number; drPaise: number; crPaise: number; disputedPaise: number };
  rows: Array<{ clientId: string; name: string; legalName: string; email: string | null; balancePaise: number; side: "Dr" | "Cr"; docsInRange: number; lastDay: string | null; confirmation: ConfirmationState | null; lastConfirmed: string | null }>;
  todo: ReconTodo[];
}
export interface LedgerResponse { ledger: LedgerView; recipients: { to: string[]; cc: string[] }; confirmation: (ConfirmationState & { ledgerAsSent: LedgerView }) | null }
export type ReconEmailResult = { sent: boolean; to: string[]; cc: string[] };

// ─── smart-invoicing: reconcile BRS (PR 6) ───
// The Bank tab of /reconcile (spec-reconcile §6.4) — mirrors apps/api/src/services/sales/recon/brs*.ts.
export type BrsState = "running" | "open" | "reconciled" | "changed";
export type BrsGroup = "not_credited" | "credited_other_month" | "unmatched" | "ignored" | "rounding" | "over_matched" | "duplicate";
export interface BrsItem {
  key: string; group: BrsGroup; open: boolean; reason: { code: string; text: string; action: string | null }; day: string; amountPaise: number;
  line?: { id: string; txnDate: string; rowNo: number; statementId: string; fileName: string; narration: string; reference: string | null; utr: string | null; creditPaise: number; matchedPaise: number };
  receipt?: { id: string; number: string; paidOn: string; clientName: string; mode: string; amountPaise: number; creditedOn: string | null };
  link?: { lineId: string; paymentId: string; text: string };
}
export interface BrsAccountRef { id: string; label: string; bank: string; last4: string; ifsc: string | null; matchFrom: string | null }
export interface BrsView {
  company: "dspl" | "dmpl"; account: BrsAccountRef;
  accounts: Array<{ id: string; label: string; last4: string; isDefault: boolean }>;
  defaultAccount: { id: string; why: "only" | "printed_on_invoices" | "oldest" } | null;
  month: { key: string; label: string; from: string; to: string; over: boolean };
  coverage: { complete: boolean; gaps: Array<{ from: string; to: string }>; statements: Array<{ id: string; fileName: string; periodFrom: string; periodTo: string }> };
  balances: { source: "statement" | "typed" | "unknown"; openingPaise: number | null; creditsPaise: number; creditCount: number; debitsPaise: number; debitCount: number; closingPaise: number | null;
    breaks: Array<{ kind: "day" | "equation" | "statement_open" | "statement_close"; day?: string; fileName?: string; expectedPaise: number | null; foundPaise: number | null; text: string }>; warnings: string[]; agreesWith: string | null };
  books: { receiptsPaise: number; receiptCount: number; excluded: { cashPaise: number; cashCount: number; razorpayPaise: number; razorpayCount: number; otherAccountsPaise: number; otherAccountsCount: number } };
  formula: Array<{ key: "books" | "not_credited" | "credited_other_month" | "unmatched" | "ignored" | "rounding" | "over_matched" | "credits"; label: string; paise: number; count: number }>;
  ties: boolean; items: BrsItem[]; openItems: { count: number; paise: number };
  debits: { totalPaise: number; lines: Array<{ id: string; day: string; amountPaise: number; refund: { id: string; number: string } | null; reversalOf: string | null; narration: string; redacted: boolean }> };
  fingerprint: string; state: BrsState;
  signoff: null | { id: string; version: number; reconciledAt: string; reconciledByName: string; note: string | null; accepted: string[]; balanceSource: string; closingPaise: number; booksPaise: number; openItemsPaise: number };
  versions: Array<{ version: number; reconciledAt: string; reconciledByName: string; supersedeKind: string | null; supersededAt: string | null; supersedeReason: string | null; supersededByName: string | null }>;
  reopened: null | { byName: string; at: string; reason: string | null };
  changes: null | { added: BrsItem[]; removed: BrsItem[]; figures: Array<{ key: string; frozenPaise: number | null; livePaise: number | null }>; newLines: Array<{ statementId: string; fileName: string; uploadedByName: string; uploadedAt: string; lines: number }> };
  blockers: Array<{ code: string; sentence: string }>; needsAck: Array<"open_items" | "coverage_gap" | "statement_break" | "typed_closing">; todo: ReconTodo[];
}
export interface BrsMonthsView {
  company: "dspl" | "dmpl"; account: BrsAccountRef | null; accounts: BrsView["accounts"]; defaultAccount: BrsView["defaultAccount"];
  months: Array<{ month: string; label: string; state: BrsState; creditsPaise: number; debitsPaise: number; lineCount: number; coverage: "complete" | "partial" | "none"; coverageNote: string | null;
    reconciledAt: string | null; reconciledByName: string | null; version: number | null }>;
}

// ─── smart-invoicing: tally (PR 2) ───
// Tally export / Send to Tally (spec-tally §3.4).
export type TallyDocType = "invoice" | "credit_note" | "receipt" | "refund";
export type TallyAction = "create" | "alter" | "cancel" | "unchanged" | "skip" | "blocked";
export interface TallyIssue {
  id: string; code: string; severity: "block" | "ack" | "info";
  docType?: TallyDocType; docId?: string; number?: string; message: string; fix?: { href: string; label: string };
}
export interface TallyRegistration { gstin: string; tallyCompany: string; registrationName: string | null; salesVoucherType: string | null; creditNoteVoucherType: string | null }
export interface TallySettings {
  release: "prime3" | "legacy"; booksFrom: string | null; registrations: TallyRegistration[]; gstr1Filing: "monthly" | "quarterly"; partyGroup: string;
  salesLedgers: Array<{ name: string; sac: string; gstRateBp: number }>;
  ledgers: { outputCgst: string; outputSgst: string; outputIgst: string; roundOff: string; tdsReceivable: string; bank: string | null; cash: string; gateway: string | null; other: string | null; zeroRatedSales: string | null };
  voucherTypes: { sales: string; creditNote: string; receipt: string; payment: string };
  createAccountLedgers: boolean; bankAllocations: boolean; ledgersConfirmed: boolean; pushUrl: string | null;
}
export interface TallySettingsView {
  company: "dspl" | "dmpl"; settings: TallySettings; saved: boolean; missing: string[];
  registrations: Array<{ gstin: string; label: string; state: string }>; pushEnabled: boolean;
}
export interface TallyDocRow {
  docType: TallyDocType; docId: string; number: string; date: string; party: string; partyAmountPaise: number; action: TallyAction;
  reason: "new" | "changed" | "resend" | "cancelled" | "needed" | "earlier_change" | null; issueIds: string[];
  lastSent: { runNo: number; at: string; action: string } | null;
  /** a credit note's invoice, a refund's receipt */
  parentId: string | null;
}
export type TallyGst = { count: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number };
export type TallyActionCounts = { create: number; alter: number; cancel: number };
export interface TallyShouldShow {
  gst: Array<{ gstin: string; label: string; month: string; b2b: TallyGst; b2c: TallyGst; sezwop?: TallyGst; expwop?: TallyGst; creditNotes: TallyGst; zeroRatedCreditNotes?: TallyGst; documents: { issued: number; cancelled: number; fromNo: string | null; toNo: string | null } }>;
  /** export / SEZ invoices are not in the file yet: they are entered in Tally by hand */
  zeroRatedByHand?: boolean;
  tds: Array<{ fy: string; ledger: string; paise: number; receipts: number }>;
}
export interface TallyPreview {
  company: "dspl" | "dmpl"; tallyCompany: string; scopeGstin: string | null; release: "prime3" | "legacy";
  period: { from: string; to: string; effectiveFrom: string; booksFrom: string };
  mode: "new_only" | "everything"; openRun: { id: string; runNo: number; status: string } | null;
  counts: {
    sales: TallyActionCounts; creditNotes: TallyActionCounts; receipts: TallyActionCounts; refunds: TallyActionCounts;
    vouchers: number; unchanged: number; skipped: number; blocked: number; beforeBooks: number; earlierChanges: number; pulledIn: number;
    masters: { partiesNew: number; accountLedgers: number };
  };
  totals: Record<"salesTaxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "roundOffPaise" | "salesTotalPaise" | "creditTotalPaise" | "receiptCashPaise" | "tdsPaise" | "refundPaise" | "controlTotalPaise", number>;
  tallyShouldShow: TallyShouldShow;
  ledgers: Array<{ role: string; name: string; group: string | null; createdByExport: boolean; debitPaise: number; creditPaise: number }>;
  issues: TallyIssue[]; documents: TallyDocRow[]; documentsTruncated: boolean; previewHash: string; canExport: boolean;
}
export interface TallyRunRow {
  id: string; companyKey: "dspl" | "dmpl"; runNo: number; tallyCompany: string; scopeGstin: string | null; periodFrom: string; periodTo: string;
  mode: string; channel: "file" | "push" | "manual"; status: string; voucherCount: number; masterCount: number; blockedCount: number;
  controlTotalPaise: number; createdBy: { id: string; name: string } | null; createdAt: string; closedAt: string | null;
}
export interface TallyRunView extends TallyRunRow {
  summary: Partial<TallyPreview>; acknowledged: Array<{ id: string; byId: string; at: string }>;
  pushTarget: string | null; pushResult: { error?: string | null; synced?: number; adopted?: number; failed?: number; unknown?: number } | null;
  tallyReported: { created: number; altered: number; cancelled: number; errors: number } | null; statusNote: string | null; previewHash: string;
  items: Array<{ id: string; docType: TallyDocType; docId: string; docNumber: string; docDate: string; voucherType: string; action: string; outcome: string;
    partyAmountPaise: number; issueCode: string | null; error: string | null; tallyVchId: string | null; attempts: number; parentId: string | null }>;
  itemsTruncated: boolean; progress: { done: number; failed: number; waiting: number; total: number } | null; stale: boolean;
  files: { masters: boolean; vouchers: boolean };
}
export interface TallyPartyRow { clientId: string; client: string; gstin: string | null; ledgerName: string; proposed: boolean; existsInTally: boolean; lockedAt: string | null; lastRunNo: number | null }
export interface TallyDocStatus { state: "not_set_up" | "never" | "before_books" | "pending" | "synced" | "changed" | "failed" | "cancelled_in_tally"; runId: string | null; runNo: number | null; at: string | null; error: string | null }
export interface TallyTestResult { reachable: true; latencyMs: number; server: string | null; openCompanies: string[]; missingCompanies: string[]; ledgers: Array<{ role: string; name: string; found: boolean }> }

// ─── smart-invoicing: import (PR 3) ───
// Old-invoice import from Swipe (spec-import §3.4) — mirrors apps/api/src/services/sales/imports.service.ts.
export type InvoiceSource = "portal" | "swipe";
export type ImportStatus = "draft" | "applying" | "applied" | "failed" | "undone";
export type ImportOutcome = "ready" | "warning" | "error" | "excluded" | "duplicate" | "imported" | "failed";
export type IssueLevel = "error" | "warning" | "info";
export interface ImportIssue { code: string; level: IssueLevel; message: string }
export type ImportFieldKey =
  | "number" | "issueDate" | "dueDate" | "docType" | "status" | "sellerGstin" | "placeOfSupply" | "poNumber" | "poDate" | "notes" | "irn"
  | "customerName" | "customerGstin" | "customerAddress" | "customerCity" | "customerState" | "customerPincode" | "customerCountry" | "customerEmail"
  | "itemName" | "itemDescription" | "hsnSac" | "quantity" | "rate" | "lineDiscount" | "gstRate"
  | "taxable" | "discount" | "cgst" | "sgst" | "igst" | "totalTax" | "cess" | "tcs" | "roundOff" | "total"
  | "amountPaid" | "tds" | "balance" | "paidOn";
export type MappingHow = "auto" | "check" | "user" | "previous" | "missing";
export interface ImportOptions { dateOrder: "auto" | "dmy" | "mdy"; amountLevel: "auto" | "line" | "invoice"; paidIncludesTds: "auto" | "yes" | "no"; registration: string; fillMissingProfiles: boolean; exclude: string[] }
export interface ImportListRow {
  id: string; companyKey: "dspl" | "dmpl"; status: ImportStatus; fileName: string; createdAt: string; createdByName: string | null;
  counts: { rows: number; found: number; ready: number; imported: number; skipped: number; failed: number; clientsMatched: number; clientsCreated: number; payments: number };
  totalPaise: number; appliedAt: string | null; undoneAt: string | null;
  undo: { allowed: boolean; blockedBy: string | null } | null;
}
export type ClientDecision = { action: "match"; clientId: string; clientName: string; by: "gstin" | "name" | "user" } | { action: "create"; by: "auto" | "user" } | { action: "choose" };
export interface ImportSummary {
  generatedAt: string; blockers: ImportIssue[]; notices: ImportIssue[];
  amountLevels: Partial<Record<string, "line" | "invoice">>; dateOrder: "dmy" | "mdy"; paidIncludesTds: boolean | null;
  outcomes: Record<"ready" | "warning" | "error" | "excluded" | "duplicate", number>;
  issueCounts: Array<{ code: string; level: IssueLevel; invoices: number }>;
  toImport: { invoices: number; cancelled: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number; receipts: number; paidPaise: number; tdsPaise: number; outstandingPaise: number };
  byFy: Array<{ fy: string; invoices: number; cancelled: number; b2bTaxablePaise: number; b2cTaxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number; paidPaise: number; tdsPaise: number; outstandingPaise: number }>;
  byRegistration: Array<{ gstin: string; label: string; fy: string; invoices: number; taxablePaise: number; taxPaise: number; firstNumber: string | null; lastNumber: string | null; inFormat: number; offFormat: number; sequenceKey: string; nextBefore: string; nextAfter: string; live: boolean; gaps: string[] }>;
  clientGroups: Array<{ groupKey: string; name: string; gstin: string | null; invoices: number; totalPaise: number; decision: ClientDecision; candidates: Array<{ clientId: string; name: string; gstin: string | null; reason: string }> }>;
  liveSeriesMoves: Array<{ label: string; from: string; to: string }>;
  rowsRead: number; firstFy: string | null; lastFy: string | null;
  reconcile?: { ok: boolean; byFy: Array<{ fy: string; invoices: number; taxablePaise: number; taxPaise: number; totalPaise: number; planTotalPaise: number }> };
}
export interface ImportView extends ImportListRow {
  source: "swipe"; stale: boolean;
  file: { sha256: string; bytes: number; kind: "csv" | "xlsx" | "xls"; sheet: string | null; sheets: string[]; headerRow: number };
  columns: Array<{ index: number; header: string; samples: string[] }>;
  mapping: Partial<Record<ImportFieldKey, number | null>>;
  mappingHow: Partial<Record<ImportFieldKey, MappingHow>>;
  options: ImportOptions; summary: ImportSummary | null; planHash: string;
  landed: { taxablePaise: number; taxPaise: number; totalPaise: number; paidPaise: number; tdsPaise: number };
  checkedAt: string | null; appliedByName: string | null; undoneByName: string | null; undoReason: string | null;
  sameFile: Array<{ id: string; status: ImportStatus; createdAt: string }>;
  lastError: string | null;
}
export interface ImportInvoiceRow {
  key: string; number: string; rowNos: number[]; issueDate: string | null; fy: string | null;
  customer: { name: string; gstin: string | null; groupKey: string; clientId: string | null; clientName: string | null; decision: "gstin" | "name" | "user" | "new" | "choose" };
  registration: { gstin: string; label: string; claimSeries: boolean } | null;
  docStatus: "issued" | "cancelled" | null; swipeStatus: string | null; taxMode: TaxMode | null; gstRateBp: number | null;
  taxablePaise: number | null; cgstPaise: number | null; sgstPaise: number | null; igstPaise: number | null; roundOffPaise: number | null; totalPaise: number | null;
  paidPaise: number; tdsPaise: number; outcome: ImportOutcome; issues: ImportIssue[];
  invoiceId: string | null; paymentId: string | null; error: string | null;
}

// ─── smart-invoicing: bank (PR 4) ───
export type BankPreset = "idfc" | "icici" | "hdfc" | "sbi" | "axis" | "kotak" | "yes" | "other";
export type BankLineStatus = "unmatched" | "suggested" | "partly_matched" | "matched" | "ignored";
export type BankConfidence = "high" | "medium" | "low";
export interface BankAccount {
  id: string; companyKey: string; label: string; bank: BankPreset; accountNumber: string; last4: string; ifsc: string | null;
  matchFrom: string | null; status: "active" | "archived"; lastStatementTo: string | null; createdAt: string;
}
export interface BankMapping {
  sheet?: string | null; headerRow: number;
  columns: { date: number; valueDate?: number | null; narration: number; reference?: number | null; debit?: number | null; credit?: number | null; amount?: number | null; drCr?: number | null; balance?: number | null };
  dateOrder: "dmy" | "mdy" | "ymd"; amountStyle: "split" | "drcr_column" | "suffix" | "signed_credit_positive" | "signed_debit_positive";
}
export interface StatementPreview {
  fileName: string; fileSha256: string; fileBytes: number; format: string; sheets: string[]; sheet: string | null;
  preset: BankPreset | null; presetLabel: string | null; headerRow: number | null; headers: string[]; firstRows: string[][];
  mapping: BankMapping | null; mappingSource: "given" | "last_used" | "detected" | null; needs: Array<"columns" | "dateFormat" | "amountSign">;
  accountCheck: { status: "match" | "mismatch" | "not_stated"; found: string | null };
  counts: { rows: number; credits: number; debits: number; skipped: number; errors: number; alreadyImported: number; possibleDuplicates: number; newLines: number; beforeCutover: number };
  totals: { creditsPaise: number; debitsPaise: number; openingPaise: number | null; closingPaise: number | null };
  period: { from: string; to: string } | null;
  balanceCheck: { status: "ok" | "breaks" | "no_balance_column"; breaks: Array<{ rowNo: number; expectedPaise: number; foundPaise: number }> };
  skipped: Array<{ rowNo: number; reason: string }>; errors: Array<{ rowNo: number; message: string }>;
  sample: Array<{ rowNo: number; txnDate: string; narration: string; reference: string | null; debitPaise: number | null; creditPaise: number | null; balancePaise: number | null; alreadyImported: boolean }>;
  duplicateOf: { statementId: string; fileName: string; createdAt: string } | null;
  blockers: string[]; warnings: string[]; canImport: boolean;
}
export interface BankStatementRow {
  id: string; companyKey: string; bankAccountId: string; account: { label: string; bank: string; last4: string }; fileName: string; format: string;
  periodFrom: string; periodTo: string; rowCount: number; newLineCount: number; duplicateCount: number; skippedCount: number;
  creditTotalPaise: number; debitTotalPaise: number; openingBalancePaise: number | null; closingBalancePaise: number | null;
  warnings: string[] | null; uploadedById: string; createdAt: string; lineCounts: Record<BankLineStatus, number>;
}
export interface ImportResult { statement: BankStatementRow; newLines: number; duplicates: number; credits: number; debits: number; autoLinked: number; suggested: number; sure: number; unmatched: number; matching?: "done" | "running" }
export interface BankCandidate {
  kind: "invoice" | "advance"; codes: string[]; score: number; confidence: BankConfidence; clientId: string; client: { id: string; companyName: string };
  amountPaise: number; tdsPaise: number; tdsRateBp: number | null; tdsBase: "taxable" | "gross" | null; tdsSection: string | null;
  allocations: Array<{ invoiceId: string; number: string; amountPaise: number; tdsPaise: number; balancePaise: number; liveBalancePaise: number; dueDate: string | null }>;
  advancePaise: number; reasons: string[]; stale: boolean;
}
export interface BankLineView {
  id: string; companyKey: string; bankAccountId: string; account: { label: string; bank: string; last4: string }; statementId: string; statement: { fileName: string };
  rowNo: number; txnDate: string; valueDate: string | null; narration: string; reference: string | null; utr: string | null; redacted?: true;
  creditPaise: number; debitPaise: number; balancePaise: number | null; status: BankLineStatus; matchedPaise: number; remainingPaise: number; possibleDuplicate: boolean;
  bestScore: number | null; confidence: BankConfidence | null; ignoreReason: string | null; ignoreNote: string | null;
  suggestion: {
    candidates: BankCandidate[]; receiptCandidates: Array<{ paymentId: string; number: string; clientId: string; clientName: string; amountPaise: number; paidOn: string; why: string }>;
    conflict: { lineId: string; txnDate: string; invoiceNumber: string } | null; ignoreHint: { reason: string; why: string } | null; note: "too_large" | null;
  } | null;
  debitHint: { refund?: { id: string; number: string }; reversalOf?: { lineId: string; txnDate: string; receiptNumbers: string[] } } | null;
  receipts: Array<{ id: string; number: string; clientName: string; amountPaise: number; tdsPaise: number; status: "recorded" | "voided"; paidOn: string | null }>;
}
export interface BankSummary {
  unmatchedMonthCount: number; unmatchedMonthPaise: number; openCount: number; openPaise: number; reviewCount: number; sureCount: number;
  accounts: Array<{ id: string; label: string; last4: string; lastStatementTo: string | null }>;
}
export interface BankLinesResponse { lines: BankLineView[]; counts: { review: number; sure: number; matched: number; ignored: number; debits: number }; summary: BankSummary | null }
export interface LineReceipt { paymentId: string; number: string; clientId: string; clientName: string; amountPaise: number; tdsPaise: number; paidOn: string | null; reference: string | null; mode: string; days: number; imported: boolean; why: string }
