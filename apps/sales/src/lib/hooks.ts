"use client";
import useSWR, { type SWRConfiguration } from "swr";
import { fetcher } from "./api";
import { useCompany, type CompanyKey } from "./company";
import type { ClientRow, CreditNote, Dashboard, InventoryChannel, Invoice, InvoiceRow, Order, Payment, Quote, SalesEvent, SellerSettings, Statement } from "./sales-types";

// SWR hooks over /v1/sales/*. A null key skips the request (no id yet, or a detail page
// opened without ?id=). keepPreviousData keeps a list on screen while a filter changes.
const opts: SWRConfiguration = { revalidateOnFocus: false, dedupingInterval: 10_000, keepPreviousData: true };
const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};

// Lists and the dashboard follow the company the portal is working in; detail pages do not
// need it (a document carries its own company).
export const useDashboard = () => {
  const { company } = useCompany();
  return useSWR<Dashboard>(`/sales/dashboard${qs({ company })}`, fetcher, { ...opts, refreshInterval: 60_000 });
};
/** A company's seller profile: the given one (a document's), else the current one. */
export const useSeller = (forCompany?: CompanyKey) => {
  const { company } = useCompany();
  return useSWR<SellerSettings>(`/sales/settings/seller${qs({ company: forCompany ?? company })}`, fetcher, opts);
};
export const useInventory = () => useSWR<InventoryChannel[]>("/sales/inventory", fetcher, opts);
export const useClients = (q?: string) => useSWR<ClientRow[]>(`/sales/clients${qs({ q })}`, fetcher, opts);
export const useClient = (id: string | null) => useSWR<ClientRow>(id ? `/sales/clients/${id}` : null, fetcher, opts);
export const useStatement = (id: string | null) => {
  const { company } = useCompany();
  return useSWR<Statement>(id ? `/sales/clients/${id}/statement${qs({ company })}` : null, fetcher, opts);
};
export const useQuotes = (f: { status?: string; clientId?: string; q?: string; company?: CompanyKey }) => {
  const { company: current } = useCompany();
  const company = f.company ?? current;
  return useSWR<Quote[]>(`/sales/quotes${qs({ ...f, company })}`, fetcher, opts);
};
export const useQuote = (id: string | null) => useSWR<Quote>(id ? `/sales/quotes/${id}` : null, fetcher, opts);
export const useOrders = (f: { status?: string; clientId?: string; q?: string; company?: CompanyKey }) => {
  const { company: current } = useCompany();
  const company = f.company ?? current;
  return useSWR<Order[]>(`/sales/orders${qs({ ...f, company })}`, fetcher, opts);
};
export const useOrder = (id: string | null) => useSWR<Order>(id ? `/sales/orders/${id}` : null, fetcher, opts);
export const useInvoices = (f: { status?: string; clientId?: string; q?: string; company?: CompanyKey }) => {
  const { company: current } = useCompany();
  const company = f.company ?? current;
  return useSWR<InvoiceRow[]>(`/sales/invoices${qs({ ...f, company })}`, fetcher, opts);
};
export const useInvoice = (id: string | null) => useSWR<Invoice>(id ? `/sales/invoices/${id}` : null, fetcher, opts);
export const usePayments = (f: { clientId?: string; q?: string; company?: CompanyKey }) => {
  const { company: current } = useCompany();
  const company = f.company ?? current;
  return useSWR<Payment[]>(`/sales/payments${qs({ ...f, company })}`, fetcher, opts);
};
export const usePayment = (id: string | null) => useSWR<Payment>(id ? `/sales/payments/${id}` : null, fetcher, opts);
/** One client's receipts, for applying an unallocated advance to an invoice (no request until the client is known). */
export const useClientReceipts = (clientId: string | null | undefined, company: CompanyKey | undefined) =>
  useSWR<Payment[]>(clientId && company ? `/sales/payments${qs({ clientId, company })}` : null, fetcher, opts);
export const useCreditNotes = (f: { invoiceId?: string; clientId?: string }) => useSWR<CreditNote[]>(`/sales/credit-notes${qs(f)}`, fetcher, opts);
export const useEvents = (entityType: string, entityId: string | null) => useSWR<SalesEvent[]>(entityId ? `/sales/events${qs({ entityType, entityId })}` : null, fetcher, opts);
