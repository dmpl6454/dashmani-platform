// Shapes of the /v1/sales/* responses the pages read. Money is integer paise.
export type TaxMode = "intra" | "inter" | "none";

export interface SellerProfile {
  legalName: string; tradeName?: string | null; gstin?: string | null; pan?: string | null;
  addressLine1?: string | null; addressLine2?: string | null; city?: string | null; state?: string | null; stateCode?: string | null; pincode?: string | null;
  email?: string | null; billingEmails?: string[]; phone?: string | null; website?: string | null;
  bankName?: string | null; accountName?: string | null; accountNumber?: string | null; ifsc?: string | null; upiId?: string | null;
  invoicePrefix: string; quotePrefix: string; orderPrefix: string; creditNotePrefix: string; receiptPrefix: string;
  defaultSac: string; defaultGstRateBp: number; defaultDueDays: number; roundToRupee: boolean; terms?: string | null; signatory?: string | null;
  /** Additional GST registrations in other states; a client in that state is billed from it. */
  branches: SellerBranch[];
  eInvoicing: { enabled: boolean; applicableFrom?: string | null; thirtyDayLimit: boolean };
}
export interface SellerBranch {
  label: string; gstin: string; stateCode?: string | null; state?: string | null; addressLine1: string; addressLine2?: string | null; city: string; pincode: string;
  invoicePrefix: string; creditNotePrefix: string;
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
}
export interface InvoiceRow extends DocumentTotals {
  id: string; companyKey: string; number: string | null; kind: string; status: string; derivedStatus: DerivedInvoiceStatus; issueDate: string | null; dueDate: string | null;
  paidPaise: number; tdsPaise: number; creditedPaise: number; balancePaise: number; clientId: string; client?: { id: string; companyName: string; billingProfile?: { legalName: string } | null };
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
  items: Array<{ id: string; platform: string; format: string; accountName: string; accountHandle: string | null; pricePaise: number; audioAddonPaise: number; status: string; permalink: string | null; postedAt: string | null; live: boolean; billed: boolean }>;
  billable: boolean; billablePaise: number; invoices: BookingInvoice[];
}
export interface BookingsSummary {
  review: { count: number; totalPaise: number }; active: { count: number; totalPaise: number }; live: { count: number; totalPaise: number };
  toInvoice: { count: number; totalPaise: number };
  recentToInvoice: Array<{ id: string; name: string; brand: string; status: string; statusLabel: string; client: string; billablePaise: number }>;
}
export interface Dashboard {
  company: string; today: string; bookings?: BookingsSummary; financialYear: string; ordersByFy: Array<{ financialYear: string; count: number; totalPaise: number; closedPaise: number }>; invoicedFyPaise: number; invoicedFyCount: number; invoicedMonthPaise: number; collectedFyPaise: number; tdsFyPaise: number; collectedMonthPaise: number;
  outstandingPaise: number; outstandingCount: number; overduePaise: number; overdueCount: number;
  openQuotes: { count: number; totalPaise: number }; acceptedQuotes: { count: number; totalPaise: number }; activeOrders: { count: number; totalPaise: number }; deliveredOrders: { count: number; totalPaise: number };
  topClients: Array<{ clientId: string; name: string; invoicedPaise: number }>; byPlatform: Array<{ platform: string; lines: number; amountPaise: number }>; recent: SalesEvent[];
}
