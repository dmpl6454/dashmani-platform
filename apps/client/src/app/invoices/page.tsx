"use client";
import { Topstrip } from "@/components/portal-topstrip";
import { Empty, PageError, Skeleton } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { InvoiceList } from "@/components/invoice-list";
import { inr, useClientInvoices } from "@/lib/hooks/use-invoices";

export default function InvoicesPage() {
  const { data, error, isLoading, mutate } = useClientInvoices();
  const invoices = data ?? [];
  const due = invoices.filter((i) => i.status !== "cancelled").reduce((s, i) => s + i.balancePaise, 0);

  return (
    <>
      <Topstrip
        title="Invoices"
        sub={data ? `${invoices.length} invoice${invoices.length === 1 ? "" : "s"}${due > 0 ? ` · ${inr(due)} due` : ""}` : "Your invoices"}
      />
      <div className="px-4 sm:px-6 py-4 max-w-4xl">
        {error && !data ? (
          <div>
            <PageError message="Your invoices couldn't be loaded — this is a loading problem, not a billing one." />
            <div className="text-center"><button type="button" className="underline text-[13px] text-indigo-light" onClick={() => mutate()}>Try again</button></div>
          </div>
        ) : isLoading && !data ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
        ) : invoices.length === 0 ? (
          <Empty icon={<Icon.Receipt size={20} />} title="No invoices yet" hint="Your invoice appears here — and in your inbox — as soon as a payment is received." />
        ) : (
          <>
            <p className="text-[12.5px] text-ink-3 mb-3">Each invoice is also emailed to you when a payment is received. Download any of them as a PDF.</p>
            <InvoiceList invoices={invoices} />
          </>
        )}
      </div>
    </>
  );
}
