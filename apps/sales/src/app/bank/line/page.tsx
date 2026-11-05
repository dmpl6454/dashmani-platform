"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BANK_IGNORE_LABELS, bankPct } from "@dashmani/shared/src/sales/bank";
import { useBankLine, useEvents } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, fmtInr } from "@/lib/format";
import { Confirm, Empty, LoadError, Loading, Money, PageHead, StatusPill, Toast } from "@/components/sales-ui";
import { EventList } from "@/components/document-view";
import { ConfidencePill, refreshAfterBankAction } from "@/components/bank/line-card";
import { RecordForm, type Ack, type RecordOutcome } from "@/components/bank/record-form";
import { IgnoreDialog, LinkDialog, UnlinkDialog } from "@/components/bank/dialogs";
import type { BankCandidate } from "@/lib/sales-types";

// /bank/line?id= — review one credit: its facts, the suggestions (Use this fills the form), the
// record form with the TDS cut, the receipts on it (Unlink…) and its history.

function LineView() {
  const id = useSearchParams().get("id");
  const { data: line, error, isLoading, mutate } = useBankLine(id);
  const { data: events, mutate: mutateEvents } = useEvents("bank_line", id);
  const [fill, setFill] = useState<BankCandidate | null>(null);
  const [ack, setAck] = useState<Ack>({});
  const [dialog, setDialog] = useState<null | "link" | "ignore" | "reopen" | { unlink: { id: string; number: string } }>(null);
  const [ask, setAsk] = useState<null | { code: string; message: string; resend: (a: Ack) => void }>(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  if (!id) return <Empty title="No bank line selected." action={<Link href="/bank" className="btn">Back to the bank</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !line) return <Loading />;
  const refresh = () => Promise.all([mutate(), mutateEvents(), refreshAfterBankAction()]);
  const done = async (message: string, tone: "ok" | "err" = "ok") => { setDialog(null); if (tone === "ok") await refresh(); setToast({ message, tone }); };
  const isDebit = line.debitPaise > 0;
  const open = ["unmatched", "suggested", "partly_matched"].includes(line.status);
  const s = line.suggestion;

  function onRecorded(o: RecordOutcome, resend: (a: Ack) => void) {
    if (o.ok) { void done(`${o.number} recorded${o.invoices.length ? ` — ${o.invoices.join(", ")} is now paid.` : " as an advance."}`); return; }
    if (o.code === "POSSIBLE_DOUBLE_RECEIPT" || o.code === "TDS_TOO_HIGH" || o.code === "POSSIBLE_DUPLICATE") setAsk({ code: o.code, message: o.message, resend });
    else setToast({ message: o.message, tone: "err" });
  }
  async function reopen() {
    try { await apiFetch(`/sales/bank/lines/${line!.id}/reopen`, { method: "POST" }); await done("The credit is back in the review queue."); } catch (err) { await done(errorSentence(err), "err"); }
  }

  return (
    <>
      <PageHead kicker={<Link href="/bank" className="hover:text-white">Bank</Link> as unknown as string} title={<>{isDebit ? "Withdrawal" : "Credit"} {fmtInr(isDebit ? line.debitPaise : line.creditPaise)} · {fmtDate(line.txnDate)} <StatusPill status={line.status} /> <ConfidencePill confidence={open ? line.confidence : null} /></>}>
        {!isDebit && open && <button type="button" className="btn btn-ghost" onClick={() => setDialog("link")}>Link existing receipt</button>}
        {!isDebit && open && line.matchedPaise === 0 && <button type="button" className="btn btn-ghost" onClick={() => setDialog("ignore")}>Ignore…</button>}
        {!isDebit && line.status === "ignored" && <button type="button" className="btn btn-ghost" onClick={() => setDialog("reopen")}>Reopen</button>}
      </PageHead>

      <section className="card p-4 mb-4">
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Date</dt><dd>{fmtDate(line.txnDate)}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Value date</dt><dd>{fmtDate(line.valueDate)}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Account</dt><dd>{line.account.label} ••{line.account.last4}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Statement</dt><dd className="min-w-0 truncate"><Link href={`/bank/statement?id=${line.statementId}`} className="hover:text-indigo-light">{line.statement.fileName}</Link> · row {line.rowNo}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Reference</dt><dd className="font-mono text-xs break-all">{line.reference ?? "—"}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">UTR</dt><dd className="font-mono text-xs break-all">{line.utr ?? "—"}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Balance after</dt><dd>{line.balancePaise != null ? fmtInr(line.balancePaise) : "—"}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Left to record</dt><dd><Money paise={line.remainingPaise} /></dd></div>
          <div className="col-span-2 sm:col-span-4"><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Narration</dt><dd className="font-mono text-xs break-words">{line.redacted ? "Withdrawal details are visible to admins." : line.narration}</dd></div>
        </dl>
      </section>

      {line.possibleDuplicate && open && (
        <div className="card border-attention p-3 text-sm mb-4 flex flex-wrap items-center gap-2">
          <span>This looks like the same transaction as a line imported earlier.</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDialog("ignore")}>Ignore as duplicate</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setAck({ ...ack, ackDuplicateLine: true }); setToast({ message: "Marked as a separate payment — record it below.", tone: "ok" }); }}>It is a separate payment</button>
        </div>
      )}
      {line.status === "partly_matched" && <div className="card p-3 text-sm mb-4">{line.receipts.filter((r) => r.status === "recorded").map((r) => `${fmtInr(r.amountPaise)} is on ${r.number} (${r.clientName})`).join("; ")}; {fmtInr(line.remainingPaise)} is left to record.</div>}
      {line.ignoreReason === "before_cutover" && <div className="card p-3 text-sm mb-4">Dated before bank matching started — not matched. Its invoice may still be in Swipe.</div>}
      {line.status === "ignored" && line.ignoreReason !== "before_cutover" && <div className="card p-3 text-sm mb-4">Ignored — {BANK_IGNORE_LABELS[line.ignoreReason ?? "other"]}{line.ignoreNote ? ` · ${line.ignoreNote}` : ""}</div>}
      {s?.note === "too_large" && open && <div className="card border-attention p-3 text-sm mb-4">Larger than one receipt can hold (₹2,14,74,836.47) — record it as two receipts: lower the cash below.</div>}

      {!isDebit && open && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          <section className="lg:col-span-1 lg:order-2 grid grid-cols-1 gap-2 content-start">
            <h2 className="font-bold">Suggestions</h2>
            {s?.ignoreHint && <p className="text-xs text-ink-3">Looks like: {BANK_IGNORE_LABELS[s.ignoreHint.reason]} — <button type="button" className="underline" onClick={() => setDialog("ignore")}>ignore it</button></p>}
            {s?.receiptCandidates.map((r) => (
              <div key={r.paymentId} className="card-inset p-3 text-sm">Already recorded? <span className="font-mono">{r.number}</span> · {r.clientName} · <Money paise={r.amountPaise} /> · {fmtDate(r.paidOn)} <span className="text-xs text-ink-3">({r.why})</span>
                <div className="mt-2"><button type="button" className="btn btn-sm" onClick={() => setDialog("link")}>Link {r.number}</button></div></div>
            ))}
            {s?.conflict && <p className="text-xs text-ink-3">{s.conflict.invoiceNumber} is suggested for the credit of {fmtDate(s.conflict.txnDate)}.</p>}
            {!s?.candidates.length && !s?.receiptCandidates.length && <p className="text-sm text-ink-3">No invoice matches this amount. Pick the client below, or record it as an advance.</p>}
            {s?.candidates.map((c, i) => (
              <div key={i} className="card-inset p-3 text-sm grid gap-2 min-w-0">
                <div className="flex items-center gap-2"><ConfidencePill confidence={c.confidence} /><span className="text-xs text-ink-3">score {c.score}</span>{c.stale && <span className="text-xs text-attention">balances changed</span>}</div>
                <p>{c.client.companyName}{c.kind === "advance" ? " — as an advance" : ` — ${c.allocations.map((a) => `${a.number} (balance ${fmtInr(a.liveBalancePaise)})`).join(" + ")}`}: {fmtInr(c.amountPaise)} received{c.tdsPaise ? ` + TDS ${fmtInr(c.tdsPaise)}${c.tdsRateBp ? ` (${bankPct(c.tdsRateBp)}${c.tdsSection ? ` · ${c.tdsSection}` : ""})` : ""}` : ""}</p>
                <ul className="text-xs text-ink-3 list-disc pl-4">{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                <div><button type="button" className="btn btn-sm" onClick={() => setFill({ ...c })}>Use this</button></div>
              </div>
            ))}
          </section>
          <div className="lg:col-span-2 lg:order-1 min-w-0"><RecordForm line={line} fill={fill} ack={ack} onDone={onRecorded} /></div>
        </div>
      )}

      {line.receipts.length > 0 && (
        <section className="card p-4 mb-4">
          <h2 className="font-bold mb-2">Receipts on this line</h2>
          <ul className="divide-y divide-rule text-sm">
            {line.receipts.map((r) => (
              <li key={r.id} className="py-2 flex flex-wrap justify-between gap-2">
                <span><Link href={`/payments/view?id=${r.id}`} className="font-mono hover:text-indigo-light">{r.number}</Link> · {r.clientName} · <Money paise={r.amountPaise} />{r.tdsPaise ? <> + TDS <Money paise={r.tdsPaise} /></> : null} <StatusPill status={r.status} /></span>
                {r.status === "recorded" && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDialog({ unlink: { id: r.id, number: r.number } })}>Unlink…</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card p-4"><h2 className="font-bold mb-3">History</h2><EventList events={events} /></section>

      {dialog === "link" && <LinkDialog line={line} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "ignore" && <IgnoreDialog line={line} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "reopen" && <Confirm title="Put this credit back in the review queue?" confirmLabel="Reopen" onConfirm={reopen} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === "object" && <UnlinkDialog line={line} receipt={dialog.unlink} onClose={() => setDialog(null)} onDone={done} />}
      {ask && (
        <Confirm title={ask.code === "TDS_TOO_HIGH" ? "TDS looks too high" : ask.code === "POSSIBLE_DUPLICATE" ? "Possible duplicate line" : "Already recorded?"} onClose={() => setAsk(null)}
          confirmLabel={ask.code === "TDS_TOO_HIGH" ? "Record anyway" : "It is a separate payment"}
          onConfirm={() => { const r = ask.resend; const a: Ack = ask.code === "TDS_TOO_HIGH" ? { ackHighTds: true } : ask.code === "POSSIBLE_DUPLICATE" ? { ackDuplicateLine: true } : { ackExistingReceipt: true }; setAck({ ...ack, ...a }); setAsk(null); r(a); }}
          body={<div className="grid gap-2"><p>{ask.message}</p>{ask.code === "POSSIBLE_DOUBLE_RECEIPT" && <button type="button" className="btn btn-ghost btn-sm justify-self-start" onClick={() => { setAsk(null); setDialog("link"); }}>Link that receipt instead</button>}</div>} />
      )}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function Page() {
  return <Suspense fallback={<Loading />}><LineView /></Suspense>;
}
