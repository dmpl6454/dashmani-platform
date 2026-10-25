import { prisma } from "@dashmani/db";
import { sellerProfileSchema, type SellerProfileInput } from "@dashmani/shared";
import { logSalesEvent } from "./common";

// The seller's own GST identity and document defaults, stored as JSON under one
// system_settings key. Read on every document action; cheap (one row).

export const SELLER_SETTINGS_KEY = "sales.seller";

export type SellerProfile = SellerProfileInput;

export async function getSellerProfile(): Promise<SellerProfile | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SELLER_SETTINGS_KEY } });
  if (!row) return null;
  try {
    const parsed = sellerProfileSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Defaults a document inherits when no profile has been saved yet. */
export const SELLER_FALLBACK = sellerProfileSchema.parse({ legalName: "Dashmani Media Private Limited", stateCode: "27", state: "Maharashtra" });

export async function getSellerOrDefaults(): Promise<SellerProfile> {
  return (await getSellerProfile()) ?? SELLER_FALLBACK;
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

export async function saveSellerProfile(input: SellerProfileInput, actorId: string): Promise<SellerProfile> {
  const value = JSON.stringify(input);
  await prisma.systemSetting.upsert({
    where: { key: SELLER_SETTINGS_KEY },
    create: { key: SELLER_SETTINGS_KEY, value },
    update: { value },
  });
  await logSalesEvent(prisma, { entityType: "settings", entityId: SELLER_SETTINGS_KEY, actorId, action: "seller_profile_saved" });
  return input;
}
