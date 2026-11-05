"use client";
import { useState } from "react";
import Link from "next/link";
import { BANK_IGNORE_LABELS } from "@dashmani/shared/src/sales/bank";
import { useBankAccounts, useBankLines, useBankStatements } from "@/lib/hooks";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { daysBetween, fmtDate, fmtInr, todayIST } from "@/lib/format";
import { Confirm, Empty, Field, LoadError, Loading, PageHead, Stat, Toast } from "@/components/sales-ui";
import { LineCard, candidateShort, refreshAfterBankAction } from "@/components/bank/line-card";

// /bank — the review queue (phone first). Credits from uploaded statements, each with a stored
// suggestion; nothing is recorded until someone confirms (one card, or "Confirm all sure").

const TABS = [["review", "To review"], ["sure", "Sure"], ["matched", "Matched"], ["ignored", "Ignored"], ["debits", "Withdrawals"]] as const;
const STAFF_REASONS = ["own_transfer", "gst_refund", "tax_refund", "interest", "loan_capital", "gateway", "salary", "vendor_refund", "reversal", "duplicate", "other"];

export default function BankPage() {
  const { company, info } = useCompany();
  const { user } = useAuth();
  const admin = isAdminUser(user);
  const [tab, setTab] = useState<string>("review");
  const [q, setQ] = useState("");
  const [accountId, setAccountId] = useState("");
  const { data: accounts, isLoading: accLoading } = useBankAccounts();
  const { data, error, isLoading, mutate } = useBankLines({ tab, q: q.trim() || undefined, accountId: accountId || undefined });
  const { data: statements } = useBankStatements({ accountId: accountId || undefined });
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  const [sureOpen, setSureOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const say = (message: string, tone: "ok" | "err" = "ok") => setToast({ message, tone });

  if (accLoading) return <Loading label="Reading the statements…" />;
  const active = (accounts ?? []).filter((a) => a.status === "active");
  if (!active.length) {
    return (
      <>
        <PageHead kicker={`Bank · ${info.short}`} title="Bank" />
        <Empty title={`No bank account set up for ${info.short}.`} body="An admin adds the company's bank account in Settings → Bank accounts; statements can then be uploaded here."
          action={admin ? <Link href="/settings#bank" className="btn">Add a bank account</Link> : undefined} />
      </>
    );
  }
  const s = data?.summary;
  const newest = s?.accounts.map((a) => a.lastStatementTo).filter((x): x is string => !!x).sort().pop() ?? null;
  const sureLines = (data?.lines ?? []).filter((l) => l.status === "suggested" && l.confidence === "high" && l.suggestion?.candidates[0] && !l.suggestion.candidates[0].stale).slice(0, 25);

  async function rematch() {
    setBusy(true);
    try {
      const r = await apiFetch<{ autoLinked: number; suggested: number }>(`/sales/bank/rematch?company=${company}`, { method: "POST" });
      await refreshAfterBankAction();
      say(`Matching re-run — ${r.data.suggested} suggestion${r.data.suggested === 1 ? "" : "s"}, ${r.data.autoLinked} linked to a receipt.`);
    } catch (err) { say(errorSentence(err), "err"); } finally { setBusy(false); }
  }
  async function confirmSure() {
    try {
      const r = await apiFetch<{ confirmed: unknown[]; skipped: Array<{ message: string }> }>("/sales/bank/lines/confirm-sure", { method: "POST", body: JSON.stringify({ lineIds: sureLines.map((l) => l.id) }) });
      await refreshAfterBankAction();
      setSureOpen(false);
      const n = r.data.confirmed.length;
      say(r.data.skipped.length ? `Recorded ${n} receipt${n === 1 ? "" : "s"}. ${r.data.skipped.length} need${r.data.skipped.length === 1 ? "s" : ""} a look: ${r.data.skipped[0].message}` : `Recorded ${n} receipt${n === 1 ? "" : "s"}.`);
    } catch (err) { setSureOpen(false); say(errorSentence(err), "err"); }
  }

  return (
    <>
      <PageHead kicker={`Bank · ${info.short}`} title="Bank">
        <Link href="/bank/upload" className="btn">Upload statement</Link>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={rematch}>{busy ? "Re-checking…" : "Re-check matches"}</button>
      </PageHead>

      {s && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <Stat label="To review" value={s.reviewCount} sub={`${s.sureCount} sure`} tone={s.sureCount ? "attention" : undefined} />
          <Stat label="Unmatched this month" value={fmtInr(s.unmatchedMonthPaise, { whole: true })} sub={`${s.unmatchedMonthCount} credit${s.unmatchedMonthCount === 1 ? "" : "s"}`} tone={s.unmatchedMonthCount ? "attention" : "success"} />
          <Stat label="Waiting overall" value={fmtInr(s.openPaise, { whole: true })} sub={`${s.openCount} credit${s.openCount === 1 ? "" : "s"}`} />
          <Stat label="Last statement" value={newest ? fmtDate(newest) : "—"} sub={newest && daysBetween(newest, todayIST()) > 10 ? `No statement for ${daysBetween(newest, todayIST())} days` : s.accounts.map((a) => `${a.label} ••${a.last4}`).join(", ")} tone={newest && daysBetween(newest, todayIST()) > 10 ? "attention" : undefined} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {TABS.map(([k, label]) => {
          const count = data?.counts[k as keyof typeof data.counts];
          return (
            <button key={k} type="button" onClick={() => setTab(k)} className={`px-3 py-1.5 text-sm border ${tab === k ? "bg-indigo text-white border-indigo" : "border-border text-ink-3 hover:text-white"}`}>
              {label}{count != null ? ` · ${count}` : ""}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_auto] gap-2 mb-4">
        <input className="input" placeholder="Search narration, UTR or amount" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search narration, UTR or amount" />
        {active.length > 1 && (
          <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Bank account">
            <option value="">All accounts</option>
            {active.map((a) => <option key={a.id} value={a.id}>{a.label} ••{a.last4}</option>)}
          </select>
        )}
        <div className="flex flex-wrap gap-2">
          {(tab === "review" || tab === "sure") && sureLines.length > 0 && <button type="button" className="btn" onClick={() => setSureOpen(true)}>Confirm all sure ({sureLines.length})</button>}
          {tab === "review" && <button type="button" className="btn btn-ghost" onClick={() => setBulkOpen(true)}>Ignore old credits…</button>}
        </div>
      </div>

      {error ? <LoadError error={error} retry={() => mutate()} />
        : isLoading || !data ? <Loading label="Reading the statements…" />
        : !statements?.length && tab === "review" ? (
          <Empty title="No bank statements yet." body="Download the statement from net banking as Excel or CSV and upload it — credits are matched to invoices for you, TDS included. Nothing is recorded until you confirm." action={<Link href="/bank/upload" className="btn">Upload statement</Link>} />
        ) : data.lines.length === 0 ? (
          <Empty title={tab === "review" ? "Nothing to review — every credit is matched or explained." : "Nothing here."} />
        ) : (
          <ul className="grid grid-cols-1 gap-2 mb-8">{data.lines.map((l) => <LineCard key={l.id} line={l} onToast={say} />)}</ul>
        )}

      {!!statements?.length && (
        <section className="card overflow-x-auto mb-6">
          <h2 className="font-bold p-4 pb-2">Statements</h2>
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-[0.1em] text-ink-3"><th className="p-3">Account</th><th className="p-3">Period</th><th className="p-3">File</th><th className="p-3 text-right">New</th><th className="p-3 text-right">Already in</th><th className="p-3">Uploaded</th></tr></thead>
            <tbody className="divide-y divide-rule">
              {statements.map((st) => (
                <tr key={st.id}>
                  <td className="p-3">{st.account.label} ••{st.account.last4}</td>
                  <td className="p-3 whitespace-nowrap">{fmtDate(st.periodFrom)} – {fmtDate(st.periodTo)}</td>
                  <td className="p-3"><Link href={`/bank/statement?id=${st.id}`} className="hover:text-indigo-light break-all">{st.fileName}</Link></td>
                  <td className="p-3 text-right">{st.newLineCount}</td>
                  <td className="p-3 text-right">{st.duplicateCount}</td>
                  <td className="p-3 whitespace-nowrap">{fmtDate(st.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {sureOpen && (
        <Confirm title={`Record ${sureLines.length} receipt${sureLines.length === 1 ? "" : "s"}?`} confirmLabel="Record receipts" onConfirm={confirmSure} onClose={() => setSureOpen(false)}
          body={<div className="grid gap-2"><ul className="text-xs max-h-60 overflow-y-auto grid gap-1">{sureLines.map((l) => <li key={l.id}>{fmtInr(l.creditPaise)} · {candidateShort(l.suggestion!.candidates[0])}</li>)}</ul><p>Each receipt settles the invoice shown and emails the client the paid invoice, as when you record a payment by hand.</p></div>} />
      )}
      {bulkOpen && <IgnoreBefore company={company} accounts={active} onClose={() => setBulkOpen(false)} onDone={(n) => { setBulkOpen(false); say(`Ignored ${n} old credit${n === 1 ? "" : "s"}.`); }} onError={(e) => say(errorSentence(e), "err")} />}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

/** Owner (2026-11-05): ignore every still-unmatched credit before a day, with one reason. */
function IgnoreBefore({ company, accounts, onClose, onDone, onError }: { company: string; accounts: Array<{ id: string; label: string; last4: string }>; onClose: () => void; onDone: (n: number) => void; onError: (e: unknown) => void }) {
  const [before, setBefore] = useState("");
  const [reason, setReason] = useState("other");
  const [note, setNote] = useState("Before the invoices were in the portal");
  const [accountId, setAccountId] = useState("");
  const [includeSuggested, setIncludeSuggested] = useState(false);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const r = await apiFetch<{ ignored: number }>(`/sales/bank/lines/ignore-before?company=${company}`, { method: "POST", body: JSON.stringify({ before, reason, note: note || null, accountId: accountId || null, includeSuggested }) });
      await refreshAfterBankAction();
      onDone(r.data.ignored);
    } catch (err) { onError(err); } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" onClick={busy ? undefined : onClose}>
      <div className="card p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ib-title">
        <h3 id="ib-title" className="font-extrabold text-lg mb-2">Ignore old unmatched credits</h3>
        <p className="text-sm text-ink-3 mb-4">Every credit dated before the day below that has no receipt on it is marked ignored with this reason. Credits with a receipt are never touched; each one can be reopened later.</p>
        <div className="grid grid-cols-1 gap-3 mb-5">
          <Field label="Credits dated before"><input type="date" className="input" value={before} onChange={(e) => setBefore(e.target.value)} /></Field>
          {accounts.length > 1 && <Field label="Account"><select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">All accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label} ••{a.last4}</option>)}</select></Field>}
          <Field label="What are they?"><select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>{STAFF_REASONS.map((r) => <option key={r} value={r}>{BANK_IGNORE_LABELS[r]}</option>)}</select></Field>
          <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeSuggested} onChange={(e) => setIncludeSuggested(e.target.checked)} /> Also ignore credits that have a suggestion</label>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={busy || !before || (reason === "other" && note.trim().length < 3)} onClick={go}>{busy ? "Working…" : "Ignore credits"}</button>
        </div>
      </div>
    </div>
  );
}
