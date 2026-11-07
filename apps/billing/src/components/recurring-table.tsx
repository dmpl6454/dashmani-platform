"use client";
import Link from "next/link";
import { fmtDate } from "@/lib/format";
import { useRecurringList } from "@/lib/hooks";
import type { Recurring } from "@/lib/sales-types";
import { Money, StatusPill } from "@/components/sales-ui";

// The recurring invoices table: used by the Recurring page and on a client's page.

export const FREQUENCY_LABEL: Record<string, string> = { monthly: "Monthly", quarterly: "Every 3 months", yearly: "Yearly" };
export const MODE_LABEL: Record<string, string> = { draft: "Draft for review", issue: "Issue and email" };

/** What one period bills, before GST — the lines and the document discount. */
export const recurringTaxable = (r: Pick<Recurring, "lines" | "discountPaise">) =>
  Math.max(0, r.lines.reduce((s, l) => s + Math.max(0, l.quantity * l.unitPricePaise - (l.discountPaise ?? 0)), 0) - r.discountPaise);

export function RecurringTable({ rows, showClient = true }: { rows: Recurring[]; showClient?: boolean }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left">
          <tr className="border-b-2 border-border">
            <th className="p-3">Title</th>{showClient && <th className="p-3">Client</th>}<th className="p-3">Every</th><th className="p-3">Next run</th><th className="p-3">Mode</th><th className="p-3">Status</th><th className="p-3">Last invoice</th><th className="p-3 text-right">Per period (pre-GST)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-rule hover:bg-muted/60 align-top">
              <td className="p-3">
                <Link href={`/recurring/view?id=${r.id}`} className="font-bold hover:text-indigo-light">{r.title}</Link>
                {r.lastError && <p className="text-xs text-danger mt-1">Last run failed — open it for details.</p>}
              </td>
              {showClient && <td className="p-3">{r.client.companyName}</td>}
              <td className="p-3">{FREQUENCY_LABEL[r.frequency] ?? r.frequency} · day {r.dayOfMonth}</td>
              <td className="p-3">{r.status === "ended" ? "—" : <>{fmtDate(r.nextRunDate)}<span className="block text-xs text-ink-3">{r.nextPeriodLabel}</span></>}</td>
              <td className="p-3">{MODE_LABEL[r.mode] ?? r.mode}</td>
              <td className="p-3"><StatusPill status={r.status} /></td>
              <td className="p-3">{r.lastInvoice ? <Link href={`/invoices/view?id=${r.lastInvoice.id}`} className="font-mono hover:text-indigo-light">{r.lastInvoice.number ?? "Draft"}</Link> : <span className="text-ink-3">None yet</span>}</td>
              <td className="p-3 text-right"><Money paise={recurringTaxable(r)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A client's recurring invoices (both companies), for the client page. */
export function ClientRecurring({ clientId }: { clientId: string }) {
  const { data, error } = useRecurringList({ clientId });
  return (
    <section className="card p-4 mt-5">
      <div className="flex items-center justify-between gap-3 mb-3"><h2 className="font-bold">Recurring invoices</h2><Link href={`/recurring/edit?clientId=${clientId}`} className="btn btn-ghost btn-sm">New</Link></div>
      {error ? <p className="text-sm text-danger">Couldn&apos;t load recurring invoices.</p> : !data ? <p className="text-sm text-ink-3">Loading…</p> : !data.length ? <p className="text-sm text-ink-3">None set up for this client.</p> : (
        <ul className="text-sm grid gap-2">{data.map((r) => (
          <li key={r.id} className="flex flex-wrap justify-between gap-2">
            <Link href={`/recurring/view?id=${r.id}`} className="font-bold hover:text-indigo-light">{r.title}</Link>
            <span className="text-ink-3">{FREQUENCY_LABEL[r.frequency] ?? r.frequency} · {r.status === "active" ? `next ${fmtDate(r.nextRunDate)}` : r.status}</span>
          </li>
        ))}</ul>
      )}
    </section>
  );
}
