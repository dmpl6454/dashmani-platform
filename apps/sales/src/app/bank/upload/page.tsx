"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useBankAccounts } from "@/lib/hooks";
import { useCompany } from "@/lib/company";
import { apiUpload } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, fmtInr } from "@/lib/format";
import { Field, Loading, Money, PageHead, Toast } from "@/components/sales-ui";
import { MappingEditor } from "@/components/bank/mapping-editor";
import { refreshAfterBankAction } from "@/components/bank/line-card";
import type { BankMapping, ImportResult, StatementPreview } from "@/lib/sales-types";

// /bank/upload — choose the account and the file; the statement is read at once (nothing is
// stored), the preview says what was understood, and Import stores only the new lines.

export default function UploadPage() {
  const router = useRouter();
  const { company, info } = useCompany();
  const { data: accounts, isLoading } = useBankAccounts();
  const active = (accounts ?? []).filter((a) => a.status === "active");
  const [accountId, setAccountId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [mapping, setMapping] = useState<BankMapping | null>(null);
  const [editing, setEditing] = useState(false);
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState<null | "reading" | "importing">(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => { if (!accountId && active.length) setAccountId(active[0].id); }, [accountId, active]);

  async function read(f: File, m: BankMapping | null) {
    setBusy("reading"); setErr(null); setAccept(false);
    const form = new FormData();
    form.append("bankAccountId", accountId);
    if (m) form.append("mapping", JSON.stringify(m));
    form.append("file", f);
    try {
      const r = await apiUpload<StatementPreview>(`/sales/bank/statements/preview?company=${company}`, form);
      setPreview(r.data); setMapping(r.data.mapping); setEditing(r.data.needs.length > 0);
    } catch (e) { setPreview(null); setErr(errorSentence(e)); } finally { setBusy(null); }
  }
  async function doImport() {
    if (!file || !preview) return;
    setBusy("importing"); setErr(null);
    const form = new FormData();
    form.append("bankAccountId", accountId);
    form.append("mapping", JSON.stringify(mapping));
    form.append("expectedSha256", preview.fileSha256);
    form.append("acceptWarnings", accept ? "true" : "false");
    form.append("file", file);
    try {
      const r = await apiUpload<ImportResult>(`/sales/bank/statements?company=${company}`, form);
      await refreshAfterBankAction();
      const d = r.data;
      setToast(`Imported ${d.newLines} lines (${d.credits} credits) · ${d.autoLinked} linked to receipts already recorded · ${d.suggested} to review.`);
      router.replace("/bank");
    } catch (e) { setErr(errorSentence(e)); } finally { setBusy(null); }
  }

  if (isLoading) return <Loading />;
  const p = preview;
  const blocked = !p || !p.canImport || (p.warnings.length > 0 && !accept);
  return (
    <>
      <PageHead kicker={<Link href="/bank" className="hover:text-white">Bank</Link> as unknown as string} title="Upload a bank statement" />
      <div className="card border-attention p-3 text-sm mb-4">Uploading for {info.name} — switch company at the top if this is {company === "dspl" ? "Dashmani Media" : "Digital Sukoon"}&apos;s statement.</div>
      {!active.length ? <p className="text-sm text-ink-3">No active bank account for {info.short} — an admin adds one in Settings → Bank accounts.</p> : (
        <section className="card p-4 grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <Field label="Bank account">
            <select className="input" value={accountId} onChange={(e) => { setAccountId(e.target.value); if (file) void read(file, null); }}>
              {active.map((a) => <option key={a.id} value={a.id}>{a.label} ••{a.last4}</option>)}
            </select>
          </Field>
          <Field label="Statement file" hint="Excel or CSV exactly as downloaded from net banking, up to 5 MB. PDF statements cannot be read.">
            <input type="file" accept=".csv,.tsv,.txt,.xls,.xlsx,.htm,.html" className="input" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setPreview(null); if (f) void read(f, null); }} />
          </Field>
        </section>
      )}
      {busy === "reading" && <Loading label="Reading the statement…" />}
      {err && <div className="card border-danger p-3 text-sm mb-4" role="alert">{err}</div>}

      {p && busy !== "reading" && (
        <section className="card p-4 grid grid-cols-1 gap-3 mb-4 text-sm min-w-0">
          <p>{p.mappingSource === "last_used" ? "Columns remembered from your last upload" : p.presetLabel ? <>Read as <b>{p.presetLabel} layout</b></> : "Read by the column headings"}{p.headerRow ? ` · headings on row ${p.headerRow}` : ""}{p.mapping ? ` · dates ${p.mapping.dateOrder === "mdy" ? "month/day/year" : p.mapping.dateOrder === "ymd" ? "year-month-day" : "day/month/year"}` : ""}</p>
          <p className={p.accountCheck.status === "match" ? "text-success" : p.accountCheck.status === "mismatch" ? "text-danger" : "text-ink-3"}>
            {p.accountCheck.status === "match" ? "The account number on the statement matches." : p.accountCheck.status === "mismatch" ? `The statement is for account ${p.accountCheck.found}.` : "The statement does not state its account number."}
          </p>
          <p>{p.counts.rows} transactions · {p.counts.credits} credits <Money paise={p.totals.creditsPaise} /> · {p.counts.debits} withdrawals <Money paise={p.totals.debitsPaise} />{p.counts.skipped ? ` · ${p.counts.skipped} rows skipped` : ""}</p>
          {(p.skipped.length > 0 || p.errors.length > 0) && (
            <details><summary className="cursor-pointer text-ink-3">Skipped and unreadable rows</summary>
              <ul className="text-xs mt-2 grid gap-1">{p.errors.map((e) => <li key={`e${e.rowNo}`} className="text-danger">Row {e.rowNo}: {e.message}</li>)}{p.skipped.map((s) => <li key={`s${s.rowNo}`} className="text-ink-3">Row {s.rowNo}: {s.reason}</li>)}</ul>
            </details>
          )}
          {p.period && <p>Period {fmtDate(p.period.from)} – {fmtDate(p.period.to)}{p.totals.openingPaise != null ? ` · Opening ${fmtInr(p.totals.openingPaise)}` : ""}{p.totals.closingPaise != null ? ` · Closing ${fmtInr(p.totals.closingPaise)}` : ""}</p>}
          <p className={p.balanceCheck.status === "breaks" ? "text-attention" : "text-ink-3"}>{p.balanceCheck.status === "ok" ? "The running balance adds up." : p.balanceCheck.status === "breaks" ? `The running balance breaks at row ${p.balanceCheck.breaks.map((b) => b.rowNo).join(", ")}.` : "No balance column to check."}</p>
          <p>Already imported: {p.counts.alreadyImported} · New: {p.counts.newLines}{p.counts.beforeCutover ? ` · Before matching start: ${p.counts.beforeCutover}` : ""}</p>
          {p.blockers.length > 0 && <div className="card border-danger p-3"><ul className="grid gap-1">{p.blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>}
          {p.warnings.length > 0 && (
            <div className="card border-attention p-3 grid gap-2">
              <ul className="grid gap-1">{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              <label className="flex items-center gap-2"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> I have read these — import anyway</label>
            </div>
          )}
          {p.sample.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead><tr className="text-left text-ink-3"><th className="p-1">Row</th><th className="p-1">Date</th><th className="p-1">Narration</th><th className="p-1 text-right">Withdrawal</th><th className="p-1 text-right">Deposit</th><th className="p-1 text-right">Balance</th></tr></thead>
                <tbody>{p.sample.map((s) => (
                  <tr key={s.rowNo} className={s.alreadyImported ? "line-through text-ink-3" : ""}>
                    <td className="p-1">{s.rowNo}</td><td className="p-1 whitespace-nowrap">{fmtDate(s.txnDate)}</td><td className="p-1 font-mono break-all">{s.narration}</td>
                    <td className="p-1 text-right">{s.debitPaise != null ? fmtInr(s.debitPaise) : ""}</td><td className="p-1 text-right">{s.creditPaise != null ? fmtInr(s.creditPaise) : ""}</td><td className="p-1 text-right">{s.balancePaise != null ? fmtInr(s.balancePaise) : ""}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn" disabled={blocked || busy !== null} title={!p.canImport ? p.blockers[0] : p.warnings.length && !accept ? "Tick “import anyway” first" : undefined} onClick={doImport}>
              {busy === "importing" ? "Importing…" : `Import ${p.counts.newLines} new line${p.counts.newLines === 1 ? "" : "s"}`}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing((x) => !x)}>Columns look wrong?</button>
          </div>
        </section>
      )}
      {p && editing && file && <MappingEditor preview={p} busy={busy === "reading"} onApply={(m) => void read(file, m)} />}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </>
  );
}
