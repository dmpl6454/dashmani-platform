"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useClients, useInventory, useSeller } from "@/lib/hooks";
import { errorSentence } from "@/lib/messages";
import { fmtCompact, fmtInr } from "@/lib/format";
import type { InventoryChannel, LineItem, Order, Quote, TaxMode } from "@/lib/sales-types";
import { Field, Loading, Money, MoneyInput, Toast, platformLabel, titleCase } from "@/components/sales-ui";
import { computeTotals, taxModeFor, GST_STATE_CODES } from "@dashmani/shared/src/sales/gst";

// One editor for quotes and orders: the same lines, the same tax resolution, live totals from
// the shared GST arithmetic (the API recomputes everything on save; this is for the eyes).

type Kind = "quote" | "order";
type Doc = Quote | Order;

interface FormState {
  clientId: string; title: string; campaignType: "brand" | "entertainment"; validUntil: string; poNumber: string; startDate: string; endDate: string;
  taxMode: "auto" | TaxMode; gstRateBp: number; discountPaise: number; notes: string; internalNotes: string; items: LineItem[];
}

const blankLine = (): LineItem => ({ kind: "custom", description: "", quantity: 1, unitPricePaise: 0, discountPaise: 0 });

function fromDoc(d: Doc | undefined, clientIdPreset: string | null): FormState {
  return {
    clientId: d?.clientId ?? clientIdPreset ?? "",
    title: d?.title ?? "",
    campaignType: (d?.campaignType as "brand" | "entertainment") ?? "brand",
    validUntil: (d as Quote | undefined)?.validUntil ?? "",
    poNumber: (d as Order | undefined)?.poNumber ?? "",
    startDate: (d as Order | undefined)?.startDate ?? "",
    endDate: (d as Order | undefined)?.endDate ?? "",
    taxMode: d ? d.taxMode : "auto",
    gstRateBp: d?.gstRateBp ?? 1800,
    discountPaise: d?.discountPaise ?? 0,
    notes: d?.notes ?? "",
    internalNotes: d?.internalNotes ?? "",
    items: d?.items?.length ? d.items.map((i) => ({ ...i })) : [blankLine()],
  };
}

