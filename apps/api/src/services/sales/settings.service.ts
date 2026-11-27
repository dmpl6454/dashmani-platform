import { createHash } from "crypto";
import PDFDocument from "pdfkit";
import { prisma } from "@dashmani/db";
import { DEFAULT_COMPANY, SALES_COMPANIES, sellerProfileSchema, type CompanyKey, type SellerProfileInput } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { logSalesEvent } from "./common";

// Each billing company's own GST identity and document defaults, stored as JSON under its own
// system_settings key (Digital Sukoon keeps "sales.seller"). Read on every document action; cheap.

/** Digital Sukoon's key, kept for older callers. */
export const SELLER_SETTINGS_KEY = SALES_COMPANIES.dspl.settingsKey;

export type SellerProfile = SellerProfileInput;

/** `db` lets a caller inside a transaction read through its own connection (a pool of 1 would otherwise wait on itself). */
export async function getSellerProfile(company: CompanyKey = DEFAULT_COMPANY, db: Pick<typeof prisma, "systemSetting"> = prisma): Promise<SellerProfile | null> {
  const row = await db.systemSetting.findUnique({ where: { key: SALES_COMPANIES[company].settingsKey } });
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

export async function getSellerOrDefaults(company: CompanyKey = DEFAULT_COMPANY, db: Pick<typeof prisma, "systemSetting"> = prisma): Promise<SellerProfile> {
  return (await getSellerProfile(company, db)) ?? FALLBACKS[company];
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
  if (input.signatureId && !(await getSignature(input.signatureId))) {
    throw new AppError(400, "SIGNATURE_NOT_FOUND", "That signature image is no longer on file. Upload it again.");
  }
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

// ── Signature image ─────────────────────────────────────────────────────────────
// Stored once per distinct image under system_settings "sales.signature.<sha-256>" (base64), and
// never changed or deleted: an issued invoice's seller snapshot freezes the id, so re-downloading
// it prints the signature it was issued with even after the company uploads a new one. No file
// on disk, no DDL. Small by design (a scanned signature or signature + seal is ~20–150 KB).

export const SIGNATURE_MAX_BYTES = 300 * 1024;
export type SignatureType = "image/png" | "image/jpeg";
const signatureKey = (id: string) => `sales.signature.${id}`;
const SIGNATURE_ID_RE = /^[a-f0-9]{64}$/;

/** The real type from the first bytes — never the name or the Content-Type the browser sent. */
export function sniffSignatureType(b: Buffer): SignatureType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

/** Store an uploaded signature (PNG or JPEG pdfkit can draw) and return its id. Idempotent. */
export async function storeSignature(bytes: Buffer, actorId: string, company: CompanyKey = DEFAULT_COMPANY): Promise<{ signatureId: string; contentType: SignatureType; width: number; height: number }> {
  if (!bytes.length) throw new AppError(400, "INVALID_UPLOAD", "Choose a signature image to upload.");
  if (bytes.length > SIGNATURE_MAX_BYTES) throw new AppError(413, "FILE_TOO_LARGE", "That image is larger than 300 KB. Crop it to the signature, or save it smaller.");
  const contentType = sniffSignatureType(bytes);
  if (!contentType) throw new AppError(400, "UNSUPPORTED_IMAGE", "Upload the signature as a PNG or JPEG image.");
  // pdfkit is what prints it: an image it cannot open would break every invoice PDF later.
  let width = 0;
  let height = 0;
  try {
    const doc = new PDFDocument({ autoFirstPage: false }) as unknown as { openImage(src: Buffer): { width: number; height: number } };
    const img = doc.openImage(bytes);
    width = img.width;
    height = img.height;
  } catch {
    throw new AppError(400, "UNSUPPORTED_IMAGE", "That image can't be read. Save it again as a PNG or JPEG and upload that.");
  }
  if (!width || !height) throw new AppError(400, "UNSUPPORTED_IMAGE", "That image is empty.");
  const signatureId = createHash("sha256").update(bytes).digest("hex");
  const key = signatureKey(signatureId);
  const value = `${contentType};base64,${bytes.toString("base64")}`;
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: {} });
  await logSalesEvent(prisma, { entityType: "settings", entityId: SALES_COMPANIES[company].settingsKey, actorId, action: "signature_uploaded" });
  return { signatureId, contentType, width, height };
}

// Immutable by id, so a small cache is always correct.
const signatureCache = new Map<string, { bytes: Buffer; contentType: SignatureType } | null>();

export async function getSignature(id: string): Promise<{ bytes: Buffer; contentType: SignatureType } | null> {
  if (!SIGNATURE_ID_RE.test(id)) return null;
  const hit = signatureCache.get(id);
  if (hit) return hit;
  const row = await prisma.systemSetting.findUnique({ where: { key: signatureKey(id) } });
  const m = row?.value.match(/^(image\/(?:png|jpeg));base64,(.+)$/s);
  if (!m) return null; // not cached: it may be uploaded a moment later
  const out = { bytes: Buffer.from(m[2], "base64"), contentType: m[1] as SignatureType };
  if (signatureCache.size >= 20) signatureCache.delete(signatureCache.keys().next().value as string);
  signatureCache.set(id, out);
  return out;
}

/** The signature to print on a document, from its seller snapshot; null when none or switched off. */
export async function signatureToPrint(seller: { signatureId?: string | null; printSignature?: boolean | null }): Promise<Buffer | null> {
  if (seller.printSignature === false || !seller.signatureId) return null;
  return (await getSignature(seller.signatureId).catch(() => null))?.bytes ?? null;
}
