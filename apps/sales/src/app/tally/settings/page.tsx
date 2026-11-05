"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { useTallySettings } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { refreshTally } from "@/lib/tally";
import { Field, LoadError, Loading, PageHead, Toast } from "@/components/sales-ui";
import type { TallySettings, TallySettingsView, TallyTestResult } from "@/lib/sales-types";

// Tally settings for the current billing company (spec-tally §5.4). Admins edit; everyone else sees
// the form disabled. Stored under its own system_settings key — never inside the seller profile.

const CHECKLIST = [
  "Release: Help → About → note the release; 3.0 or later = \"TallyPrime 3.0 or later\".",
  "GSTINs: one Tally company per billing company with both of Digital Sukoon's GSTINs as registrations (TallyPrime 3+). Note each registration's name.",
  "Voucher types Sales, Credit Note, Receipt, Payment (or your own names, entered here): Method of voucher numbering Manual, and Prevent duplicates Yes.",
  "Client ledgers under Sundry Debtors with Maintain balances bill-by-bill = Yes.",
  "Sales ledger(s) under Sales Accounts with GST Applicable, Taxable, Services, SAC 998365, 18% — one ledger per SAC and rate the portal uses.",
  "Output CGST / SGST / IGST under Duties & Taxes, type of duty GST, tax type Central / State / Integrated.",
  "Round Off under Indirect Expenses with GST applicability Not Applicable.",
  "TDS Receivable under Current Assets (use {fy} in the name for one per year).",
  "Bank ledger(s) as named here (and Cash, and Razorpay if used).",
  "Never generate e-invoices (IRN) from Tally for vouchers imported from the portal; the portal is the only IRN generator.",
  "Push only: F1 Help → Settings → Connectivity → TallyPrime acts as Server, port 9000; install Tailscale; never port-forward 9000 to the internet.",
  "Before the first import, back up the company and use a TEST copy.",
];

const blankToNull = (s: string) => (s.trim() ? s : null);

