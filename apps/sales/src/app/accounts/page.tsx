"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { fyLabelsBetween, fyMonths, periodBounds, FILED_MIN_FY, MONTH_LONG } from "@dashmani/shared/src/sales/accounts";
import { useAccounts } from "@/lib/hooks";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { apiFetchBlob, downloadBlob } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, fmtInr, fmtInt } from "@/lib/format";
import type { AccountsView, FiledYearView, GstMonth, Money5 } from "@/lib/sales-types";
import { Empty, LoadError, Loading, Money, PageHead, Stat, StatusPill, Toast, titleCase } from "@/components/sales-ui";
import { MonthBars } from "@/components/month-bars";
import { viewFiledPdf } from "@/lib/filed-pdf";

// sales.digitalsukoon.com/accounts (spec-accounts §5.2): live figures for one company × financial
// year, computed by SQL aggregates on every load, beside the figures typed from the signed
// statements. Every heading labels itself from what the SERVER returned (data.fy.label /
// data.company), never from the URL — while another year loads, the old one is dimmed.

const W = (p: number) => fmtInr(p, { whole: true });
const sum5 = (rows: Money5[]): Money5 => rows.reduce((a, r) => ({ taxablePaise: a.taxablePaise + r.taxablePaise, cgstPaise: a.cgstPaise + r.cgstPaise, sgstPaise: a.sgstPaise + r.sgstPaise, igstPaise: a.igstPaise + r.igstPaise, totalPaise: a.totalPaise + r.totalPaise }), { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 0 });
const tax = (m: Money5) => m.cgstPaise + m.sgstPaise + m.igstPaise;
/** A credit-note figure shown as a deduction; 0 stays 0 (Intl prints −0 as "-₹0.00"). */
const neg = (p: number) => (p ? -p : 0);
const monthLabel = (m: string) => `${MONTH_LONG[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

function useDownload(setToast: (t: { message: string; tone: "ok" | "err" }) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, path: string, fallback: string) => {
    setBusy(key);
    try {
      const { blob, filename } = await apiFetchBlob(path);
      downloadBlob(blob, filename ?? fallback);
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

function gapLabel(gap: number | null, filed: number | null): { text: string; tone: string } {
  if (gap == null || filed == null) return { text: "—", tone: "text-ink-3" };
  if (filed !== 0 && Math.abs(gap) * 100 <= Math.abs(filed)) return { text: "Matches within 1%", tone: "text-success" };
  if (gap > 0) return { text: `${W(gap)} not in the portal`, tone: "text-attention" };
  return { text: `Portal ${W(-gap)} above filed — check year-end credit notes and dates`, tone: "text-attention" };
}

// ─── Page ──────────────────────────────────────────────────────────────────────────────────────

function AccountsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const requestedFy = params.get("fy") ?? undefined;
  const { company, info } = useCompany();
  const { user } = useAuth();
  const admin = isAdminUser(user);
  const { data, error, isLoading, mutate } = useAccounts(requestedFy);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  // The filed-figures editor navigates here after a save with ?saved=1 (saved) or ?saved=0 (no
  // change); its own toast would unmount with it, so the confirmation is shown on this page.
  const saved = params.get("saved");
  useEffect(() => {
    if (saved !== "1" && saved !== "0") return;
    setToast({ message: saved === "1" ? `Filed figures${requestedFy ? ` for ${requestedFy}` : ""} saved.` : "Nothing changed.", tone: "ok" });
    router.replace(requestedFy ? `/accounts?fy=${requestedFy}` : "/accounts");
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  // keepPreviousData: after a company switch `data` is still the OTHER company's view, so a failed
  // load must show its error here too — never an endless "Adding up the books…".
  if (error && (!data || data.company !== company)) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading && !data) return <Loading label="Adding up the books…" />;
  if (!data || data.company !== company) return <Loading label="Adding up the books…" />;
  const stale = !!requestedFy && data.fy.label !== requestedFy;
  const d = data;
  const filedHref = (fy: string) => `/accounts/filed?fy=${fy}&company=${d.company}`;

  return (
    <>
      <PageHead kicker={`${info.short} · Financial year ${d.fy.label}${d.fy.closed ? "" : " · running"}`} title="Accounts">
        {admin && d.fy.closed && <Link href={filedHref(d.fy.label)} className="btn btn-light">{d.filed ? "Edit filed figures" : "Add filed figures"}</Link>}
      </PageHead>
      {error && <div className="mb-4"><LoadError error={error} retry={() => mutate()} /></div>}
      <YearPills years={d.years.map((y) => y.fy)} current={d.fy.label} running={d.years.find((y) => !y.closed)?.fy} onPick={(fy) => router.replace(`/accounts?fy=${fy}`)} />
      <div className={stale ? "opacity-60" : ""} aria-busy={stale || undefined}>
        <KeyFigures d={d} />
        <ChartCard d={d} />
        <GstSection d={d} setToast={setToast} />
        <Receivables d={d} />
        <Tds d={d} setToast={setToast} />
        <Collections d={d} />
        <FiledTable d={d} admin={admin} filedHref={filedHref} setToast={setToast} />
        <p className="text-xs text-ink-4 mt-6">Computed {fmtDate(d.computedAt)} from the portal&apos;s own invoices, credit notes and receipts.</p>
      </div>
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

function YearPills({ years, current, running, onPick }: { years: string[]; current: string; running?: string; onPick: (fy: string) => void }) {
  const shown = years.slice(0, 6);
  const older = years.slice(6);
  return (
    <div className="flex flex-wrap gap-2 mb-6 items-center" role="radiogroup" aria-label="Financial year">
      {shown.map((fy) => (
        <button key={fy} type="button" role="radio" aria-checked={fy === current} onClick={() => onPick(fy)}
          className={`px-3 py-1.5 text-sm border-2 ${fy === current ? "bg-indigo border-indigo text-white" : "border-border text-ink-3 hover:text-white"}`}>
          {fy}{fy === running ? " · running" : ""}
        </button>
      ))}
      {older.length > 0 && (
        <select className="input w-auto" aria-label="Older years" value={older.includes(current) ? current : ""} onChange={(e) => e.target.value && onPick(e.target.value)}>
          <option value="">Older years</option>
          {older.map((fy) => <option key={fy} value={fy}>{fy}</option>)}
        </select>
      )}
    </div>
  );
}

function KeyFigures({ d }: { d: AccountsView }) {
  const inv = d.invoiced;
  const filedTile = d.comparison.state === "current"
    ? <Stat label="Filed accounts" value={<span className="text-base">Not yet</span>} sub={`closes ${fmtDate(d.fy.endDay)}`} />
    : d.comparison.state === "closed_not_filed"
      ? <Stat label="Filed accounts" value={<span className="text-base">Not added</span>} sub="Type the figures from the signed statements" tone="attention" />
      : <Stat label="Filed revenue" value={d.comparison.filedRevenuePaise == null ? <span className="text-base">Revenue not typed</span> : W(d.comparison.filedRevenuePaise)} sub={gapLabel(d.comparison.gapPaise, d.comparison.filedRevenuePaise).text} />;
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <Stat label="Invoiced" value={W(inv.net.totalPaise)} sub={`${W(inv.net.taxablePaise)} before GST · ${fmtInt(inv.gross.count)} invoices · credit notes −${W(inv.creditNotes.totalPaise)}`} />
        <Stat label="Collected" tone="success" value={W(d.collected.netPaise)} sub={`TDS ${W(d.collected.tdsPaise)} · refunds ${W(d.collected.refundedPaise)}`} />
        <Stat label="Receivables today" tone={d.receivables.totalPaise > 0 ? "attention" : undefined} value={W(d.receivables.totalPaise)} sub={`${W(d.receivables.overduePaise)} overdue · all years`} />
        <Stat label="TDS by clients" value={W(d.tds.totalPaise)} sub={`for 26AS · ${fmtInt(d.tds.clients.length)} clients`} />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Stat label="Credit notes" value={W(inv.creditNotes.totalPaise)} sub={`${fmtInt(inv.creditNotes.count)} · ${fmtInt(inv.creditNotes.onEarlierYearInvoices)} on earlier years' invoices`} />
        <Stat label="Unapplied advances" value={W(d.unapplied.cashPaise + d.unapplied.tdsPaise)} sub={`on ${fmtInt(d.unapplied.clients)} clients' receipts — apply them from the invoice`} />
        {d.bank && <Link href="/bank" className="min-w-0"><Stat label="Bank credits to match" value={fmtInt(d.bank.unmatchedCount)} sub={`${W(d.bank.unmatchedPaise)}${d.bank.lastStatementDay ? ` · statement to ${fmtDate(d.bank.lastStatementDay)}` : ""}`} /></Link>}
        {filedTile}
      </div>
      {inv.cancelled.count > 0 && <p className="text-xs text-ink-3 -mt-4 mb-6">{fmtInt(inv.cancelled.count)} cancelled invoice{inv.cancelled.count === 1 ? "" : "s"} ({W(inv.cancelled.totalPaise)}) are not counted.</p>}
    </>
  );
}

