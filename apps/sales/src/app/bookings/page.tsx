"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useBookings } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import { companyName } from "@/lib/company";
import { Empty, LoadError, Loading, Money, PageHead, StatusPill } from "@/components/sales-ui";

// Client campaign bookings (client.digitalsukoon.com → Campaigns). Review, posting and refunds
// happen in the staff portal; here the sales team sees where each stands and bills it.

const TABS: Array<[string, string]> = [
  ["all", "All"], ["to_invoice", "To invoice"], ["review", "In review"], ["active", "Approved"], ["live", "Live"], ["awaiting_payment", "Unpaid"], ["closed", "Closed"],
];

export default function BookingsPage() {
  const [stage, setStage] = useState("all");
  // Opened from a dashboard tile: start on its tab (read once; no useSearchParams in a static export page).
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("stage");
    if (s && TABS.some(([k]) => k === s)) setStage(s);
  }, []);
  const [q, setQ] = useState("");
  const { data, error, isLoading, mutate } = useBookings({ stage, q: q.trim() || undefined });
  return (
    <>
      <PageHead kicker="Bookings" title="Campaign bookings" />
      <p className="text-sm text-ink-3 -mt-2 mb-4">Campaigns clients booked themselves on the client portal. Staff review and post them in the staff portal; bill them from here. A booking belongs to neither company until it is invoiced.</p>
      <div className="card p-3 mb-4 flex flex-wrap gap-2 items-center">
        <div className="flex flex-wrap gap-1">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setStage(k)} className={`px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] border-2 ${stage === k ? "bg-indigo border-indigo text-white font-bold" : "border-transparent text-ink-3 hover:border-border hover:text-white"}`}>{label}</button>
          ))}
        </div>
        <input className="input flex-1 min-w-[200px]" placeholder="Search campaign, brand or client" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error ? <LoadError error={error} retry={() => mutate()} /> : isLoading && !data ? <Loading /> : !data?.length ? (
        <Empty title={stage === "to_invoice" ? "Nothing waiting to be invoiced." : "No bookings here."} body="Bookings appear once a client submits a campaign on the client portal." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left">
              <tr className="border-b-2 border-border"><th className="p-3">Campaign</th><th className="p-3">Client</th><th className="p-3">Status</th><th className="p-3">Posts live</th><th className="p-3">Invoice</th><th className="p-3 text-right">To bill</th></tr>
            </thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id} className="border-b border-rule hover:bg-muted/60">
                  <td className="p-3 min-w-0">
                    <Link href={`/bookings/view?id=${b.id}`} className="font-bold hover:text-indigo-light">{b.name}</Link>
                    <div className="text-xs text-ink-4">{b.brand} · {fmtDate(b.submittedAt ?? b.createdAt)}{b.paidOnline ? " · paid online" : ""}</div>
                  </td>
                  <td className="p-3"><Link href={`/clients/view?id=${b.client.id}`} className="hover:text-indigo-light">{b.client.companyName}</Link></td>
                  <td className="p-3"><StatusPill status={b.status} label={b.statusLabel} /></td>
                  <td className="p-3">{b.liveCount}/{b.itemCount}</td>
                  <td className="p-3">
                    {b.invoices.filter((i) => i.status !== "cancelled").length
                      ? b.invoices.filter((i) => i.status !== "cancelled").map((i) => <Link key={i.id} href={`/invoices/view?id=${i.id}`} className="font-mono text-xs hover:text-indigo-light block" title={companyName(i.companyKey)}>{i.number ?? "draft"}</Link>)
                      : b.billable ? <span className="text-attention text-xs">Not invoiced</span> : <span className="text-ink-4">—</span>}
                  </td>
                  <td className="p-3 text-right">{b.billable ? <Money paise={b.billablePaise} /> : <span className="text-ink-4">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
