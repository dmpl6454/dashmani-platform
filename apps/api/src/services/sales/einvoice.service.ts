import { prisma, Prisma } from "@dashmani/db";
import { DEFAULT_COMPANY, isCompanyKey, todayIST, type CompanyKey } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { dateToDay, logSalesEvent, type Tx } from "./common";
import { getSellerOrDefaults, type SellerProfile } from "./settings.service";
import { getIrpProvider, IrpError, type IrpResult } from "./irp/provider";

// E-invoicing: tax invoices to GST-registered buyers (B2B), SEZ units and exports — and the credit
// notes against them — are registered on the government IRP, which returns the IRN, an
// acknowledgement and a signed QR code that the PDF prints. The registration lives in
// sales_einvoices (one row per document). Rules kept here:
//  - applicability is decided per document from the seller's settings (enabled, applicable-from
//    date); B2C documents are never registered;
//  - the data the IRP insists on (both parties' address, city, PIN, state) is checked BEFORE the
//    document takes its serial, so a number is never spent on a document that cannot register;
//  - registration runs after the issuing transaction commits; failures are recorded, visible and
//    retryable; a retry first asks the IRP whether it already holds the document, and a duplicate
//    answer (2150) is adopted, so a timeout can never produce a second IRN;
//  - an IRN can be cancelled only within 24 hours of registration; after that the correction is a
//    credit note (enforced by the cancel paths).

type Party = {
  legalName?: string | null; companyName?: string | null; tradeName?: string | null; gstin?: string | null;
  addressLine1?: string | null; addressLine2?: string | null; city?: string | null; pincode?: string | null;
  stateCode?: string | null; country?: string | null; phone?: string | null; email?: string | null;
};

export type EInvoiceRow = Prisma.SalesEInvoiceGetPayload<object>;

const rupees = (paise: number) => Math.round(paise) / 100;
const ddmmyyyy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const cut = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const pin = (s: string | null | undefined) => {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length === 6 ? Number(d) : null;
};
const isExport = (buyer: Party) => !!buyer.country && buyer.country.toUpperCase() !== "IN";

/** Does a document of this buyer, dated `day`, need an IRN under the seller's settings? */
export function needsEInvoice(seller: SellerProfile, buyer: Party, day: string): boolean {
  const e = seller.eInvoicing;
  if (!e?.enabled) return false;
  if (e.applicableFrom && day < e.applicableFrom) return false;
  return !!buyer.gstin || isExport(buyer);
}

/** The fields the IRP rejects a document without — checked before a serial is taken. */
export function missingForEInvoice(seller: Party, buyer: Party): string[] {
  const out: string[] = [];
  if (!seller.gstin) out.push("company GSTIN");
  if (!cut(seller.addressLine1, 100) || cut(seller.addressLine1, 100).length < 3) out.push("company address");
  if (!cut(seller.city, 50) || cut(seller.city, 50).length < 3) out.push("company city");
  if (!pin(seller.pincode)) out.push("company PIN code");
  if (!cut(buyer.legalName ?? buyer.companyName, 100)) out.push("client legal name");
  if (!cut(buyer.addressLine1, 100) || cut(buyer.addressLine1, 100).length < 3) out.push("client address");
  if (!cut(buyer.city, 50) || cut(buyer.city, 50).length < 3) out.push("client city");
  if (!isExport(buyer)) {
    if (!pin(buyer.pincode)) out.push("client PIN code");
    if (!buyer.stateCode) out.push("client state");
  }
  return out;
}

export function assertEInvoiceData(seller: Party, buyer: Party): void {
  const missing = missingForEInvoice(seller, buyer);
  if (missing.length) {
    throw new AppError(422, "EINVOICE_DATA_MISSING", `This document must be registered for e-invoicing, and the IRP needs: ${missing.join(", ")}. Fill them in (Settings / the client's billing profile) and issue again.`);
  }
}

/** Split `total` across weights so the parts add up exactly (largest remainder). */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!sum) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (total * w) / sum);
  const base = raw.map(Math.floor);
  let left = total - base.reduce((s, v) => s + v, 0);
  raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f).forEach(({ i }) => { if (left > 0) { base[i]++; left--; } });
  return base;
}

function sellerDtls(s: Party) {
  return {
    Gstin: s.gstin, LglNm: cut(s.legalName, 100), ...(s.tradeName ? { TrdNm: cut(s.tradeName, 100) } : {}),
    Addr1: cut(s.addressLine1, 100), ...(s.addressLine2 ? { Addr2: cut(s.addressLine2, 100) } : {}),
    Loc: cut(s.city, 50), Pin: pin(s.pincode), Stcd: s.stateCode,
    ...(s.phone && /^\d{6,12}$/.test(s.phone.replace(/\D/g, "")) ? { Ph: s.phone.replace(/\D/g, "") } : {}),
    ...(s.email ? { Em: cut(s.email, 100) } : {}),
  };
}

