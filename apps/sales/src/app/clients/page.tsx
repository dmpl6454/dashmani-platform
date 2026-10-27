"use client";
import { useState } from "react";
import Link from "next/link";
import { useClients } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { Empty, Field, LoadError, Loading, Money, PageHead, Toast } from "@/components/sales-ui";

export default function ClientsPage() {
  const [q, setQ] = useState("");
  const { data, error, isLoading, mutate } = useClients(q.trim() || undefined);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ companyName: "", contactName: "", email: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await apiFetch("/sales/clients", { method: "POST", body: JSON.stringify({ ...form, phone: form.phone || null }) });
      setForm({ companyName: "", contactName: "", email: "", phone: "" });
      setAdding(false);
      await mutate();
      setToast({ message: "Client added.", tone: "ok" });
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead kicker={data ? `${data.length} clients` : "Clients"} title="Clients">
        <button type="button" className="btn" onClick={() => setAdding((a) => !a)}>{adding ? "Close" : "Add client"}</button>
      </PageHead>
      {adding && (
        <form onSubmit={create} className="card p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4 items-end">
          <Field label="Company"><input className="input" required value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} /></Field>
          <Field label="Contact person"><input className="input" required value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></Field>
          <Field label="Email"><input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Phone"><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <button type="submit" className="btn" disabled={busy}>{busy ? "Adding…" : "Add"}</button>
          <p className="text-xs text-ink-4 sm:col-span-2 lg:col-span-5">Adds the client for quotes and invoices. It does not give them a portal login — they can claim the account later through an invite.</p>
        </form>
      )}
      <div className="card p-3 mb-4"><input className="input" placeholder="Search company, contact, email or legal name" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {error ? <LoadError error={error} retry={() => mutate()} /> : isLoading && !data ? <Loading /> : !data?.length ? <Empty title="No clients match." /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-3">Client</th><th className="p-3">Contact</th><th className="p-3">GST</th><th className="p-3 text-right">Outstanding</th></tr></thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className="border-b border-rule hover:bg-muted/60">
                  <td className="p-3"><Link href={`/clients/view?id=${c.id}`} className="font-bold hover:text-indigo-light">{c.companyName}</Link>{c.billingProfile?.legalName && c.billingProfile.legalName !== c.companyName && <div className="text-xs text-ink-3">{c.billingProfile.legalName}</div>}</td>
                  <td className="p-3"><div>{c.contactName}</div><div className="text-xs text-ink-3">{c.email}</div></td>
                  <td className="p-3 font-mono text-xs">{c.billingProfile?.gstin ?? <span className="text-ink-4">not set</span>}</td>
                  <td className="p-3 text-right"><Money paise={c.outstandingPaise} whole className={c.outstandingPaise ? "text-attention" : "text-ink-3"} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}
