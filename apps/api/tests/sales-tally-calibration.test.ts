/**
 * Tally calibration (spec-tally §8.3, §9.3). Compares the tag paths our builder writes against the
 * accountant's OWN TallyPrime exports, anonymised, in tests/fixtures/tally/calibration/*.xml:
 * (a) a GST Sales voucher in invoice mode, (b) a Receipt with an Agst Ref bill and a TDS line,
 * (c) a Credit Note against an invoice, (d) a cancelled Sales voucher, (e) a party ledger with a
 * GSTIN — plus, per the owner (2026-11-05), (f) an export / SEZ sales voucher before
 * ZERO_RATED_CALIBRATED in vouchers.ts may be switched on.
 *
 * TODO(owner task: "Tally calibration — accountant's five sample exports"): commit the fixtures and
 * remove `.skip`. Until this passes, no file is imported into the LIVE Tally company — use the TEST copy.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { buildFiles, planTally } from "../src/services/sales/tally/plan";
import { renderPartyLedger } from "../src/services/sales/tally/masters";
import { CLIENT, CN, doc, INV, planInput, RCPT } from "./tally-worked-example";

const DIR = path.join(__dirname, "fixtures/tally/calibration");
/** Tags Tally omits when empty — allowed to be missing from its export. */
const OPTIONAL = new Set(["INVOICEORDERLIST.LIST", "BANKALLOCATIONS.LIST", "GSTREGISTRATION"]);

/** Every element path ("VOUCHER/LEDGERENTRIES.LIST/AMOUNT") inside the first <root …> of a document. Linear scan. */
export function tagPaths(xml: string, root: string): Set<string> {
  const out = new Set<string>();
  const start = xml.indexOf(`<${root}`);
  if (start < 0) return out;
  const stack: string[] = [];
  let i = start;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    const gt = xml.indexOf(">", lt);
    if (gt < 0) break;
    const tag = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith("/")) { stack.pop(); if (!stack.length) break; continue; }
    const name = tag.split(/[\s/]/)[0];
    stack.push(name);
    out.add(stack.join("/"));
    if (tag.endsWith("/")) stack.pop();
  }
  return out;
}

const fixtures = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".xml")) : [];

describe("calibration against the accountant's Tally exports", () => {
  it.skip("every tag path we emit exists in Tally's own export (or is optional)", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
    const ours = buildFiles(planTally(planInput({ docs: [doc({ docType: "invoice", doc: INV }), doc({ docType: "receipt", doc: RCPT }), doc({ docType: "credit_note", doc: CN })] })), "X", "prime3").vouchers;
    const theirs = new Set<string>();
    for (const f of fixtures) tagPaths(fs.readFileSync(path.join(DIR, f), "utf8"), "VOUCHER").forEach((p) => theirs.add(p));
    const missing = [...tagPaths(ours, "VOUCHER")].filter((p) => !theirs.has(p) && !p.split("/").some((seg) => OPTIONAL.has(seg)));
    expect(missing).toEqual([]);
    const party = renderPartyLedger({ name: "X", group: "Sundry Debtors", mailingName: "X", gstin: CLIENT.gstin, pan: CLIENT.pan, addressLine1: "A", addressLine2: null, city: "B", pincode: "1", stateCode: "27", country: "IN" }, "prime3");
    const ledgerPaths = new Set<string>();
    for (const f of fixtures) tagPaths(fs.readFileSync(path.join(DIR, f), "utf8"), "LEDGER").forEach((p) => ledgerPaths.add(p));
    console.log("Tally has, we don't:", [...theirs].filter((p) => !tagPaths(ours, "VOUCHER").has(p)));
    expect([...tagPaths(party, "LEDGER")].filter((p) => !ledgerPaths.has(p))).toEqual([]);
  });

  it("the tag-path reader itself works (so un-skipping is a one-line change)", () => {
    expect([...tagPaths("<X><VOUCHER A=\"1\"><DATE>1</DATE><L.LIST><AMOUNT>1</AMOUNT></L.LIST><E/></VOUCHER></X>", "VOUCHER")])
      .toEqual(["VOUCHER", "VOUCHER/DATE", "VOUCHER/L.LIST", "VOUCHER/L.LIST/AMOUNT", "VOUCHER/E"]);
  });
});
