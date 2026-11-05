"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { useTallyPreview, useTallyRuns, useTallySettings } from "@/lib/hooks";
import { apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate } from "@/lib/format";
import { Confirm, Empty, LoadError, Loading, Money, PageHead, Stat, StatusPill, Toast } from "@/components/sales-ui";
import { defaultPeriod, TallyPeriod, type TallyPeriodValue } from "@/components/tally-period";
import { docHref, refreshTally } from "@/lib/tally";
import type { TallyIssue, TallyPreview, TallyRunView } from "@/lib/sales-types";

// Tally — the monthly export (spec-tally §5.2). Choose a period; the preview loads by itself and
// shows what goes, what can't, and what Tally's GSTR-1 should show after the import. Download for
// Tally freezes an export (masters + vouchers files); it stays open until someone types Tally's
// import counts on its page, so nothing is silently missed or posted twice.

const ACTION_LABEL: Record<string, string> = { create: "new", alter: "change", cancel: "cancel", unchanged: "already in Tally", skip: "skipped", blocked: "held back" };
const DOC_LABEL: Record<string, string> = { invoice: "Sales", credit_note: "Credit note", receipt: "Receipt", refund: "Refund" };
const monthName = (m: string) => fmtDate(`${m}-01`).split(" ").slice(1).join(" ");
const sumCounts = (c: { create: number; alter: number; cancel: number }) => c.create + c.alter + c.cancel;

function readPeriod(company: string): TallyPeriodValue {
  try {
    const raw = window.localStorage.getItem(`sales.tally.period.${company}`);
    if (raw) { const v = JSON.parse(raw); if (v?.from && v?.to && v?.preset) return v; }
  } catch { /* storage unavailable */ }
  return defaultPeriod();
}

