"use client";
// /reconcile/ledger?clientId=&from=&to= — one client's statement of account with this company,
// documents as they stand today; PDF, "Send for confirmation" and "Record reply" (spec §7.5).
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSWRConfig } from "swr";
import { Download } from "lucide-react";
import { useEvents, useLedger } from "@/lib/hooks";
import { useCompany } from "@/lib/company";
import { apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, todayIST } from "@/lib/format";
import { drCrText, reconKey } from "@/lib/reconcile";
import { fyStartOf } from "@dashmani/shared/src/sales/recon";
import { Confirm, Empty, Field, LoadError, Loading, PageHead, Stat, Toast } from "@/components/sales-ui";
import { EventList } from "@/components/document-view";
import { LedgerRows } from "@/components/reconcile/ledger-rows";
import { ReplyDialog } from "@/components/reconcile/reply-dialog";

function Ledger() {
  const params = useSearchParams();
  const router = useRouter();
  const { company } = useCompany();
  const clientId = params.get("clientId");
  const today = todayIST();
  const to = params.get("to") ?? today;
  const from = params.get("from") ?? fyStartOf(to);
  const { data, error, isLoading, mutate } = useLedger(clientId, from, to);
  const { data: events } = useEvents("confirmation", data?.confirmation?.id ?? null);
  const { mutate: globalMutate } = useSWRConfig();
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err"; noEmail?: boolean } | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const [reply, setReply] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!clientId) return <Empty title="No client selected." action={<Link href="/reconcile?tab=balances" className="btn">Client balances</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !data) return <Loading label="Building the statement…" />;
  const l = data.ledger;
  const c = data.confirmation;
  const setDates = (f: string, t: string) => router.replace(`/reconcile/ledger?clientId=${clientId}&from=${f}&to=${t}`);
  const pdf = async (inline: boolean) => {
    const win = inline ? window.open("", "_blank") : null;
    setBusy(true);
    try {
      const { blob, filename } = await apiFetchBlob(c && inline ? `/sales/reconcile/confirmations/${c.id}/pdf?company=${company}` : `/sales/reconcile/ledger.pdf?company=${company}&clientId=${clientId}&from=${from}&to=${to}`);
      if (win) { const url = URL.createObjectURL(blob); win.location.href = url; setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      else downloadBlob(blob, filename ?? "statement.pdf");
    } catch (err) { win?.close(); setToast({ message: errorSentence(err), tone: "err" }); } finally { setBusy(false); }
  };
  const send = async () => {
    try {
      const r = c
        ? await apiFetch<{ email: { to: string[] } }>(`/sales/reconcile/confirmations/${c.id}/send?company=${company}`, { method: "POST", body: JSON.stringify({ refresh: c.stale }) })
        : await apiFetch<{ email: { to: string[] } | null }>("/sales/reconcile/confirmations", { method: "POST", body: JSON.stringify({ companyKey: company, clientId, asOf: to, from, send: true, refresh: true }) });
      setToast({ message: r.data.email ? `Statement sent to ${r.data.email.to.join(", ")} — ${drCrText(l.closingPaise, false)}.` : "Statement saved.", tone: "ok" });
      await globalMutate(reconKey, undefined, { revalidate: true });
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err", noEmail: err instanceof ApiError && err.code === "CONFIRM_NO_EMAIL" });
      // A failed email may still have saved the row — reload so the next click resends it (route 15).
      await globalMutate(reconKey, undefined, { revalidate: true });
    } finally { setConfirmSend(false); }
  };
  return (
    <>
      <PageHead kicker="Reconcile" title={`Statement · ${l.client.name}`}>
        <button type="button" className="btn btn-light inline-flex items-center gap-1" disabled={busy} onClick={() => pdf(false)}><Download size={14} aria-hidden />Download PDF</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => pdf(true)}>View PDF</button>
        <button type="button" className="btn" disabled={!!c && c.status !== "pending"} onClick={() => setConfirmSend(true)}>Send for confirmation</button>
        {c && <button type="button" className="btn btn-ghost" onClick={() => setReply(true)}>Record reply</button>}
      </PageHead>
      <div className="flex flex-wrap gap-3 items-end mb-4">
        <Field label="From"><input type="date" className="input" value={from} max={to} onChange={(e) => e.target.value && setDates(e.target.value, to)} /></Field>
        <Field label="To (balance as of)"><input type="date" className="input" value={to} max={today} onChange={(e) => e.target.value && setDates(from, e.target.value)} /></Field>
        <Link href={`/reconcile?tab=balances&asOf=${to}&from=${from}`} className="btn btn-ghost btn-sm">All client balances</Link>
      </div>
      {c && (
        <div className={`card p-3 text-sm mb-4 ${c.stale ? "border-attention" : c.status === "disputed" ? "border-danger" : ""}`}>
          {c.stale ? <>Our figures changed since it was sent ({drCrText(c.ourBalancePaise, false)} → {drCrText(l.closingPaise, false)}) — send the new statement.</>
            : c.sentCount ? <>Sent {fmtDate(c.lastSentAt)} to {c.lastSentTo} — {c.status}{c.status === "disputed" ? ` · their figure ${drCrText(c.theirBalancePaise ?? 0, false)}` : ""}.</>
              : <>Saved for {fmtDate(c.asOf)}, not sent yet.{c.lastSendError ? ` ${c.lastSendError}.` : ""}</>}
          {c.hasFile && <> · <button type="button" className="underline" onClick={async () => { try { const { blob, filename } = await apiFetchBlob(`/sales/reconcile/confirmations/${c.id}/file?company=${company}`); downloadBlob(blob, filename ?? "reply"); } catch (err) { setToast({ message: errorSentence(err), tone: "err" }); } }}>their reply</button></>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <Stat label={`Opening · ${fmtDate(l.from)}`} value={drCrText(l.openingPaise, false)} />
        <Stat label={`Closing · ${fmtDate(l.to)}`} value={drCrText(l.closingPaise, false)} sub={l.closingPaise > 0 ? "they owe us" : l.closingPaise < 0 ? "advance from them" : undefined} tone={l.closingPaise > 0 ? "attention" : undefined} />
      </div>
      <section className="card p-4 mb-4 min-w-0">
        {l.lines.length === 0 && l.openingPaise === 0 ? <p className="text-sm text-ink-3">No documents with this company in this period.</p> : <LedgerRows l={l} />}
        {l.excluded.length > 0 && (
          <div className="mt-3 text-xs text-ink-3">
            <p className="font-bold">Not included (cancelled or voided):</p>
            <ul>{l.excluded.map((x) => <li key={`${x.kind}-${x.number}`}>{x.number} of {fmtDate(x.day)}{x.changedOn ? `, cancelled ${fmtDate(x.changedOn)}` : ""}{x.reason ? ` (${x.reason})` : ""}</li>)}</ul>
          </div>
        )}
        <ul className="mt-3 text-xs text-ink-3">{l.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>
      <p className="text-xs text-ink-3 mb-4">To: <span className="font-mono break-all">{data.recipients.to.join(", ") || "no email"}</span>{data.recipients.cc.length ? <> · Cc: <span className="font-mono break-all">{data.recipients.cc.join(", ")}</span></> : null}</p>
      {c && <section className="card p-4"><h2 className="font-bold mb-3">Activity</h2><EventList events={events} /></section>}
      {confirmSend && (
        <Confirm title={`Send the statement to ${l.client.name}?`} confirmLabel="Send" onClose={() => setConfirmSend(false)} onConfirm={send}
          body={<>To: {data.recipients.to.join(", ") || "—"}<br />Cc: {data.recipients.cc.join(", ") || "—"}<br />Balance as of {fmtDate(to)}: {drCrText(l.closingPaise)}</>} />
      )}
      {reply && c && <ReplyDialog c={c} name={l.client.name} company={company} onClose={() => setReply(false)} onSaved={async (m) => { setReply(false); setToast({ message: m, tone: "ok" }); await globalMutate(reconKey, undefined, { revalidate: true }); }} />}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
      {toast?.noEmail && <p className="mt-3 text-sm"><Link href={`/clients/edit?id=${clientId}`} className="underline">Add a billing email</Link></p>}
    </>
  );
}

export default function LedgerPage() {
  return <Suspense fallback={<Loading />}><Ledger /></Suspense>;
}
