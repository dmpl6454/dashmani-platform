import { countryName, cut, tallyStateName, XmlWriter } from "./xml";

// Master (ledger) XML for the masters file (spec-tally §4.7). Masters are ALWAYS ACTION="Create" and
// imported with @@DUPIGNORE: the portal never alters or deletes a Tally master. Party ledgers come
// from the client's CURRENT billing profile; account ledgers are written only when the settings
// ask for them (a brand-new Tally company) and carry no GST rate details — the accountant sets SAC
// and rate on each sales ledger once (those tags changed in TallyPrime 3.0).

export interface PartyMaster {
  name: string;
  group: string;
  mailingName: string;
  gstin: string | null;
  pan: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  pincode: string | null;
  stateCode: string | null;
  country: string | null;
}

/** "Address line 1", "line 2", "<city> <pin>" — empty lines dropped. */
export function partyAddress(p: { addressLine1?: string | null; addressLine2?: string | null; city?: string | null; pincode?: string | null }): string[] {
  return [p.addressLine1, p.addressLine2, [p.city, p.pincode].filter(Boolean).join(" ")].map((x) => (x ?? "").trim()).filter(Boolean);
}

/** PAN when present, else characters 3–12 of the GSTIN, else null. */
export const incomeTaxNumber = (pan: string | null, gstin: string | null) => (pan ? pan : gstin && gstin.length >= 12 ? gstin.slice(2, 12) : null);

/** The party's state for Tally: billing state code, else its GSTIN's; abroad = "Other Territory". */
export function partyStateCode(p: { stateCode?: string | null; gstin?: string | null; country?: string | null }): string | null {
  if (p.country && p.country.toUpperCase() !== "IN") return "97";
  return p.stateCode || (p.gstin ? p.gstin.slice(0, 2) : null) || null;
}

/** One party ledger as a TALLYMESSAGE block (depth 4). */
export function renderPartyLedger(p: PartyMaster, release: "prime3" | "legacy"): string {
  const w = new XmlWriter(4);
  const gstin = p.country && p.country.toUpperCase() !== "IN" ? null : p.gstin;
  const state = tallyStateName(partyStateCode(p));
  const address = partyAddress(p);
  w.open("TALLYMESSAGE", [["xmlns:UDF", "TallyUDF"]]);
  w.open("LEDGER", [["NAME", p.name], ["ACTION", "Create"]]);
  w.open("NAME.LIST", [["TYPE", "String"]]).leaf("NAME", p.name).close("NAME.LIST");
  w.leaf("PARENT", p.group).leaf("ISBILLWISEON", "Yes").leaf("AFFECTSSTOCK", "No");
  w.leaf("INCOMETAXNUMBER", incomeTaxNumber(p.pan, gstin));
  const regType = gstin ? "Regular" : release === "prime3" ? "Unregistered/Consumer" : "Unregistered";
  if (release === "prime3") {
    w.open("LEDMAILINGDETAILS.LIST");
    if (address.length) { w.open("ADDRESS.LIST", [["TYPE", "String"]]); for (const a of address) w.leaf("ADDRESS", a); w.close("ADDRESS.LIST"); }
    w.leaf("APPLICABLEFROM", "20170701").leaf("MAILINGNAME", cut(p.mailingName, 100)).leaf("STATE", state).leaf("COUNTRY", countryName(p.country));
    w.leaf("PINCODE", p.pincode || null);
    w.close("LEDMAILINGDETAILS.LIST");
    w.open("LEDGSTREGDETAILS.LIST");
    w.leaf("APPLICABLEFROM", "20170701").leaf("GSTREGISTRATIONTYPE", regType).leaf("PLACEOFSUPPLY", state).leaf("GSTIN", gstin);
    w.close("LEDGSTREGDETAILS.LIST");
  } else {
    if (address.length) { w.open("ADDRESS.LIST", [["TYPE", "String"]]); for (const a of address) w.leaf("ADDRESS", a); w.close("ADDRESS.LIST"); }
    w.open("MAILINGNAME.LIST", [["TYPE", "String"]]).leaf("MAILINGNAME", cut(p.mailingName, 100)).close("MAILINGNAME.LIST");
    w.leaf("COUNTRYOFRESIDENCE", countryName(p.country)).leaf("LEDSTATENAME", state).leaf("PINCODE", p.pincode || null);
    w.leaf("GSTREGISTRATIONTYPE", regType).leaf("PARTYGSTIN", gstin);
  }
  w.close("LEDGER").close("TALLYMESSAGE");
  return w.toString();
}

export type AccountLedgerKind = "sales" | "cgst" | "sgst" | "igst" | "roundoff" | "tds" | "bank" | "cash" | "gateway" | "other";

const GROUP: Record<AccountLedgerKind, string> = {
  sales: "Sales Accounts", cgst: "Duties & Taxes", sgst: "Duties & Taxes", igst: "Duties & Taxes", roundoff: "Indirect Expenses",
  tds: "Current Assets", bank: "Bank Accounts", cash: "Cash-in-Hand", gateway: "Current Assets", other: "Current Assets",
};
const DUTY_HEAD: Partial<Record<AccountLedgerKind, string>> = { cgst: "Central Tax", sgst: "State Tax", igst: "Integrated Tax" };
export const accountLedgerGroup = (k: AccountLedgerKind) => GROUP[k];

/** One account ledger (sales, duty, round off, TDS, money) as a TALLYMESSAGE block. */
export function renderAccountLedger(name: string, kind: AccountLedgerKind): string {
  const w = new XmlWriter(4);
  w.open("TALLYMESSAGE", [["xmlns:UDF", "TallyUDF"]]);
  w.open("LEDGER", [["NAME", name], ["ACTION", "Create"]]);
  w.open("NAME.LIST", [["TYPE", "String"]]).leaf("NAME", name).close("NAME.LIST");
  w.leaf("PARENT", GROUP[kind]);
  if (kind === "sales") {
    w.leaf("ISBILLWISEON", "No").leaf("AFFECTSSTOCK", "No");
    w.constant("GSTAPPLICABLE", "&#4; Applicable");
    w.leaf("GSTTYPEOFSUPPLY", "Services");
  } else if (DUTY_HEAD[kind]) {
    w.leaf("TAXTYPE", "GST").leaf("GSTDUTYHEAD", DUTY_HEAD[kind]!);
  } else if (kind === "roundoff") {
    w.constant("GSTAPPLICABLE", "&#4; Not Applicable");
  }
  w.close("LEDGER").close("TALLYMESSAGE");
  return w.toString();
}
