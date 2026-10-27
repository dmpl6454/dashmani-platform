import useSWR from "swr";
import { apiFetch } from "@/lib/api";

/** One of the client's own invoices, as the API lists it (never a draft). */
export interface ClientInvoice {
  id: string;
  number: string | null;
  kind: "tax_invoice" | "proforma";
  status: "issued" | "partially_paid" | "paid" | "overdue" | "cancelled";
  company: string;
  issueDate: string | null;
  dueDate: string | null;
  totalPaise: number;
  paidPaise: number;
  balancePaise: number;
  campaignBookingId: string | null;
}

export function useClientInvoices(bookingId?: string) {
  const key = `/client/invoices${bookingId ? `?bookingId=${encodeURIComponent(bookingId)}` : ""}`;
  return useSWR<ClientInvoice[]>(key, async (url: string) => (await apiFetch<ClientInvoice[]>(url)).data, { revalidateOnFocus: false, dedupingInterval: 30_000 });
}

export const INVOICE_STATUS_LABEL: Record<ClientInvoice["status"], string> = {
  issued: "Due", partially_paid: "Part paid", paid: "Paid", overdue: "Overdue", cancelled: "Cancelled",
};

export function inr(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtDay(day: string | null): string {
  if (!day) return "—";
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]} ${y}`;
}
