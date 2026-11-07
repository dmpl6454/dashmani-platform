"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useBankStatement, useEvents } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, fmtInr } from "@/lib/format";
import { Confirm, Empty, Field, LoadError, Loading, PageHead, StatusPill, Toast } from "@/components/sales-ui";
import { EventList } from "@/components/document-view";
import { refreshAfterBankAction } from "@/components/bank/line-card";

// /bank/statement?id= — one uploaded statement: its facts, every line, and (admins) Delete.

function StatementView() {
  const id = useSearchParams().get("id");
  const router = useRouter();
  const { user } = useAuth();
  const { data: s, error, isLoading, mutate } = useBankStatement(id);
  const { data: events } = useEvents("bank_statement", id);
  const [del, setDel] = useState(false);
  const [reason, setReason] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  if (!id) return <Empty title="No statement selected." action={<Link href="/bank" className="btn">Back to the bank</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !s) return <Loading />;
  async function remove() {
    try { await apiFetch(`/sales/bank/statements/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }); await refreshAfterBankAction(); router.replace("/bank"); }
    catch (err) { setDel(false); setToast(errorSentence(err)); }
  }
  return (
    <>
      <PageHead kicker={<Link href="/bank" className="hover:text-white">Bank</Link> as unknown as string} title={<span className="break-all">{s.fileName}</span>}>
        {isAdminUser(user) && <button type="button" className="btn btn-danger" onClick={() => setDel(true)}>Delete statement</button>}
      </PageHead>
      <section className="card p-4 mb-4">
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Account</dt><dd>{s.account.label} ••{s.account.last4}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Period</dt><dd>{fmtDate(s.periodFrom)} – {fmtDate(s.periodTo)}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Format</dt><dd className="uppercase">{s.format}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Uploaded</dt><dd>{fmtDate(s.createdAt)}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Opening / closing</dt><dd>{s.openingBalancePaise != null ? fmtInr(s.openingBalancePaise) : "—"} / {s.closingBalancePaise != null ? fmtInr(s.closingBalancePaise) : "—"}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Lines</dt><dd>{s.rowCount} read · {s.newLineCount} new · {s.duplicateCount} already in · {s.skippedCount} skipped</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Credits</dt><dd>{fmtInr(s.creditTotalPaise)}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Withdrawals</dt><dd>{fmtInr(s.debitTotalPaise)}</dd></div>
        </dl>
        {!!s.warnings?.length && <ul className="text-xs text-attention mt-3 grid gap-1">{s.warnings.map((w) => <li key={w}>Accepted at import: {w}</li>)}</ul>}
      </section>
      <section className="card overflow-x-auto mb-4">
        <table className="w-full min-w-[720px] text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-[0.1em] text-ink-3"><th className="p-2">Row</th><th className="p-2">Date</th><th className="p-2">Narration</th><th className="p-2 text-right">Withdrawal</th><th className="p-2 text-right">Deposit</th><th className="p-2 text-right">Balance</th><th className="p-2">Status</th></tr></thead>
          <tbody className="divide-y divide-rule">
            {s.lines.map((l) => (
              <tr key={l.id}>
                <td className="p-2">{l.rowNo}</td>
                <td className="p-2 whitespace-nowrap">{fmtDate(l.txnDate)}</td>
                <td className="p-2 font-mono text-xs break-all">{l.creditPaise > 0 ? <Link href={`/bank/line?id=${l.id}`} className="hover:text-indigo-light">{l.narration}</Link> : l.redacted ? <span className="text-ink-4">Visible to admins</span> : l.narration}</td>
                <td className="p-2 text-right">{l.debitPaise ? fmtInr(l.debitPaise) : ""}</td>
                <td className="p-2 text-right">{l.creditPaise ? fmtInr(l.creditPaise) : ""}</td>
                <td className="p-2 text-right">{l.balancePaise != null ? fmtInr(l.balancePaise) : ""}</td>
                <td className="p-2"><StatusPill status={l.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card p-4"><h2 className="font-bold mb-3">History</h2><EventList events={events} /></section>
      {del && (
        <Confirm title="Delete this statement?" danger confirmLabel="Delete statement" onConfirm={() => (reason.trim().length >= 3 ? remove() : setToast("Say why it is being deleted."))} onClose={() => setDel(false)}
          body={<div className="grid gap-3"><p>Its lines are removed; the history stays. A statement that receipts were recorded from cannot be deleted.</p><Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>} />
      )}
      {toast && <Toast message={toast} tone="err" onDone={() => setToast(null)} />}
    </>
  );
}

export default function Page() {
  return <Suspense fallback={<Loading />}><StatementView /></Suspense>;
}
