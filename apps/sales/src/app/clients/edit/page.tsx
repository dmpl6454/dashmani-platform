"use client";
// Edit client profile: every detail sales keeps about a client — company, contact, phone, the
// billing profile (GST, address, place of supply, billing contact) and internal notes — saved in
// one transaction (PUT /sales/clients/:id/profile). The email is the owner's portal sign-in, so
// it changes separately and only for sales admins (PUT /sales/clients/:id/email).
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useClient } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import type { BillingProfile } from "@/lib/sales-types";
import { Empty, Field, LoadError, Loading, PageHead, Toast } from "@/components/sales-ui";
import { BillingFields, EMPTY_BILLING, billingBody } from "@/components/billing-fields";

type ToastState = { message: string; tone: "ok" | "err" } | null;

function EditClient() {
  const id = useSearchParams().get("id");
  const router = useRouter();
  const { data: client, error, isLoading, mutate } = useClient(id);
  const [details, setDetails] = useState({ companyName: "", contactName: "", phone: "" });
  const [billing, setBilling] = useState<BillingProfile>(EMPTY_BILLING);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  // The TAN the form was filled with — a background refresh may bring a TAN learned from 26AS.
  const [loadedTan, setLoadedTan] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  // Fill the form once per client — a background refresh must not wipe what is being typed.
  useEffect(() => {
    if (!client || loadedFor === client.id) return;
    setDetails({ companyName: client.companyName, contactName: client.contactName, phone: client.phone ?? "" });
    setBilling(
      client.billingProfile
        ? ({ ...EMPTY_BILLING, ...Object.fromEntries(Object.entries(client.billingProfile).map(([k, v]) => [k, v ?? ""])) } as BillingProfile)
        : { ...EMPTY_BILLING, legalName: client.companyName, billingEmail: client.email },
    );
    setEmail(client.email);
    setLoadedTan(client.billingProfile?.tan ?? null);
    setLoadedFor(client.id);
  }, [client, loadedFor]);

  if (!id) return <Empty title="No client selected." action={<Link href="/clients" className="btn">Back to clients</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !client || loadedFor !== client.id) return <Loading />;

  const setB = (k: keyof BillingProfile, v: string) => setBilling((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await apiFetch(`/sales/clients/${id}/profile`, {
        method: "PUT",
        body: JSON.stringify({ ...details, phone: details.phone || null, billing: billingBody({ ...billing, legalName: billing.legalName || details.companyName }, loadedTan) }),
      });
      await mutate();
      router.push(`/clients/view?id=${id}`);
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
      setBusy(false);
    }
  }

  async function changeEmail(e: React.FormEvent) {
    e.preventDefault();
    setEmailBusy(true);
    try {
      await apiFetch(`/sales/clients/${id}/email`, { method: "PUT", body: JSON.stringify({ email }) });
      await mutate();
      setToast({ message: "Email changed. The client's portal sign-in now uses the new address.", tone: "ok" });
    } catch (err) {
      const status = (err as { status?: number }).status;
      setToast({ message: status === 403 ? "Only a sales admin can change a client's sign-in email." : errorSentence(err), tone: "err" });
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <>
      <PageHead kicker={<Link href={`/clients/view?id=${id}`} className="hover:text-white">{client.companyName}</Link> as unknown as string} title="Edit client profile" />
      <form onSubmit={save} className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <div className="grid grid-cols-1 gap-4 content-start">
          <section className="card p-4 grid grid-cols-[minmax(0,1fr)] gap-3 text-sm">
            <h2 className="font-bold">Company and contact</h2>
            <Field label="Company"><input className="input" required minLength={2} value={details.companyName} onChange={(e) => setDetails({ ...details, companyName: e.target.value })} /></Field>
            <Field label="Contact person"><input className="input" required minLength={2} value={details.contactName} onChange={(e) => setDetails({ ...details, contactName: e.target.value })} /></Field>
            <Field label="Phone"><input className="input" value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} /></Field>
          </section>
        </div>
        <section className="card p-4 grid grid-cols-[minmax(0,1fr)] gap-3 text-sm lg:row-span-2">
          <h2 className="font-bold">Billing profile</h2>
          <BillingFields form={billing} set={setB} legalNameRequired={false} withNotes />
          <p className="text-xs text-ink-4">The legal name defaults to the company name when left blank. Changes apply to new invoices; issued invoices keep the details they were issued with.</p>
        </section>
        <div className="lg:col-span-2 flex gap-2 order-last">
          <button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
          <Link href={`/clients/view?id=${id}`} className="btn btn-ghost">Cancel</Link>
        </div>
      </form>
      <form onSubmit={changeEmail} className="card p-4 grid grid-cols-[minmax(0,1fr)] gap-3 text-sm mt-4 max-w-xl">
        <h2 className="font-bold">Sign-in email</h2>
        <Field label="Email"><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <p className="text-xs text-ink-4">This is the client owner&apos;s portal sign-in as well as their contact email. Changing it moves their sign-in to the new address and signs out sessions under the old one. Sales admins only; saved separately from the profile above.</p>
        <div><button type="submit" className="btn btn-light" disabled={emailBusy || email.trim().toLowerCase() === client.email.toLowerCase()}>{emailBusy ? "Saving…" : "Change email"}</button></div>
      </form>
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function EditClientPage() {
  return <Suspense fallback={<Loading />}><EditClient /></Suspense>;
}