function ChartCard({ d }: { d: AccountsView }) {
  const [table, setTable] = useState(false);
  const empty = d.invoiced.gross.count === 0 && d.invoiced.creditNotes.count === 0 && d.collected.receipts === 0;
  const tot = d.months.reduce((s, m) => ({ i: s.i + m.invoicedPaise, c: s.c + m.collectedPaise, t: s.t + m.tdsPaise }), { i: 0, c: 0, t: 0 });
  return (
    <section className="card p-4 mb-6 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="font-bold">Invoiced vs collected, by month</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTable((t) => !t)}>{table ? "Chart" : "Table"}</button>
      </div>
      {table ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[480px]">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2">Month</th><th className="p-2 text-right">Invoiced</th><th className="p-2 text-right">Collected</th><th className="p-2 text-right">TDS</th></tr></thead>
            <tbody>{d.months.map((m) => <tr key={m.month} className={`border-b border-rule ${m.future ? "text-ink-4" : ""}`}><td className="p-2">{monthLabel(m.month)}</td><td className="p-2 text-right"><Money paise={m.invoicedPaise} /></td><td className="p-2 text-right"><Money paise={m.collectedPaise} /></td><td className="p-2 text-right"><Money paise={m.tdsPaise} /></td></tr>)}</tbody>
            <tfoot><tr className="font-bold"><td className="p-2">Total</td><td className="p-2 text-right"><Money paise={tot.i} /></td><td className="p-2 text-right"><Money paise={tot.c} /></td><td className="p-2 text-right"><Money paise={tot.t} /></td></tr></tfoot>
          </table>
        </div>
      ) : (
        <MonthBars months={d.months} currentMonth={d.fy.closed ? undefined : d.today.slice(0, 7)} />
      )}
      {empty && <p className="text-sm text-ink-3 mt-3">No tax invoices or receipts in {d.fy.label} for {d.company === "dmpl" ? "Dashmani Media" : "Digital Sukoon"} yet.{d.fy.closed ? " Old invoices from Swipe appear here once they are imported." : ""}</p>}
    </section>
  );
}

