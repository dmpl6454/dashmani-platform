"use client";
// /reconcile/brs?accountId=&month= — one bank account × month: the balance as per bank, the
// reconciliation of receipts (every rupee of credits explained), withdrawals, Mark reconciled /
// Reopen, PDF and CSV, and the history (spec-reconcile §7.6). Nothing here changes a receipt;
// the one-tap Link goes through Bank's own route.
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSWRConfig } from "swr";
import { useBrs, useEvents } from "@/lib/hooks";
import { useCompany } from "@/lib/company";
import { apiFetch, apiFetchBlob, ApiError, downloadBlob } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, fmtInr } from "@/lib/format";
import type { BrsItem, BrsView } from "@/lib/sales-types";
import { Confirm, Empty, Field, LoadError, Loading, Money, PageHead, StatusPill, Toast } from "@/components/sales-ui";
import { EventList } from "@/components/document-view";
import { TodoCard } from "@/components/reconcile/todo-card";
import { BrsFormula } from "@/components/reconcile/brs-formula";
import { BrsItems } from "@/components/reconcile/brs-items";
import { BrsReconcileDialog, type BrsReconcileBody } from "@/components/reconcile/brs-reconcile-dialog";
import { BRS_STATE_LABEL } from "@/components/reconcile/bank-tab";

const brsKey = (key: unknown) => typeof key === "string" && (key.startsWith("/sales/reconcile/bank") || key.startsWith("/sales/bank") || key.startsWith("/sales/events"));
const mon = (v: BrsView) => v.month.label.split(" ")[0];

function StateBanner({ v, showFrozen, onToggle }: { v: BrsView; showFrozen: boolean; onToggle: () => void }) {
  if (v.state === "reconciled" && v.signoff) {
    return <div className="card p-3 text-sm border-success mb-4">Reconciled by {v.signoff.reconciledByName} on {fmtDate(v.signoff.reconciledAt)} · version {v.signoff.version}{v.signoff.note ? <> — {v.signoff.note}</> : null}</div>;
  }
  if (v.state === "changed" && v.signoff && v.changes) {
    const c = v.changes;
    const what = [
      ...c.newLines.map((n) => `${n.lines} new line${n.lines === 1 ? "" : "s"} from ${n.fileName} (uploaded ${fmtDate(n.uploadedAt)} by ${n.uploadedByName})`),
      ...c.removed.filter((i) => i.receipt).map((i) => `${i.receipt!.number} no longer counted as before`),
    ];
    return (
      <div className="card p-3 text-sm border-attention mb-4 grid grid-cols-1 gap-2">
        <p>Reopened automatically — changed since it was reconciled on {fmtDate(v.signoff.reconciledAt)}{what.length ? `: ${what.join(", ")}` : ""}.</p>
        {c.figures.length > 0 && (
          <ul className="text-xs text-ink-3 grid grid-cols-1 gap-0.5">
            {c.figures.map((f) => <li key={f.key}>{f.key.replace(/_/g, " ")}: {f.frozenPaise === null ? "—" : fmtInr(f.frozenPaise)} → {f.livePaise === null ? "—" : fmtInr(f.livePaise)}</li>)}
          </ul>
        )}
        {(c.added.length > 0 || c.removed.length > 0) && <p className="text-xs text-ink-3">{c.added.length} item{c.added.length === 1 ? "" : "s"} added · {c.removed.length} removed</p>}
        <div><button type="button" className="btn btn-ghost btn-sm" onClick={onToggle}>{showFrozen ? "Show the live figures" : "Show the figures as reconciled"}</button></div>
      </div>
    );
  }
  if (v.state === "open" && v.reopened) return <div className="card p-3 text-sm mb-4">Reopened by {v.reopened.byName} on {fmtDate(v.reopened.at)}{v.reopened.reason ? ` — ${v.reopened.reason}` : ""}.</div>;
  if (v.state === "running") return <div className="card p-3 text-sm border-indigo-light mb-4">{v.month.label} is still running — figures so far.</div>;
  return null;
}

