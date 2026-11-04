"use client";
// The client picker on the quote, order and invoice editors. Its "+ Add new client" option opens
// a dialog that creates the client through the same POST /sales/clients as the New client page
// (same validators, same EMAIL_EXISTS rule), then selects it — the document being typed stays.
import { useEffect, useState } from "react";
import { useSWRConfig } from "swr";
import { UserPlus, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import type { BillingProfile, ClientRow } from "@/lib/sales-types";
import { Field } from "@/components/sales-ui";
import { BillingFields, EMPTY_BILLING, billingBody } from "@/components/billing-fields";
import { ModalPortal } from "@/components/modal-portal";

const ADD_NEW = "__add_new__";

export function ClientSelect({ clients, value, onChange, className = "" }: { clients: ClientRow[]; value: string; onChange: (clientId: string) => void; className?: string }) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <Field label="Client" className={className} hint={<button type="button" className="inline-flex items-center gap-1 underline hover:text-white" onClick={() => setAdding(true)}><UserPlus size={12} /> Add new client</button>}>
        <select className="input" required value={value} onChange={(e) => (e.target.value === ADD_NEW ? setAdding(true) : onChange(e.target.value))}>
          <option value="">Choose a client…</option>
          <option value={ADD_NEW}>+ Add new client…</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.companyName}{c.billingProfile?.gstin ? ` · ${c.billingProfile.gstin}` : ""}</option>)}
        </select>
      </Field>
      {adding && <NewClientDialog onClose={() => setAdding(false)} onCreated={(c) => { setAdding(false); onChange(c.id); }} />}
    </>
  );
}

function NewClientDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (client: ClientRow) => void }) {
  const { mutate } = useSWRConfig();
  const [form, setForm] = useState({ companyName: "", contactName: "", email: "", phone: "" });
  const [billing, setBilling] = useState<BillingProfile>(EMPTY_BILLING);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setB = (k: keyof BillingProfile, v: string) => setBilling((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    // React bubbles events through portals: without this the editor's own form would submit too.
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, phone: form.phone || null, billing: billingBody({ ...billing, legalName: billing.legalName || form.companyName, billingEmail: billing.billingEmail || form.email }) };
      const res = await apiFetch<ClientRow>("/sales/clients", { method: "POST", body: JSON.stringify(body) });
      // Put the new client in every cached client list now (so the select can show it), then refetch.
      await mutate((key) => typeof key === "string" && key.startsWith("/sales/clients") && !key.startsWith("/sales/clients/"), (list?: ClientRow[]) => (list ? [...list, res.data] : list), { revalidate: true });
      onCreated(res.data);
    } catch (err) {
      setError(errorSentence(err));
      setBusy(false);
    }
  }

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4 overflow-y-auto">
        <form onSubmit={create} className="card p-4 sm:p-6 w-full max-w-3xl my-auto grid grid-cols-[minmax(0,1fr)] gap-4 text-sm" role="dialog" aria-modal="true" aria-labelledby="new-client-title">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 id="new-client-title" className="font-extrabold text-lg">Add new client</h3>
              <p className="text-ink-3 text-xs mt-1">Saved to Clients and picked for this document. Everything already typed here stays.</p>
            </div>
            <button type="button" className="text-ink-3 hover:text-white" aria-label="Close" disabled={busy} onClick={onClose}><X size={18} /></button>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <section className="grid grid-cols-[minmax(0,1fr)] gap-3">
              <h4 className="font-bold">Company and contact</h4>
              <Field label="Company"><input className="input" required minLength={2} maxLength={200} autoFocus value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} /></Field>
              <Field label="Contact person"><input className="input" required minLength={2} maxLength={120} value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></Field>
              <Field label="Email" hint="Also the address they would sign in with, if you later give them a portal login."><input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
              <Field label="Phone"><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
              <p className="text-xs text-ink-4">Adding a client does not give them a portal login.</p>
            </section>
            <section className="grid grid-cols-[minmax(0,1fr)] gap-3">
              <h4 className="font-bold">Billing profile (GST and address)</h4>
              <BillingFields form={billing} set={setB} legalNameRequired={false} />
              <p className="text-xs text-ink-4">Legal name and billing email default to the company name and email when left blank. The state decides CGST + SGST or IGST on this document.</p>
            </section>
          </div>
          {error && <p className="text-danger text-sm" role="alert">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={busy}>{busy ? "Creating…" : "Create and select"}</button>
          </div>
        </form>
      </div>
    </ModalPortal>
  );
}
