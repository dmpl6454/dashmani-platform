"use client";
import { useState } from "react";
import Link from "next/link";
import { useRecurringList } from "@/lib/hooks";
import { useCompany } from "@/lib/company";
import { Empty, LoadError, Loading, PageHead } from "@/components/sales-ui";
import { RecurringTable } from "@/components/recurring-table";

// Recurring (retainer) invoices of the current company. A daily job at 06:30 IST bills every
// due period once: a draft to review, or issued and emailed, as each template says.

const TABS = ["active", "paused", "ended", "all"];

export default function RecurringPage() {
  const [status, setStatus] = useState("active");
  const { info } = useCompany();
  const { data, error, isLoading, mutate } = useRecurringList({ status: status === "all" ? undefined : status });
  return (
    <>
      <PageHead kicker="Recurring" title="Recurring invoices"><Link href="/recurring/edit" className="btn">New recurring invoice</Link></PageHead>
      <p className="text-sm text-ink-3 mb-4">Billed by {info.name}. Every morning at 6:30 IST each active template due that day creates its invoice once — as a draft, or issued and emailed to the client.</p>
      <div className="card p-3 mb-4 flex flex-wrap gap-1">
        {TABS.map((t) => <button key={t} type="button" onClick={() => setStatus(t)} className={`px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] border-2 ${status === t ? "bg-indigo border-indigo text-white font-bold" : "border-transparent text-ink-3 hover:border-border hover:text-white"}`}>{t}</button>)}
      </div>
      {error ? <LoadError error={error} retry={() => mutate()} /> : isLoading && !data ? <Loading /> : !data?.length
        ? <Empty title={status === "active" ? "No active recurring invoices." : "Nothing here."} body="Set one up for a retainer client: the lines, how often, and whether it is issued automatically." action={<Link href="/recurring/edit" className="btn">New recurring invoice</Link>} />
        : <RecurringTable rows={data} />}
    </>
  );
}