function Brs() {
  const params = useSearchParams();
  const accountId = params.get("accountId");
  const month = params.get("month");
  const { company } = useCompany();
  const { data, error, isLoading, mutate } = useBrs(accountId, month);
  const { data: events } = useEvents("brs_month", accountId && month ? `${accountId}:${month}` : null);
  const { mutate: globalMutate } = useSWRConfig();
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  const [dialog, setDialog] = useState(false);
  const [reopen, setReopen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [showFrozen, setShowFrozen] = useState(false);
  const router = useRouter();
  // The account in the URL belongs to the other company (after a company switch) or is gone: Retry
  // would fail the same way, so go back to the months list of the switcher's company.
  const wrongAccount = error instanceof ApiError && (error.code === "COMPANY_MISMATCH" || error.code === "NO_BANK_ACCOUNT");
  useEffect(() => { if (wrongAccount) router.replace("/reconcile?tab=bank"); }, [wrongAccount, router]);
  if (!accountId || !month) return <Empty title="No month selected." action={<Link href="/reconcile?tab=bank" className="btn">Bank reconciliation</Link>} />;
  if (wrongAccount) return <Loading label="This account belongs to the other company — opening the months list…" />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !data) return <Loading label="Reconciling the month…" />;
  if (data.company !== company) return <Loading />;
  const refresh = () => globalMutate(brsKey, undefined, { revalidate: true });
  const v = data;
  const title = `${v.account.label} ••${v.account.last4} · ${v.month.label}`;
  const blocker = v.blockers[0];

  const download = async (kind: "pdf" | "csv", inline = false) => {
    const win = inline ? window.open("", "_blank") : null;
    try {
      const { blob, filename } = await apiFetchBlob(`/sales/reconcile/bank/brs.${kind}?company=${company}&accountId=${v.account.id}&month=${v.month.key}${inline ? "&inline=1" : ""}`);
      if (win) { const url = URL.createObjectURL(blob); win.location.href = url; setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      else downloadBlob(blob, filename ?? `brs.${kind}`);
    } catch (err) { win?.close(); setToast({ message: errorSentence(err), tone: "err" }); }
  };
  const link = async (i: BrsItem) => {
    if (!i.link) return;
    setBusy(true);
    try {
      await apiFetch(`/sales/bank/lines/${i.link.lineId}/link`, { method: "POST", body: JSON.stringify({ paymentId: i.link.paymentId }) });
      const number = i.receipt?.number ?? "The receipt";
      setToast({ message: `Linked — ${number} is on the statement now (${fmtInr(i.receipt?.amountPaise ?? i.amountPaise)}).`, tone: "ok" });
      await refresh();
    } catch (err) { setToast({ message: errorSentence(err), tone: "err" }); } finally { setBusy(false); }
  };
  const submit = async (b: BrsReconcileBody) => {
    try {
      const r = await apiFetch<{ unchanged: boolean; version: number }>(`/sales/reconcile/bank/reconcile?company=${company}`, {
        method: "POST", body: JSON.stringify({ accountId: v.account.id, month: v.month.key, fingerprint: v.fingerprint, ...b }),
      });
      setToast({ message: r.data.unchanged ? `${v.month.label} is already reconciled (version ${r.data.version}).` : `${v.month.label} reconciled (version ${r.data.version}) — closing ${fmtInr(b.typedClosingPaise ?? v.balances.closingPaise ?? 0)}.`, tone: "ok" });
      setDialog(false);
      await refresh();
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
      if (err instanceof ApiError && err.code === "BRS_CHANGED") { setDialog(false); await refresh(); }
    }
  };
  const doReopen = async () => {
    try {
      await apiFetch(`/sales/reconcile/bank/reopen?company=${company}`, { method: "POST", body: JSON.stringify({ accountId: v.account.id, month: v.month.key, reason }) });
      setToast({ message: `${v.month.label} reopened — ${reason}.`, tone: "ok" });
      setReopen(false); setReason("");
      await refresh();
    } catch (err) { setToast({ message: errorSentence(err), tone: "err" }); }
  };

  const b = v.balances;
  const dupes = v.items.filter((i) => i.group === "duplicate");
  const canReconcile = !blocker && v.state !== "reconciled";
  return (
    <>
      <PageHead kicker="Reconcile" title={<span className="inline-flex flex-wrap items-center gap-2">{title} <StatusPill status={v.state} label={BRS_STATE_LABEL[v.state]} /></span>}>
        <Link href="/reconcile?tab=bank" className="btn btn-ghost btn-sm">All months</Link>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => download("pdf", true)}>PDF</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => download("csv")}>CSV</button>
      </PageHead>
      <StateBanner v={v} showFrozen={showFrozen} onToggle={() => setShowFrozen((x) => !x)} />
      {!v.ties && <div className="card p-3 text-sm border-danger text-danger mb-4">The figures do not add up — this is a bug; reconciling is refused. Tell the developers.</div>}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 grid grid-cols-1 gap-4 min-w-0">
          <TodoCard todo={v.todo.filter((t) => t.code !== "RECONCILE" || canReconcile)} empty={v.state === "reconciled" ? `${v.month.label} is reconciled.` : "Nothing to do."}
            actionFor={(t, first) => t.href ? <Link href={t.href} className={first ? "btn btn-sm" : "btn btn-ghost btn-sm"}>Open</Link>
              : t.code === "RECONCILE" ? <button type="button" className="btn btn-sm" onClick={() => setDialog(true)}>Mark {mon(v)} reconciled</button> : null} />

          {showFrozen && v.state === "changed" && v.changes && (
            <section className="card p-4 grid grid-cols-1 gap-2 border-attention" aria-label="As reconciled">
              <h2 className="font-bold">As reconciled (version {v.signoff?.version})</h2>
              <p className="text-sm text-ink-3">Closing {fmtInr(v.signoff?.closingPaise ?? 0)} · books {fmtInr(v.signoff?.booksPaise ?? 0)} · open items {fmtInr(v.signoff?.openItemsPaise ?? 0)}. The PDF and CSV of version {v.signoff?.version} print these figures.</p>
              {v.changes.removed.length > 0 && <><h3 className="text-sm font-bold">No longer as reconciled</h3><BrsItems items={v.changes.removed} /></>}
              {v.changes.added.length > 0 && <><h3 className="text-sm font-bold">New since then</h3><BrsItems items={v.changes.added} onLink={link} busy={busy} /></>}
            </section>
          )}

          <section className="card p-4" aria-label="Balance as per bank">
            <h2 className="font-bold mb-2">Balance as per bank</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt>Opening <span className="text-ink-3 text-xs">{b.source === "typed" ? "(worked back from the typed closing)" : b.source === "unknown" ? "(no balances on the statement)" : ""}</span></dt>
              <dd className="text-right">{b.openingPaise === null ? "—" : <Money paise={b.openingPaise} />}</dd>
              <dt>+ Credits ({b.creditCount})</dt><dd className="text-right"><Money paise={b.creditsPaise} /></dd>
              <dt>− Withdrawals ({b.debitCount})</dt><dd className="text-right"><Money paise={b.debitsPaise} /></dd>
              <dt className="font-bold">= Closing</dt><dd className="text-right font-bold">{b.closingPaise === null ? "—" : <Money paise={b.closingPaise} />}</dd>
            </dl>
            {b.agreesWith && <p className="text-sm text-success mt-2">Agrees with {b.agreesWith}</p>}
            {b.breaks.map((x, k) => <p key={k} className="text-sm text-danger mt-1">{x.text}</p>)}
            {b.warnings.map((x, k) => <p key={k} className="text-xs text-attention mt-1">{x}</p>)}
            <p className="text-xs text-ink-3 mt-2">
              Statements: {v.coverage.statements.length ? v.coverage.statements.map((s) => `${s.fileName} (${fmtDate(s.periodFrom)} – ${fmtDate(s.periodTo)})`).join("; ") : "none"}
              {v.coverage.gaps.length > 0 && <> · <span className="text-attention">not covered: {v.coverage.gaps.map((g) => g.from === g.to ? fmtDate(g.from) : `${fmtDate(g.from)} – ${fmtDate(g.to)}`).join(", ")}</span></>}
            </p>
          </section>

          <BrsFormula v={v} onLink={link} busy={busy} />

          <details className="card p-4" aria-label="Withdrawals">
            <summary className="cursor-pointer font-bold">Withdrawals <span className="font-normal text-ink-3">· {v.debits.lines.length} · {fmtInr(v.debits.totalPaise)}</span></summary>
            <ul className="grid grid-cols-1 gap-1 mt-2 text-sm">
              {v.debits.lines.map((d) => (
                <li key={d.id} className="flex flex-wrap justify-between gap-2 border-b border-border py-1">
                  <span className="min-w-0">
                    <span className="text-ink-3">{fmtDate(d.day)}</span>
                    {d.refund && <> · refund <span className="font-mono text-xs">{d.refund.number}</span></>}
                    {d.reversalOf && <> · {d.reversalOf}</>}
                    {!d.redacted && d.narration && <span className="block font-mono text-xs break-all text-ink-3">{d.narration}</span>}
                  </span>
                  <Money paise={d.amountPaise} />
                </li>
              ))}
            </ul>
            {v.debits.lines.some((d) => d.redacted) && <p className="text-xs text-ink-3 mt-2">Withdrawal details are visible to admins.</p>}
            {dupes.length > 0 && <><h3 className="text-sm font-bold mt-3">Stored twice — not counted</h3><BrsItems items={dupes} /></>}
          </details>

          <div className="flex flex-wrap gap-2">
            {v.state !== "reconciled" && (
              <button type="button" className="btn" disabled={!canReconcile} title={blocker?.sentence} onClick={() => setDialog(true)}>Mark {mon(v)} reconciled</button>
            )}
            {(v.state === "reconciled" || v.state === "changed") && <button type="button" className="btn btn-ghost" onClick={() => setReopen(true)}>Reopen…</button>}
          </div>
          {blocker && v.state !== "reconciled" && <p className="text-sm text-ink-3 -mt-2">{blocker.sentence}</p>}
        </div>

        <aside className="grid grid-cols-1 gap-4 content-start min-w-0">
          <section className="card p-4">
            <h2 className="font-bold mb-2">Versions</h2>
            {!v.versions.length ? <p className="text-sm text-ink-3">Not reconciled yet.</p> : (
              <ul className="grid grid-cols-1 gap-2 text-sm">
                {v.versions.map((x) => (
                  <li key={x.version} className="grid grid-cols-1 gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-bold">v{x.version}</span>
                      <span className="text-ink-3">{fmtDate(x.reconciledAt)} · {x.reconciledByName}</span>
                      <button type="button" className="text-xs underline text-ink-3" onClick={async () => {
                        try { const { blob, filename } = await apiFetchBlob(`/sales/reconcile/bank/brs.pdf?company=${company}&accountId=${v.account.id}&month=${v.month.key}&version=${x.version}`); downloadBlob(blob, filename ?? "brs.pdf"); }
                        catch (err) { setToast({ message: errorSentence(err), tone: "err" }); }
                      }}>PDF</button>
                    </span>
                    {x.supersedeKind && <span className="text-xs text-ink-3">{x.supersedeKind === "reopened" ? `Reopened ${fmtDate(x.supersededAt)} by ${x.supersededByName}${x.supersedeReason ? ` — ${x.supersedeReason}` : ""}` : `Replaced by a later version ${fmtDate(x.supersededAt)}`}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <EventList events={events} />
        </aside>
      </div>
      {dialog && <BrsReconcileDialog v={v} onSubmit={submit} onClose={() => setDialog(false)} />}
      {reopen && (
        <Confirm danger title={`Reopen ${v.month.label}?`} confirmLabel="Reopen"
          body={<Field label="Why (required)"><input className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. cheque bounced" /></Field>}
          onConfirm={() => (reason.trim().length >= 3 ? doReopen() : setToast({ message: "Say why the month is reopened.", tone: "err" }))} onClose={() => setReopen(false)} />
      )}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function BrsPage() {
  return <Suspense fallback={<Loading />}><Brs /></Suspense>;
}
