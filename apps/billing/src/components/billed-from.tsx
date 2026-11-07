"use client";
import { Field } from "@/components/sales-ui";
import { registrationFor, sellerRegistrations, GST_STATE_CODES } from "@dashmani/shared/src/sales/gst";
import type { SellerSettings } from "@/lib/sales-types";

// "Billed from": which of the company's GST registrations an invoice is issued from. Automatic
// (the registration in the client's state, else the principal) unless one is picked by hand.
// Shown only when the company holds two or more registrations; "" means automatic.

type Profile = SellerSettings["profile"];

const regLabel = (r: { gstin: string | null; city: string | null; stateCode: string | null; label: string }) =>
  `${r.gstin} · ${r.city || (r.stateCode ? GST_STATE_CODES[r.stateCode] : null) || r.label}`;

export function BilledFromSelect({ profile, placeOfSupplyCode, value, onChange, className }: {
  profile: Profile | undefined; placeOfSupplyCode: string | null | undefined; value: string; onChange: (gstin: string) => void; className?: string;
}) {
  if (!profile) return null;
  const regs = sellerRegistrations(profile).filter((r) => r.gstin);
  if (regs.length < 2 && !value) return null;
  const auto = registrationFor(profile, placeOfSupplyCode);
  const known = !value || regs.some((r) => r.gstin === value);
  return (
    <Field label="Billed from" className={className} hint={value ? "Picked by hand: this GSTIN, its invoice series and the GST type it gives." : "Automatic: the registration in the client's state, else the principal."}>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Automatic ({auto.gstin ? regLabel(auto) : "principal"})</option>
        {regs.map((r) => <option key={r.gstin!} value={r.gstin!}>{regLabel(r)}</option>)}
        {!known && <option value={value}>{value} · no longer a registration</option>}
      </select>
    </Field>
  );
}
