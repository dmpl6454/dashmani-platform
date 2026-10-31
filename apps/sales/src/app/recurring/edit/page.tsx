"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useClients, useRecurring, useSeller } from "@/lib/hooks";
import { companyOfDoc, SALES_COMPANIES, useCompany } from "@/lib/company";
import { errorSentence } from "@/lib/messages";
import { todayIST } from "@/lib/format";
import type { Recurring, RecurringLine, TaxMode } from "@/lib/sales-types";
import { Field, LoadError, Loading, Money, MoneyInput, PageHead, Toast } from "@/components/sales-ui";
import { BilledFromSelect } from "@/components/billed-from";
import { FREQUENCY_LABEL, MODE_LABEL } from "@/components/recurring-table";
import { computeTotals, registrationChoice, taxModeFor } from "@dashmani/shared/src/sales/gst";

// Create or edit a recurring invoice: the same lines as an invoice, plus how often it bills and
// whether each period becomes a draft or is issued and emailed. Totals are recomputed by the API
// on every run; the preview here is for the eyes.

const blank = (): RecurringLine => ({ description: "", sac: null, quantity: 1, unitPricePaise: 0, discountPaise: 0 });

function Editor() {
  const params = useSearchParams();
  const id = params.get("id");
  const router = useRouter();
  const { data: rec, error, isLoading } = useRecurring(id);
  const { data: clients } = useClients();
  const { company: current } = useCompany();
  const companyKey = id ? companyOfDoc(rec) : current;
  const { data: seller } = useSeller(id && !rec ? undefined : companyKey);
  const [form, setForm] = useState({
    clientId: params.get("clientId") ?? "", title: "", kind: "tax_invoice" as "tax_invoice" | "proforma", frequency: "monthly" as Recurring["frequency"],
    dayOfMonth: 1, startDate: todayIST(), endDate: "", mode: "draft" as Recurring["mode"], taxMode: "auto" as "auto" | TaxMode, sellerGstin: "",
    gstRateBp: 1800, discountPaise: 0, dueDays: "", notes: "", lines: [blank()] as RecurringLine[],
  });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  useEffect(() => {
    if (rec) setForm({
      clientId: rec.client.id, title: rec.title, kind: rec.kind, frequency: rec.frequency, dayOfMonth: rec.dayOfMonth, startDate: rec.startDate, endDate: rec.endDate ?? "",
      mode: rec.mode, taxMode: rec.taxMode ?? "auto", sellerGstin: rec.sellerGstin ?? "", gstRateBp: rec.gstRateBp ?? 1800, discountPaise: rec.discountPaise,
      dueDays: rec.dueDays == null ? "" : String(rec.dueDays), notes: rec.notes ?? "", lines: rec.lines.length ? rec.lines.map((l) => ({ ...l })) : [blank()],
    });
  }, [rec]);
  useEffect(() => { if (seller && !rec && !id) setForm((f) => ({ ...f, gstRateBp: seller.profile.defaultGstRateBp })); }, [seller, rec, id]);
  const client = clients?.find((c) => c.id === form.clientId);
  const placeOfSupply = client?.billingProfile?.stateCode ?? null;
  const autoMode = taxModeFor(seller ? registrationChoice(seller.profile, placeOfSupply, form.sellerGstin || null).stateCode : null, placeOfSupply, client?.billingProfile?.country ?? "IN");
  const taxMode: TaxMode = form.taxMode === "auto" ? autoMode : form.taxMode;
  const totals = useMemo(() => computeTotals({ lines: form.lines, discountPaise: form.discountPaise, taxMode, gstRateBp: form.gstRateBp, roundToRupee: seller?.profile.roundToRupee ?? true }), [form.lines, form.discountPaise, taxMode, form.gstRateBp, seller]);
  const setLine = (i: number, patch: Partial<RecurringLine>) => setForm((f) => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  if (error) return <LoadError error={error} />;
  if (id && (isLoading || !rec)) return <Loading />;
  if (rec?.status === "ended") return <div className="card p-6"><p>This recurring invoice has ended and can no longer be changed. <Link href={`/recurring/view?id=${rec.id}`} className="underline">Open it</Link>.</p></div>;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.clientId) { setToast({ message: "Choose a client first.", tone: "err" }); return; }
    if (form.lines.some((l) => !l.description.trim())) { setToast({ message: "Every line needs a description.", tone: "err" }); return; }
    setBusy(true);
    try {
      const body = {
        companyKey, clientId: form.clientId, title: form.title.trim(), kind: form.kind, frequency: form.frequency, dayOfMonth: form.dayOfMonth,
        startDate: form.startDate, endDate: form.endDate || null, mode: form.mode, gstRateBp: form.gstRateBp, discountPaise: form.discountPaise,
        sellerGstin: form.sellerGstin || null, dueDays: form.dueDays === "" ? null : Number(form.dueDays), notes: form.notes || null,
        taxMode: form.taxMode === "auto" ? null : form.taxMode,
        lines: form.lines.map((l) => ({ description: l.description.trim(), sac: l.sac || null, quantity: l.quantity, unitPricePaise: l.unitPricePaise, discountPaise: l.discountPaise })),
      };
      const res = await apiFetch<Recurring>(rec ? `/sales/recurring/${rec.id}` : "/sales/recurring", { method: rec ? "PUT" : "POST", body: JSON.stringify(body) });
      router.replace(`/recurring/view?id=${res.data.id}`);
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
      setBusy(false);
    }
  }

  if (!clients) return <Loading />;
  return (
    <>
      <PageHead kicker={<Link href="/recurring" className="hover:text-white">Recurring</Link> as unknown as string} title={rec ? "Edit recurring invoice" : "New recurring invoice"} />
      <form onSubmit={save} className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <section className="card p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Field label="Billed by" className="sm:col-span-2 lg:col-span-4" hint={rec ? "A recurring invoice stays with its company." : "Switch company at the top of the page before saving."}>
            <p className="font-bold py-2">{SALES_COMPANIES[companyKey].name}</p>
          </Field>
          <Field label="Client" className="sm:col-span-2">
            <select className="input" required value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}><option value="">Choose a client…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.companyName}{c.billingProfile?.gstin ? ` · ${c.billingProfile.gstin}` : ""}</option>)}</select>
          </Field>
          <Field label="Title" className="sm:col-span-2" hint="Printed in each invoice's notes with the period, e.g. “Monthly retainer — November 2026”."><input className="input" required minLength={2} maxLength={200} placeholder="Monthly retainer" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Every"><select className="input" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as Recurring["frequency"] })}>{Object.entries(FREQUENCY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="On day" hint="1–28, so every month has it."><input className="input" type="number" min={1} max={28} value={form.dayOfMonth} onChange={(e) => setForm({ ...form, dayOfMonth: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })} /></Field>
          <Field label="Starts"><input className="input" type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
          <Field label="Ends (optional)"><input className="input" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></Field>
          <Field label="Each period" className="sm:col-span-2" hint={form.mode === "issue" ? "Issued, numbered and emailed to the client. If it cannot be issued it is left as a draft and the error is shown here." : "Created as a draft for someone to review and issue."}>
            <select className="input" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as Recurring["mode"] })}>{Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </Field>
          <Field label="Kind"><select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}><option value="tax_invoice">Tax invoice</option><option value="proforma">Proforma</option></select></Field>
          <Field label="Due after (days)" hint={`Blank = ${seller?.profile.defaultDueDays ?? 15} days.`}><input className="input" type="number" min={0} max={365} value={form.dueDays} onChange={(e) => setForm({ ...form, dueDays: e.target.value })} /></Field>
          <Field label="GST rate (%)"><input className="input" type="number" min={0} max={40} step={0.01} value={form.gstRateBp / 100} onChange={(e) => setForm({ ...form, gstRateBp: Math.round(Number(e.target.value) * 100) })} /></Field>
          <Field label="GST" hint={form.taxMode === "auto" ? "Worked out on each run from the client's state." : undefined}>
            <select className="input" value={form.taxMode} onChange={(e) => setForm({ ...form, taxMode: e.target.value as typeof form.taxMode })}><option value="auto">Auto ({autoMode === "intra" ? "CGST + SGST" : autoMode === "inter" ? "IGST" : "no GST"})</option><option value="intra">CGST + SGST</option><option value="inter">IGST</option><option value="none">No GST (export / SEZ)</option></select>
          </Field>
          <BilledFromSelect className="sm:col-span-2" profile={seller?.profile} placeOfSupplyCode={placeOfSupply} value={form.sellerGstin} onChange={(g) => setForm({ ...form, sellerGstin: g, taxMode: "auto" })} />
        </section>
        <section className="card p-4">
          <div className="flex items-center justify-between mb-3"><h2 className="font-bold">Lines (each period)</h2><button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, blank()] }))}><Plus size={14} /> Add line</button></div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2 w-[46%]">Description</th><th className="p-2">SAC</th><th className="p-2 w-16">Qty</th><th className="p-2 w-36">Unit price</th><th className="p-2 w-32">Discount</th><th className="p-2 text-right w-32">Amount</th><th className="p-2 w-8" /></tr></thead>
              <tbody>
                {form.lines.map((l, i) => (
                  <tr key={i} className="border-b border-rule align-top">
                    <td className="p-2"><input className="input" placeholder="Social media management" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                    <td className="p-2"><input className="input font-mono" placeholder={seller?.profile.defaultSac ?? "998365"} value={l.sac ?? ""} onChange={(e) => setLine(i, { sac: e.target.value })} /></td>
                    <td className="p-2"><input className="input text-right" type="number" min={1} value={l.quantity} onChange={(e) => setLine(i, { quantity: Math.max(1, Number(e.target.value) || 1) })} /></td>
                    <td className="p-2"><MoneyInput paise={l.unitPricePaise} onChange={(p) => setLine(i, { unitPricePaise: p })} /></td>
                    <td className="p-2"><MoneyInput paise={l.discountPaise} onChange={(p) => setLine(i, { discountPaise: p })} /></td>
                    <td className="p-2 text-right pt-4"><Money paise={Math.max(0, l.quantity * l.unitPricePaise - l.discountPaise)} /></td>
                    <td className="p-2 pt-3"><button type="button" className="text-ink-3 hover:text-danger" aria-label="Remove line" onClick={() => setForm((f) => ({ ...f, lines: f.lines.length > 1 ? f.lines.filter((_, j) => j !== i) : [blank()] }))}><Trash2 size={15} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
            <Field label="Notes (printed on each invoice, after the title and period)"><textarea className="input min-h-[60px]" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
            <dl className="text-sm grid gap-1 content-start">
              <div className="flex justify-between"><dt className="text-ink-3">Subtotal</dt><dd><Money paise={totals.subtotalPaise} /></dd></div>
              <div className="flex justify-between items-center gap-3"><dt className="text-ink-3">Invoice discount</dt><dd className="w-36"><MoneyInput paise={form.discountPaise} onChange={(p) => setForm({ ...form, discountPaise: p })} /></dd></div>
              <div className="flex justify-between"><dt className="text-ink-3">Taxable value</dt><dd><Money paise={totals.taxablePaise} /></dd></div>
              {taxMode === "intra" && (<><div className="flex justify-between"><dt className="text-ink-3">CGST {form.gstRateBp / 200}%</dt><dd><Money paise={totals.cgstPaise} /></dd></div><div className="flex justify-between"><dt className="text-ink-3">SGST {form.gstRateBp / 200}%</dt><dd><Money paise={totals.sgstPaise} /></dd></div></>)}
              {taxMode === "inter" && <div className="flex justify-between"><dt className="text-ink-3">IGST {form.gstRateBp / 100}%</dt><dd><Money paise={totals.igstPaise} /></dd></div>}
              {totals.roundOffPaise !== 0 && <div className="flex justify-between"><dt className="text-ink-3">Round off</dt><dd><Money paise={totals.roundOffPaise} /></dd></div>}
              <div className="flex justify-between border-t-2 border-border pt-2 mt-1 font-extrabold text-base"><dt>Each period</dt><dd><Money paise={totals.totalPaise} /></dd></div>
            </dl>
          </div>
        </section>
        <div className="flex gap-2"><button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : "Save"}</button><button type="button" className="btn btn-ghost" onClick={() => router.back()}>Cancel</button></div>
      </form>
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function RecurringEditPage() {
  return <Suspense fallback={<Loading />}><Editor /></Suspense>;
}
