"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import useSWR, { mutate as mutateGlobal } from "swr";
import { useRouter, useSearchParams } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { useBooking } from "@/lib/hooks";
import { apiFetch, fetcher } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate } from "@/lib/format";
import { companyName, useCompany } from "@/lib/company";
import type { Invoice } from "@/lib/sales-types";
import type { PortalDirectory } from "@/lib/types";
import { LoadError, Loading, Money, PageHead, StatusPill, Toast, platformLabel, titleCase } from "@/components/sales-ui";

function BookingView() {
  const id = useSearchParams().get("id");
  const router = useRouter();
  const { company, info } = useCompany();
  const { data: b, error, isLoading, mutate } = useBooking(id);
  const { data: portals } = useSWR<PortalDirectory>("/auth/portals", fetcher, { revalidateOnFocus: false, dedupingInterval: 300_000 });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  if (!id) return <LoadError error={new Error("No booking selected")} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !b) return <Loading />;
  const staff = portals?.portals.find((p) => p.key === "internal");
  const live = b.invoices.filter((i) => i.status !== "cancelled");
  const canInvoice = b.billable && live.length === 0 && b.billablePaise > 0;

  async function createInvoice() {
    setBusy(true);
    try {
      const res = await apiFetch<Invoice>(`/sales/invoices/from-booking/${b!.id}?company=${company}`, { method: "POST" });
      await mutateGlobal((key) => typeof key === "string" && (key.startsWith("/sales/bookings") || key.startsWith("/sales/invoices") || key.startsWith("/sales/dashboard")), undefined, { revalidate: true });
      router.push(`/invoices/view?id=${res.data.id}`);
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead kicker={<><Link href="/bookings" className="hover:text-white">Bookings</Link> · {b.brand}</> as unknown as string} title={<>{b.name} <StatusPill status={b.status} label={b.statusLabel} /></>}>
        {canInvoice && <button type="button" className="btn" disabled={busy} onClick={createInvoice}>{busy ? "Creating…" : `Create invoice (${info.short})`}</button>}
        {staff?.access && <a href={`${staff.url.replace(/\/+$/, "")}/campaigns/${b.id}`} target="_blank" rel="noopener noreferrer" className="btn btn-light">Open in staff portal <ExternalLink size={14} aria-hidden /></a>}
      </PageHead>
      {canInvoice && <p className="text-sm text-ink-3 -mt-2 mb-4">The invoice is a draft for {info.name} (switch company at the top to bill the other). It bills every account except posts that failed or were refunded.</p>}
      {!b.billable && <div className="card p-3 text-sm mb-4">This booking is {b.statusLabel.toLowerCase()}, so it cannot be invoiced.</div>}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <section className="card p-4 text-sm grid gap-2">
          <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Client</div><Link href={`/clients/view?id=${b.client.id}`} className="font-bold hover:text-indigo-light">{b.client.billingProfile?.legalName ?? b.client.companyName}</Link><div className="text-ink-3 text-xs">{b.client.contactName ? `${b.client.contactName} · ` : ""}{b.client.email}{b.client.billingProfile?.gstin ? ` · GSTIN ${b.client.billingProfile.gstin}` : " · no GSTIN on file"}</div></div>
          <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Campaign</div>{titleCase(b.campaignType)}{b.format ? ` · ${titleCase(b.format)}` : ""}{b.audioIntegration ? ` · song${b.audioTrack ? `: ${b.audioTrack}` : ""}` : ""}</div>
          <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Posting window</div>{b.launchFrom ? `${fmtDate(b.launchFrom)} – ${fmtDate(b.launchTo)}` : "—"}</div>
          <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Payment</div>{b.paidOnline ? "Paid online (Razorpay)" : "Collected offline — not paid online"}</div>
          <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Submitted</div>{fmtDate(b.submittedAt ?? b.createdAt)}{b.approvedAt ? ` · approved ${fmtDate(b.approvedAt)}` : ""}</div>
          {b.reviewNote && <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Review note</div>{b.reviewNote}</div>}
        </section>
        <section className="card p-4 text-sm lg:col-span-2">
          <h2 className="font-bold mb-3">Billing</h2>
          <div className="flex flex-wrap gap-x-8 gap-y-2 mb-3">
            <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Booked</div><Money paise={b.totalPaise} /></div>
            <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">To bill</div>{b.billable ? <Money paise={b.billablePaise} /> : "—"}</div>
          </div>
          {b.invoices.length === 0 ? <p className="text-ink-3">Not invoiced yet.</p> : (
            <ul className="divide-y divide-rule">
              {b.invoices.map((i) => (
                <li key={i.id} className="py-2 flex flex-wrap justify-between gap-2">
                  <span><Link href={`/invoices/view?id=${i.id}`} className="font-mono hover:text-indigo-light">{i.number ?? "Draft invoice"}</Link> <StatusPill status={i.status} /> <span className="text-ink-4 text-xs">{companyName(i.companyKey)}{i.kind === "proforma" ? " · proforma" : ""}</span></span>
                  <Money paise={i.totalPaise} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-3">Account</th><th className="p-3">Post</th><th className="p-3">Status</th><th className="p-3 text-right">Price</th></tr></thead>
          <tbody>
            {b.items.map((i) => (
              <tr key={i.id} className={`border-b border-rule ${i.billed ? "" : "text-ink-4"}`}>
                <td className="p-3"><span className="font-bold">{i.accountName}</span>{i.accountHandle ? <span className="text-ink-4"> @{i.accountHandle}</span> : null}</td>
                <td className="p-3">{platformLabel(i.platform)} {titleCase(i.format)}{i.audioAddonPaise ? " + song" : ""}{i.permalink ? <> · <a href={i.permalink} target="_blank" rel="noopener noreferrer" className="underline hover:text-indigo-light">view post</a></> : null}</td>
                <td className="p-3"><StatusPill status={i.status} />{!i.billed && <span className="text-xs ml-2">not billed</span>}</td>
                <td className="p-3 text-right"><Money paise={i.pricePaise} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function BookingViewPage() {
  return <Suspense fallback={<Loading />}><BookingView /></Suspense>;
}
