"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useClient, useStatement } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate } from "@/lib/format";
import type { BillingProfile } from "@/lib/sales-types";
import { Empty, Field, LoadError, Loading, Money, PageHead, Stat, StatusPill, Toast, titleCase } from "@/components/sales-ui";
import { GST_STATE_CODES, stateCodeFromGstin } from "@dashmani/shared/src/sales/gst";

const EMPTY: BillingProfile = { legalName: "", gstin: "", pan: "", addressLine1: "", addressLine2: "", city: "", state: "", stateCode: "", pincode: "", country: "IN", billingEmail: "", billingPhone: "", notes: "" };

function ClientView() {
  const id = useSearchParams().get("id");
  const { data: client, error, isLoading, mutate } = useClient(id);
  const { data: statement, mutate: mutateStatement } = useStatement(id);
  const [form, setForm] = useState<BillingProfile>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  useEffect(() => {
    if (client) setForm({ ...EMPTY, ...(client.billingProfile ? Object.fromEntries(Object.entries(client.billingProfile).map(([k, v]) => [k, v ?? ""])) : { legalName: client.companyName, billingEmail: client.email }) } as BillingProfile);
  }, [client]);
  if (!id) return <Empty title="No client selected." action={<Link href="/clients" className="btn">Back to clients</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !client) return <Loading />;
  const set = (k: keyof BillingProfile, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = { ...form };
      for (const k of Object.keys(body)) if (body[k] === "") body[k] = null;
      body.country = form.country || "IN";
      await apiFetch(`/sales/clients/${id}/billing`, { method: "PUT", body: JSON.stringify(body) });
      await mutate();
      setEditing(false);
      setToast({ message: "Billing profile saved.", tone: "ok" });
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
    } finally {
      setBusy(false);
    }
  }

  const p = client.billingProfile;
  const t = statement?.totals;
  return (
    <>
      <PageHead kicker={<Link href="/clients" className="hover:text-white">Clients</Link> as unknown as string} title={client.companyName}>
        <Link href={`/quotes/edit?clientId=${id}`} className="btn">New quote</Link>
        <Link href={`/invoices/edit?clientId=${id}`} className="btn btn-light">New invoice</Link>
        <Link href={`/payments/record?clientId=${id}`} className="btn btn-light">Record payment</Link>
      </PageHead>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Stat label="Invoiced" value={<Money paise={t?.invoicedPaise ?? 0} whole />} />
        <Stat label="Collected" value={<Money paise={t?.collectedPaise ?? 0} whole />} sub={t?.tdsPaise ? <>TDS withheld <Money paise={t.tdsPaise} whole /></> : undefined} tone="success" />
        <Stat label="Outstanding" value={<Money paise={t?.outstandingPaise ?? 0} whole />} tone={t?.outstandingPaise ? "attention" : undefined} />
        <Stat label="Overdue" value={<Money paise={t?.overduePaise ?? 0} whole />} tone={t?.overduePaise ? "danger" : undefined} />
      </div>
      <div className="grid lg:grid-cols-3 gap-4 mb-6">
        <section className="card p-4 lg:col-span-1">
          <div className="flex items-center justify-between mb-3"><h2 className="font-bold">Billing profile</h2><button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing((v) => !v)}>{editing ? "Cancel" : p ? "Edit" : "Add"}</button></div>
          {!editing ? (
            p ? (
              <dl className="text-sm grid gap-1">
                <div><dt className="text-ink-4 text-xs">Legal name</dt><dd>{p.legalName}</dd></div>
                <div><dt className="text-ink-4 text-xs">GSTIN</dt><dd className="font-mono">{p.gstin ?? "Unregistered"}</dd></div>
                {p.pan && <div><dt className="text-ink-4 text-xs">PAN</dt><dd className="font-mono">{p.pan}</dd></div>}
                <div><dt className="text-ink-4 text-xs">Address</dt><dd>{[p.addressLine1, p.addressLine2, p.city, p.state, p.pincode].filter(Boolean).join(", ") || "—"}</dd></div>
                <div><dt className="text-ink-4 text-xs">Place of supply</dt><dd>{p.stateCode ? `${p.stateCode} · ${GST_STATE_CODES[p.stateCode] ?? ""}` : "—"}{p.country !== "IN" ? ` · ${p.country}` : ""}</dd></div>
                <div><dt className="text-ink-4 text-xs">Billing contact</dt><dd>{[p.billingEmail, p.billingPhone].filter(Boolean).join(" · ") || client.email}</dd></div>
              </dl>
            ) : <p className="text-sm text-ink-3">No billing profile yet. Invoices will print the company name and contact email; add the GSTIN and address for a proper tax invoice.</p>
          ) : (
            <form onSubmit={save} className="grid gap-3 text-sm">
              <Field label="Legal name"><input className="input" required value={form.legalName} onChange={(e) => set("legalName", e.target.value)} /></Field>
              <Field label="GSTIN" hint="Leave blank for an unregistered client."><input className="input" value={form.gstin ?? ""} onChange={(e) => { const v = e.target.value.toUpperCase(); set("gstin", v); const sc = stateCodeFromGstin(v); if (sc) { set("stateCode", sc); set("state", GST_STATE_CODES[sc] ?? ""); } }} /></Field>
              <Field label="PAN"><input className="input" value={form.pan ?? ""} onChange={(e) => set("pan", e.target.value.toUpperCase())} /></Field>
              <Field label="Address line 1"><input className="input" value={form.addressLine1 ?? ""} onChange={(e) => set("addressLine1", e.target.value)} /></Field>
              <Field label="Address line 2"><input className="input" value={form.addressLine2 ?? ""} onChange={(e) => set("addressLine2", e.target.value)} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="City"><input className="input" value={form.city ?? ""} onChange={(e) => set("city", e.target.value)} /></Field>
                <Field label="PIN"><input className="input" value={form.pincode ?? ""} onChange={(e) => set("pincode", e.target.value)} /></Field>
              </div>
              <Field label="State (place of supply)">
                <select className="input" value={form.stateCode ?? ""} onChange={(e) => { set("stateCode", e.target.value); set("state", GST_STATE_CODES[e.target.value] ?? ""); }}>
                  <option value="">Choose…</option>
                  {Object.entries(GST_STATE_CODES).map(([code, name]) => <option key={code} value={code}>{code} · {name}</option>)}
                </select>
              </Field>
              <Field label="Country (ISO code)" hint="Anything other than IN is treated as an export: no GST."><input className="input" value={form.country} maxLength={2} onChange={(e) => set("country", e.target.value.toUpperCase())} /></Field>
              <Field label="Billing email"><input className="input" type="email" value={form.billingEmail ?? ""} onChange={(e) => set("billingEmail", e.target.value)} /></Field>
              <Field label="Billing phone"><input className="input" value={form.billingPhone ?? ""} onChange={(e) => set("billingPhone", e.target.value)} /></Field>
              <button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
            </form>
          )}
          <p className="text-xs text-ink-4 mt-4">{client.contactName} · {client.email}{client.phone ? ` · ${client.phone}` : ""}</p>
        </section>
        <section className="card p-4 lg:col-span-2">
          <h2 className="font-bold mb-3">Invoices</h2>
          {!statement ? <Loading /> : statement.invoices.length === 0 ? <p className="text-sm text-ink-3">No invoices issued to this client yet.</p> : (
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2">Number</th><th className="p-2">Issued</th><th className="p-2">Due</th><th className="p-2">Status</th><th className="p-2 text-right">Total</th><th className="p-2 text-right">Balance</th></tr></thead>
              <tbody>
                {statement.invoices.map((i) => (
                  <tr key={i.id} className="border-b border-rule">
                    <td className="p-2"><Link href={`/invoices/view?id=${i.id}`} className="font-mono hover:text-indigo-light">{i.number ?? "Draft"}</Link>{i.kind === "proforma" && <span className="text-xs text-ink-3"> · proforma</span>}</td>
                    <td className="p-2">{fmtDate(i.issueDate)}</td><td className="p-2">{fmtDate(i.dueDate)}</td>
                    <td className="p-2"><StatusPill status={i.derivedStatus} /></td>
                    <td className="p-2 text-right"><Money paise={i.totalPaise} /></td>
                    <td className="p-2 text-right"><Money paise={i.balancePaise} className={i.balancePaise ? "" : "text-ink-3"} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {statement && statement.payments.length > 0 && (
            <>
              <h2 className="font-bold mt-6 mb-3">Payments</h2>
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2">Receipt</th><th className="p-2">Date</th><th className="p-2">Mode</th><th className="p-2">Reference</th><th className="p-2 text-right">Received</th><th className="p-2 text-right">TDS</th></tr></thead>
                <tbody>
                  {statement.payments.map((p) => (
                    <tr key={p.id} className="border-b border-rule"><td className="p-2 font-mono">{p.number}</td><td className="p-2">{fmtDate(p.paidOn)}</td><td className="p-2">{titleCase(p.mode)}</td><td className="p-2 font-mono text-xs">{p.reference ?? "—"}</td><td className="p-2 text-right"><Money paise={p.amountPaise} /></td><td className="p-2 text-right"><Money paise={p.tdsPaise} className={p.tdsPaise ? "" : "text-ink-3"} /></td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {statement && statement.creditNotes.length > 0 && (
            <>
              <h2 className="font-bold mt-6 mb-3">Credit notes</h2>
              <ul className="text-sm divide-y divide-rule">{statement.creditNotes.map((c) => <li key={c.id} className="py-2 flex justify-between gap-3"><span><span className="font-mono">{c.number}</span> · {c.reason} <StatusPill status={c.status} /></span><Money paise={c.totalPaise} /></li>)}</ul>
            </>
          )}
          <button type="button" className="btn btn-ghost btn-sm mt-4" onClick={() => mutateStatement()}>Refresh</button>
        </section>
      </div>
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function ClientViewPage() {
  return <Suspense fallback={<Loading />}><ClientView /></Suspense>;
}
