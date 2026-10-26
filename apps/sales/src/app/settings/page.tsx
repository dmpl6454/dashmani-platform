"use client";
import { useEffect, useState } from "react";
import { useSeller } from "@/lib/hooks";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import type { SellerBranch, SellerProfile } from "@/lib/sales-types";
import { Field, LoadError, Loading, PageHead, Toast } from "@/components/sales-ui";
import { GST_STATE_CODES } from "@dashmani/shared/src/sales/gst";

// Each billing company's GST identity and the defaults its documents inherit (the company
// chosen at the top of the page). A tax invoice cannot be
// issued until the fields a GST invoice must print are filled in.

const EMPTY: SellerProfile = {
  legalName: "", tradeName: "", gstin: "", pan: "", addressLine1: "", addressLine2: "", city: "", state: "", stateCode: "27", pincode: "", email: "", billingEmails: [], phone: "", website: "",
  bankName: "", accountName: "", accountNumber: "", ifsc: "", upiId: "", invoicePrefix: "DS", quotePrefix: "Q", orderPrefix: "SO", creditNotePrefix: "CN", receiptPrefix: "RCPT",
  defaultSac: "998365", defaultGstRateBp: 1800, defaultDueDays: 15, roundToRupee: true, terms: "", signatory: "", branches: [],
  eInvoicing: { enabled: false, applicableFrom: null, thirtyDayLimit: false },
};
const EMPTY_BRANCH: SellerBranch = { label: "", gstin: "", stateCode: "", state: "", addressLine1: "", addressLine2: "", city: "", pincode: "", invoicePrefix: "", creditNotePrefix: "" };

const LABELS: Record<string, string> = { legalName: "legal name", gstin: "GSTIN", addressLine1: "address", city: "city", stateCode: "state", pincode: "PIN code" };

