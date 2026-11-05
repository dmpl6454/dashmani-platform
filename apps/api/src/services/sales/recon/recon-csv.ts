import { reconDay } from "@dashmani/shared";
import { csvDocument, csvMoney } from "../csv";
import type { TdsReconView } from "./tds.service";
import type { GstReconView } from "./gst.service";
import type { BrsCore } from "./brs";

// The reconcile CSVs (spec-reconcile §8.4): PR 0's csvDocument (UTF-8 BOM, commas, CRLF, formula
// guard), money bare with its sign via csvMoney. Built from the SAME view the page shows, so the
// file and the screen can never disagree.

export const TDS_CHASE_HEADERS = [
  "Client", "Legal name", "PAN", "TAN", "Billing email", "Quarter", "Problem", "Our invoice", "Invoice date", "Our receipt", "Receipt date",
  "TDS in our books", "TDS in 26AS", "TDS deposited (26AS)", "Difference (books − 26AS)", "Amount to chase", "26AS booking status", "What to ask",
] as const;
export const GST_DIFF_HEADERS = [
  "Section", "Status", "Number (portal)", "Number (GSTR-1)", "Date (portal)", "Date (GSTR-1)", "Recipient GSTIN (portal)", "Recipient GSTIN (GSTR-1)", "Receiver",
  "Value (portal)", "Value (GSTR-1)", "Taxable (portal)", "Taxable (GSTR-1)", "IGST (portal)", "IGST (GSTR-1)", "CGST (portal)", "CGST (GSTR-1)", "SGST (portal)", "SGST (GSTR-1)",
  "Cess (GSTR-1)", "Value difference", "Issues", "What to do",
] as const;

const PROBLEM: Record<string, string> = { not_in_26as: "Not in 26AS", short: "Short in 26AS", status_U: "Booking status U", status_O: "Booking status O", short_deposited: "Deposited less than deducted" };
const m = (p: number | null | undefined) => (p == null ? "" : csvMoney(p));
const istStamp = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().replace("T", " ").slice(0, 16) + " IST";

export function tdsChaseCsv(v: TdsReconView, meta: { legalName: string; by: string; now: Date }): { filename: string; body: Buffer } {
  const up = v.upload;
  const source = up ? `${up.fileName} · sha256 ${up.fileSha256.slice(0, 12)} · as on ${reconDay(up.asOn)}` : "no Form 26AS uploaded";
  const clients = new Map(v.clients.map((c) => [c.clientId, c]));
  const out: unknown[][] = [["Company", meta.legalName], ["Source", `${source} · generated ${istStamp(meta.now)} by ${meta.by}`], [], [...TDS_CHASE_HEADERS]];
  for (const r of v.rows.filter((x) => x.group === "chase")) {
    const c = r.clientId ? clients.get(r.clientId) : undefined;
    const it = r.items[0];
    const e = r.entries[0];
    out.push([
      r.clientName ?? r.deductorName ?? "", c?.name ?? "", c?.pan ?? "", r.tan ?? c?.tans.join(" ") ?? "", c?.billingEmail ?? "", r.quarter ? `Q${r.quarter}` : "",
      PROBLEM[r.reason.code] ?? r.reason.code, it?.invoiceNumber ?? "", it ? (it.homeDay ?? "") : "", r.items.map((i) => i.receiptNumber).join(" "), it?.paidOn ?? "",
      m(r.booksPaise), m(r.form26Paise), m(r.depositedPaise), m(r.differencePaise), m(r.chasePaise ?? r.differencePaise), e?.bookingStatus ?? "", r.reason.text,
    ]);
  }
  const unknown = v.deductors.filter((d) => d.kind === "unknown");
  if (unknown.length) out.push(["Unknown deductors", unknown.length, unknown.map((d) => `${d.name} (${d.tan})`).join("; ")]);
  return { filename: `tds-chase-${v.company}-${v.fy.label}.csv`, body: csvDocument(out) };
}