export default function TallySettingsPage() {
  const { company, info } = useCompany();
  const { user } = useAuth();
  const admin = isAdminUser(user);
  const { data, error, isLoading, mutate } = useTallySettings();
  const [form, setForm] = useState<TallySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ ok?: TallyTestResult; err?: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  useEffect(() => { if (data && data.company === company) setForm(structuredClone(data.settings)); }, [data, company]);
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !data || data.company !== company || !form) return <Loading />;

  const set = <K extends keyof TallySettings>(k: K, v: TallySettings[K]) => setForm({ ...form, [k]: v });
  const setLedger = (k: keyof TallySettings["ledgers"], v: string | null) => setForm({ ...form, ledgers: { ...form.ledgers, [k]: v } });
  const setVt = (k: keyof TallySettings["voucherTypes"], v: string) => setForm({ ...form, voucherTypes: { ...form.voucherTypes, [k]: v } });
  const reg = (gstin: string) => form.registrations.find((r) => r.gstin === gstin) ?? { gstin, tallyCompany: "", registrationName: null, salesVoucherType: null, creditNoteVoucherType: null };
  const setReg = (gstin: string, patch: Partial<TallySettings["registrations"][number]>) =>
    setForm({ ...form, registrations: data.registrations.map((x) => (x.gstin === gstin ? { ...reg(gstin), ...patch } : reg(x.gstin))) });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const wasTicked = form!.ledgersConfirmed;
      const r = (await apiFetch<TallySettingsView>(`/sales/tally/settings?company=${company}`, { method: "PUT", body: JSON.stringify({ ...form, registrations: form!.registrations.filter((x) => x.tallyCompany.trim()) }) })).data;
      await mutate(r, { revalidate: false });
      await refreshTally();
      const unticked = wasTicked && !r.settings.ledgersConfirmed;
      setToast({ tone: "ok", message: `${r.missing.length ? `Saved. Still needed before the first export: ${r.missing.join("; ")}.` : `Tally settings saved for ${info.short}.`}${unticked ? " Names changed — tick 'These names match our Tally' again after checking." : ""}` });
    } catch (err) { setToast({ message: errorSentence(err), tone: "err" }); } finally { setSaving(false); }
  }
  async function runTest() {
    setTest(null);
    try { setTest({ ok: (await apiFetch<TallyTestResult>(`/sales/tally/test?company=${company}`, { method: "POST" })).data }); } catch (err) { setTest({ err: errorSentence(err) }); }
  }

  const text = (v: string | null, on: (s: string) => void, placeholder?: string) => <input className="input w-full" value={v ?? ""} placeholder={placeholder} onChange={(e) => on(e.target.value)} />;
  return (
    <>
      <PageHead kicker={<><Link href="/tally" className="hover:text-white">Tally</Link> · {info.short}</> as unknown as string} title="Tally settings" />
      {!admin && <div className="card p-3 text-sm mb-4">Only an admin can change where the company&apos;s books are posted in Tally.</div>}
      {!data.saved && <div className="card border-attention p-3 text-sm mb-4">These are suggestions from your seller profile — check them with your accountant and save.</div>}
      <form onSubmit={save} className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <fieldset disabled={!admin} className="grid grid-cols-[minmax(0,1fr)] gap-4 min-w-0">
          <section className="card p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <h2 className="font-bold sm:col-span-2">Tally</h2>
            <Field label="Tally version"><select className="input w-full" value={form.release} onChange={(e) => set("release", e.target.value as TallySettings["release"])}><option value="prime3">TallyPrime 3.0 or later</option><option value="legacy">Tally ERP 9 or TallyPrime 1–2</option></select></Field>
            <Field label="Tally already has everything before" hint="Tally already has your books from 2023 — set this to the first date Tally does NOT have. Documents dated before it are never sent.">
              <input type="date" className="input w-full" required value={form.booksFrom ?? ""} placeholder="2026-11-01" onChange={(e) => set("booksFrom", e.target.value || null)} />
            </Field>
            <Field label="GSTR-1 filing"><select className="input w-full" value={form.gstr1Filing} onChange={(e) => set("gstr1Filing", e.target.value as "monthly" | "quarterly")}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option></select></Field>
          </section>

          <section className="card p-4 grid grid-cols-1 gap-4">
            <h2 className="font-bold">GST registrations</h2>
            {data.registrations.map((r) => { const x = reg(r.gstin); return (
              <div key={r.gstin} className="card-inset p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <p className="sm:col-span-2 text-sm font-bold break-all">{r.label} · {r.gstin}</p>
                <Field label="Company name in Tally" hint="Exactly as Tally shows it (Alt+F3)">{text(x.tallyCompany, (v) => setReg(r.gstin, { tallyCompany: v }))}</Field>
                {form.release === "prime3" && <Field label="Registration name in Tally">{text(x.registrationName, (v) => setReg(r.gstin, { registrationName: blankToNull(v) }))}</Field>}
                <details className="sm:col-span-2"><summary className="cursor-pointer text-sm text-ink-3">Own voucher types</summary>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                    <Field label="Sales voucher type" hint="Blank = the company default">{text(x.salesVoucherType, (v) => setReg(r.gstin, { salesVoucherType: blankToNull(v) }))}</Field>
                    <Field label="Credit note voucher type" hint="Blank = the company default">{text(x.creditNoteVoucherType, (v) => setReg(r.gstin, { creditNoteVoucherType: blankToNull(v) }))}</Field>
                  </div></details>
              </div>); })}
          </section>

          <section className="card p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <h2 className="font-bold sm:col-span-2">Ledgers</h2>
            <Field label="Group for client ledgers">{text(form.partyGroup, (v) => set("partyGroup", v))}</Field>
            <div className="sm:col-span-2 grid grid-cols-[minmax(0,1fr)] gap-2">
              <p className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Sales ledgers <span className="normal-case tracking-normal text-ink-4">— each invoice goes to the ledger with its SAC and rate</span></p>
              {form.salesLedgers.map((l, i) => (
                <div key={i} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_120px_100px_auto] gap-2 items-end">
                  <input className="input w-full" aria-label="Ledger name" value={l.name} onChange={(e) => set("salesLedgers", form.salesLedgers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <input className="input w-full" aria-label="SAC" value={l.sac} onChange={(e) => set("salesLedgers", form.salesLedgers.map((x, j) => (j === i ? { ...x, sac: e.target.value } : x)))} />
                  <input className="input w-full" aria-label="GST %" inputMode="decimal" value={l.gstRateBp / 100} onChange={(e) => set("salesLedgers", form.salesLedgers.map((x, j) => (j === i ? { ...x, gstRateBp: Math.round(Number(e.target.value || 0) * 100) } : x)))} />
                  <button type="button" className="btn btn-ghost btn-sm" disabled={form.salesLedgers.length === 1} onClick={() => set("salesLedgers", form.salesLedgers.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
              <div><button type="button" className="btn btn-ghost btn-sm" onClick={() => set("salesLedgers", [...form.salesLedgers, { name: "", sac: "998365", gstRateBp: 1800 }])}>Add sales ledger</button></div>
            </div>
            <Field label="Output CGST">{text(form.ledgers.outputCgst, (v) => setLedger("outputCgst", v))}</Field>
            <Field label="Output SGST">{text(form.ledgers.outputSgst, (v) => setLedger("outputSgst", v))}</Field>
            <Field label="Output IGST">{text(form.ledgers.outputIgst, (v) => setLedger("outputIgst", v))}</Field>
            <Field label="Round off">{text(form.ledgers.roundOff, (v) => setLedger("roundOff", v))}</Field>
            <Field label="TDS deducted by clients" hint="Add {fy} for one ledger per year, e.g. TDS Receivable {fy}">{text(form.ledgers.tdsReceivable, (v) => setLedger("tdsReceivable", v))}</Field>
            <Field label="Bank">{text(form.ledgers.bank, (v) => setLedger("bank", blankToNull(v)), "IDFC First Bank A/c 8788")}</Field>
            <Field label="Cash">{text(form.ledgers.cash, (v) => setLedger("cash", v))}</Field>
            <Field label="Razorpay" hint="Blank = such receipts are held back with a message">{text(form.ledgers.gateway, (v) => setLedger("gateway", blankToNull(v)))}</Field>
            <Field label="Other receipts" hint="Blank = such receipts are held back with a message">{text(form.ledgers.other, (v) => setLedger("other", blankToNull(v)))}</Field>
            <Field label="Export / SEZ sales" hint="For 'No GST' (export / SEZ) invoices. They stay held back and listed on the export until this voucher has been checked against your accountant's Tally.">{text(form.ledgers.zeroRatedSales, (v) => setLedger("zeroRatedSales", blankToNull(v)))}</Field>
            <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" className="mt-1" checked={form.createAccountLedgers} onChange={(e) => set("createAccountLedgers", e.target.checked)} /><span>Also create these ledgers in Tally <span className="block text-xs text-ink-4">Only for a new Tally company — leave off if your accountant already has them.</span></span></label>
            <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" className="mt-1" checked={form.bankAllocations} onChange={(e) => set("bankAllocations", e.target.checked)} /><span>Bank reconciliation details on receipts</span></label>
          </section>

          <section className="card p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <h2 className="font-bold sm:col-span-2">Voucher types</h2>
            <Field label="Sales">{text(form.voucherTypes.sales, (v) => setVt("sales", v))}</Field>
            <Field label="Credit Note">{text(form.voucherTypes.creditNote, (v) => setVt("creditNote", v))}</Field>
            <Field label="Receipt">{text(form.voucherTypes.receipt, (v) => setVt("receipt", v))}</Field>
            <Field label="Payment">{text(form.voucherTypes.payment, (v) => setVt("payment", v))}</Field>
          </section>

          <section className="card p-4">
            <h2 className="font-bold mb-2">Check</h2>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={form.ledgersConfirmed} onChange={(e) => set("ledgersConfirmed", e.target.checked)} /><span>These names match our Tally <span className="block text-xs text-ink-4">Tick after checking with your accountant or Test connection. Changing any name un-ticks it.</span></span></label>
          </section>

          <section className="card p-4 grid grid-cols-[minmax(0,1fr)] gap-3">
            <h2 className="font-bold">Send straight to Tally</h2>
            {!data.pushEnabled && <p className="text-sm text-ink-3">Switched off on the server — files only for now.</p>}
            <Field label="Tally's address" hint="The computer running Tally, reached over Tailscale. In Tally: F1 Help → Settings → Connectivity → TallyPrime acts as Server, port 9000. Never open port 9000 to the internet.">
              {text(form.pushUrl, (v) => set("pushUrl", blankToNull(v)), "http://100.101.102.103:9000")}
            </Field>
            {data.pushEnabled && admin && (
              <div>
                <button type="button" className="btn btn-light btn-sm" onClick={runTest}>Test connection</button>
                {test?.err && <p className="text-sm text-danger mt-2 break-words">{test.err}</p>}
                {test?.ok && (
                  <div className="text-sm mt-2 break-words">
                    <p>Tally answered in {test.ok.latencyMs} ms · open: {test.ok.openCompanies.join(", ") || "none"}{test.ok.missingCompanies.length ? ` · not open: ${test.ok.missingCompanies.join(", ")}` : " ✓"}</p>
                    <ul className="mt-1">{test.ok.ledgers.map((l) => <li key={l.role + l.name}>{l.role}: {l.name} {l.found ? "✓" : <span className="text-danger">not in Tally</span>}</li>)}</ul>
                  </div>
                )}
              </div>
            )}
          </section>
        </fieldset>
        {admin && <div><button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : "Save Tally settings"}</button></div>}
      </form>

      <section className="card p-4 mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2"><h2 className="font-bold">Accountant&apos;s checklist</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={async () => { try { await navigator.clipboard.writeText(CHECKLIST.map((c, i) => `${i + 1}. ${c}`).join("\n")); setToast({ message: "Copied.", tone: "ok" }); } catch { setToast({ message: "Couldn't copy — select the text instead.", tone: "err" }); } }}>Copy for your accountant</button></div>
        <ol className="list-decimal ml-5 grid gap-1 text-sm text-ink-3">{CHECKLIST.map((c) => <li key={c} className="break-words">{c}</li>)}</ol>
      </section>
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}