export default function SettingsPage() {
  const { company, info } = useCompany();
  const { data, error, isLoading, mutate } = useSeller();
  const { user } = useAuth();
  const canEdit = isAdminUser(user);
  const [form, setForm] = useState<SellerProfile>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  useEffect(() => { if (data) setForm({ ...EMPTY, ...Object.fromEntries(Object.entries(data.profile).map(([k, v]) => [k, v ?? (typeof EMPTY[k as keyof SellerProfile] === "boolean" ? false : "")])) } as SellerProfile); }, [data]);
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  // While the other company's profile loads, the previous one is still on screen: never show or save it under this company.
  if (isLoading || !data || data.company !== company) return <Loading />;
  const set = (k: keyof SellerProfile, v: string | number | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const text = (k: keyof SellerProfile, placeholder = "") => (
    <input className="input" value={(form[k] as string) ?? ""} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} />
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const body: Record<string, unknown> = { ...form };
      for (const k of Object.keys(body)) if (body[k] === "") body[k] = null;
      body.billingEmails = (form.billingEmails ?? []).filter(Boolean);
      body.branches = (form.branches ?? []).map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v === "" ? null : v])));
      const res = await apiFetch<{ profile: SellerProfile; missing: string[] }>(`/sales/settings/seller?company=${company}`, { method: "PUT", body: JSON.stringify(body) });
      await mutate();
      setToast({ message: res.data.missing.length ? `Saved. Still needed for tax invoices: ${res.data.missing.map((m) => LABELS[m] ?? m).join(", ")}.` : "Saved. Tax invoices can be issued.", tone: "ok" });
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHead kicker="Settings" title={`${info.short} billing profile`} />
      <p className="text-sm text-ink-3 -mt-2 mb-4">Every document of {info.name} prints these details. The other company has its own profile: switch company at the top of the page. Prefixes must differ between the two companies.</p>
      {!data.saved && <div className="card border-attention p-3 text-sm mb-4">Not saved yet. Invoices print these details, and a <strong>tax invoice</strong> cannot be issued until the legal name, GSTIN, address, city, state and PIN are filled in.</div>}
      {data.saved && data.missing.length > 0 && <div className="card border-attention p-3 text-sm mb-4">Still needed for tax invoices: {data.missing.map((m) => LABELS[m] ?? m).join(", ")}.</div>}
      {!canEdit && <div className="card p-3 text-sm mb-4">Only an Admin or Super Admin can change the company profile — its GSTIN and bank details print on every invoice.</div>}
      <form onSubmit={save}>
       <fieldset disabled={!canEdit} className="grid gap-6 min-w-0 border-0 p-0 m-0">
        <section className="card p-4 grid sm:grid-cols-2 gap-4">
          <h2 className="font-bold sm:col-span-2">Identity</h2>
          <Field label="Legal name" className="sm:col-span-2">{text("legalName", info.name)}</Field>
          <Field label="Trade name (optional)">{text("tradeName", info.short)}</Field>
          <Field label="GSTIN" hint="15 characters; the first two are the state code.">{text("gstin", "27AAACD1234E1Z5")}</Field>
          <Field label="PAN">{text("pan", "AAACD1234E")}</Field>
          <Field label="Authorised signatory">{text("signatory", "Name printed under the signature")}</Field>
        </section>
        <section className="card p-4 grid sm:grid-cols-2 gap-4">
          <h2 className="font-bold sm:col-span-2">Registered address</h2>
          <Field label="Address line 1" className="sm:col-span-2">{text("addressLine1")}</Field>
          <Field label="Address line 2" className="sm:col-span-2">{text("addressLine2")}</Field>
          <Field label="City">{text("city", "Mumbai")}</Field>
          <Field label="State">
            <select className="input" value={form.stateCode ?? ""} onChange={(e) => { set("stateCode", e.target.value); set("state", GST_STATE_CODES[e.target.value] ?? ""); }}>
              <option value="">Choose…</option>
              {Object.entries(GST_STATE_CODES).map(([code, name]) => <option key={code} value={code}>{code} · {name}</option>)}
            </select>
          </Field>
          <Field label="PIN code">{text("pincode", "400053")}</Field>
          <Field label="Email on invoices">{text("email", "accounts@digitalsukoon.com")}</Field>
          <Field label="More billing emails" hint="Printed beside the email above. Separate with commas.">
            <input className="input" value={(form.billingEmails ?? []).join(", ")} placeholder="finance@digitalsukoon.com"
              onChange={(e) => setForm((f) => ({ ...f, billingEmails: e.target.value.split(",").map((x) => x.trim()) }))} />
          </Field>
          <Field label="Phone on invoices">{text("phone")}</Field>
          <Field label="Website">{text("website", "https://digitalsukoon.com")}</Field>
        </section>
        <section className="card p-4 grid gap-4">
          <div className="flex items-center justify-between gap-3"><h2 className="font-bold">Other GST registrations</h2><button type="button" className="btn btn-ghost btn-sm" onClick={() => set("branches", [...(form.branches ?? []), { ...EMPTY_BRANCH }] as never)}>Add registration</button></div>
          <p className="text-xs text-ink-3">The address above is the principal registration. A client in a state listed here is billed from that GSTIN (CGST + SGST), with its own invoice and credit-note numbers; every other client is billed from the principal one.</p>
          {(form.branches ?? []).map((b, i) => {
            const setB = (k: keyof SellerBranch, v: string) => set("branches", form.branches.map((x, j) => (j === i ? { ...x, [k]: v } : x)) as never);
            const t = (k: keyof SellerBranch, ph = "") => <input className="input" value={(b[k] as string) ?? ""} placeholder={ph} onChange={(e) => setB(k, e.target.value)} />;
            return (
              <div key={i} className="border border-border p-3 grid sm:grid-cols-2 gap-3">
                <Field label="Label">{t("label", "Gurugram")}</Field>
                <Field label="GSTIN" hint="The state is taken from its first two digits.">{t("gstin", "06AAKCD3352K1ZJ")}</Field>
                <Field label="Address line 1" className="sm:col-span-2">{t("addressLine1")}</Field>
                <Field label="Address line 2" className="sm:col-span-2">{t("addressLine2")}</Field>
                <Field label="City">{t("city")}</Field>
                <Field label="PIN code">{t("pincode")}</Field>
                <Field label="Invoice prefix" hint="Up to 5; different from every other registration">{t("invoicePrefix", "DSHR")}</Field>
                <Field label="Credit note prefix">{t("creditNotePrefix", "CNHR")}</Field>
                <div className="sm:col-span-2"><button type="button" className="btn btn-ghost btn-sm" onClick={() => set("branches", form.branches.filter((_, j) => j !== i) as never)}>Remove this registration</button></div>
              </div>
            );
          })}
        </section>
        <section className="card p-4 grid sm:grid-cols-3 gap-4">
          <h2 className="font-bold sm:col-span-3">E-invoicing (IRN)</h2>
          <p className="text-xs text-ink-3 sm:col-span-3">When on, every tax invoice to a GST-registered client, SEZ unit or overseas client — and its credit notes — is registered on the government IRP at issue; the PDF carries the IRN and signed QR. Mandatory once aggregate turnover crossed ₹5 crore in any year since 2017-18: confirm with your CA. Needs the IRP connection (API credentials) on the server.</p>
          <Field label="E-invoicing">
            <select className="input" value={form.eInvoicing?.enabled ? "on" : "off"} onChange={(e) => set("eInvoicing", { ...form.eInvoicing, enabled: e.target.value === "on" } as never)}><option value="off">Off</option><option value="on">On — register at issue</option></select>
          </Field>
          <Field label="Applies to documents dated from" hint="Blank = every document issued while it is on">
            <input className="input" type="date" value={form.eInvoicing?.applicableFrom ?? ""} onChange={(e) => set("eInvoicing", { ...form.eInvoicing, applicableFrom: e.target.value || null } as never)} />
          </Field>
          <Field label="30-day reporting limit" hint="AATO ₹10 crore or more">
            <select className="input" value={form.eInvoicing?.thirtyDayLimit ? "yes" : "no"} onChange={(e) => set("eInvoicing", { ...form.eInvoicing, thirtyDayLimit: e.target.value === "yes" } as never)}><option value="no">No</option><option value="yes">Yes — refuse documents older than 30 days</option></select>
          </Field>
        </section>
        <section className="card p-4 grid sm:grid-cols-2 gap-4">
          <h2 className="font-bold sm:col-span-2">Bank details (printed on invoices)</h2>
          <Field label="Account name">{text("accountName")}</Field>
          <Field label="Bank">{text("bankName")}</Field>
          <Field label="Account number">{text("accountNumber")}</Field>
          <Field label="IFSC">{text("ifsc")}</Field>
          <Field label="UPI ID">{text("upiId")}</Field>
        </section>
        <section className="card p-4 grid sm:grid-cols-3 gap-4">
          <h2 className="font-bold sm:col-span-3">Documents</h2>
          <Field label="Invoice prefix" hint="Up to 5 letters, digits or hyphens. Numbers run per financial year: DS/26-27/0001">{text("invoicePrefix")}</Field>
          <Field label="Quote prefix">{text("quotePrefix")}</Field>
          <Field label="Order prefix">{text("orderPrefix")}</Field>
          <Field label="Credit note prefix" hint="Up to 5 letters, digits or hyphens">{text("creditNotePrefix")}</Field>
          <Field label="Receipt prefix">{text("receiptPrefix")}</Field>
          <Field label="Default SAC" hint="998365 = sale of internet advertising space">{text("defaultSac")}</Field>
          <Field label="Default GST rate (%)"><input className="input" type="number" min={0} max={40} step={0.01} value={form.defaultGstRateBp / 100} onChange={(e) => set("defaultGstRateBp", Math.round(Number(e.target.value) * 100))} /></Field>
          <Field label="Payment due (days)"><input className="input" type="number" min={0} max={180} value={form.defaultDueDays} onChange={(e) => set("defaultDueDays", Number(e.target.value))} /></Field>
          <Field label="Round totals to the rupee">
            <select className="input" value={form.roundToRupee ? "yes" : "no"} onChange={(e) => set("roundToRupee", e.target.value === "yes")}><option value="yes">Yes — print a round-off line</option><option value="no">No — exact paise</option></select>
          </Field>
          <Field label="Default terms (printed on invoices)" className="sm:col-span-3"><textarea className="input min-h-[90px]" value={form.terms ?? ""} onChange={(e) => set("terms", e.target.value)} /></Field>
        </section>
        <div><button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : "Save profile"}</button></div>
       </fieldset>
      </form>
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}
