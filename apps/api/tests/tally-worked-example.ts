/**
 * The spec-tally §4.8 worked example as pure documents — shared by the pure XML tests. Not a test
 * file itself (no .test suffix).
 */
import { tallySettingsSchema } from "@dashmani/shared";
import type { ClientInfo, LastGood, PlanDoc, PlanInput } from "../src/services/sales/tally/plan";
import type { CreditNoteDoc, InvoiceDoc, ReceiptDoc, RefundDoc } from "../src/services/sales/tally/vouchers";

export const SETTINGS = tallySettingsSchema.parse({
  release: "prime3",
  booksFrom: "2026-11-01",
  registrations: [
    { gstin: "27AAKCD3352K1ZF", tallyCompany: "Digital Sukoon Private Limited", registrationName: "Maharashtra Registration" },
    { gstin: "06AAKCD3352K1ZJ", tallyCompany: "Digital Sukoon Private Limited", registrationName: "Haryana Registration" },
  ],
  ledgers: { bank: "IDFC First Bank A/c 8788" },
  ledgersConfirmed: true,
});

export const CLIENT_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
export const CLIENT: ClientInfo = {
  id: CLIENT_ID, companyName: "Filmy Brands", legalName: "Filmy Brands Private Limited", gstin: "27AABCU9603R1ZX", pan: "AABCU9603R",
  addressLine1: "Bandra", addressLine2: null, city: "Mumbai", pincode: "400050", stateCode: "27", country: "IN",
};
const BUYER = { legalName: "Filmy Brands Private Limited", companyName: "Filmy Brands", gstin: "27AABCU9603R1ZX", pan: "AABCU9603R", addressLine1: "Bandra", addressLine2: null, city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400050", country: "IN" };
const SELLER = { gstin: "27AAKCD3352K1ZF", stateCode: "27", state: "Maharashtra", legalName: "Digital Sukoon Private Limited" };

export const INV: InvoiceDoc = {
  id: "6b0c2f9e-1d2a-4c55-9a51-3f0e8c7d1a10", companyKey: "dspl", number: "INV/26-27/0016", kind: "tax_invoice", issueDate: "2026-11-05", status: "issued",
  cancelledDay: null, cancelReason: null, clientId: CLIENT_ID, placeOfSupplyCode: "27", taxMode: "intra", gstRateBp: 1800,
  seller: SELLER, buyer: BUYER,
  taxablePaise: 10_000_000, cgstPaise: 900_000, sgstPaise: 900_000, igstPaise: 0, roundOffPaise: 0, totalPaise: 11_800_000,
  notes: null, poNumber: "FB/PO/2211", poDate: "2026-11-01", orderNumber: "SO/26-27/0042", irn: null,
  items: [{ description: "Instagram reel - Diwali campaign", sac: "998365", amountPaise: 10_000_000 }],
};

export const RCPT_ID = "c3e5d0a1-77b2-4e91-b0f4-2a9d6c8e1f05";
const alloc = (amountPaise: number) => ({
  invoiceId: INV.id, amountPaise, tdsPaise: 200_000, createdAt: "2026-11-20T06:00:00.000Z", invoiceNumber: INV.number, invoiceKind: "tax_invoice",
  invoiceStatus: "paid", invoiceDate: INV.issueDate, invoiceGstin: SELLER.gstin,
});
export const RCPT: ReceiptDoc = {
  id: RCPT_ID, companyKey: "dspl", number: "RCPT/26-27/0021", clientId: CLIENT_ID, amountPaise: 11_600_000, tdsPaise: 200_000, mode: "bank_transfer",
  reference: "IDFBR52026112012345", paidOn: "2026-11-20", notes: null, status: "recorded", voidedDay: null, voidReason: null, allocations: [alloc(11_600_000)],
};
/** After the 10 Dec credit note, releaseExcess hands ₹11,800 back to the receipt. */
export const RCPT_AFTER_CN: ReceiptDoc = { ...RCPT, allocations: [alloc(10_420_000)] };

export const CN: CreditNoteDoc = {
  id: "9d41a7c2-5b3e-4f0a-8c2d-71e6b9a04f33", number: "CN/26-27/0001", issueDate: "2026-12-10", status: "issued", cancelledDay: null,
  reason: "Post-sale discount: 1 story not delivered", clientId: CLIENT_ID,
  taxablePaise: 1_000_000, cgstPaise: 90_000, sgstPaise: 90_000, igstPaise: 0, totalPaise: 1_180_000, invoice: INV,
};

export const REFUND: RefundDoc = {
  id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", number: "RF/26-27/0001", paymentId: RCPT_ID, receiptNumber: RCPT.number, receiptStatus: "recorded",
  clientId: CLIENT_ID, amountPaise: 500_000, mode: "bank_transfer", reference: "NEFT991", refundedOn: "2026-12-15", notes: null, status: "issued",
  cancelledDay: null, receiptAllocations: RCPT_AFTER_CN.allocations,
};

const doc = (d: PlanDoc["d"], origin: PlanDoc["origin"] = "period"): PlanDoc => ({ d, routeGstin: SELLER.gstin, tallyCompany: "Digital Sukoon Private Limited", origin });
export { doc };

export function planInput(over: Partial<PlanInput> = {}): PlanInput {
  return {
    company: "dspl", tallyCompany: "Digital Sukoon Private Limited", scopeGstin: null, scopeGstins: ["27AAKCD3352K1ZF", "06AAKCD3352K1ZJ"],
    registrations: [{ gstin: "27AAKCD3352K1ZF", label: "Mumbai", state: "Maharashtra" }, { gstin: "06AAKCD3352K1ZJ", label: "Gurugram", state: "Haryana" }],
    release: "prime3", mode: "new_only", from: "2026-11-01", to: "2026-11-30", effectiveFrom: "2026-11-01", booksFrom: "2026-11-01", today: "2026-12-02",
    settings: SETTINGS, defaultSac: "998365", docs: [], lastGood: new Map<string, LastGood>(), mappings: [], clients: new Map([[CLIENT_ID, CLIENT]]),
    beforeBooks: 0, openRun: null, firstExport: false, settingsUpdatedAt: "2026-11-01T00:00:00.000Z", stateVersion: "0:-",
    ...over,
  };
}