function buyerDtls(b: Party, pos: string | null) {
  const exp = isExport(b);
  return {
    Gstin: exp ? "URP" : b.gstin, LglNm: cut(b.legalName ?? b.companyName, 100),
    Pos: exp ? "96" : (pos ?? b.stateCode),
    Addr1: cut(b.addressLine1, 100), ...(b.addressLine2 ? { Addr2: cut(b.addressLine2, 100) } : {}),
    Loc: cut(b.city, 50), Pin: exp ? 999999 : pin(b.pincode), Stcd: exp ? "96" : b.stateCode,
  };
}

function supplyType(taxMode: string, buyer: Party) {
  if (isExport(buyer)) return taxMode === "none" ? "EXPWOP" : "EXPWP";
  return taxMode === "none" ? "SEZWOP" : "B2B";
}

type InvoiceForIrp = Prisma.SalesInvoiceGetPayload<{ include: { items: true } }>;

/** INV-01 (v1.1) for a tax invoice. Line discounts and tax are apportioned so every total reconciles. */
export function buildInvoicePayload(inv: InvoiceForIrp) {
  const seller = (inv.sellerSnapshot ?? {}) as Party;
  const buyer = (inv.buyerSnapshot ?? {}) as Party;
  const items = [...inv.items].sort((a, b) => a.position - b.position);
  const nets = items.map((it) => it.amountPaise);
  const docDisc = apportion(inv.discountPaise, nets);
  const ass = nets.map((n, i) => n - docDisc[i]);
  const cg = apportion(inv.cgstPaise, ass), sg = apportion(inv.sgstPaise, ass), ig = apportion(inv.igstPaise, ass);
  const rate = inv.taxMode === "none" ? 0 : inv.gstRateBp / 100;
  const day = dateToDay(inv.issueDate)!;
  return {
    Version: "1.1",
    TranDtls: { TaxSch: "GST", SupTyp: supplyType(inv.taxMode, buyer), RegRev: "N", IgstOnIntra: "N" },
    DocDtls: { Typ: "INV", No: inv.number, Dt: ddmmyyyy(day) },
    SellerDtls: sellerDtls(seller),
    BuyerDtls: buyerDtls(buyer, inv.placeOfSupplyCode),
    ItemList: items.map((it, i) => ({
      SlNo: String(i + 1), PrdDesc: cut(it.description, 300), IsServc: "Y", HsnCd: it.sac ?? "998365",
      Qty: it.quantity, Unit: "OTH", UnitPrice: rupees(it.unitPricePaise), TotAmt: rupees(it.quantity * it.unitPricePaise),
      Discount: rupees(it.discountPaise + docDisc[i]), AssAmt: rupees(ass[i]), GstRt: rate,
      IgstAmt: rupees(ig[i]), CgstAmt: rupees(cg[i]), SgstAmt: rupees(sg[i]), TotItemVal: rupees(ass[i] + cg[i] + sg[i] + ig[i]),
    })),
    ValDtls: {
      AssVal: rupees(inv.taxablePaise), CgstVal: rupees(inv.cgstPaise), SgstVal: rupees(inv.sgstPaise), IgstVal: rupees(inv.igstPaise),
      RndOffAmt: rupees(inv.roundOffPaise), TotInvVal: rupees(inv.totalPaise),
    },
    ...(isExport(buyer) ? { ExpDtls: { CntCode: buyer.country!.toUpperCase(), ForCur: "INR" } } : {}),
  };
}

type CreditNoteForIrp = Prisma.SalesCreditNoteGetPayload<{ include: { invoice: { include: { items: { take: 1; orderBy: { position: "asc" } } } } } }>;

