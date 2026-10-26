"use client";
import { createContext, useCallback, useContext, useState } from "react";
import { COMPANY_KEYS, DEFAULT_COMPANY, SALES_COMPANIES, isCompanyKey, type CompanyKey, type SalesCompany } from "@dashmani/shared/src/sales/companies";

// The billing company the portal is working in (Digital Sukoon or Dashmani Media). Lists, the
// dashboard, settings and every NEW document follow it; an existing document always stays with
// the company it was created under. Remembered per browser.

export { COMPANY_KEYS, SALES_COMPANIES, isCompanyKey, type CompanyKey, type SalesCompany };
const STORAGE_KEY = "sales.company";

const CompanyContext = createContext<{ company: CompanyKey; setCompany: (c: CompanyKey) => void }>({ company: DEFAULT_COMPANY, setCompany: () => {} });

export function CompanyProvider({ children }: { children: React.ReactNode }) {
  // Mounted only after the auth guard has run in the browser (never during the static render), so
  // reading storage in the initializer cannot cause a hydration mismatch — and no request ever
  // goes out for the wrong company first.
  const [company, setState] = useState<CompanyKey>(() => {
    try {
      const stored = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
      return isCompanyKey(stored) ? stored : DEFAULT_COMPANY;
    } catch {
      return DEFAULT_COMPANY;
    }
  });
  const setCompany = useCallback((c: CompanyKey) => {
    setState(c);
    try { localStorage.setItem(STORAGE_KEY, c); } catch { /* storage blocked */ }
  }, []);
  return <CompanyContext.Provider value={{ company, setCompany }}>{children}</CompanyContext.Provider>;
}

export function useCompany() {
  const ctx = useContext(CompanyContext);
  return { ...ctx, info: SALES_COMPANIES[ctx.company] };
}

/** The company of a document, read defensively (rows from before the column default to Digital Sukoon). */
export const companyOfDoc = (d: { companyKey?: string | null } | null | undefined): CompanyKey => (isCompanyKey(d?.companyKey) ? d.companyKey : DEFAULT_COMPANY);
export const companyName = (k: string | null | undefined) => SALES_COMPANIES[isCompanyKey(k) ? k : DEFAULT_COMPANY].name;

/** Each company's mark for the header (files in apps/sales/public). */
export const COMPANY_LOGO: Record<CompanyKey, string> = { dspl: "/logo-dspl.png", dmpl: "/logo-dmpl.png" };