export function DocumentEditor({ kind, initial, clientIdPreset }: { kind: Kind; initial?: Doc; clientIdPreset: string | null }) {
  const router = useRouter();
  const { data: clients } = useClients();
  const { data: seller } = useSeller();
  const [form, setForm] = useState<FormState>(() => fromDoc(initial, clientIdPreset));
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  useEffect(() => { if (initial) setForm(fromDoc(initial, clientIdPreset)); }, [initial, clientIdPreset]);

  const client = clients?.find((c) => c.id === form.clientId);
  const autoMode = taxModeFor(seller?.profile.stateCode, client?.billingProfile?.stateCode, client?.billingProfile?.country ?? "IN");
  const taxMode: TaxMode = form.taxMode === "auto" ? autoMode : form.taxMode;
  const totals = useMemo(() => computeTotals({ lines: form.items, discountPaise: form.discountPaise, taxMode, gstRateBp: form.gstRateBp, roundToRupee: false }), [form.items, form.discountPaise, taxMode, form.gstRateBp]);
  const setItem = (i: number, patch: Partial<LineItem>) => setForm((f) => ({ ...f, items: f.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));
  const removeItem = (i: number) => setForm((f) => ({ ...f, items: f.items.length > 1 ? f.items.filter((_, j) => j !== i) : [blankLine()] }));

  function addFromInventory(c: InventoryChannel, format: string, pricePaise: number, rateCardId: string | null) {
    const line: LineItem = {
      kind: "placement", targetType: c.targetType, targetId: c.targetId, platform: c.platform, format, rateCardId,
      description: `${c.name} · ${platformLabel(c.platform)} ${titleCase(format)}`, accountName: c.name, accountHandle: c.handle, quantity: 1, unitPricePaise: pricePaise, discountPaise: 0,
    };
    setForm((f) => ({ ...f, items: f.items.length === 1 && !f.items[0].description && !f.items[0].unitPricePaise ? [line] : [...f.items, line] }));
    setPicker(false);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.clientId) { setToast({ message: "Choose a client first.", tone: "err" }); return; }
    if (form.items.some((i) => !i.description.trim())) { setToast({ message: "Every line needs a description.", tone: "err" }); return; }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        clientId: form.clientId, title: form.title, campaignType: form.campaignType, gstRateBp: form.gstRateBp, discountPaise: form.discountPaise,
        notes: form.notes || null, internalNotes: form.internalNotes || null,
        ...(form.taxMode !== "auto" ? { taxMode: form.taxMode } : {}),
        items: form.items.map((i, position) => ({
          kind: i.kind, targetType: i.targetType ?? null, targetId: i.targetId ?? null, platform: i.platform ?? null, format: i.format ?? null,
          description: i.description.trim(), accountName: i.accountName ?? null, accountHandle: i.accountHandle ?? null, quantity: i.quantity,
          unitPricePaise: i.unitPricePaise, discountPaise: i.discountPaise, sac: i.sac || null, scheduledOn: i.scheduledOn || null, rateCardId: i.rateCardId ?? null, position,
        })),
      };
      if (kind === "quote") body.validUntil = form.validUntil || null;
      else { body.poNumber = form.poNumber || null; body.startDate = form.startDate || null; body.endDate = form.endDate || null; }
      const path = initial ? `/sales/${kind}s/${initial.id}` : `/sales/${kind}s`;
      const res = await apiFetch<Doc>(path, { method: initial ? "PUT" : "POST", body: JSON.stringify(body) });
      router.replace(`/${kind}s/view?id=${res.data.id}`);
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
      setBusy(false);
    }
  }

  if (!clients) return <Loading label="Loading clients…" />;
  return (
    <form onSubmit={save} className="grid gap-5">
      <section className="card p-4 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Field label="Client" className="sm:col-span-2">
          <select className="input" required value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}>
            <option value="">Choose a client…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.companyName}{c.billingProfile?.gstin ? ` · ${c.billingProfile.gstin}` : ""}</option>)}
          </select>
        </Field>
        <Field label="Title" className="sm:col-span-2"><input className="input" required maxLength={200} placeholder="Diwali reels across 6 pages" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="Campaign type" hint="Entertainment uses the entertainment column of the rate card.">
          <select className="input" value={form.campaignType} onChange={(e) => setForm({ ...form, campaignType: e.target.value as FormState["campaignType"] })}><option value="brand">Brand promotion</option><option value="entertainment">Entertainment (film, OTT, music)</option></select>
        </Field>
        {kind === "quote" ? (
          <Field label="Valid until"><input className="input" type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} /></Field>
        ) : (
          <>
            <Field label="Client PO number"><input className="input" value={form.poNumber} onChange={(e) => setForm({ ...form, poNumber: e.target.value })} /></Field>
            <Field label="Start"><input className="input" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
            <Field label="End"><input className="input" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></Field>
          </>
        )}
        <Field label="GST" hint={form.taxMode === "auto" ? `Auto: ${client?.billingProfile?.stateCode ? `${client.billingProfile.stateCode} ${GST_STATE_CODES[client.billingProfile.stateCode] ?? ""}` : "no state on the client → IGST"}` : undefined}>
          <select className="input" value={form.taxMode} onChange={(e) => setForm({ ...form, taxMode: e.target.value as FormState["taxMode"] })}>
            <option value="auto">Auto from the client&apos;s state ({autoMode === "intra" ? "CGST + SGST" : autoMode === "inter" ? "IGST" : "no GST"})</option>
            <option value="intra">CGST + SGST (same state)</option><option value="inter">IGST (other state)</option><option value="none">No GST (export / SEZ)</option>
          </select>
        </Field>
        <Field label="GST rate (%)"><input className="input" type="number" min={0} max={40} step={0.01} value={form.gstRateBp / 100} onChange={(e) => setForm({ ...form, gstRateBp: Math.round(Number(e.target.value) * 100) })} /></Field>
      </section>

      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 className="font-bold">Lines</h2>
          <div className="flex gap-2">
            <button type="button" className="btn btn-light btn-sm" onClick={() => setPicker(true)}><Plus size={14} /> From inventory</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm((f) => ({ ...f, items: [...f.items, blankLine()] }))}><Plus size={14} /> Custom line</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2 w-[42%]">Description</th><th className="p-2">SAC</th><th className="p-2 w-16">Qty</th><th className="p-2 w-36">Unit price</th><th className="p-2 w-32">Discount</th><th className="p-2 text-right w-32">Amount</th><th className="p-2 w-8" /></tr></thead>
            <tbody>
              {form.items.map((it, i) => (
                <tr key={i} className="border-b border-rule align-top">
                  <td className="p-2">
                    <input className="input" placeholder="What is being sold" value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} />
                    {it.kind === "placement" && <div className="text-xs text-ink-4 mt-1">{platformLabel(it.platform)} · {titleCase(it.format)}{it.accountHandle ? ` · @${it.accountHandle}` : ""}</div>}
                    <input className="input mt-1 text-xs" type="date" value={it.scheduledOn ?? ""} onChange={(e) => setItem(i, { scheduledOn: e.target.value || null })} title="Scheduled on" />
                  </td>
                  <td className="p-2"><input className="input font-mono" placeholder={seller?.profile.defaultSac ?? "998365"} value={it.sac ?? ""} onChange={(e) => setItem(i, { sac: e.target.value })} /></td>
                  <td className="p-2"><input className="input text-right" type="number" min={1} max={10000} value={it.quantity} onChange={(e) => setItem(i, { quantity: Math.max(1, Number(e.target.value) || 1) })} /></td>
                  <td className="p-2"><MoneyInput paise={it.unitPricePaise} onChange={(p) => setItem(i, { unitPricePaise: p })} /></td>
                  <td className="p-2"><MoneyInput paise={it.discountPaise} onChange={(p) => setItem(i, { discountPaise: p })} /></td>
                  <td className="p-2 text-right pt-4"><Money paise={Math.max(0, it.quantity * it.unitPricePaise - it.discountPaise)} /></td>
                  <td className="p-2 pt-3"><button type="button" className="text-ink-3 hover:text-danger" aria-label="Remove line" onClick={() => removeItem(i)}><Trash2 size={15} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid sm:grid-cols-2 gap-4 mt-4">
          <div className="grid gap-3">
            <Field label="Notes (printed on the document)"><textarea className="input min-h-[80px]" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
            <Field label="Internal notes (never printed)"><textarea className="input min-h-[60px]" value={form.internalNotes} onChange={(e) => setForm({ ...form, internalNotes: e.target.value })} /></Field>
          </div>
          <dl className="text-sm grid gap-1 content-start">
            <div className="flex justify-between"><dt className="text-ink-3">Subtotal</dt><dd><Money paise={totals.subtotalPaise} /></dd></div>
            <div className="flex justify-between items-center gap-3"><dt className="text-ink-3">Document discount</dt><dd className="w-36"><MoneyInput paise={form.discountPaise} onChange={(p) => setForm({ ...form, discountPaise: p })} /></dd></div>
            <div className="flex justify-between"><dt className="text-ink-3">Taxable value</dt><dd><Money paise={totals.taxablePaise} /></dd></div>
            {taxMode === "intra" && (<><div className="flex justify-between"><dt className="text-ink-3">CGST {form.gstRateBp / 200}%</dt><dd><Money paise={totals.cgstPaise} /></dd></div><div className="flex justify-between"><dt className="text-ink-3">SGST {form.gstRateBp / 200}%</dt><dd><Money paise={totals.sgstPaise} /></dd></div></>)}
            {taxMode === "inter" && <div className="flex justify-between"><dt className="text-ink-3">IGST {form.gstRateBp / 100}%</dt><dd><Money paise={totals.igstPaise} /></dd></div>}
            {taxMode === "none" && <div className="flex justify-between"><dt className="text-ink-3">GST</dt><dd className="text-ink-3">nil</dd></div>}
            <div className="flex justify-between border-t-2 border-border pt-2 mt-1 font-extrabold text-base"><dt>Total</dt><dd><Money paise={totals.totalPaise} /></dd></div>
          </dl>
        </div>
      </section>
      <div className="flex gap-2">
        <button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : initial ? "Save changes" : kind === "quote" ? "Create quote" : "Create order"}</button>
        <button type="button" className="btn btn-ghost" onClick={() => router.back()}>Cancel</button>
      </div>
      {picker && <InventoryPicker campaignType={form.campaignType} onPick={addFromInventory} onClose={() => setPicker(false)} />}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </form>
  );
}

