"use client";
import Link from "next/link";
import { useDashboard } from "@/lib/hooks";
import { daysBetween, fmtInr, fmtDate, todayIST } from "@/lib/format";
import { Empty, LoadError, Loading, Money, PageHead, Stat, StatusPill } from "@/components/sales-ui";
import { PortalLink } from "@/components/portal-link";

// The billing half of what was "Sales at a glance" on the sales portal (2026-11-07): the same
// GET /sales/dashboard, read for invoicing, collections, the bank and the bookings waiting to be
// invoiced. Quotes and orders stay on the sales dashboard. Clients and bookings are sales-portal
// pages, reached through PortalLink.

/** The activity feed is shared with sales; here only billing documents and finance actions show. */
const BILLING_ENTITIES = new Set([
  "invoice", "payment", "credit_note", "recurring", "import",
  "bank_account", "bank_line", "bank_statement", "brs_month",
  "confirmation", "filed_year", "gst_upload", "settings", "tally_run", "tds_deductor", "tds_upload",
]);

export default function DashboardPage() {
  const { data, error, isLoading, mutate } = useDashboard();
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !data) return <Loading label="Adding things up…" />;
  const d = data;
  const recent = d.recent.filter((e) => BILLING_ENTITIES.has(e.entityType));
  const quiet = d.invoicedFyCount === 0 && d.outstandingCount === 0;
  return (
    <>
      <PageHead kicker={`Financial year ${d.financialYear} · ${fmtDate(d.today)}`} title="Billing at a glance">
        <Link href="/invoices/edit" className="btn">New invoice</Link>
        <Link href="/payments/record" className="btn btn-light">Record payment</Link>
      </PageHead>
      {!!d.bookings?.toInvoice.count && (
        <PortalLink portal="sales" href="/bookings?stage=to_invoice" className="card p-3 mb-4 flex items-center justify-between gap-3 text-sm hover:border-indigo">
          <span><span className="font-bold">{d.bookings.toInvoice.count} campaign booking{d.bookings.toInvoice.count === 1 ? "" : "s"}</span> live and not yet invoiced · {fmtInr(d.bookings.toInvoice.totalPaise, { whole: true })}</span>
          <span className="text-indigo-light text-xs uppercase tracking-[0.08em]">On the sales portal →</span>
        </PortalLink>
      )}
      {quiet && (
        <div className="mb-6">
          <Empty title="Nothing invoiced through the portal yet." body="Record an invoice for work already agreed, or import the old ones from Swipe." action={<Link href="/invoices/import" className="btn">Import invoices</Link>} />
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Link href="/invoices?status=all" className="min-w-0 block hover:[&>div]:border-indigo"><Stat label="Invoiced this FY" value={fmtInr(d.invoicedFyPaise, { whole: true })} sub={`${d.invoicedFyCount} tax invoices · ${fmtInr(d.invoicedMonthPaise, { whole: true })} this month`} /></Link>
        <Link href="/payments" className="min-w-0 block hover:[&>div]:border-indigo"><Stat label="Collected this FY" value={fmtInr(d.collectedFyPaise, { whole: true })} sub={`${fmtInr(d.collectedMonthPaise, { whole: true })} this month${d.tdsFyPaise ? ` · TDS ${fmtInr(d.tdsFyPaise, { whole: true })}` : ""}`} tone="success" /></Link>
        <Link href="/invoices?status=outstanding" className="min-w-0 block hover:[&>div]:border-indigo"><Stat label="Outstanding" value={fmtInr(d.outstandingPaise, { whole: true })} sub={`${d.outstandingCount} open invoice${d.outstandingCount === 1 ? "" : "s"}`} tone={d.outstandingPaise ? "attention" : undefined} /></Link>
        <Link href="/invoices?status=overdue" className="min-w-0 block hover:[&>div]:border-indigo"><Stat label="Overdue" value={fmtInr(d.overduePaise, { whole: true })} sub={`${d.overdueCount} past due date`} tone={d.overdueCount ? "danger" : undefined} /></Link>
      </div>
      {d.bank && (() => {
        const bank = d.bank;
        const newest = bank.accounts.map((a) => a.lastStatementTo).filter((x): x is string => !!x).sort().pop() ?? null;
        const stale = newest ? daysBetween(newest, todayIST()) : null;
        const month = new Date(`${d.today}T00:00:00Z`).toLocaleString("en-IN", { month: "short", timeZone: "UTC" });
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            <Link href="/bank" className="min-w-0 block hover:[&>div]:border-indigo"><Stat label={`Unmatched credits · ${month}`} value={fmtInr(bank.unmatchedMonthPaise, { whole: true })} sub={stale != null && stale > 10 ? `No statement for ${stale} days` : `${bank.unmatchedMonthCount} credits · ${bank.sureCount} sure`} tone={bank.unmatchedMonthCount ? "attention" : "success"} /></Link>
            <Link href="/bank/upload" className="min-w-0 block hover:[&>div]:border-indigo"><Stat label="Bank statements" value={newest ? fmtDate(newest) : "None yet"} sub={newest ? "latest statement day · upload the next one" : "Upload the first statement"} /></Link>
            <Link href="/reconcile" className="min-w-0 block hover:[&>div]:border-indigo"><Stat label="Reconcile" value="GST · TDS · BRS" sub="GSTR-1, Form 26AS, balance confirmations, bank" /></Link>
            <Link href="/accounts" className="min-w-0 block hover:[&>div]:border-indigo"><Stat label="Accounts" value={d.financialYear} sub="invoiced, collected, GST and TDS by month" /></Link>
          </div>
        );
      })()}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="card p-4">
          <h2 className="font-bold mb-3">Top clients this FY <span className="text-ink-3 font-normal text-xs">by invoiced amount · the client pages are on the sales portal</span></h2>
          {d.topClients.length === 0 ? <p className="text-ink-3 text-sm">No invoices issued this financial year.</p> : (
            <ul className="divide-y divide-rule">
              {d.topClients.map((c) => (
                <li key={c.clientId} className="py-2 flex justify-between gap-3 text-sm">
                  <PortalLink portal="sales" href={`/clients/view?id=${c.clientId}`} className="truncate hover:text-indigo-light">{c.name}</PortalLink>
                  <Money paise={c.invoicedPaise} whole />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card p-4">
          <h2 className="font-bold mb-3">Recent activity</h2>
          {recent.length === 0 ? <p className="text-ink-3 text-sm">Nothing yet.</p> : (
            <ul className="divide-y divide-rule">
              {recent.map((e) => (
                <li key={e.id} className="py-2 text-sm flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-ink-4 text-xs w-[72px] shrink-0">{fmtDate(e.createdAt)}</span>
                  <span className="text-ink-3">{e.entityType.replace("_", " ")}</span>
                  <span className="truncate">{e.label ?? e.action.replace(/_/g, " ")}</span>
                  {e.toStatus && <StatusPill status={e.toStatus} />}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
