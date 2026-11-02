"use client";
import { useState } from "react";
import Link from "next/link";
import { useClients } from "@/lib/hooks";
import { Empty, LoadError, Loading, Money, PageHead } from "@/components/sales-ui";

export default function ClientsPage() {
  const [q, setQ] = useState("");
  const { data, error, isLoading, mutate } = useClients(q.trim() || undefined);
  return (
    <>
      <PageHead kicker={data ? `${data.length} clients` : "Clients"} title="Clients">
        <Link href="/clients/new" className="btn">Add client</Link>
      </PageHead>
      <div className="card p-3 mb-4"><input className="input" placeholder="Search company, contact, email or legal name" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {error ? <LoadError error={error} retry={() => mutate()} /> : isLoading && !data ? <Loading /> : !data?.length ? <Empty title={q.trim() ? "No clients match." : "No clients yet."} action={<Link href="/clients/new" className="btn">Add client</Link>} /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-3">Client</th><th className="p-3">Contact</th><th className="p-3">GST</th><th className="p-3 text-right">Outstanding</th></tr></thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className="border-b border-rule hover:bg-muted/60">
                  <td className="p-3"><Link href={`/clients/view?id=${c.id}`} className="font-bold hover:text-indigo-light">{c.companyName}</Link>{c.billingProfile?.legalName && c.billingProfile.legalName !== c.companyName && <div className="text-xs text-ink-3">{c.billingProfile.legalName}</div>}</td>
                  <td className="p-3"><div>{c.contactName}</div><div className="text-xs text-ink-3">{c.email}</div></td>
                  <td className="p-3 font-mono text-xs">{c.billingProfile?.gstin ?? <span className="text-ink-4">not set</span>}</td>
                  <td className="p-3 text-right"><Money paise={c.outstandingPaise} whole className={c.outstandingPaise ? "text-attention" : "text-ink-3"} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
