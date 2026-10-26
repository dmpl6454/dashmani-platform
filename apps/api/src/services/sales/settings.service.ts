import { prisma } from "@dashmani/db";
import { DEFAULT_COMPANY, SALES_COMPANIES, sellerProfileSchema, type CompanyKey, type SellerProfileInput } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { logSalesEvent } from "./common";

// Each billing company's own GST identity and document defaults, stored as JSON under its own
// system_settings key (Digital Sukoon keeps "sales.seller"). Read on every document action; cheap.

/** Digital Sukoon's key, kept for older callers. */
export const SELLER_SETTINGS_KEY = SALES_COMPANIES.dspl.settingsKey;

export type SellerProfile = SellerProfileInput;

export async function getSellerProfile(company: CompanyKey = DEFAULT_COMPANY): Promise<SellerProfile | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SALES_COMPANIES[company].settingsKey } });
  if (!row) return null;
  try {
    const parsed = sellerProfileSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Defaults a document inherits when the company has no saved profile yet. */
const FALLBACKS: Record<CompanyKey, SellerProfile> = {
  dspl: sellerProfileSchema.parse({ legalName: SALES_COMPANIES.dspl.name, stateCode: "27", state: "Maharashtra" }),
  // Prefilled from its GST registration certificate (REG-06, GSTIN 27AAJCD7425L1Z8, issued
  // 03/10/2025). Bank details and signatory are not on the certificate: an Admin adds them.
  dmpl: sellerProfileSchema.parse({
    legalName: SALES_COMPANIES.dmpl.name, tradeName: SALES_COMPANIES.dmpl.name,
    gstin: "27AAJCD7425L1Z8", pan: "AAJCD7425L",
    addressLine1: "Off-702, Parinee I, Plot No 7/A", addressLine2: "Shah Industrial Estate, Off Veera Desai Marg, Andheri West",
    city: "Mumbai", pincode: "400053", stateCode: "27", state: "Maharashtra",
    invoicePrefix: "DM", creditNotePrefix: "DMCN", quotePrefix: "DMQ", orderPrefix: "DMSO", receiptPrefix: "DMRC",
  }),
};
export const SELLER_FALLBACK = FALLBACKS.dspl;
export const sellerFallback = (company: CompanyKey = DEFAULT_COMPANY): SellerProfile => FALLBACKS[company];

export async function getSellerOrDefaults(company: CompanyKey = DEFAULT_COMPANY): Promise<SellerProfile> {
  return (await getSellerProfile(company)) ?? FALLBACKS[company];
}

/** Everything a tax invoice must print about the supplier. Missing fields block issuing. */
export function sellerMissingFields(p: SellerProfile | null): string[] {
  if (!p) return ["legalName", "gstin", "addressLine1", "city", "stateCode", "pincode"];
  const missing: string[] = [];
  if (!p.legalName) missing.push("legalName");
  if (!p.gstin) missing.push("gstin");
  if (!p.addressLine1) missing.push("addressLine1");
  if (!p.city) missing.push("city");
  if (!p.stateCode) missing.push("stateCode");
  if (!p.pincode) missing.push("pincode");
  return missing;
}

/** Every prefix a company's documents are numbered with (numbers are unique platform-wide). */
export function prefixesOf(company: CompanyKey, p: SellerProfile): string[] {
  const c = SALES_COMPANIES[company];
  return [
    p.invoicePrefix, p.creditNotePrefix, p.quotePrefix, p.orderPrefix, p.receiptPrefix,
    ...p.branches.flatMap((b) => [b.invoicePrefix, b.creditNotePrefix]),
    c.proformaPrefix, c.refundPrefix,
  ].map((x) => x.toUpperCase());
}

export async function saveSellerProfile(input: SellerProfileInput, actorId: string, company: CompanyKey = DEFAULT_COMPANY): Promise<SellerProfile> {
  // Two companies may never number documents with the same prefix or claim the same GSTIN:
  // a number would collide, or an invoice would print the other company's registration.
  for (const other of Object.keys(SALES_COMPANIES) as CompanyKey[]) {
    if (other === company) continue;
    const theirs = await getSellerOrDefaults(other);
    const taken = new Set(prefixesOf(other, theirs));
    const clash = prefixesOf(company, input).find((x) => taken.has(x));
    if (clash) throw new AppError(409, "PREFIX_TAKEN", `The prefix ${clash} is already used by ${SALES_COMPANIES[other].name}. Pick a different one.`);
    const gstins = new Set([theirs.gstin, ...theirs.branches.map((b) => b.gstin)].filter(Boolean));
    const dup = [input.gstin, ...input.branches.map((b) => b.gstin)].find((g) => g && gstins.has(g));
    if (dup) throw new AppError(409, "GSTIN_TAKEN", `GSTIN ${dup} belongs to ${SALES_COMPANIES[other].name}.`);
  }
  const key = SALES_COMPANIES[company].settingsKey;
  const value = JSON.stringify(input);
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  await logSalesEvent(prisma, { entityType: "settings", entityId: key, actorId, action: "seller_profile_saved" });
  return input;
}
