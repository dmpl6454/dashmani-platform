"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuotes } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import { Empty, LoadError, Loading, Money, PageHead, StatusPill } from "@/components/sales-ui";

const TABS = ["all", "draft", "sent", "accepted", "converted", "declined", "expired"];

export default function QuotesPage() {
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const { data, error, isLoading, mutate } = useQuotes({ status: status === "all" ? undefined : status, q: q.trim() || undefined });
  return (
    <>
      <PageHead kicker="Quotes" title="Quotes"><Link href="/quotes/edit" className="btn">New quote</Link></PageHead>
      <div className="card p-3 mb-4 flex flex-wrap gap-2 items-center">
        <div className="flex flex-wrap gap-1">{TABS.map((t) => <button key={t} type="button" onClick={() => setStatus(t)} className={`px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] border-2 ${status === t ? "bg-indigo border-indigo text-white font-bold" : "border-transparent text-ink-3 hover:border-border hover:text-white"}`}>{t}</button>)}</div>
        <input className="input flex-1 min-w-[200px]" placeholder="Search number, title or client" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error ? <LoadError error={error} retry={() => mutate()} /> : isLoading && !data ? <Loading /> : !data?.length ? <Empty title="No quotes here." body="Build one from the inventory." action={<Link href="/quotes/edit" className="btn">New quote</Link>} /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-3">Quote</th><th className="p-3">Client</th><th className="p-3">Status</th><th className="p-3">Valid until</th><th className="p-3 text-right">Lines</th><th className="p-3 text-right">Total</th></tr></thead>
            <tbody>
              {data.map((qt) => (
                <tr key={qt.id} className="border-b border-rule hover:bg-muted/60">
                  <td className="p-3"><Link href={`/quotes/view?id=${qt.id}`} className="hover:text-indigo-light"><span className="font-mono">{qt.number}</span> <span className="font-bold">{qt.title}</span></Link><div className="text-xs text-ink-4">{fmtDate(qt.createdAt)}</div></td>
                  <td className="p-3">{qt.client.companyName}</td>
                  <td className="p-3"><StatusPill status={qt.expired ? "expired" : qt.status} /></td>
                  <td className="p-3">{fmtDate(qt.validUntil)}</td>
                  <td className="p-3 text-right">{qt.itemCount ?? qt.items?.length ?? "—"}</td>
                  <td className="p-3 text-right"><Money paise={qt.totalPaise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
