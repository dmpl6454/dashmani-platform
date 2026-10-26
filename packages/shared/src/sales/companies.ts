// The legal entities the sales portal bills for. Each has its own seller profile (GSTINs,
// address, bank account, number prefixes), its own document series and its own books: a receipt
// of one company can never settle the other's invoice. Import BY PATH from the frontend
// ("@dashmani/shared/src/sales/companies").

export const COMPANY_KEYS = ["dspl", "dmpl"] as const;
export type CompanyKey = (typeof COMPANY_KEYS)[number];
export const DEFAULT_COMPANY: CompanyKey = "dspl";

export interface SalesCompany {
  key: CompanyKey;
  name: string;
  short: string;
  /** system_settings key of its seller profile (Digital Sukoon keeps the original key). */
  settingsKey: string;
  /** Fixed prefixes of its non-configurable series. */
  proformaPrefix: string;
  refundPrefix: string;
}

export const SALES_COMPANIES: Record<CompanyKey, SalesCompany> = {
  dspl: { key: "dspl", name: "Digital Sukoon Private Limited", short: "Digital Sukoon", settingsKey: "sales.seller", proformaPrefix: "PI", refundPrefix: "RF" },
  dmpl: { key: "dmpl", name: "Dashmani Media Private Limited", short: "Dashmani Media", settingsKey: "sales.seller.dmpl", proformaPrefix: "DMPI", refundPrefix: "DMRF" },
};

export const isCompanyKey = (v: unknown): v is CompanyKey => typeof v === "string" && (COMPANY_KEYS as readonly string[]).includes(v);

/**
 * The numbering scope of a document: Digital Sukoon keeps the sequence keys it always had (so
 * DS/26-27/… continues unchanged); every other company's series are namespaced by its key.
 */
export function companyScope(company: CompanyKey, scope: string | null): string | null {
  return company === DEFAULT_COMPANY ? scope : `${company}${scope ? `:${scope}` : ""}`;
}