function InventoryPicker({ campaignType, onPick, onClose }: { campaignType: "brand" | "entertainment"; onPick: (c: InventoryChannel, format: string, pricePaise: number, rateCardId: string | null) => void; onClose: () => void }) {
  const { data, isLoading } = useInventory();
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState("all");
  const platforms = useMemo(() => Array.from(new Set((data ?? []).map((c) => c.platform))).sort(), [data]);
  const term = q.trim().toLowerCase();
  const rows = (data ?? []).filter((c) => (platform === "all" || c.platform === platform) && (!term || c.name.toLowerCase().includes(term) || (c.handle ?? "").toLowerCase().includes(term) || (c.category ?? "").toLowerCase().includes(term))).slice(0, 80);
  return (
    <div className="fixed inset-0 z-40 bg-black/70 p-4 overflow-y-auto" onClick={onClose}>
      <div className="card max-w-4xl mx-auto my-6 p-4" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="font-extrabold">Add a placement from the inventory</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          <input autoFocus className="input flex-1 min-w-[200px]" placeholder="Search channel" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input w-auto" value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="all">All platforms</option>{platforms.map((p) => <option key={p} value={p}>{platformLabel(p)}</option>)}</select>
        </div>
        {isLoading ? <Loading /> : (
          <ul className="divide-y divide-rule max-h-[60vh] overflow-y-auto">
            {rows.map((c) => {
              const offers = c.offers.filter((o) => o.active);
              return (
                <li key={`${c.targetType}:${c.targetId}`} className="py-2 flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-bold truncate">{c.name} <span className="text-ink-3 font-normal text-xs">{platformLabel(c.platform)} · {fmtCompact(c.followers)} followers{c.category ? ` · ${c.category}` : ""}</span></div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {offers.map((o) => {
                      const price = campaignType === "entertainment" ? o.entertainmentPricePaise : o.pricePaise;
                      return price == null ? null : <button key={o.rateCardId} type="button" className="btn btn-ghost btn-sm" onClick={() => onPick(c, o.format, price, o.rateCardId)}>{titleCase(o.format)} · {fmtInr(price, { whole: true })}</button>;
                    })}
                    <button type="button" className="btn btn-ghost btn-sm text-ink-3" onClick={() => onPick(c, "post", 0, null)}>Custom price…</button>
                  </div>
                </li>
              );
            })}
            {rows.length === 0 && <li className="py-6 text-center text-ink-3 text-sm">No channels match.</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