// ─── GST ───────────────────────────────────────────────────────────────────────────────────────

function periodOptions(d: AccountsView): Array<{ value: string; label: string }> {
  const fy = d.fy.label;
  const started = fyMonths(fy).filter((m) => `${m}-01` <= d.today);
  const curMonth = d.today.slice(0, 7);
  const out = started.map((m) => ({ value: m, label: `${MONTH_LONG[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}${m === curMonth ? " (so far)" : ""}` }));
  for (let q = 1; q <= 4; q++) {
    const p = periodBounds(`${fy}-Q${q}`)!;
    if (p.from <= d.today) out.push({ value: `${fy}-Q${q}`, label: p.label });
  }
  out.push({ value: fy, label: `Whole year ${fy}` });
  return out;
}

function defaultPeriod(d: AccountsView): string {
  if (d.fy.closed) return d.fy.label;
  const months = fyMonths(d.fy.label);
  const cur = d.today.slice(0, 7);
  const i = months.indexOf(cur);
  return i <= 0 ? cur : months[i - 1];
}

function GstSection({ d, setToast }: { d: AccountsView; setToast: (t: { message: string; tone: "ok" | "err" }) => void }) {
  const regs = d.gst.byRegistration;
  const [gstin, setGstin] = useState<string>(regs[0]?.gstin ?? "");
  const [period, setPeriod] = useState(() => defaultPeriod(d));
  const { busy, run } = useDownload(setToast);
  // A new year (or company) resets the filters to that year's defaults.
  useEffect(() => { setPeriod(defaultPeriod(d)); setGstin(d.gst.byRegistration[0]?.gstin ?? ""); }, [d.fy.label, d.company]); // eslint-disable-line react-hooks/exhaustive-deps

  const reg = regs.find((r) => r.gstin === gstin) ?? regs[0];
  const regInfo = d.registrations.find((r) => r.gstin === reg?.gstin);
  const pb = periodBounds(period);
  const inPeriod = (m: string) => !!pb && `${m}-01` >= pb.from && `${m}-01` < pb.toExclusive;
  const periodMonths: GstMonth[] = (reg?.months ?? []).filter((m) => inPeriod(m.month));
  const periodDocs = periodMonths.reduce((s, m) => s + m.invoices.count + m.creditNotes.count, 0);
  const a = periodMonths.reduce((s, m) => ({ taxablePaise: s.taxablePaise + m.gstr3b.a.taxablePaise, cgstPaise: s.cgstPaise + m.gstr3b.a.cgstPaise, sgstPaise: s.sgstPaise + m.gstr3b.a.sgstPaise, igstPaise: s.igstPaise + m.gstr3b.a.igstPaise }), { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
  const b = periodMonths.reduce((s, m) => ({ taxablePaise: s.taxablePaise + m.gstr3b.b.taxablePaise, igstPaise: s.igstPaise + m.gstr3b.b.igstPaise }), { taxablePaise: 0, igstPaise: 0 });
  const docs = d.gst.documents.filter((x) => x.gstin === reg?.gstin && inPeriod(x.month));
  const periodLabel = pb?.label ?? period;
  const nothing = periodDocs === 0;
  const nothingTitle = `Nothing to file for ${periodLabel} from ${regInfo?.label ?? "this registration"}.`;
  const canGstr1 = !!regInfo?.current;
  const q = (layout: string, withGstin: boolean) => `/sales/accounts/gst.csv?company=${d.company}&period=${encodeURIComponent(period)}&layout=${layout}${withGstin && reg?.gstin ? `&gstin=${reg.gstin}` : ""}`;
  // The register follows the pill whenever pills are shown — a former registration included, and
  // "none" for documents frozen with no seller GSTIN — so the file matches the table on screen.
  const registerQ = `/sales/accounts/gst.csv?company=${d.company}&period=${encodeURIComponent(period)}&layout=register${regs.length >= 2 && reg ? `&gstin=${reg.gstin || "none"}` : ""}`;
  const totals = reg ? { inv: sum5(reg.months.map((m) => m.invoices)), cn: sum5(reg.months.map((m) => m.creditNotes)), net: sum5(reg.months.map((m) => m.net)) } : null;

  return (
    <section className="card p-4 mb-6 min-w-0">
      <h2 className="font-bold mb-3">GST output · for GSTR-1 and GSTR-3B</h2>
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        {regs.length >= 2 && regs.map((r) => {
          const ri = d.registrations.find((x) => x.gstin === r.gstin);
          return (
            <button key={r.gstin || "none"} type="button" aria-pressed={r.gstin === reg?.gstin} onClick={() => setGstin(r.gstin)}
              className={`px-3 py-1.5 text-xs border-2 break-all text-left ${r.gstin === reg?.gstin ? "bg-indigo border-indigo text-white" : "border-border text-ink-3 hover:text-white"}`}>
              {ri?.label ?? r.gstin}
            </button>
          );
        })}
        <select className="input w-auto" aria-label="Return period" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {periodOptions(d).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button type="button" className="btn btn-light btn-sm inline-flex items-center gap-1" disabled={nothing || !canGstr1 || !!busy} title={nothing ? nothingTitle : !canGstr1 ? "GSTR-1 files are made for a current registration only" : undefined}
          onClick={() => run("b2b", q("b2b", true), `gstr1-b2b-${period}.csv`)}><Download size={14} aria-hidden />{busy === "b2b" ? "Preparing…" : "GSTR-1 B2B CSV"}</button>
        <button type="button" className="btn btn-light btn-sm inline-flex items-center gap-1" disabled={nothing || !canGstr1 || !!busy} title={nothing ? nothingTitle : !canGstr1 ? "GSTR-1 files are made for a current registration only" : undefined}
          onClick={() => run("cdnr", q("cdnr", true), `gstr1-cdnr-${period}.csv`)}><Download size={14} aria-hidden />{busy === "cdnr" ? "Preparing…" : "Credit notes CDNR CSV"}</button>
        <button type="button" className="btn btn-light btn-sm inline-flex items-center gap-1" disabled={nothing || !!busy} title={nothing ? nothingTitle : undefined}
          onClick={() => run("register", registerQ, `sales-register-${period}.csv`)}><Download size={14} aria-hidden />{busy === "register" ? "Preparing…" : "Sales register CSV"}</button>
      </div>
      {nothing && <p className="text-sm text-ink-3 mb-3">{nothingTitle}</p>}
      {reg && totals && (
        <div className="overflow-x-auto mb-4">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left">
              <tr className="border-b-2 border-border"><th className="p-2">Month</th><th className="p-2 text-right">Invoices</th><th className="p-2 text-right">Taxable</th><th className="p-2 text-right">CGST</th><th className="p-2 text-right">SGST</th><th className="p-2 text-right">IGST</th><th className="p-2 text-right">Credit notes (taxable / tax)</th><th className="p-2 text-right">Net taxable</th><th className="p-2 text-right">Net tax</th></tr>
            </thead>
            <tbody>
              {reg.months.map((m) => (
                <tr key={m.month} className={`border-b border-rule ${inPeriod(m.month) ? "bg-muted/60" : ""}`}>
                  <td className="p-2">{monthLabel(m.month)}</td><td className="p-2 text-right">{fmtInt(m.invoices.count)}</td>
                  <td className="p-2 text-right"><Money paise={m.invoices.taxablePaise} /></td><td className="p-2 text-right"><Money paise={m.invoices.cgstPaise} /></td><td className="p-2 text-right"><Money paise={m.invoices.sgstPaise} /></td><td className="p-2 text-right"><Money paise={m.invoices.igstPaise} /></td>
                  <td className="p-2 text-right">{m.creditNotes.count ? <><Money paise={neg(m.creditNotes.taxablePaise)} /> / <Money paise={neg(tax(m.creditNotes))} /></> : <span className="text-ink-4">—</span>}</td>
                  <td className="p-2 text-right"><Money paise={m.net.taxablePaise} /></td><td className="p-2 text-right"><Money paise={tax(m.net)} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="font-bold"><td className="p-2">Total</td><td className="p-2" /><td className="p-2 text-right"><Money paise={totals.inv.taxablePaise} /></td><td className="p-2 text-right"><Money paise={totals.inv.cgstPaise} /></td><td className="p-2 text-right"><Money paise={totals.inv.sgstPaise} /></td><td className="p-2 text-right"><Money paise={totals.inv.igstPaise} /></td><td className="p-2 text-right">{totals.cn.totalPaise ? <><Money paise={neg(totals.cn.taxablePaise)} /> / <Money paise={neg(tax(totals.cn))} /></> : <span className="text-ink-4">—</span>}</td><td className="p-2 text-right"><Money paise={totals.net.taxablePaise} /></td><td className="p-2 text-right"><Money paise={tax(totals.net)} /></td></tr></tfoot>
          </table>
        </div>
      )}
      <details className="mb-3">
        <summary className="cursor-pointer text-sm font-bold">GSTR-3B 3.1 for {periodLabel}</summary>
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-sm min-w-[520px]">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2">Row</th><th className="p-2 text-right">Taxable</th><th className="p-2 text-right">IGST</th><th className="p-2 text-right">CGST</th><th className="p-2 text-right">SGST</th></tr></thead>
            <tbody>
              <tr className="border-b border-rule"><td className="p-2">3.1(a) Outward taxable supplies</td><td className="p-2 text-right"><Money paise={a.taxablePaise} /></td><td className="p-2 text-right"><Money paise={a.igstPaise} /></td><td className="p-2 text-right"><Money paise={a.cgstPaise} /></td><td className="p-2 text-right"><Money paise={a.sgstPaise} /></td></tr>
              <tr><td className="p-2">3.1(b) Zero rated (export, SEZ)</td><td className="p-2 text-right"><Money paise={b.taxablePaise} /></td><td className="p-2 text-right"><Money paise={b.igstPaise} /></td><td className="p-2 text-right text-ink-4">—</td><td className="p-2 text-right text-ink-4">—</td></tr>
            </tbody>
          </table>
        </div>
      </details>
      <div className="mb-3">
        <h3 className="text-sm font-bold mb-1">Documents issued · {periodLabel}</h3>
        {docs.length === 0 ? <p className="text-sm text-ink-3">None.</p> : (
          <ul className="text-sm space-y-1">
            {docs.map((x) => <li key={`${x.month}-${x.doc}-${x.series}`} className="break-all">{monthLabel(x.month)} · {x.doc === "invoice" ? "Invoices" : "Credit notes"} <span className="font-mono">{x.first}</span> – <span className="font-mono">{x.last}</span> · {fmtInt(x.total)} issued · {fmtInt(x.cancelled)} cancelled</li>)}
          </ul>
        )}
      </div>
      {d.gst.warnings.map((w) => (
        <div key={w.code} className="card border-attention p-3 text-sm mb-2">
          <p>{w.message}</p>
          {w.documents.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-x-3">
              {w.documents.map((doc) => doc.kind === "invoice"
                ? <Link key={doc.id} href={`/invoices/view?id=${doc.id}`} className="font-mono text-xs hover:text-indigo-light">{doc.number}</Link>
                : <span key={doc.id} className="font-mono text-xs">{doc.number}</span>)}
            </p>
          )}
        </div>
      ))}
      {d.gst.warnings.some((w) => w.code === "CREDIT_NOTE_LATE") && <p className="text-xs text-ink-4 mt-3">GSTR-3B 3.1 and the CDNR file leave out credit notes dated after the 30 November deadline (CGST s.34(2)); the table above and the sales register still show them.</p>}
      <p className="text-xs text-ink-4 mt-3">Working papers from invoices issued in this portal. Have your CA check the first file against the GST offline tool. SEZ supplies with IGST paid look like regular B2B here.</p>
    </section>
  );
}

// ─── Receivables, TDS, collections ─────────────────────────────────────────────────────────────

function Receivables({ d }: { d: AccountsView }) {
  const r = d.receivables;
  return (
    <section className="mb-6 min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-3 mb-3"><h2 className="font-bold">Receivables today · all years</h2><span className="text-xs text-ink-3">Today&apos;s position, not at 31 March</span></div>
      {r.invoices === 0 ? <Empty title="Nothing outstanding — every issued tax invoice is settled." /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
            {r.buckets.map((b) => (
              <Link key={b.key} href="/invoices" className="min-w-0"><Stat label={b.label} value={W(b.paise)} sub={`${fmtInt(b.invoices)} invoice${b.invoices === 1 ? "" : "s"}`} tone={b.key === "d90_plus" && b.paise > 0 ? "danger" : undefined} /></Link>
            ))}
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2">Client</th><th className="p-2 text-right">Outstanding</th><th className="p-2 text-right">Overdue</th><th className="p-2 text-right">Invoices</th><th className="p-2">Oldest due</th></tr></thead>
              <tbody>{r.topDebtors.map((t) => <tr key={t.clientId} className="border-b border-rule"><td className="p-2 max-w-[240px] truncate"><Link href={`/clients/view?id=${t.clientId}`} className="hover:text-indigo-light">{t.name}</Link></td><td className="p-2 text-right"><Money paise={t.balancePaise} /></td><td className="p-2 text-right"><Money paise={t.overduePaise} className={t.overduePaise ? "text-attention" : "text-ink-3"} /></td><td className="p-2 text-right">{fmtInt(t.invoices)}</td><td className="p-2">{fmtDate(t.oldestDue)}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="text-xs text-ink-3 mt-2">{W(r.fromThisFyPaise)} of this is from invoices issued in {d.fy.label}.</p>
        </>
      )}
    </section>
  );
}

function Tds({ d, setToast }: { d: AccountsView; setToast: (t: { message: string; tone: "ok" | "err" }) => void }) {
  const { busy, run } = useDownload(setToast);
  return (
    <section className="mb-6 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="font-bold">TDS deducted by clients · {d.fy.label}</h2>
        <button type="button" className="btn btn-light btn-sm inline-flex items-center gap-1" disabled={!!busy || d.tds.totalPaise === 0} onClick={() => run("tds", `/sales/accounts/tds.csv?company=${d.company}&fy=${d.fy.label}`, `tds-by-client-${d.fy.label}.csv`)}>
          <Download size={14} aria-hidden />{busy ? "Preparing…" : "TDS by client CSV"}
        </button>
      </div>
      {d.tds.totalPaise === 0 ? <Empty title={`No TDS recorded on receipts in ${d.fy.label}.`} body="TDS is entered on Record payment when a client pays less than the invoice." /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">{d.tds.byQuarter.map((p, i) => <Stat key={i} label={`Q${i + 1} ${["Apr–Jun", "Jul–Sep", "Oct–Dec", "Jan–Mar"][i]}`} value={W(p)} />)}</div>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2">Client</th><th className="p-2">PAN</th><th className="p-2">GSTIN</th><th className="p-2 text-right">Q1</th><th className="p-2 text-right">Q2</th><th className="p-2 text-right">Q3</th><th className="p-2 text-right">Q4</th><th className="p-2 text-right">Total</th><th className="p-2">Rates seen</th></tr></thead>
              <tbody>{d.tds.clients.map((c) => (
                <tr key={c.clientId} className="border-b border-rule align-top">
                  <td className="p-2 max-w-[200px] truncate"><Link href={`/clients/view?id=${c.clientId}`} className="hover:text-indigo-light">{c.name}</Link></td>
                  <td className="p-2 font-mono text-xs">{c.pan ?? "—"}{c.panSource === "gstin" && <span className="block text-ink-4 font-sans">from GSTIN</span>}</td>
                  <td className="p-2 font-mono text-xs break-all">{c.gstin ?? "—"}</td>
                  {c.quarters.map((q, i) => <td key={i} className="p-2 text-right"><Money paise={q} className={q ? "" : "text-ink-4"} /></td>)}
                  <td className="p-2 text-right font-bold"><Money paise={c.totalPaise} /></td>
                  <td className="p-2"><div className="flex flex-wrap gap-1">{c.rates.map((r) => <span key={r.label} title={r.kind === "on_total" ? "CBDT circular 23/2017: TDS is on the value excluding GST" : undefined} className={`text-[11px] px-1.5 py-0.5 border ${r.kind === "on_total" ? "border-attention text-attention" : "border-border text-ink-3"}`}>{r.label}</span>)}</div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="text-xs text-ink-3 mt-2">Match against Form 26AS / AIS Part I by the client&apos;s name and PAN. Quarters here use our receipt date; a client may have deducted in the quarter it booked our invoice.</p>
        </>
      )}
    </section>
  );
}

function Collections({ d }: { d: AccountsView }) {
  return (
    <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <div className="card p-4 min-w-0">
        <h2 className="font-bold mb-3">Collections by mode · {d.fy.label}</h2>
        {d.collected.byMode.length === 0 ? <p className="text-sm text-ink-3">No receipts in {d.fy.label}.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[420px]">
              <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2">Mode</th><th className="p-2 text-right">Receipts</th><th className="p-2 text-right">Received</th><th className="p-2 text-right">Refunded</th><th className="p-2 text-right">Net</th></tr></thead>
              <tbody>{d.collected.byMode.map((m) => <tr key={m.mode} className="border-b border-rule"><td className="p-2">{titleCase(m.mode)}</td><td className="p-2 text-right">{fmtInt(m.receipts)}</td><td className="p-2 text-right"><Money paise={m.receivedPaise} /></td><td className="p-2 text-right"><Money paise={m.refundedPaise} /></td><td className="p-2 text-right"><Money paise={m.netPaise} /></td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card p-4 min-w-0">
        <h2 className="font-bold mb-3">Unapplied money · today</h2>
        {d.unapplied.top.length === 0 ? <p className="text-sm text-ink-3">No unapplied money — every receipt is on an invoice or refunded.</p> : (
          <ul className="text-sm divide-y divide-rule">{d.unapplied.top.map((u) => <li key={u.clientId} className="py-2 flex justify-between gap-3 min-w-0"><Link href={`/clients/view?id=${u.clientId}`} className="truncate min-w-0 hover:text-indigo-light">{u.name}</Link><Money paise={u.paise} /></li>)}</ul>
        )}
      </div>
    </section>
  );
}

// ─── Filed vs the portal ───────────────────────────────────────────────────────────────────────

function FiledTable({ d, admin, filedHref, setToast }: { d: AccountsView; admin: boolean; filedHref: (fy: string) => string; setToast: (t: { message: string; tone: "ok" | "err" }) => void }) {
  const router = useRouter();
  const listed = new Set(d.years.map((y) => y.fy));
  const oldest = d.years[d.years.length - 1]?.fy;
  const earlier = useMemo(() => (oldest ? fyLabelsBetween(FILED_MIN_FY, oldest).filter((fy) => !listed.has(fy)) : []), [oldest]); // eslint-disable-line react-hooks/exhaustive-deps
  const anyFiled = d.years.some((y) => y.filed);
  const pdfCell = (f: FiledYearView | null, fy: string) => {
    if (!f?.files.length) return <span className="text-ink-4">—</span>;
    return (
      <span className="whitespace-nowrap">
        <button type="button" className="hover:text-indigo-light underline" onClick={() => viewFiledPdf(f.files[0].id, f.files[0].fileName, (m) => setToast({ message: m, tone: "err" }))}>View</button>
        {f.files.length > 1 && <Link href={filedHref(fy)} className="text-ink-3 ml-1 hover:text-white">+{f.files.length - 1}</Link>}
      </span>
    );
  };
  return (
    <section className="mb-6 min-w-0">
      <h2 className="font-bold mb-3">Filed accounts vs the portal</h2>
      {!anyFiled && <p className="text-sm text-ink-3 mb-3">{admin ? "No filed accounts yet. Add the figures from the signed balance sheet and P&L for a closed year." : "No filed accounts yet. An admin adds them from the signed statements."}</p>}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2">Year</th><th className="p-2 text-right">Revenue from operations (filed)</th><th className="p-2 text-right">Invoiced in portal (excl. GST, net)</th><th className="p-2">Difference</th><th className="p-2 text-right">Profit after tax</th><th className="p-2 text-right">Net worth</th><th className="p-2">Signed PDF</th>{admin && <th className="p-2" />}</tr></thead>
          <tbody>{d.years.map((y) => {
            const g = gapLabel(y.gapPaise, y.filed?.figures.revenuePaise ?? null);
            return (
              <tr key={y.fy} className={`border-b border-rule ${y.fy === d.fy.label ? "bg-muted/60" : ""}`}>
                <td className="p-2 whitespace-nowrap">{y.fy} {!y.closed ? <StatusPill status="running" /> : y.filed ? <StatusPill status="filed" /> : <StatusPill status="not_filed" label="not added" />}</td>
                <td className="p-2 text-right"><Money paise={y.filed?.figures.revenuePaise ?? null} /></td>
                <td className="p-2 text-right"><Money paise={y.liveNetTaxablePaise} /> <span className="text-xs text-ink-4">· {fmtInt(y.liveInvoices)}</span></td>
                <td className={`p-2 text-xs ${g.tone}`}>{!y.closed ? "Filed: not yet" : g.text}</td>
                <td className="p-2 text-right"><Money paise={y.filed?.figures.profitAfterTaxPaise ?? null} /></td>
                <td className="p-2 text-right"><Money paise={y.filed?.figures.equityPaise ?? null} /></td>
                <td className="p-2">{pdfCell(y.filed, y.fy)}</td>
                {admin && <td className="p-2 text-right">{y.closed && <Link href={filedHref(y.fy)} className="btn btn-ghost btn-sm">{y.filed ? "Edit" : "Add"}</Link>}</td>}
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      {admin && earlier.length > 0 && (
        <select className="input w-auto mt-3" aria-label="Add an earlier year" value="" onChange={(e) => e.target.value && router.push(filedHref(e.target.value))}>
          <option value="">Add an earlier year</option>
          {earlier.map((fy) => <option key={fy} value={fy}>{fy}</option>)}
        </select>
      )}
      <p className="text-xs text-ink-4 mt-2">Filed figures are typed from the signed statements. The difference is revenue the portal never invoiced — usually bills from the old billing app (Swipe).</p>
    </section>
  );
}

export default function AccountsRoute() {
  return (
    <Suspense fallback={<Loading />}>
      <AccountsPage />
    </Suspense>
  );
}
