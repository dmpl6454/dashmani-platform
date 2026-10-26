"use client";
import { useState } from "react";
import Link from "next/link";
import { usePayments } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import { Empty, LoadError, Loading, Money, PageHead, StatusPill, titleCase } from "@/components/sales-ui";

export default function PaymentsPage() {
  const [q, setQ] = useState("");
  const { data, error, isLoading, mutate } = usePayments({ q: q.trim() || undefined });
  // Voided receipts are listed (their numbers stay on record) but never counted; refunds come off.
  const total = (data ?? []).filter((p) => p.status === "recorded").reduce((s, p) => s + p.amountPaise - p.refundedPaise, 0);
  return (
    <>
      <PageHead kicker="Payments" title="Payments received"><Link href="/payments/record" className="btn">Record payment</Link></PageHead>
      <div className="card p-3 mb-4"><input className="input" placeholder="Search receipt, reference or client" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {error ? <LoadError error={error} retry={() => mutate()} /> : isLoading && !data ? <Loading /> : !data?.length ? <Empty title="No payments recorded." body="Record a bank transfer, UPI, cheque or cash receipt and allocate it to invoices." action={<Link href="/payments/record" className="btn">Record payment</Link>} /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-3">Receipt</th><th className="p-3">Date</th><th className="p-3">Client</th><th className="p-3">Mode · reference</th><th className="p-3">Invoices</th><th className="p-3 text-right">Received</th><th className="p-3 text-right">TDS</th></tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} className="border-b border-rule hover:bg-muted/60">
                  <td className="p-3 font-mono"><Link href={`/payments/view?id=${p.id}`} className={`hover:text-indigo-light ${p.status === "voided" ? "line-through text-ink-3" : ""}`}>{p.number}</Link>{p.status === "voided" && <> <StatusPill status="voided" /></>}</td><td className="p-3">{fmtDate(p.paidOn)}</td>
                  <td className="p-3"><Link href={`/clients/view?id=${p.client.id}`} className="hover:text-indigo-light">{p.client.companyName}</Link></td>
                  <td className="p-3">{titleCase(p.mode)}{p.reference ? <span className="text-ink-3 font-mono text-xs"> · {p.reference}</span> : null}</td>
                  <td className="p-3">{p.allocations.length ? p.allocations.map((a) => <Link key={a.invoiceId} href={`/invoices/view?id=${a.invoiceId}`} className="font-mono text-xs hover:text-indigo-light block">{a.invoice.number ?? "draft"} · <Money paise={a.amountPaise + a.tdsPaise} /></Link>) : <span className="text-ink-4">unallocated</span>}{p.status === "recorded" && p.allocations.length > 0 && p.unallocatedPaise > 0 && <span className="block text-xs text-attention">+ <Money paise={p.unallocatedPaise} /> unallocated</span>}{p.refundedPaise > 0 && <span className="block text-xs text-ink-3">refunded <Money paise={p.refundedPaise} /></span>}</td>
                  <td className="p-3 text-right"><Money paise={p.amountPaise} /></td><td className="p-3 text-right"><Money paise={p.tdsPaise} className={p.tdsPaise ? "" : "text-ink-3"} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="font-bold"><td className="p-3" colSpan={5}>Received, net of refunds (this list)</td><td className="p-3 text-right"><Money paise={total} /></td><td /></tr></tfoot>
          </table>
        </div>
      )}
    </>
  );
}
