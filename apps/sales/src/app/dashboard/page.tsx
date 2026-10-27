"use client";
import Link from "next/link";
import { useDashboard } from "@/lib/hooks";
import { fmtInr, fmtDate } from "@/lib/format";
import { Empty, LoadError, Loading, Money, PageHead, Stat, StatusPill, platformLabel } from "@/components/sales-ui";

export default function DashboardPage() {
  const { data, error, isLoading, mutate } = useDashboard();
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !data) return <Loading label="Adding things up…" />;
  const d = data;
  const quiet = d.invoicedFyCount === 0 && d.openQuotes.count === 0 && d.activeOrders.count === 0;
  return (
    <>
      <PageHead kicker={`Financial year ${d.financialYear} · ${fmtDate(d.today)}`} title="Sales at a glance">
        <Link href="/quotes/edit" className="btn">New quote</Link>
        <Link href="/invoices/edit" className="btn btn-light">New invoice</Link>
      </PageHead>
      {quiet && (
        <div className="mb-6">
          <Empty title="Nothing sold through the portal yet." body="Start with a quote from the inventory, or record an invoice for work already agreed." action={<Link href="/inventory" className="btn">Open the inventory</Link>} />
        </div>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Stat label="Invoiced this FY" value={fmtInr(d.invoicedFyPaise, { whole: true })} sub={`${d.invoicedFyCount} tax invoices · ${fmtInr(d.invoicedMonthPaise, { whole: true })} this month`} />
        <Stat label="Collected this FY" value={fmtInr(d.collectedFyPaise, { whole: true })} sub={`${fmtInr(d.collectedMonthPaise, { whole: true })} this month${d.tdsFyPaise ? ` · TDS ${fmtInr(d.tdsFyPaise, { whole: true })}` : ""}`} tone="success" />
        <Stat label="Outstanding" value={fmtInr(d.outstandingPaise, { whole: true })} sub={`${d.outstandingCount} open invoice${d.outstandingCount === 1 ? "" : "s"}`} tone={d.outstandingPaise ? "attention" : undefined} />
        <Stat label="Overdue" value={fmtInr(d.overduePaise, { whole: true })} sub={`${d.overdueCount} past due date`} tone={d.overdueCount ? "danger" : undefined} />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
        <Stat label="Open quotes" value={d.openQuotes.count} sub={fmtInr(d.openQuotes.totalPaise, { whole: true })} />
        <Stat label="Accepted, not ordered" value={d.acceptedQuotes.count} sub={fmtInr(d.acceptedQuotes.totalPaise, { whole: true })} />
        <Stat label="Active orders" value={d.activeOrders.count} sub={fmtInr(d.activeOrders.totalPaise, { whole: true })} />
        <Stat label="Delivered, awaiting close" value={d.deliveredOrders.count} sub={fmtInr(d.deliveredOrders.totalPaise, { whole: true })} />
      </div>
      {d.bookings && (
        <section className="card p-4 mb-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
            <h2 className="font-bold">Campaign bookings <span className="text-ink-3 font-normal text-xs">booked by clients on the client portal · same for both companies</span></h2>
            <Link href="/bookings" className="text-sm hover:text-indigo-light">All bookings →</Link>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Link href="/bookings?stage=review" className="min-w-0"><Stat label="In review" value={d.bookings.review.count} sub={fmtInr(d.bookings.review.totalPaise, { whole: true })} tone={d.bookings.review.count ? "attention" : undefined} /></Link>
            <Link href="/bookings?stage=active" className="min-w-0"><Stat label="Approved, going live" value={d.bookings.active.count} sub={fmtInr(d.bookings.active.totalPaise, { whole: true })} /></Link>
            <Link href="/bookings?stage=live" className="min-w-0"><Stat label="Live" value={d.bookings.live.count} sub={fmtInr(d.bookings.live.totalPaise, { whole: true })} tone={d.bookings.live.count ? "success" : undefined} /></Link>
            <Link href="/bookings?stage=to_invoice" className="min-w-0"><Stat label="To invoice" value={d.bookings.toInvoice.count} sub={fmtInr(d.bookings.toInvoice.totalPaise, { whole: true })} tone={d.bookings.toInvoice.count ? "attention" : undefined} /></Link>
          </div>
          {d.bookings.recentToInvoice.length > 0 && (
            <ul className="divide-y divide-rule mt-3">
              {d.bookings.recentToInvoice.map((b) => (
                <li key={b.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0"><Link href={`/bookings/view?id=${b.id}`} className="font-bold hover:text-indigo-light">{b.name}</Link> <span className="text-ink-4">· {b.client}</span> <StatusPill status={b.status} label={b.statusLabel} /></span>
                  <span className="flex items-center gap-3"><Money paise={b.billablePaise} whole /><Link href={`/bookings/view?id=${b.id}`} className="btn btn-light btn-sm">Invoice</Link></span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {d.ordersByFy.length > 0 && (
        <section className="card p-4 mb-4">
          <h2 className="font-bold mb-3">Sales by financial year <span className="text-ink-3 font-normal text-xs">confirmed orders · closed = delivered and paid</span></h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2">Financial year</th><th className="p-2 text-right">Orders</th><th className="p-2 text-right">Order value</th><th className="p-2 text-right">Closed</th></tr></thead>
              <tbody>{d.ordersByFy.map((r) => <tr key={r.financialYear} className="border-b border-rule"><td className="p-2 font-mono">{r.financialYear}</td><td className="p-2 text-right">{r.count}</td><td className="p-2 text-right"><Money paise={r.totalPaise} whole /></td><td className="p-2 text-right"><Money paise={r.closedPaise} whole /></td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="card p-4">
          <h2 className="font-bold mb-3">Top clients this FY</h2>
          {d.topClients.length === 0 ? <p className="text-ink-3 text-sm">No invoices issued this financial year.</p> : (
            <ul className="divide-y divide-rule">
              {d.topClients.map((c) => (
                <li key={c.clientId} className="py-2 flex justify-between gap-3 text-sm">
                  <Link href={`/clients/view?id=${c.clientId}`} className="truncate hover:text-indigo-light">{c.name}</Link>
                  <Money paise={c.invoicedPaise} whole />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card p-4">
          <h2 className="font-bold mb-3">Orders by platform this FY</h2>
          {d.byPlatform.length === 0 ? <p className="text-ink-3 text-sm">No confirmed orders this financial year.</p> : (
            <ul className="divide-y divide-rule">
              {d.byPlatform.map((p) => (
                <li key={p.platform} className="py-2 flex justify-between gap-3 text-sm">
                  <span>{platformLabel(p.platform)} <span className="text-ink-4">· {p.lines} line{p.lines === 1 ? "" : "s"}</span></span>
                  <Money paise={p.amountPaise} whole />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card p-4">
          <h2 className="font-bold mb-3">Recent activity</h2>
          {d.recent.length === 0 ? <p className="text-ink-3 text-sm">Nothing yet.</p> : (
            <ul className="divide-y divide-rule">
              {d.recent.map((e) => (
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
