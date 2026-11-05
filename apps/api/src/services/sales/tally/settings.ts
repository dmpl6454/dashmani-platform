import { prisma } from "@dashmani/db";
import {
  GST_STATE_CODES, SALES_COMPANIES, sellerRegistrations, tallySettingsSchema,
  type CompanyKey, type TallySettingsInput,
} from "@dashmani/shared";
import { AppError } from "../../../middleware/error-handler";
import { logSalesEvent, type Tx } from "../common";
import { getSellerOrDefaults, type SellerProfile } from "../settings.service";

// Tally settings per billing company (spec-tally §6.1): system_settings "sales.tally" (dspl) and
// "sales.tally.dmpl". Deliberately NOT inside the seller profile — sellerSnapshotFor spreads that
// profile into every issued invoice, and Tally names / URLs must never be frozen into invoices.
// Reads return null when the key is absent or fails the schema: exports then refuse with
// TALLY_NOT_CONFIGURED and NEVER fall back to defaults; only the settings view shows defaults.

export type TallySettings = TallySettingsInput;

export const tallySettingsKey = (company: CompanyKey) => SALES_COMPANIES[company].tallySettingsKey;
export const tallyPushEnabled = () => process.env.SALES_TALLY_PUSH_ENABLED === "1";

export async function getTallySettingsRow(company: CompanyKey, db: Tx | typeof prisma = prisma): Promise<{ settings: TallySettings; updatedAt: Date } | null> {
  const row = await db.systemSetting.findUnique({ where: { key: tallySettingsKey(company) } });
  if (!row) return null;
  try {
    const parsed = tallySettingsSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? { settings: parsed.data, updatedAt: row.updatedAt } : null;
  } catch {
    return null;
  }
}
export async function getTallySettings(company: CompanyKey): Promise<TallySettings | null> {
  return (await getTallySettingsRow(company))?.settings ?? null;
}

/** The seller's registrations as the settings page labels them ("Mumbai · 27AAKCD3352K1ZF"). */
export function registrationsView(seller: SellerProfile) {
  return sellerRegistrations(seller)
    .filter((r) => !!r.gstin)
    .map((r) => ({ gstin: r.gstin!, label: r.city || r.label, state: r.state || GST_STATE_CODES[r.stateCode ?? ""] || "" }));
}

/** Suggestions shown (never saved) when nothing is stored yet: names from the seller profile. */
export function tallyDefaults(company: CompanyKey, seller: SellerProfile): TallySettings {
  const regs = registrationsView(seller);
  const companyName = seller.legalName || SALES_COMPANIES[company].name;
  const acct = (seller.accountNumber ?? "").replace(/\s+/g, "");
  const bank = seller.bankName && acct.length >= 4 ? `${seller.bankName} A/c ${acct.slice(-4)}` : null;
  return tallySettingsSchema.parse({
    registrations: regs.map((r) => ({ gstin: r.gstin, tallyCompany: companyName, registrationName: regs.length >= 2 && r.state ? `${r.state} Registration` : null })),
    ledgers: { bank: bank ? bank.slice(0, 100) : null },
  });
}

/** What still blocks an export, as sentences. Empty = ready. */
export function tallyMissing(s: TallySettings | null, seller: SellerProfile): string[] {
  if (!s) return ["Tally settings have never been saved"];
  const out: string[] = [];
  if (!s.booksFrom) out.push("the date Tally's books already cover");
  for (const r of registrationsView(seller)) if (!s.registrations.some((x) => x.gstin === r.gstin)) out.push(`a Tally company for ${r.label} (${r.gstin})`);
  if (!s.ledgers.bank) out.push("the bank ledger name");
  if (!s.ledgersConfirmed) out.push("ticking 'These names match our Tally'");
  return out;
}

export async function getTallySettingsView(company: CompanyKey) {
  const [row, seller] = await Promise.all([getTallySettingsRow(company), getSellerOrDefaults(company)]);
  const settings = row?.settings ?? tallyDefaults(company, seller);
  return {
    company,
    settings,
    saved: !!row,
    missing: tallyMissing(row?.settings ?? null, seller),
    registrations: registrationsView(seller),
    pushEnabled: tallyPushEnabled(),
  };
}

/** Everything whose change means "check the names against Tally again". */
function namesOf(s: TallySettings) {
  return JSON.stringify({
    release: s.release, partyGroup: s.partyGroup, salesLedgers: s.salesLedgers, ledgers: s.ledgers, voucherTypes: s.voucherTypes,
    registrations: [...s.registrations].sort((a, b) => (a.gstin < b.gstin ? -1 : 1))
      .map((r) => [r.gstin, r.tallyCompany, r.registrationName, r.salesVoucherType, r.creditNoteVoucherType]),
  });
}

export async function saveTallySettings(company: CompanyKey, body: TallySettings, actorId: string) {
  const seller = await getSellerOrDefaults(company);
  const held = new Set(registrationsView(seller).map((r) => r.gstin));
  for (const r of body.registrations) {
    if (!held.has(r.gstin)) throw new AppError(400, "UNKNOWN_REGISTRATION", `${r.gstin} is not one of ${SALES_COMPANIES[company].name}'s GST registrations in Settings — pick one of its GSTINs, or Automatic`);
  }
  const key = tallySettingsKey(company);
  await prisma.$transaction(async (tx) => {
    const stored = await getTallySettingsRow(company, tx);
    const next = { ...body };
    // The server, not the page, decides whether the "names match our Tally" tick survives.
    if (stored && namesOf(stored.settings) !== namesOf(next)) next.ledgersConfirmed = false;
    await tx.systemSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
    await logSalesEvent(tx, { entityType: "settings", entityId: key, actorId, action: "tally_settings_saved", note: `${SALES_COMPANIES[company].short}: Tally settings` });
  });
  return getTallySettingsView(company);
}

/** SELECT … FOR UPDATE on the company's Tally settings row: serialises run creation, party naming and confirm/discard per company. */
export async function lockTallySettings(tx: Tx, company: CompanyKey, required = true): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ key: string }>>`SELECT key FROM system_settings WHERE key = ${tallySettingsKey(company)} FOR UPDATE`;
  if (!rows.length && required) throw new AppError(409, "TALLY_NOT_CONFIGURED", `Tally isn't set up for ${SALES_COMPANIES[company].short} yet — an admin fills in Tally settings.`);
  return rows.length > 0;
}
