"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEvents, useQuote } from "@/lib/hooks";
import { companyName } from "@/lib/company";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate } from "@/lib/format";
import type { Order } from "@/lib/sales-types";
import { Confirm, Empty, LoadError, Loading, Money, PageHead, StatusPill, Toast, platformLabel, titleCase } from "@/components/sales-ui";
import { DocumentLines, EventList } from "@/components/document-view";

function QuoteView() {
  const id = useSearchParams().get("id");
  const router = useRouter();
  const { data: q, error, isLoading, mutate } = useQuote(id);
  const { data: events, mutate: mutateEvents } = useEvents("quote", id);
  const [confirm, setConfirm] = useState<null | "delete" | "convert" | "decline">(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  if (!id) return <Empty title="No quote selected." action={<Link href="/quotes" className="btn">Back to quotes</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !q) return <Loading />;
  const status = q.expired ? "expired" : q.status;

  async function act(path: string, ok: string) {
    try {
      await apiFetch(`/sales/quotes/${id}/${path}`, { method: "POST" });
      await Promise.all([mutate(), mutateEvents()]);
      setToast({ message: ok, tone: "ok" });
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
    }
  }
  async function convert() {
    try {
      const res = await apiFetch<Order>(`/sales/quotes/${id}/convert`, { method: "POST" });
      router.push(`/orders/view?id=${res.data.id}`);
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
    }
  }
  async function remove() {
    try {
      await apiFetch(`/sales/quotes/${id}`, { method: "DELETE" });
      router.replace("/quotes");
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
    }
  }

  return (
    <>
      <PageHead kicker={<><Link href="/quotes" className="hover:text-white">Quotes</Link> · {companyName(q.companyKey)} · <span className="font-mono">{q.number}</span></> as unknown as string} title={<>{q.title} <StatusPill status={status} /></>}>
        {(status === "draft" || status === "sent") && <Link href={`/quotes/edit?id=${q.id}`} className="btn btn-light">Edit</Link>}
        {status === "draft" && <button type="button" className="btn" onClick={() => act("send", "Marked as sent.")}>Mark sent</button>}
        {(status === "draft" || status === "sent") && <button type="button" className="btn" onClick={() => act("accept", "Marked as accepted.")}>Mark accepted</button>}
        {(status === "draft" || status === "sent" || status === "accepted") && <button type="button" className="btn btn-light" onClick={() => setConfirm("convert")}>Convert to order</button>}
        {(status === "draft" || status === "sent") && <button type="button" className="btn btn-danger" onClick={() => setConfirm("decline")}>Declined</button>}
        {(status === "declined" || status === "expired") && <button type="button" className="btn btn-ghost" onClick={() => act("reopen", "Back to draft.")}>Reopen</button>}
        {status === "converted" && q.convertedOrderId && <Link href={`/orders/view?id=${q.convertedOrderId}`} className="btn">Open order</Link>}
        {status === "draft" && <button type="button" className="btn btn-ghost" onClick={() => setConfirm("delete")}>Delete</button>}
      </PageHead>
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 grid gap-4">
          <section className="card p-4 text-sm grid sm:grid-cols-2 gap-3">
            <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Client</div><Link href={`/clients/view?id=${q.clientId}`} className="font-bold hover:text-indigo-light">{q.client.billingProfile?.legalName ?? q.client.companyName}</Link><div className="text-ink-3 text-xs">{q.client.contactName} · {q.client.email}</div></div>
            <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Terms</div><div>{titleCase(q.campaignType)} · {q.taxMode === "intra" ? "CGST + SGST" : q.taxMode === "inter" ? "IGST" : "No GST"} {q.gstRateBp / 100}%</div><div className="text-ink-3 text-xs">Valid until {fmtDate(q.validUntil)} · created {fmtDate(q.createdAt)}</div></div>
          </section>
          <DocumentLines doc={q} />
          {q.notes && <section className="card p-4 text-sm whitespace-pre-wrap">{q.notes}</section>}
          {q.internalNotes && <section className="card-inset p-4 text-sm whitespace-pre-wrap text-ink-3"><span className="text-[11px] uppercase tracking-[0.1em] block mb-1">Internal notes</span>{q.internalNotes}</section>}
        </div>
        <EventList events={events} />
      </div>
      {confirm === "delete" && <Confirm title="Delete this draft quote?" danger confirmLabel="Delete" onConfirm={remove} onClose={() => setConfirm(null)} />}
      {confirm === "decline" && <Confirm title="Mark as declined?" body="The quote stays on file; you can reopen it later." confirmLabel="Mark declined" onConfirm={async () => { await act("decline", "Marked as declined."); setConfirm(null); }} onClose={() => setConfirm(null)} />}
      {confirm === "convert" && <Confirm title="Convert to a confirmed order?" body={<>Creates an order with the same {q.items.length} line{q.items.length === 1 ? "" : "s"} and total <Money paise={q.totalPaise} />. The quote is marked converted.</>} confirmLabel="Create order" onConfirm={convert} onClose={() => setConfirm(null)} />}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function QuoteViewPage() {
  return <Suspense fallback={<Loading />}><QuoteView /></Suspense>;
}
// platformLabel is used by DocumentLines; keep the import list honest for the linter.
void platformLabel;
