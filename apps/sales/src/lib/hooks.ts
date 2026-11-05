"use client";
import useSWR, { type SWRConfiguration } from "swr";
import { fetcher } from "./api";
import { useCompany, type CompanyKey } from "./company";
import type { ConfirmationsView, GstReconView, LedgerResponse, TdsReconView } from "./sales-types";
import type { AccountsView, FiledYearView, BookingDetail, BookingRow, ClientRow, CreditNote, Dashboard, InventoryChannel, Invoice, InvoiceRow, Order, Payment, Quote, Recurring, SalesEvent, SellerSettings, Statement } from "./sales-types";

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
/** The number an invoice will get when issued (read-only preview; Issue takes the real one). Null key = don't ask. */
export const useNextInvoiceNumber = (q: { company: CompanyKey; kind: string; clientId?: string; sellerGstin?: string; issueDate?: string } | null) =>
  useSWR<{ number: string; gstin: string | null; registration: string | null }>(q ? `/sales/invoices/next-number${qs({ company: q.company, kind: q.kind, clientId: q.clientId || undefined, sellerGstin: q.sellerGstin || undefined, issueDate: q.issueDate || undefined })}` : null, fetcher, { ...opts, dedupingInterval: 2_000 });
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
/** Client campaign bookings — shared by both companies (a booking has no billing company). */
export const useBookings = (f: { stage?: string; q?: string; clientId?: string }) => useSWR<BookingRow[]>(`/sales/bookings${qs(f)}`, fetcher, opts);
export const useBooking = (id: string | null) => useSWR<BookingDetail>(id ? `/sales/bookings/${id}` : null, fetcher, opts);
export const useEvents = (entityType: string, entityId: string | null) => useSWR<SalesEvent[]>(entityId ? `/sales/events${qs({ entityType, entityId })}` : null, fetcher, opts);

/** Recurring invoices of the current company (or one client's, across companies when clientId is given). */
export const useRecurringList = (f: { clientId?: string; status?: string } = {}) => {
  const { company } = useCompany();
  return useSWR<Recurring[]>(`/sales/recurring${qs(f.clientId ? f : { ...f, company })}`, fetcher, opts);
};
export const useRecurring = (id: string | null) => useSWR<Recurring>(id ? `/sales/recurring/${id}` : null, fetcher, opts);

// ─── smart-invoicing: accounts (PR 1) ───
/** The accounts page for the current company and a financial year (default: the current one). */
export const useAccounts = (fy?: string) => {
  const { company } = useCompany();
  return useSWR<AccountsView>(`/sales/accounts${qs({ company, fy })}`, fetcher, opts);
};
/** Filed years of a company (the current one unless given), newest first; PDFs listed without bytes. */
export const useFiledYears = (forCompany?: CompanyKey) => {
  const { company } = useCompany();
  return useSWR<FiledYearView[]>(`/sales/accounts/filed${qs({ company: forCompany ?? company })}`, fetcher, opts);
};

// ─── smart-invoicing: reconcile (PR 5) ───
/** Reconcile → TDS · 26AS for the current company and a FY (default chosen by the server). */
export const useTdsRecon = (fy?: string) => {
  const { company } = useCompany();
  return useSWR<TdsReconView>(`/sales/reconcile/tds${qs({ company, fy })}`, fetcher, opts);
};
/** Reconcile → GST · GSTR-1 for a registration and a month / quarter (defaults chosen by the server). */
export const useGstRecon = (gstin?: string, period?: string) => {
  const { company } = useCompany();
  return useSWR<GstReconView>(`/sales/reconcile/gst${qs({ company, gstin, period })}`, fetcher, opts);
};
/** Client balances as of a day; polls while a batch is sending. */
export const useConfirmations = (asOf?: string, from?: string) => {
  const { company } = useCompany();
  return useSWR<ConfirmationsView>(`/sales/reconcile/confirmations${qs({ company, asOf, from })}`, fetcher, { ...opts, refreshInterval: (d) => (d?.rows.some((r) => r.confirmation?.sending) ? 3000 : 0) });
};
export const useLedger = (clientId: string | null, from?: string, to?: string) => {
  const { company } = useCompany();
  return useSWR<LedgerResponse>(clientId ? `/sales/reconcile/ledger${qs({ company, clientId, from, to })}` : null, fetcher, opts);
};

// ─── smart-invoicing: reconcile BRS (PR 6) ───

// ─── smart-invoicing: tally (PR 2) ───

// ─── smart-invoicing: import (PR 3) ───

// ─── smart-invoicing: bank (PR 4) ───
