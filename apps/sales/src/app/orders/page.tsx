"use client";
import { useState } from "react";
import Link from "next/link";
import { useOrders } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import { Empty, LoadError, Loading, Money, PageHead, StatusPill } from "@/components/sales-ui";

const TABS = ["all", "draft", "confirmed", "in_progress", "delivered", "closed", "cancelled"];

export default function OrdersPage() {
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const { data, error, isLoading, mutate } = useOrders({ status: status === "all" ? undefined : status, q: q.trim() || undefined });
  return (
    <>
      <PageHead kicker="Orders" title="Orders"><Link href="/orders/edit" className="btn">New order</Link></PageHead>
      <div className="card p-3 mb-4 flex flex-wrap gap-2 items-center">
        <div className="flex flex-wrap gap-1">{TABS.map((t) => <button key={t} type="button" onClick={() => setStatus(t)} className={`px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] border-2 ${status === t ? "bg-indigo border-indigo text-white font-bold" : "border-transparent text-ink-3 hover:border-border hover:text-white"}`}>{t.replace("_", " ")}</button>)}</div>
        <input className="input flex-1 min-w-[200px]" placeholder="Search number, title or client" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error ? <LoadError error={error} retry={() => mutate()} /> : isLoading && !data ? <Loading /> : !data?.length ? <Empty title="No orders here." body="Convert an accepted quote, or write an order up directly." action={<Link href="/orders/edit" className="btn">New order</Link>} /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-3">Order</th><th className="p-3">Client</th><th className="p-3">Status</th><th className="p-3">Delivery</th><th className="p-3">Invoices</th><th className="p-3 text-right">Total</th></tr></thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id} className="border-b border-rule hover:bg-muted/60">
                  <td className="p-3"><Link href={`/orders/view?id=${o.id}`} className="hover:text-indigo-light"><span className="font-mono">{o.number}</span> <span className="font-bold">{o.title}</span></Link><div className="text-xs text-ink-4">{fmtDate(o.createdAt)}{o.poNumber ? ` · PO ${o.poNumber}` : ""}</div></td>
                  <td className="p-3">{o.client.companyName}</td>
                  <td className="p-3"><StatusPill status={o.status} /></td>
                  <td className="p-3">{o.deliveredCount ?? 0}/{o.itemCount ?? 0} lines</td>
                  <td className="p-3">{o.invoices.length ? o.invoices.map((i) => <Link key={i.id} href={`/invoices/view?id=${i.id}`} className="font-mono text-xs hover:text-indigo-light block">{i.number ?? "draft"}</Link>) : <span className="text-ink-4">none</span>}</td>
                  <td className="p-3 text-right"><Money paise={o.totalPaise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