export default function TallyPage() {
  const router = useRouter();
  const { company, info } = useCompany();
  const { user } = useAuth();
  const admin = isAdminUser(user);
  const { data: setup, error: setupError, isLoading: setupLoading, mutate: reloadSetup } = useTallySettings();
  const [period, setPeriod] = useState<TallyPeriodValue>(defaultPeriod());
  const [gstin, setGstin] = useState<string>("");
  const [mode, setMode] = useState<"new_only" | "everything">("new_only");
  const [acks, setAcks] = useState<Set<string>>(new Set());
  const [allowPartial, setAllowPartial] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  useEffect(() => { setPeriod(readPeriod(company)); setGstin(""); setMode("new_only"); }, [company]);
  const choosePeriod = (v: TallyPeriodValue) => {
    setPeriod(v);
    try { window.localStorage.setItem(`sales.tally.period.${company}`, JSON.stringify(v)); } catch { /* storage unavailable */ }
  };

  const ready = !!setup && setup.company === company && setup.missing.length === 0;
  const regs = setup?.registrations ?? [];
  const companyOf = (g: string) => setup?.settings.registrations.find((r) => r.gstin === g)?.tallyCompany;
  const sharedCompany = regs.length > 0 && new Set(regs.map((r) => companyOf(r.gstin))).size === 1;
  const effectiveGstin = gstin || (!sharedCompany && regs.length ? regs[0].gstin : "");
  const query = ready && period.from && period.to && period.from <= period.to ? { company, from: period.from, to: period.to, gstin: effectiveGstin || undefined, mode } : null;
  const { data: p, error, isLoading, isValidating, mutate } = useTallyPreview(query);
  const runs = useTallyRuns();
  useEffect(() => { setAcks(new Set()); setAllowPartial(false); }, [p?.previewHash]);

  if (setupError) return <LoadError error={setupError} retry={() => reloadSetup()} />;
  if (setupLoading || !setup || setup.company !== company) return <Loading />;

  const head = (
    <PageHead kicker="Accounts" title="Tally">
      <Link href="/tally/parties" className="btn btn-ghost">Party ledgers</Link>
      <Link href="/tally/settings" className="btn btn-ghost">Tally settings</Link>
    </PageHead>
  );
  if (!ready) {
    return (
      <>
        {head}
        <Empty title={`Tally isn't set up for ${info.short} yet.`}
          body={<>An admin fills in Tally settings once: the company name in Tally, the ledger names, and the date Tally&apos;s books already cover.
            <span className="block mt-2">Still needed: {setup.missing.join("; ")}.</span></>}
          action={admin ? <Link className="btn" href="/tally/settings">Open Tally settings</Link> : <span className="text-sm text-ink-3">Ask an admin.</span>} />
      </>
    );
  }

  const blocks = p?.issues.filter((i) => i.severity === "block") ?? [];
  const ackIssues = p?.issues.filter((i) => i.severity === "ack") ?? [];
  const infos = p?.issues.filter((i) => i.severity === "info") ?? [];
  const allTicked = ackIssues.every((i) => acks.has(i.id));
  const reason = !p ? "" : p.openRun ? `Export #${p.openRun.runNo} is still open.` : p.counts.vouchers === 0 ? "Nothing to send." : blocks.length && !allowPartial ? "Tick 'Leave out' or fix the held-back documents." : !allTicked ? "Tick every warning first." : "";
  // keepPreviousData shows the last good preview while a new one loads; never export it under a
  // different period / registration / mode, and never once the new one failed.
  const matches = !!p && !!query && p.company === query.company && p.period.from === query.from && p.period.to === query.to && p.mode === query.mode && (p.scopeGstin ?? undefined) === query.gstin;
  const canGo = !!p && matches && !error && !reason && !busy && !isValidating;
  const pushOn = admin && setup.pushEnabled && !!setup.settings.pushUrl;
  const body = () => ({ companyKey: company, from: period.from, to: period.to, gstin: effectiveGstin || null, mode, previewHash: p!.previewHash, acknowledge: [...acks], allowPartial });
  const fail = (err: unknown) => {
    setToast({ message: errorSentence(err), tone: "err" });
    mutate();
    runs.mutate();
  };

  async function download() {
    setBusy(true);
    try {
      const run = (await apiFetch<TallyRunView>("/sales/tally/runs", { method: "POST", body: JSON.stringify(body()) })).data;
      for (const part of run.masterCount > 0 ? ["masters", "vouchers"] : ["vouchers"]) {
        const f = await apiFetchBlob(`/sales/tally/runs/${run.id}/file?part=${part}`);
        downloadBlob(f.blob, f.filename ?? `tally-export${run.runNo}-${part}.xml`);
      }
      setToast({ message: `Export #${run.runNo} downloaded. In Tally import the masters file first, then the vouchers file — then mark it as imported.`, tone: "ok" });
      await refreshTally();
      router.push(`/tally/view?id=${run.id}`);
    } catch (err) { fail(err); } finally { setBusy(false); }
  }
  async function send() {
    try {
      const run = (await apiFetch<TallyRunView>("/sales/tally/pushes", { method: "POST", body: JSON.stringify(body()) })).data;
      await refreshTally();
      router.push(`/tally/view?id=${run.id}`);
    } catch (err) { setConfirmSend(false); fail(err); }
  }

  return (
    <>
      {head}
      <p className="text-sm text-ink-3 mb-4 break-words">{info.name} → Tally company “{p?.tallyCompany ?? companyOf(effectiveGstin || regs[0]?.gstin) ?? "—"}”</p>
      {p?.openRun && (
        <div className="card border-attention p-3 text-sm mb-4 flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
          <span>Export #{p.openRun.runNo} is waiting to be {p.openRun.status === "open" ? "marked as imported" : "finished"}.</span>
          <Link className="btn btn-sm" href={`/tally/view?id=${p.openRun.id}`}>Open export #{p.openRun.runNo}</Link>
        </div>
      )}

      <section className="card p-4 mb-4 grid grid-cols-[minmax(0,1fr)] gap-4">
        <h2 className="font-bold">What to send</h2>
        <TallyPeriod value={period} onChange={choosePeriod} />
        {regs.length >= 2 && (
          <label className="block min-w-0"><span className="block text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-1">Registration</span>
            <select className="input w-full max-w-full" value={effectiveGstin} onChange={(e) => setGstin(e.target.value)}>
              {sharedCompany && <option value="">All registrations</option>}
              {regs.map((r) => <option key={r.gstin} value={r.gstin}>{r.label} · {r.gstin}</option>)}
            </select>
          </label>
        )}
        <div className="flex flex-wrap gap-1" role="group" aria-label="What to include">
          {([["new_only", "New and changed"], ["everything", "Everything in the period"]] as const).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)}
              className={`px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] border-2 ${mode === k ? "bg-indigo border-indigo text-white font-bold" : "border-border text-ink-3 hover:text-white"}`}>{label}</button>
          ))}
        </div>
      </section>

      <section className="card p-4 mb-4 grid grid-cols-[minmax(0,1fr)] gap-4">
        <h2 className="font-bold">In this export {isValidating && p && <span className="text-xs text-ink-3 font-normal">· updating…</span>}</h2>
        {error ? <LoadError error={error} retry={() => mutate()} /> : (isLoading && !p) || (p && !matches) ? <Loading label="Checking what's new…" /> : p && (
          <>
            {p.counts.vouchers === 0 && !blocks.length ? (
              <Empty title={`Nothing new for ${fmtDate(p.period.from)} – ${fmtDate(p.period.to)} — everything here is already in Tally.`}
                action={mode === "new_only" ? <button type="button" className="btn btn-ghost whitespace-normal max-w-full" onClick={() => setMode("everything")}>Send everything in this period again</button> : undefined} />
            ) : null}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Stat label="Sales invoices" value={sumCounts(p.counts.sales)} sub={<><Money paise={p.totals.salesTotalPaise} /> · GST <Money paise={p.totals.cgstPaise + p.totals.sgstPaise + p.totals.igstPaise} /></>} />
              <Stat label="Credit notes" value={sumCounts(p.counts.creditNotes)} sub={<Money paise={p.totals.creditTotalPaise} />} />
              <Stat label="Receipts" value={sumCounts(p.counts.receipts) + sumCounts(p.counts.refunds)} sub={<><Money paise={p.totals.receiptCashPaise} /> + TDS <Money paise={p.totals.tdsPaise} /></>} />
              <Stat label="Changes" value={p.counts.sales.alter + p.counts.creditNotes.alter + p.counts.receipts.alter + p.counts.refunds.alter + p.counts.sales.cancel + p.counts.creditNotes.cancel + p.counts.receipts.cancel + p.counts.refunds.cancel}
                sub={`${p.counts.earlierChanges} from earlier months`} tone={p.counts.earlierChanges > 0 ? "attention" : undefined} />
            </div>
            <p className="text-xs text-ink-3 break-words">
              New {p.counts.sales.create + p.counts.creditNotes.create + p.counts.receipts.create + p.counts.refunds.create} · Changes {p.counts.sales.alter + p.counts.creditNotes.alter + p.counts.receipts.alter + p.counts.refunds.alter} · Cancellations {p.counts.sales.cancel + p.counts.creditNotes.cancel + p.counts.receipts.cancel + p.counts.refunds.cancel} · Already in Tally {p.counts.unchanged} (left out) · New client ledgers {p.counts.masters.partiesNew}
              {p.period.effectiveFrom !== p.period.from && <> · Tally already has everything before {fmtDate(p.period.booksFrom)}</>}
            </p>
            <Problems blocks={blocks} acks={ackIssues} infos={infos} ticked={acks} onTick={(id, on) => setAcks((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; })} allowPartial={allowPartial} setAllowPartial={setAllowPartial} />
            <ShouldShow p={p} />
            <details className="card-inset p-3">
              <summary className="cursor-pointer text-sm font-bold">Ledgers used</summary>
              <div className="overflow-x-auto mt-2"><table className="w-full min-w-[520px] text-sm [&_td]:px-2 [&_th]:px-2"><thead><tr className="text-left text-ink-3 text-xs"><th className="py-1">Role</th><th>Name</th><th className="text-right">Dr</th><th className="text-right">Cr</th><th>In Tally</th></tr></thead>
                <tbody>{p.ledgers.map((l) => <tr key={`${l.role}|${l.name}`} className="border-t border-border"><td className="py-1">{l.role}</td><td className="break-words">{l.name}</td><td className="text-right"><Money paise={l.debitPaise} /></td><td className="text-right"><Money paise={l.creditPaise} /></td><td className="text-xs text-ink-3">{l.createdByExport ? "created by this export" : "must already exist in Tally"}</td></tr>)}</tbody></table></div>
            </details>
            <details className="card-inset p-3">
              <summary className="cursor-pointer text-sm font-bold">Show the {p.documents.length} documents</summary>
              <div className="overflow-x-auto mt-2"><table className="w-full min-w-[640px] text-sm [&_td]:px-2 [&_th]:px-2"><thead><tr className="text-left text-ink-3 text-xs"><th className="py-1">Type</th><th>Number</th><th>Date</th><th>Client</th><th className="text-right">Amount</th><th>Will be</th><th>Last sent</th></tr></thead>
                <tbody>{p.documents.map((d) => { const href = docHref(d); return (
                  <tr key={d.docId} className="border-t border-border"><td className="py-1">{DOC_LABEL[d.docType]}</td>
                    <td className="font-mono break-all">{href ? <Link href={href} className="hover:text-white underline">{d.number}</Link> : d.number}</td>
                    <td>{fmtDate(d.date)}</td><td className="break-words">{d.party}</td><td className="text-right"><Money paise={d.partyAmountPaise} /></td>
                    <td><StatusPill status={d.action === "blocked" ? "blocked" : d.action === "unchanged" ? "unchanged" : d.action === "skip" ? "superseded" : "open"} label={ACTION_LABEL[d.action]} /></td>
                    <td className="text-xs text-ink-3">{d.lastSent ? `#${d.lastSent.runNo} · ${fmtDate(d.lastSent.at)}` : "—"}</td></tr>); })}</tbody></table></div>
              {p.documentsTruncated && <p className="text-xs text-ink-3 mt-2">Showing 2,000 — every document is in the file.</p>}
            </details>
          </>
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          {pushOn && <button type="button" className="btn w-full sm:w-auto" disabled={!canGo} onClick={() => setConfirmSend(true)}>Send to Tally</button>}
          <button type="button" className={`btn ${pushOn ? "btn-light" : ""} w-full sm:w-auto`} disabled={!canGo} onClick={download}>{busy ? "Preparing…" : "Download for Tally"}</button>
        </div>
        {reason && <p className="text-xs text-attention">{reason}</p>}
        <p className="text-xs text-ink-3">In Tally: Import → Masters (Ignore Duplicates), then Import → Transactions.</p>
      </section>

      <section className="card p-4">
        <h2 className="font-bold mb-3">Earlier exports</h2>
        {runs.error ? <LoadError error={runs.error} retry={() => runs.mutate()} /> : !runs.data ? <Loading /> : !runs.data.length ? <p className="text-sm text-ink-3">No exports yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm [&_td]:px-2 [&_th]:px-2"><thead><tr className="text-left text-ink-3 text-xs"><th className="py-1">Export</th><th>Period</th><th>Registration</th><th>How</th><th>Status</th><th className="text-right">Vouchers</th><th className="text-right">Control total</th><th>By</th><th>When</th></tr></thead>
            <tbody>{runs.data.map((r) => (
              <tr key={r.id} className="border-t border-border"><td className="py-1"><Link className="underline hover:text-white" href={`/tally/view?id=${r.id}`}>#{r.runNo}</Link></td>
                <td>{fmtDate(r.periodFrom)} – {fmtDate(r.periodTo)}</td><td className="font-mono text-xs break-all">{r.scopeGstin ?? "All"}</td>
                <td>{r.channel === "file" ? "File" : r.channel === "push" ? "Sent" : "By hand"}</td><td><StatusPill status={r.status} /></td>
                <td className="text-right">{r.voucherCount}</td><td className="text-right"><Money paise={r.controlTotalPaise} /></td><td>{r.createdBy?.name ?? "—"}</td><td>{fmtDate(r.createdAt)}</td></tr>
            ))}</tbody></table></div>
        )}
      </section>

      {confirmSend && p && (
        <Confirm title={`Send ${p.counts.vouchers} vouchers to Tally?`} confirmLabel="Send to Tally" onClose={() => setConfirmSend(false)} onConfirm={send}
          body={<>They go into “{p.tallyCompany}” at {setup.settings.pushUrl}. Tally must be open with this company loaded. Tally is checked first, so vouchers already there are matched, not duplicated.</>} />
      )}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

function Problems({ blocks, acks, infos, ticked, onTick, allowPartial, setAllowPartial }: {
  blocks: TallyIssue[]; acks: TallyIssue[]; infos: TallyIssue[]; ticked: Set<string>; onTick: (id: string, on: boolean) => void; allowPartial: boolean; setAllowPartial: (v: boolean) => void;
}) {
  if (!blocks.length && !acks.length && !infos.length) return null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      {blocks.length > 0 && (
        <div className="card border-danger p-3 text-sm">
          <p className="font-bold mb-2">Held back — can&apos;t go to Tally yet</p>
          <ul className="grid gap-1 mb-3">{blocks.map((i) => <li key={i.id} className="break-words"><span className="font-mono">{i.number ?? ""}</span> {i.number ? "— " : ""}{i.message} {i.fix && <Link className="underline" href={i.fix.href}>{i.fix.label}</Link>}</li>)}</ul>
          <label className="flex items-start gap-2"><input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} /> <span>Leave out these {blocks.length} documents and export the rest</span></label>
        </div>
      )}
      {acks.length > 0 && (
        <div className="card border-attention p-3 text-sm grid gap-2">
          <p className="font-bold">Needs a tick</p>
          {acks.map((i) => <label key={i.id} className="flex items-start gap-2 break-words"><input type="checkbox" className="mt-1" checked={ticked.has(i.id)} onChange={(e) => onTick(i.id, e.target.checked)} /> <span>{i.message}</span></label>)}
        </div>
      )}
      {infos.length > 0 && (
        <details className="card-inset p-3 text-sm"><summary className="cursor-pointer font-bold">For information ({infos.length})</summary>
          <ul className="grid gap-1 mt-2">{infos.map((i) => <li key={i.id} className="break-words">{i.message}</li>)}</ul></details>
      )}
    </div>
  );
}

