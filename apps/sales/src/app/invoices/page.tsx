"use client";
import { useState } from "react";
import Link from "next/link";
import { useInvoices } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import { Empty, LoadError, Loading, Money, PageHead, StatusPill } from "@/components/sales-ui";

const TABS = ["all", "draft", "outstanding", "overdue", "partially_paid", "paid", "cancelled"];

export default function InvoicesPage() {
  const [status, setStatus] = useState("outstanding");
  const [q, setQ] = useState("");
  const { data, error, isLoading, mutate } = useInvoices({ status: status === "all" ? undefined : status, q: q.trim() || undefined });
  const total = (data ?? []).reduce((s, i) => s + i.balancePaise, 0);
  return (
    <>
      <PageHead kicker="Invoices" title="Invoices"><Link href="/invoices/edit" className="btn">New invoice</Link><Link href="/payments/record" className="btn btn-light">Record payment</Link></PageHead>
      <div className="card p-3 mb-4 flex flex-wrap gap-2 items-center">
        <div className="flex flex-wrap gap-1">{TABS.map((t) => <button key={t} type="button" onClick={() => setStatus(t)} className={`px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] border-2 ${status === t ? "bg-indigo border-indigo text-white font-bold" : "border-transparent text-ink-3 hover:border-border hover:text-white"}`}>{t.replace("_", " ")}</button>)}</div>
        <input className="input flex-1 min-w-[200px]" placeholder="Search number or client" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error ? <LoadError error={error} retry={() => mutate()} /> : isLoading && !data ? <Loading /> : !data?.length ? <Empty title={status === "outstanding" ? "Nothing outstanding." : "No invoices here."} body="Create one from an order, a campaign booking, or from scratch." action={<Link href="/invoices/edit" className="btn">New invoice</Link>} /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-3">Invoice</th><th className="p-3">Client</th><th className="p-3">Issued</th><th className="p-3">Due</th><th className="p-3">Status</th><th className="p-3 text-right">Total</th><th className="p-3 text-right">Balance</th></tr></thead>
            <tbody>
              {data.map((i) => (
                <tr key={i.id} className="border-b border-rule hover:bg-muted/60">
                  <td className="p-3"><Link href={`/invoices/view?id=${i.id}`} className="font-mono hover:text-indigo-light">{i.number ?? "Draft"}</Link>{i.kind === "proforma" && <span className="text-xs text-ink-3"> · proforma</span>}</td>
                  <td className="p-3">{i.client?.billingProfile?.legalName ?? i.client?.companyName ?? "—"}</td>
                  <td className="p-3">{fmtDate(i.issueDate)}</td><td className="p-3">{fmtDate(i.dueDate)}</td>
                  <td className="p-3"><StatusPill status={i.derivedStatus} /></td>
                  <td className="p-3 text-right"><Money paise={i.totalPaise} /></td>
                  <td className="p-3 text-right"><Money paise={i.balancePaise} className={i.balancePaise ? (i.derivedStatus === "overdue" ? "text-danger" : "") : "text-ink-3"} /></td>
                </tr>
              ))}
            </tbody>
            {(status === "outstanding" || status === "overdue") && <tfoot><tr className="font-bold"><td className="p-3" colSpan={6}>Total balance</td><td className="p-3 text-right"><Money paise={total} /></td></tr></tfoot>}
          </table>
        </div>
      )}
    </>
  );
}
