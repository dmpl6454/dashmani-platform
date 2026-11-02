"use client";
// The billing-profile inputs (legal name, GSTIN, address, place of supply), shared by the client
// page's "Billing profile" editor and the New client page. Typing a GSTIN fills the state.
import type { BillingProfile } from "@/lib/sales-types";
import { Field } from "@/components/sales-ui";
import { GST_STATE_CODES, stateCodeFromGstin } from "@dashmani/shared/src/sales/gst";

export const EMPTY_BILLING: BillingProfile = { legalName: "", gstin: "", pan: "", addressLine1: "", addressLine2: "", city: "", state: "", stateCode: "", pincode: "", country: "IN", billingEmail: "", billingPhone: "", notes: "" };

/** The API body for a billing form: blanks become null, country defaults to IN. */
export function billingBody(form: BillingProfile): Record<string, unknown> {
  const body: Record<string, unknown> = { ...form };
  for (const k of Object.keys(body)) if (body[k] === "") body[k] = null;
  body.country = form.country || "IN";
  return body;
}

export function BillingFields({ form, set, legalNameRequired = true }: { form: BillingProfile; set: (k: keyof BillingProfile, v: string) => void; legalNameRequired?: boolean }) {
  return (
    <>
      <Field label="Legal name"><input className="input" required={legalNameRequired} value={form.legalName} onChange={(e) => set("legalName", e.target.value)} /></Field>
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
    </>
  );
}
