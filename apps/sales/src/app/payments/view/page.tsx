"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { mutate as mutateGlobal } from "swr";
import { usePayment, useEvents } from "@/lib/hooks";
import { companyName } from "@/lib/company";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, todayIST } from "@/lib/format";
import { Confirm, Empty, Field, LoadError, Loading, Money, MoneyInput, PageHead, StatusPill, Toast, titleCase } from "@/components/sales-ui";
import { EventList } from "@/components/document-view";
import type { Payment } from "@/lib/sales-types";

// One receipt: what it paid, what is left on it, and the two ways money leaves it — a refund
// (out of the unallocated cash) or voiding the whole receipt when it was recorded by mistake
// (a bounced cheque, a wrong amount). A voided receipt keeps its number; its allocations stop
// counting and the invoices it paid reopen.

const MODES = [["bank_transfer", "Bank transfer / NEFT / RTGS"], ["upi", "UPI"], ["cheque", "Cheque"], ["cash", "Cash"], ["razorpay", "Razorpay"], ["other", "Other"]] as const;

function PaymentView() {
  const id = useSearchParams().get("id");
  const { data: p, error, isLoading, mutate } = usePayment(id);
  const { data: events, mutate: mutateEvents } = useEvents("payment", id);
  const [modal, setModal] = useState<null | "void" | "refund">(null);
  const [reason, setReason] = useState("");
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  if (!id) return <Empty title="No receipt selected." action={<Link href="/payments" className="btn">Back to payments</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !p) return <Loading />;
  const refresh = () => Promise.all([
    mutate(), mutateEvents(),
    mutateGlobal((key) => typeof key === "string" && (key.startsWith("/sales/invoices") || key.startsWith("/sales/payments") || key.startsWith("/sales/dashboard") || key.startsWith("/sales/clients")), undefined, { revalidate: true }),
  ]);
  const fail = (err: unknown) => setToast({ message: errorSentence(err), tone: "err" });
  const live = p.status === "recorded";
  const liveRefunds = p.refunds.filter((r) => r.status === "issued");

  async function voidIt() {
    try { await apiFetch(`/sales/payments/${id}/void`, { method: "POST", body: JSON.stringify({ reason }) }); await refresh(); setModal(null); setReason(""); setToast({ message: "Receipt voided. The invoices it paid are open again.", tone: "ok" }); } catch (err) { fail(err); }
  }
  async function cancelRefund(refundId: string) {
    try { await apiFetch(`/sales/refunds/${refundId}/cancel`, { method: "POST" }); await refresh(); setToast({ message: "Refund cancelled.", tone: "ok" }); } catch (err) { fail(err); }
  }

  return (
    <>
      <PageHead kicker={<><Link href="/payments" className="hover:text-white">Payments</Link> · {companyName(p.companyKey)} · <Link href={`/clients/view?id=${p.client.id}`} className="hover:text-white">{p.client.companyName}</Link></> as unknown as string} title={<><span className="font-mono">{p.number}</span> <StatusPill status={p.status} /></>}>
        {live && p.unallocatedPaise > 0 && <button type="button" className="btn btn-light" onClick={() => setModal("refund")}>Refund</button>}
        {live && liveRefunds.length === 0 && <button type="button" className="btn btn-danger" onClick={() => setModal("void")}>Void receipt</button>}
      </PageHead>
      {!live && <div className="card border-danger p-3 text-sm mb-4">Voided{p.voidedAt ? ` on ${fmtDate(p.voidedAt)}` : ""}{p.voidReason ? ` — ${p.voidReason}` : ""}. The number stays on record; this receipt no longer pays anything.</div>}
      {live && liveRefunds.length > 0 && <p className="text-xs text-ink-3 mb-4">To void this receipt, cancel its refunds first.</p>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <section className="card p-4">
          <h2 className="font-bold mb-3">Receipt</h2>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-ink-3">Received</dt><dd className="text-right"><Money paise={p.amountPaise} /></dd>
            {p.tdsPaise > 0 && <><dt className="text-ink-3">TDS withheld</dt><dd className="text-right"><Money paise={p.tdsPaise} /></dd></>}
            <dt className="text-ink-3">Date</dt><dd className="text-right">{fmtDate(p.paidOn)}</dd>
            <dt className="text-ink-3">Mode</dt><dd className="text-right">{titleCase(p.mode)}</dd>
            {p.reference && <><dt className="text-ink-3">Reference</dt><dd className="text-right font-mono text-xs">{p.reference}</dd></>}
            {p.bankName && <><dt className="text-ink-3">Bank</dt><dd className="text-right">{p.bankName}</dd></>}
          </dl>
          {p.notes && <p className="text-sm text-ink-3 mt-3">{p.notes}</p>}
        </section>
        <section className="card p-4 lg:col-span-2">
          <h2 className="font-bold mb-3">Where the money went</h2>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-4">
            <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">On invoices</dt><dd><Money paise={p.allocatedPaise + p.allocatedTdsPaise} /></dd></div>
            <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Refunded</dt><dd><Money paise={p.refundedPaise} /></dd></div>
            <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Unallocated</dt><dd><Money paise={p.unallocatedPaise} className={p.unallocatedPaise ? "text-attention" : ""} /></dd></div>
            {p.unallocatedTdsPaise > 0 && <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">TDS unallocated</dt><dd><Money paise={p.unallocatedTdsPaise} /></dd></div>}
          </dl>
          {live && p.unallocatedPaise + p.unallocatedTdsPaise > 0 && <p className="text-xs text-ink-3 mb-3">Apply what is unallocated from the invoice it should pay (Apply a receipt), or refund it to the client.</p>}
          {p.allocations.length === 0 ? <p className="text-sm text-ink-3">Not on any invoice.</p> : (
            <ul className="divide-y divide-rule text-sm">
              {p.allocations.map((a) => (
                <li key={a.invoiceId} className="py-2 flex justify-between gap-3">
                  <Link href={`/invoices/view?id=${a.invoiceId}`} className={`font-mono hover:text-indigo-light ${live ? "" : "line-through text-ink-3"}`}>{a.invoice.number ?? "Draft invoice"}</Link>
                  <span><Money paise={a.amountPaise} />{a.tdsPaise ? <span className="text-ink-3 text-xs"> + TDS <Money paise={a.tdsPaise} /></span> : null}</span>
                </li>
              ))}
            </ul>
          )}
          {p.refunds.length > 0 && (
            <>
              <h3 className="font-bold mt-5 mb-2 text-sm">Refunds</h3>
              <ul className="divide-y divide-rule text-sm">
                {p.refunds.map((r) => (
                  <li key={r.id} className="py-2 flex flex-wrap justify-between gap-2">
                    <span><span className="font-mono">{r.number}</span> · {fmtDate(r.refundedOn)} · {titleCase(r.mode)}{r.reference ? <span className="font-mono text-xs text-ink-3"> · {r.reference}</span> : null} <StatusPill status={r.status} /></span>
                    <span className="flex items-center gap-2"><Money paise={r.amountPaise} className={r.status === "cancelled" ? "line-through text-ink-3" : ""} />{r.status === "issued" && live && <button type="button" className="btn btn-ghost btn-sm" onClick={() => cancelRefund(r.id)}>Cancel</button>}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
      <section className="card p-4"><h2 className="font-bold mb-3">Activity</h2><EventList events={events} /></section>

      {modal === "void" && (
        <Confirm title={`Void ${p.number}?`} danger confirmLabel="Void receipt" onConfirm={voidIt} onClose={() => setModal(null)}
          body={<div className="grid gap-3"><p>Use this for a bounced cheque or a receipt recorded by mistake. The number stays on record; the invoices it paid ({p.allocations.length}) become open again.</p><Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Cheque bounced / wrong amount / …" /></Field></div>} />
      )}
      {modal === "refund" && <RefundDialog payment={p} onDone={async (msg) => { await refresh(); setModal(null); setToast({ message: msg, tone: "ok" }); }} onError={fail} onClose={() => setModal(null)} />}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

function RefundDialog({ payment, onDone, onError, onClose }: { payment: Payment; onDone: (message: string) => Promise<void>; onError: (err: unknown) => void; onClose: () => void }) {
  const [amount, setAmount] = useState(payment.unallocatedPaise);
  const [mode, setMode] = useState<string>("bank_transfer");
  const [reference, setReference] = useState("");
  const [refundedOn, setRefundedOn] = useState(todayIST());
  const [busy, setBusy] = useState(false);
  const over = amount > payment.unallocatedPaise;
  async function submit() {
    setBusy(true);
    try {
      const res = await apiFetch<Payment>(`/sales/payments/${payment.id}/refunds`, { method: "POST", body: JSON.stringify({ amountPaise: amount, mode, reference: reference || null, refundedOn }) });
      const made = res.data.refunds[res.data.refunds.length - 1];
      await onDone(`Refund ${made?.number ?? ""} recorded.`);
    } catch (err) { onError(err); } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" onClick={busy ? undefined : onClose}>
      <div className="card p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="refund-title">
        <h3 id="refund-title" className="font-extrabold text-lg mb-2">Refund to {payment.client.companyName}</h3>
        <p className="text-sm text-ink-3 mb-4">Money paid back out of {payment.number}. <Money paise={payment.unallocatedPaise} /> is free to refund; money already on an invoice comes back only through a credit note.</p>
        <div className="grid gap-3 mb-5">
          <Field label="Amount refunded"><MoneyInput paise={amount} onChange={setAmount} /></Field>
          <Field label="Paid back by"><select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Reference (UTR / cheque no.)"><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
          <Field label="Date"><input className="input" type="date" value={refundedOn} onChange={(e) => setRefundedOn(e.target.value)} /></Field>
          {over && <p className="text-sm text-danger" role="alert">More than this receipt has free to refund.</p>}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn" onClick={submit} disabled={busy || over || amount <= 0}>{busy ? "Saving…" : "Record refund"}</button>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <PaymentView />
    </Suspense>
  );
}