export function gstDifferencesCsv(v: GstReconView, meta: { legalName: string; by: string; now: Date }): { filename: string; body: Buffer } {
  const cur = v.uploads.filter((u) => u.current.length);
  const source = cur.length ? cur.map((u) => `${u.fileName} · sha256 ${u.fileSha256.slice(0, 12)}`).join("; ") : "no GSTR-1 uploaded";
  const out: unknown[][] = [["Company", meta.legalName], ["Source", `${source} · ${v.gstin} · ${v.period.label} · generated ${istStamp(meta.now)} by ${meta.by}`], [], [...GST_DIFF_HEADERS]];
  for (const r of v.rows.filter((x) => x.status !== "matched" && x.status !== "matched_note")) {
    const b = r.books, f = r.filed;
    out.push([
      r.section, r.status, b?.number ?? "", f?.number ?? "", b?.date ?? "", f?.date ?? "", b?.buyerGstin ?? "", f?.ctin ?? "", b?.buyerName ?? f?.receiverName ?? "",
      m(b?.valuePaise), m(f?.valuePaise), m(b?.taxablePaise), m(f?.taxablePaise), m(b?.igstPaise), m(f?.igstPaise), m(b?.cgstPaise), m(f?.cgstPaise), m(b?.sgstPaise), m(f?.sgstPaise),
      m(f?.cessPaise), b && f ? csvMoney(f.valuePaise - b.valuePaise) : "", [...r.issues.map((i) => i.message), r.hint?.text].filter(Boolean).join(" | "), r.action,
    ]);
  }
  for (const s of v.sections.filter((x) => x.differs)) {
    out.push([s.section, "section_total", "", "", "", "", "", "", "", m(s.books.valuePaise), m(s.filed?.valuePaise), m(s.books.taxablePaise), m(s.filed?.taxablePaise),
      m(s.books.igstPaise), m(s.filed?.igstPaise), m(s.books.cgstPaise), m(s.filed?.cgstPaise), m(s.books.sgstPaise), m(s.filed?.sgstPaise), m(s.filed?.cessPaise),
      s.filed ? csvMoney(s.filed.valuePaise - s.books.valuePaise) : "", s.note ?? "", s.comparedItemwise ? "" : "Compared as totals only"]);
  }
  return { filename: `gstr1-differences-${v.gstin}-${v.period.key}.csv`, body: csvDocument(out) };
}

// ─── BRS (PR 6) ──────────────────────────────────────────────────────────────────────────────

export const BRS_ITEM_HEADERS = ["Group", "Date", "Reference", "Description", "Amount", "Reason", "Line id", "Receipt id"] as const;

/** The A/B figures as Figure,Amount rows, then every item and every withdrawal. Debit narrations only when the view carries them. */
export function brsCsv(v: BrsCore, meta: {
  legalName: string; by: string; now: Date; version: number | null; frozen: boolean;
  signoff?: { byName: string; at: Date; note: string | null; accepted: string[]; superseded?: { kind: string; at: string; byName: string; reason: string | null } | null } | null;
}): Buffer {
  const so = meta.frozen ? meta.signoff ?? null : null;
  const sup = so?.superseded ?? null;
  const status = meta.frozen && meta.version ? `reconciled version ${meta.version}${sup ? ` — superseded ${istStamp(new Date(sup.at))}` : ""}` : "not reconciled (live figures)";
  const out: unknown[][] = [
    ["Company", meta.legalName],
    ["Source", `${v.account.label} ••${v.account.last4} · ${v.month.label} · ${status} · generated ${istStamp(meta.now)} by ${meta.by}`],
    ...(so ? [
      ["Reconciled by", so.byName], ["Reconciled at", istStamp(so.at)], ["Note", so.note ?? ""], ["Acknowledged", so.accepted.join(", ").replace(/_/g, " ")],
      ...(sup ? [["Superseded", `${sup.kind === "re_reconciled" ? "replaced by a later version" : "reopened"} ${istStamp(new Date(sup.at))} by ${sup.byName}${sup.reason ? `: ${sup.reason}` : ""}`]] : []),
    ] : []),
    [],
    ["Figure", "Amount"],
    ["Opening balance", v.balances.openingPaise === null ? "" : csvMoney(v.balances.openingPaise)],
    ["Credits", csvMoney(v.balances.creditsPaise)],
    ["Withdrawals", csvMoney(v.balances.debitsPaise)],
    ["Closing balance", v.balances.closingPaise === null ? "" : csvMoney(v.balances.closingPaise)],
    ...v.formula.map((f) => [f.label, csvMoney(f.paise)]),
    ["Agrees", v.ties ? "yes" : "NO"],
    [],
    [...BRS_ITEM_HEADERS],
  ];
  for (const i of v.items) {
    out.push([i.group, i.day, i.receipt?.number ?? (i.line ? `row ${i.line.rowNo} of ${i.line.fileName}` : ""), i.line?.narration ?? (i.receipt ? `${i.receipt.clientName} · ${i.receipt.mode}` : ""),
      csvMoney(i.amountPaise), i.reason.text, i.line?.id ?? "", i.receipt?.id ?? ""]);
  }
  for (const d of v.debits.lines) {
    const desc = [d.refund ? `refund ${d.refund.number}` : null, d.reversalOf, d.redacted ? "details visible to admins" : d.narration].filter(Boolean).join(" · ");
    out.push(["withdrawal", d.day, d.refund?.number ?? "", desc, csvMoney(-d.amountPaise), "", d.id, ""]);
  }
  return csvDocument(out);
}