function ShouldShow({ p }: { p: Pick<TallyPreview, "tallyShouldShow" | "totals"> }) {
  const rows = p.tallyShouldShow.gst;
  const zr = (g: (typeof rows)[number]) => (g.sezwop?.taxablePaise ?? 0) + (g.expwop?.taxablePaise ?? 0);
  const anyZr = rows.some((g) => zr(g) !== 0 || (g.zeroRatedCreditNotes?.taxablePaise ?? 0) !== 0);
  return (
    <details open className="card-inset p-3">
      <summary className="cursor-pointer text-sm font-bold">After importing, Tally should show</summary>
      <div className="overflow-x-auto mt-2"><table className="w-full min-w-[520px] text-sm [&_td]:px-2 [&_th]:px-2"><thead><tr className="text-left text-ink-3 text-xs"><th className="py-1">Registration</th><th>Month</th><th className="text-right">B2B taxable</th><th className="text-right">B2C taxable</th><th className="text-right">CGST</th><th className="text-right">SGST</th><th className="text-right">IGST</th><th className="text-right">Credit notes</th>{anyZr && <th className="text-right">SEZ / export</th>}<th>Invoices</th></tr></thead>
        <tbody>{rows.length ? rows.map((g) => (
          <tr key={`${g.gstin}${g.month}`} className="border-t border-border"><td className="py-1">{g.label}</td><td>{monthName(g.month)}</td>
            <td className="text-right"><Money paise={g.b2b.taxablePaise} /></td><td className="text-right"><Money paise={g.b2c.taxablePaise} /></td>
            <td className="text-right"><Money paise={g.b2b.cgstPaise + g.b2c.cgstPaise} /></td><td className="text-right"><Money paise={g.b2b.sgstPaise + g.b2c.sgstPaise} /></td>
            <td className="text-right"><Money paise={g.b2b.igstPaise + g.b2c.igstPaise} /></td><td className="text-right"><Money paise={g.creditNotes.taxablePaise} /></td>
            {anyZr && <td className="text-right"><Money paise={zr(g)} />{g.sezwop?.count ? <span className="block text-[11px] text-ink-3">SEZWOP {g.sezwop.count}</span> : null}{g.expwop?.count ? <span className="block text-[11px] text-ink-3">EXPWOP {g.expwop.count}</span> : null}</td>}
            <td className="text-xs">{g.documents.issued} issued / {g.documents.cancelled} cancelled{g.documents.fromNo ? `, ${g.documents.fromNo} – ${g.documents.toNo}` : ""}</td></tr>
        )) : <tr><td colSpan={9} className="py-2 text-ink-3">No invoices in this period.</td></tr>}</tbody></table></div>
      {anyZr && <p className="text-xs text-ink-3 mt-2">SEZ / export invoices are not B2B or B2C in GSTR-1{p.tallyShouldShow.zeroRatedByHand ? " — they aren't in this file yet; enter them in Tally by hand" : ""}.</p>}
      {p.tallyShouldShow.tds.map((t) => <p key={t.fy} className="text-sm mt-2">{t.ledger}: +<Money paise={t.paise} /> ({t.receipts} receipt{t.receipts === 1 ? "" : "s"})</p>)}
      <p className="text-sm mt-1">Control total <Money paise={p.totals.controlTotalPaise} /></p>
    </details>
  );
}
