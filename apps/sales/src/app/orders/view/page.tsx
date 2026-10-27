"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEvents, useOrder } from "@/lib/hooks";
import { companyName } from "@/lib/company";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, todayIST } from "@/lib/format";
import type { Invoice, LineItem } from "@/lib/sales-types";
import { Confirm, Empty, LoadError, Loading, Money, PageHead, StatusPill, Toast, titleCase } from "@/components/sales-ui";
import { DocumentLines, EventList } from "@/components/document-view";

function LineDelivery({ orderId, item, locked, onDone }: { orderId: string; item: LineItem; locked: boolean; onDone: () => Promise<unknown> }) {
  const [status, setStatus] = useState(item.status ?? "pending");
  const [permalink, setPermalink] = useState(item.permalink ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function save() {
    setBusy(true); setErr("");
    try {
      await apiFetch(`/sales/orders/${orderId}/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ status, permalink: permalink.trim() || null, deliveredOn: status === "delivered" ? (item.deliveredOn ?? todayIST()) : null }) });
      await onDone();
    } catch (e) {
      setErr(errorSentence(e));
    } finally {
      setBusy(false);
    }
  }
  if (locked) return <div className="text-xs"><StatusPill status={item.status ?? "pending"} />{item.permalink && <a href={item.permalink} target="_blank" rel="noreferrer" className="block mt-1 text-ink-3 hover:text-white truncate max-w-[220px]">{item.permalink}</a>}</div>;
  return (
    <div className="grid gap-1 min-w-[220px]">
      <select className="input text-xs" value={status} onChange={(e) => setStatus(e.target.value)}><option value="pending">Pending</option><option value="scheduled">Scheduled</option><option value="delivered">Delivered</option><option value="cancelled">Cancelled</option></select>
      <input className="input text-xs" placeholder="Post link" value={permalink} onChange={(e) => setPermalink(e.target.value)} />
      <div className="flex items-center gap-2"><button type="button" className="btn btn-ghost btn-sm" disabled={busy || (status === (item.status ?? "pending") && permalink === (item.permalink ?? ""))} onClick={save}>{busy ? "…" : "Save"}</button>{item.deliveredOn && <span className="text-xs text-ink-3">{fmtDate(item.deliveredOn)}</span>}</div>
      {err && <span className="text-xs text-danger">{err}</span>}
    </div>
  );
}

function OrderView() {
  const id = useSearchParams().get("id");
  const router = useRouter();
  const { data: o, error, isLoading, mutate } = useOrder(id);
  const { data: events, mutate: mutateEvents } = useEvents("order", id);
  const [confirm, setConfirm] = useState<null | "cancel" | "invoice">(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  if (!id) return <Empty title="No order selected." action={<Link href="/orders" className="btn">Back to orders</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !o) return <Loading />;
  const refresh = () => Promise.all([mutate(), mutateEvents()]);
  async function act(path: string, ok: string) {
    try { await apiFetch(`/sales/orders/${id}/${path}`, { method: "POST" }); await refresh(); setToast({ message: ok, tone: "ok" }); } catch (err) { setToast({ message: errorSentence(err), tone: "err" }); }
  }
  async function invoice() {
    try { const res = await apiFetch<Invoice>(`/sales/orders/${id}/invoice`, { method: "POST" }); router.push(`/invoices/view?id=${res.data.id}`); } catch (err) { setToast({ message: errorSentence(err), tone: "err" }); setConfirm(null); }
  }
  const locked = o.status === "closed" || o.status === "cancelled";
  return (
    <>
      <PageHead kicker={<><Link href="/orders" className="hover:text-white">Orders</Link> · {companyName(o.companyKey)} · <span className="font-mono">{o.number}</span></> as unknown as string} title={<>{o.title} <StatusPill status={o.status} /></>}>
        {(o.status === "draft" || o.status === "confirmed") && <Link href={`/orders/edit?id=${o.id}`} className="btn btn-light">Edit</Link>}
        {o.status === "draft" && <button type="button" className="btn" onClick={() => act("confirm", "Order confirmed.")}>Confirm</button>}
        {o.status === "confirmed" && <button type="button" className="btn btn-ghost" onClick={() => act("start", "Marked in progress.")}>Start</button>}
        {(o.status === "confirmed" || o.status === "in_progress") && <button type="button" className="btn btn-ghost" onClick={() => act("deliver", "Marked delivered.")}>Mark delivered</button>}
        {o.status === "delivered" && <button type="button" className="btn btn-ghost" onClick={() => act("close", "Order closed.")}>Close</button>}
        {!locked && o.status !== "draft" && <button type="button" className="btn" onClick={() => setConfirm("invoice")}>Create invoice</button>}
        {!locked && o.status !== "delivered" && <button type="button" className="btn btn-danger" onClick={() => setConfirm("cancel")}>Cancel order</button>}
      </PageHead>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 grid gap-4">
          <section className="card p-4 text-sm grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Client</div><Link href={`/clients/view?id=${o.clientId}`} className="font-bold hover:text-indigo-light">{o.client.billingProfile?.legalName ?? o.client.companyName}</Link><div className="text-ink-3 text-xs">{o.client.contactName} · {o.client.email}</div></div>
            <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Terms</div><div>{titleCase(o.campaignType)} · {o.taxMode === "intra" ? "CGST + SGST" : o.taxMode === "inter" ? "IGST" : "No GST"} {o.gstRateBp / 100}%{o.poNumber ? ` · PO ${o.poNumber}` : ""}</div><div className="text-ink-3 text-xs">{o.startDate || o.endDate ? `${fmtDate(o.startDate)} → ${fmtDate(o.endDate)} · ` : ""}created {fmtDate(o.createdAt)}{o.quoteId && <> · <Link href={`/quotes/view?id=${o.quoteId}`} className="hover:text-white">from quote</Link></>}</div></div>
          </section>
          <DocumentLines doc={o} lineExtra={(it) => <LineDelivery orderId={o.id} item={it} locked={locked || o.status === "draft"} onDone={refresh} />} />
          <section className="card p-4 text-sm">
            <h2 className="font-bold mb-2">Invoices</h2>
            {o.invoices.length === 0 ? <p className="text-ink-3">Not invoiced yet.</p> : (
              <ul className="divide-y divide-rule">{o.invoices.map((i) => <li key={i.id} className="py-2 flex justify-between gap-3"><span><Link href={`/invoices/view?id=${i.id}`} className="font-mono hover:text-indigo-light">{i.number ?? "Draft"}</Link> <StatusPill status={i.status} /></span><Money paise={i.totalPaise} /></li>)}</ul>
            )}
          </section>
          {o.notes && <section className="card p-4 text-sm whitespace-pre-wrap">{o.notes}</section>}
          {o.internalNotes && <section className="card-inset p-4 text-sm whitespace-pre-wrap text-ink-3"><span className="text-[11px] uppercase tracking-[0.1em] block mb-1">Internal notes</span>{o.internalNotes}</section>}
        </div>
        <EventList events={events} />
      </div>
      {confirm === "cancel" && <Confirm title="Cancel this order?" body="Lines stay on record; no invoice is created." danger confirmLabel="Cancel order" onConfirm={async () => { await act("cancel", "Order cancelled."); setConfirm(null); }} onClose={() => setConfirm(null)} />}
      {confirm === "invoice" && <Confirm title="Create a draft invoice for this order?" body={<>Every non-cancelled line is copied; the total is <Money paise={o.totalPaise} />. You review it before issuing.</>} confirmLabel="Create draft" onConfirm={invoice} onClose={() => setConfirm(null)} />}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function OrderViewPage() {
  return <Suspense fallback={<Loading />}><OrderView /></Suspense>;
}