/** INV-01 for a credit note: one line, referring to the original invoice. */
export function buildCreditNotePayload(cn: CreditNoteForIrp) {
  const inv = cn.invoice;
  const seller = (inv.sellerSnapshot ?? {}) as Party;
  const buyer = (inv.buyerSnapshot ?? {}) as Party;
  const tax = cn.cgstPaise + cn.sgstPaise + cn.igstPaise;
  const rate = cn.taxMode === "none" ? 0 : cn.gstRateBp / 100;
  return {
    Version: "1.1",
    TranDtls: { TaxSch: "GST", SupTyp: supplyType(cn.taxMode, buyer), RegRev: "N", IgstOnIntra: "N" },
    DocDtls: { Typ: "CRN", No: cn.number, Dt: ddmmyyyy(dateToDay(cn.issueDate)!) },
    SellerDtls: sellerDtls(seller),
    BuyerDtls: buyerDtls(buyer, inv.placeOfSupplyCode),
    ItemList: [{
      SlNo: "1", PrdDesc: cut(cn.reason, 300), IsServc: "Y", HsnCd: inv.items[0]?.sac ?? "998365",
      Qty: 1, Unit: "OTH", UnitPrice: rupees(cn.taxablePaise), TotAmt: rupees(cn.taxablePaise), Discount: 0, AssAmt: rupees(cn.taxablePaise),
      GstRt: rate, IgstAmt: rupees(cn.igstPaise), CgstAmt: rupees(cn.cgstPaise), SgstAmt: rupees(cn.sgstPaise), TotItemVal: rupees(cn.taxablePaise + tax),
    }],
    ValDtls: {
      AssVal: rupees(cn.taxablePaise), CgstVal: rupees(cn.cgstPaise), SgstVal: rupees(cn.sgstPaise), IgstVal: rupees(cn.igstPaise),
      RndOffAmt: rupees(cn.totalPaise - cn.taxablePaise - tax), TotInvVal: rupees(cn.totalPaise),
    },
    RefDtls: { PrecDocDtls: [{ InvNo: inv.number, InvDt: ddmmyyyy(dateToDay(inv.issueDate)!) }] },
    ...(isExport(buyer) ? { ExpDtls: { CntCode: buyer.country!.toUpperCase(), ForCur: "INR" } } : {}),
  };
}

/** Inside the issuing transaction: record that this tax invoice needs an IRN (registered after commit). */
export async function queueInvoiceEInvoice(tx: Tx, invoiceId: string): Promise<string> {
  const inv = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { items: true } });
  const payload = buildInvoicePayload(inv);
  const row = await tx.salesEInvoice.create({
    data: { docType: "INV", invoiceId, gstin: payload.SellerDtls.Gstin as string, docNumber: inv.number!, docDate: payload.DocDtls.Dt, payload: payload as Prisma.InputJsonValue },
    select: { id: true },
  });
  return row.id;
}

export async function queueCreditNoteEInvoice(tx: Tx, creditNoteId: string): Promise<string> {
  const cn = await tx.salesCreditNote.findUniqueOrThrow({ where: { id: creditNoteId }, include: { invoice: { include: { items: { take: 1, orderBy: { position: "asc" } } } } } });
  const payload = buildCreditNotePayload(cn);
  const row = await tx.salesEInvoice.create({
    data: { docType: "CRN", creditNoteId, gstin: payload.SellerDtls.Gstin as string, docNumber: cn.number, docDate: payload.DocDtls.Dt, payload: payload as Prisma.InputJsonValue },
    select: { id: true },
  });
  return row.id;
}

const istInstant = (s: string) => {
  const t = Date.parse(`${s.trim().replace(" ", "T")}+05:30`);
  return Number.isFinite(t) ? new Date(t) : new Date();
};

/**
 * Register (or retry) one document on the IRP. Claims the row first, so two clicks never call the
 * IRP twice at once; a retry asks the IRP for the document before generating again. Never throws
 * for an IRP failure — the row records it — so issuing is not undone by a portal outage.
 */
/** The company whose document this registration is (a credit note's is its invoice's). */
async function companyOfEInvoice(row: { invoiceId: string | null; creditNoteId: string | null }): Promise<CompanyKey> {
  const inv = row.invoiceId
    ? await prisma.salesInvoice.findUnique({ where: { id: row.invoiceId }, select: { companyKey: true } })
    : await prisma.salesCreditNote.findUnique({ where: { id: row.creditNoteId! }, select: { invoice: { select: { companyKey: true } } } }).then((c) => c?.invoice ?? null);
  return isCompanyKey(inv?.companyKey) ? inv.companyKey : DEFAULT_COMPANY;
}

