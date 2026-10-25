"use client";
import useSWR, { type SWRConfiguration } from "swr";
import { fetcher } from "./api";
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

export const useDashboard = () => useSWR<Dashboard>("/sales/dashboard", fetcher, { ...opts, refreshInterval: 60_000 });
export const useSeller = () => useSWR<SellerSettings>("/sales/settings/seller", fetcher, opts);
export const useInventory = () => useSWR<InventoryChannel[]>("/sales/inventory", fetcher, opts);
export const useClients = (q?: string) => useSWR<ClientRow[]>(`/sales/clients${qs({ q })}`, fetcher, opts);
export const useClient = (id: string | null) => useSWR<ClientRow>(id ? `/sales/clients/${id}` : null, fetcher, opts);
export const useStatement = (id: string | null) => useSWR<Statement>(id ? `/sales/clients/${id}/statement` : null, fetcher, opts);
export const useQuotes = (f: { status?: string; clientId?: string; q?: string }) => useSWR<Quote[]>(`/sales/quotes${qs(f)}`, fetcher, opts);
export const useQuote = (id: string | null) => useSWR<Quote>(id ? `/sales/quotes/${id}` : null, fetcher, opts);
export const useOrders = (f: { status?: string; clientId?: string; q?: string }) => useSWR<Order[]>(`/sales/orders${qs(f)}`, fetcher, opts);
export const useOrder = (id: string | null) => useSWR<Order>(id ? `/sales/orders/${id}` : null, fetcher, opts);
export const useInvoices = (f: { status?: string; clientId?: string; q?: string }) => useSWR<InvoiceRow[]>(`/sales/invoices${qs(f)}`, fetcher, opts);
export const useInvoice = (id: string | null) => useSWR<Invoice>(id ? `/sales/invoices/${id}` : null, fetcher, opts);
export const usePayments = (f: { clientId?: string; q?: string }) => useSWR<Payment[]>(`/sales/payments${qs(f)}`, fetcher, opts);
export const useCreditNotes = (f: { invoiceId?: string; clientId?: string }) => useSWR<CreditNote[]>(`/sales/credit-notes${qs(f)}`, fetcher, opts);
export const useEvents = (entityType: string, entityId: string | null) => useSWR<SalesEvent[]>(entityId ? `/sales/events${qs({ entityType, entityId })}` : null, fetcher, opts);
