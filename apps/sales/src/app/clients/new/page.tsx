"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import type { BillingProfile, ClientRow } from "@/lib/sales-types";
import { Field, PageHead, Toast } from "@/components/sales-ui";
import { BillingFields, EMPTY_BILLING, billingBody } from "@/components/billing-fields";

export default function NewClientPage() {
  const router = useRouter();
  const [form, setForm] = useState({ companyName: "", contactName: "", email: "", phone: "" });
  const [withBilling, setWithBilling] = useState(true);
  const [billing, setBilling] = useState<BillingProfile>(EMPTY_BILLING);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  const setB = (k: keyof BillingProfile, v: string) => setBilling((f) => ({ ...f, [k]: v }));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = { ...form, phone: form.phone || null };
      if (withBilling) body.billing = billingBody({ ...billing, legalName: billing.legalName || form.companyName, billingEmail: billing.billingEmail || form.email });
      const res = await apiFetch<ClientRow>("/sales/clients", { method: "POST", body: JSON.stringify(body) });
      router.push(`/clients/view?id=${res.data.id}`);
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead kicker={<Link href="/clients" className="hover:text-white">Clients</Link> as unknown as string} title="New client" />
      <form onSubmit={create} className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <section className="card p-4 grid grid-cols-[minmax(0,1fr)] gap-3 text-sm">
          <h2 className="font-bold">Company and contact</h2>
          <Field label="Company"><input className="input" required minLength={2} value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} /></Field>
          <Field label="Contact person"><input className="input" required minLength={2} value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></Field>
          <Field label="Email" hint="Also the address they would sign in with, if you later give them a portal login."><input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Phone"><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <p className="text-xs text-ink-4">Adding a client does not give them a portal login. Invite people from the client page when they need one.</p>
        </section>
        <section className="card p-4 grid grid-cols-[minmax(0,1fr)] gap-3 text-sm">
          <label className="flex items-center gap-2 font-bold">
            <input type="checkbox" checked={withBilling} onChange={(e) => setWithBilling(e.target.checked)} />
            Billing profile (GST and address)
          </label>
          {withBilling ? (
            <BillingFields form={billing} set={setB} legalNameRequired={false} />
          ) : (
            <p className="text-ink-3">You can add it later from the client page. Tax invoices need the GSTIN and address.</p>
          )}
          {withBilling && <p className="text-xs text-ink-4">Legal name and billing email default to the company name and email when left blank.</p>}
        </section>
        <div className="lg:col-span-2 flex gap-2">
          <button type="submit" className="btn" disabled={busy}>{busy ? "Creating…" : "Create client"}</button>
          <Link href="/clients" className="btn btn-ghost">Cancel</Link>
        </div>
      </form>
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}