export async function registerEInvoice(id: string, actorId: string | null = null): Promise<EInvoiceRow | null> {
  const staleClaim = new Date(Date.now() - 2 * 60_000);
  const claimed = await prisma.salesEInvoice.updateMany({
    where: { id, OR: [{ status: { in: ["pending", "failed"] } }, { status: "registering", updatedAt: { lt: staleClaim } }] },
    data: { status: "registering", attempts: { increment: 1 } },
  });
  const row = await prisma.salesEInvoice.findUnique({ where: { id } });
  if (!row || !claimed.count) return row;
  const entity = row.invoiceId ? { entityType: "invoice" as const, entityId: row.invoiceId } : { entityType: "credit_note" as const, entityId: row.creditNoteId! };
  const fail = async (message: string) => {
    const r = await prisma.salesEInvoice.update({ where: { id }, data: { status: "failed", lastError: message } });
    await logSalesEvent(prisma, { ...entity, actorId, action: "einvoice_failed", note: message.slice(0, 280) });
    return r;
  };
  const provider = getIrpProvider();
  if (!provider) return fail("E-invoicing is switched on, but no IRP connection is configured yet (EINVOICE_PROVIDER and the e-invoice API credentials). The document stays unregistered until then.");
  const seller = await getSellerOrDefaults(await companyOfEInvoice(row));
  if (seller.eInvoicing?.thirtyDayLimit) {
    const [d, m, y] = row.docDate.split("/");
    const age = (Date.parse(`${todayIST()}T00:00:00Z`) - Date.parse(`${y}-${m}-${d}T00:00:00Z`)) / 86_400_000;
    if (age > 30) return fail(`Dated ${row.docDate}: more than 30 days ago, so the IRP will not accept it (AATO ₹10 crore+). Issue a fresh document.`);
  }
  try {
    let res: IrpResult | null = null;
    if (row.attempts > 1) res = await provider.getByDocument(row.gstin, row.docType, row.docNumber, row.docDate);
    if (!res) res = await provider.generate(row.gstin, row.payload);
    return await registered(id, res, entity, actorId);
  } catch (e) {
    if (e instanceof IrpError && e.existing?.irn) {
      // Already registered (a timeout ate the first answer): adopt it, with the full record if the IRP gives it.
      const full = await provider.getByDocument(row.gstin, row.docType, row.docNumber, row.docDate).catch(() => null);
      return registered(id, full ?? { irn: e.existing.irn, ackNo: e.existing.ackNo, ackDate: e.existing.ackDate, signedInvoice: "", signedQrCode: "" }, entity, actorId);
    }
    return fail(e instanceof Error ? e.message : "IRP call failed");
  }
}

async function registered(id: string, res: IrpResult, entity: { entityType: "invoice" | "credit_note"; entityId: string }, actorId: string | null) {
  const r = await prisma.salesEInvoice.update({
    where: { id },
    data: {
      status: "registered", irn: res.irn, ackNo: res.ackNo, ackDate: istInstant(res.ackDate),
      signedInvoice: res.signedInvoice || null, signedQrCode: res.signedQrCode || null, lastError: null,
    },
  });
  await logSalesEvent(prisma, { ...entity, actorId, action: "einvoice_registered", note: `IRN ${res.irn.slice(0, 16)}… · Ack ${res.ackNo}` });
  return r;
}

/**
 * Before cancelling a document: cancel its IRN on the IRP (only within 24 hours of registration).
 * An unregistered row is simply marked cancelled. Call BEFORE the document's own cancellation.
 */
export async function cancelEInvoiceFor(where: { invoiceId: string } | { creditNoteId: string }, reason: string, actorId: string): Promise<void> {
  const row = await prisma.salesEInvoice.findFirst({ where });
  if (!row || row.status === "cancelled") return;
  if (row.status === "registering") throw new AppError(409, "EINVOICE_BUSY", "The e-invoice is being registered right now — try again in a minute");
  if (row.status === "registered") {
    if (!row.ackDate || Date.now() - row.ackDate.getTime() > 24 * 3600_000) {
      throw new AppError(409, "IRN_CANCEL_WINDOW", "This document's e-invoice (IRN) was registered more than 24 hours ago and can no longer be cancelled — issue a credit note instead");
    }
    const provider = getIrpProvider();
    if (!provider) throw new AppError(503, "EINVOICE_NOT_CONNECTED", "The IRP connection is not configured, so the IRN cannot be cancelled");
    try {
      await provider.cancel(row.gstin, row.irn!, "4", reason);
    } catch (e) {
      throw new AppError(502, "IRN_CANCEL_FAILED", `The IRP refused to cancel the IRN: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }
  await prisma.salesEInvoice.update({ where: { id: row.id }, data: { status: "cancelled", cancelledAt: new Date(), cancelReason: reason.slice(0, 100) } });
  const entity = row.invoiceId ? { entityType: "invoice" as const, entityId: row.invoiceId } : { entityType: "credit_note" as const, entityId: row.creditNoteId! };
  await logSalesEvent(prisma, { ...entity, actorId, action: "einvoice_cancelled", note: row.irn ? `IRN ${row.irn.slice(0, 16)}… cancelled` : "unregistered e-invoice withdrawn" });
}

/** Retry from the portal (the Retry button). */
export async function retryEInvoice(where: { invoiceId: string } | { creditNoteId: string }, actorId: string) {
  const row = await prisma.salesEInvoice.findFirst({ where });
  if (!row) throw new AppError(404, "NOT_FOUND", "This document has no e-invoice to register");
  if (row.status === "registered") return row;
  if (row.status === "cancelled") throw new AppError(409, "BAD_TRANSITION", "This e-invoice was cancelled");
  return registerEInvoice(row.id, actorId);
}
