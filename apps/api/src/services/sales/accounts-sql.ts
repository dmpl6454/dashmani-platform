import { Prisma } from "@dashmani/db";
import type { CompanyKey } from "@dashmani/shared";

// The accounts page's SQL (spec-accounts §4.3). Every figure is an aggregate computed by Postgres
// over the sales tables — the page never hydrates documents. Days are bound as STRINGS and cast
// ::date (never a JS Date); company and bounds are bind parameters. Read only: nothing here writes.
//
// Definitions that must stay in step with the rest of the portal (locked by equality tests):
//  - invoiced = tax invoices issued|paid by issue_date      (dashboard invoicedFyPaise)
//  - collected = recorded receipts by paid_on − issued refunds by refunded_on (dashboard collectedFyPaise)
//  - receivables = tax invoices stored 'issued' with total − paid − tds − credited > 0 (deriveInvoice)
//  - unapplied = receiptBalance(): max(0, amount − allocated − refunds) + max(0, tds − allocatedTds)

export interface Bounds { from: string; to: string }

/** Unregistered inter-state B2C "large" threshold: ₹1,00,000 from 1 Aug 2024, ₹2,50,000 before. Confirm with CA. */
export const B2CL_THRESHOLD_SQL = "(CASE WHEN i.issue_date >= DATE '2024-08-01' THEN 10000000 ELSE 25000000 END)";

/**
 * GSTR-1 section of a tax invoice, from its FROZEN buyer snapshot (owner, 2026-11-05: "No GST"
 * invoices are SEZ or export clients):
 *   buyer abroad → exp (6A, EXPWOP/EXPWP); buyer GSTIN + no tax → sez (6B, SEZWOP);
 *   buyer GSTIN → b2b (4A); no GSTIN + no tax → check (nothing in GSTR-1 fits — the CA looks);
 *   unregistered inter-state above the threshold → b2cl (5); else b2cs (7).
 * The alias is always the code constant "i" — never user input.
 */
export const SECTION_SQL = Prisma.raw(`CASE WHEN COALESCE(NULLIF(i.buyer_snapshot->>'country',''),'IN') <> 'IN' THEN 'exp'
       WHEN NULLIF(i.buyer_snapshot->>'gstin','') IS NOT NULL AND i.tax_mode = 'none' THEN 'sez'
       WHEN NULLIF(i.buyer_snapshot->>'gstin','') IS NOT NULL THEN 'b2b'
       WHEN i.tax_mode = 'none' THEN 'check'
       WHEN i.tax_mode = 'inter' AND i.total_paise > ${B2CL_THRESHOLD_SQL} THEN 'b2cl'
       ELSE 'b2cs' END`);

/** Registration of a document = the GSTIN frozen in its seller snapshot ("" = none). */
export const GSTIN_SQL = Prisma.raw(`COALESCE(i.seller_snapshot->>'gstin','')`);

export interface Q1Row { month: string; gstin: string; section: string; rate_bp: number; docs: number; taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint; round_off: bigint; total: bigint }
export const Q1 = (c: CompanyKey, b: Bounds) => Prisma.sql`
SELECT to_char(i.issue_date,'YYYY-MM') AS month, ${GSTIN_SQL} AS gstin, ${SECTION_SQL} AS section, i.gst_rate_bp AS rate_bp,
       count(*)::int AS docs, sum(i.taxable_paise)::bigint AS taxable, sum(i.cgst_paise)::bigint AS cgst, sum(i.sgst_paise)::bigint AS sgst,
       sum(i.igst_paise)::bigint AS igst, sum(i.round_off_paise)::bigint AS round_off, sum(i.total_paise)::bigint AS total
FROM sales_invoices i
WHERE i.company_key = ${c} AND i.kind = 'tax_invoice' AND i.status IN ('issued','paid')
  AND i.issue_date >= ${b.from}::date AND i.issue_date < ${b.to}::date
GROUP BY 1, 2, 3, 4`;

export interface Q2Row { month: string; gstin: string; section: string; docs: number; earlier: number; taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint; total: bigint }
export const Q2 = (c: CompanyKey, b: Bounds) => Prisma.sql`
SELECT to_char(cn.issue_date,'YYYY-MM') AS month, ${GSTIN_SQL} AS gstin, ${SECTION_SQL} AS section,
       count(*)::int AS docs, count(*) FILTER (WHERE i.issue_date < ${b.from}::date)::int AS earlier,
       sum(cn.taxable_paise)::bigint AS taxable, sum(cn.cgst_paise)::bigint AS cgst, sum(cn.sgst_paise)::bigint AS sgst,
       sum(cn.igst_paise)::bigint AS igst, sum(cn.total_paise)::bigint AS total
FROM sales_credit_notes cn JOIN sales_invoices i ON i.id = cn.invoice_id
WHERE i.company_key = ${c} AND cn.status = 'issued' AND cn.issue_date >= ${b.from}::date AND cn.issue_date < ${b.to}::date
GROUP BY 1, 2, 3`;

export interface Q2bRow { count: number; total: bigint }
export const Q2B = (c: CompanyKey, b: Bounds) => Prisma.sql`
SELECT count(*)::int AS count, COALESCE(sum(total_paise),0)::bigint AS total FROM sales_invoices
WHERE company_key = ${c} AND kind = 'tax_invoice' AND status = 'cancelled' AND issue_date >= ${b.from}::date AND issue_date < ${b.to}::date`;

export interface Q3Row { month: string; mode: string; receipts: number; received: bigint; tds: bigint }
export const Q3 = (c: CompanyKey, b: Bounds) => Prisma.sql`
SELECT to_char(p.paid_on,'YYYY-MM') AS month, p.mode, count(*)::int AS receipts, sum(p.amount_paise)::bigint AS received, sum(p.tds_paise)::bigint AS tds
FROM sales_payments p
WHERE p.company_key = ${c} AND p.status = 'recorded' AND p.paid_on >= ${b.from}::date AND p.paid_on < ${b.to}::date
GROUP BY 1, 2`;

export interface Q4Row { month: string; mode: string; refunds: number; refunded: bigint }
export const Q4 = (c: CompanyKey, b: Bounds) => Prisma.sql`
SELECT to_char(r.refunded_on,'YYYY-MM') AS month, r.mode, count(*)::int AS refunds, sum(r.amount_paise)::bigint AS refunded
FROM sales_refunds r JOIN sales_payments p ON p.id = r.payment_id
WHERE p.company_key = ${c} AND p.status = 'recorded' AND r.status = 'issued' AND r.refunded_on >= ${b.from}::date AND r.refunded_on < ${b.to}::date
GROUP BY 1, 2`;

export interface Q5Row { client_id: string; quarter: number; receipts: number; tds: bigint }
export const Q5 = (c: CompanyKey, b: Bounds) => Prisma.sql`
SELECT p.client_id, ((EXTRACT(MONTH FROM p.paid_on)::int + 8) % 12) / 3 + 1 AS quarter, count(*)::int AS receipts, sum(p.tds_paise)::bigint AS tds
FROM sales_payments p
WHERE p.company_key = ${c} AND p.status = 'recorded' AND p.tds_paise > 0 AND p.paid_on >= ${b.from}::date AND p.paid_on < ${b.to}::date
GROUP BY 1, 2`;

export interface Q6Row { id: string; client_id: string; taxable_paise: number; total_paise: number; tds: bigint }
export const Q6 = (c: CompanyKey, b: Bounds) => Prisma.sql`
SELECT i.id, i.client_id, i.taxable_paise, i.total_paise, sum(a.tds_paise)::bigint AS tds
FROM sales_invoices i
JOIN sales_payment_allocations a ON a.invoice_id = i.id
JOIN sales_payments p ON p.id = a.payment_id AND p.status = 'recorded'
WHERE i.company_key = ${c} AND i.kind = 'tax_invoice' AND i.status = 'paid'
GROUP BY i.id, i.client_id, i.taxable_paise, i.total_paise
HAVING sum(a.tds_paise) > 0 AND bool_or(a.tds_paise > 0 AND p.paid_on >= ${b.from}::date AND p.paid_on < ${b.to}::date)`;

export interface Q7Row { client_id: string; bucket: string; invoices: number; balance: bigint; overdue: bigint; from_fy: bigint; oldest_due: Date }
export const Q7 = (c: CompanyKey, b: Bounds, today: string) => Prisma.sql`
WITH open AS (
  SELECT i.client_id, i.issue_date, COALESCE(i.due_date, i.issue_date) AS due,
         (i.total_paise - i.paid_paise - i.tds_paise - i.credited_paise)::bigint AS bal
  FROM sales_invoices i
  WHERE i.company_key = ${c} AND i.kind = 'tax_invoice' AND i.status = 'issued'
)
SELECT client_id,
       CASE WHEN due > ${today}::date THEN 'not_due'
            WHEN ${today}::date - due <= 30 THEN 'd0_30'
            WHEN ${today}::date - due <= 60 THEN 'd31_60'
            WHEN ${today}::date - due <= 90 THEN 'd61_90' ELSE 'd90_plus' END AS bucket,
       count(*)::int AS invoices, sum(bal)::bigint AS balance,
       COALESCE(sum(bal) FILTER (WHERE due < ${today}::date), 0)::bigint AS overdue,
       COALESCE(sum(bal) FILTER (WHERE issue_date >= ${b.from}::date AND issue_date < ${b.to}::date), 0)::bigint AS from_fy,
       min(due) AS oldest_due
FROM open WHERE bal > 0 GROUP BY 1, 2`;

export interface Q8Row { client_id: string; receipts: number; cash: bigint; tds: bigint }
export const Q8 = (c: CompanyKey) => Prisma.sql`
WITH r AS (
  SELECT p.client_id,
         GREATEST(0, p.amount_paise - COALESCE(a.amt,0) - COALESCE(f.amt,0))::bigint AS cash,
         GREATEST(0, p.tds_paise - COALESCE(a.tds,0))::bigint AS tds
  FROM sales_payments p
  LEFT JOIN (SELECT payment_id, sum(amount_paise) AS amt, sum(tds_paise) AS tds FROM sales_payment_allocations GROUP BY payment_id) a ON a.payment_id = p.id
  LEFT JOIN (SELECT payment_id, sum(amount_paise) AS amt FROM sales_refunds WHERE status = 'issued' GROUP BY payment_id) f ON f.payment_id = p.id
  WHERE p.company_key = ${c} AND p.status = 'recorded'
)
SELECT client_id, count(*)::int AS receipts, sum(cash)::bigint AS cash, sum(tds)::bigint AS tds
FROM r WHERE cash + tds > 0 GROUP BY client_id`;

export interface Q9Row { doc: "invoice" | "credit_note"; month: string; gstin: string; series: string; first: string; last: string; total: number; cancelled: number }
export const Q9 = (c: CompanyKey, b: Bounds) => Prisma.sql`
SELECT 'invoice' AS doc, to_char(i.issue_date,'YYYY-MM') AS month, ${GSTIN_SQL} AS gstin,
       split_part(i.number,'/',1) AS series, min(i.number COLLATE "C") AS first, max(i.number COLLATE "C") AS last,
       count(*)::int AS total, count(*) FILTER (WHERE i.status = 'cancelled')::int AS cancelled
FROM sales_invoices i
WHERE i.company_key = ${c} AND i.kind = 'tax_invoice' AND i.number IS NOT NULL AND i.issue_date >= ${b.from}::date AND i.issue_date < ${b.to}::date
GROUP BY 2, 3, 4
UNION ALL
SELECT 'credit_note', to_char(cn.issue_date,'YYYY-MM'), ${GSTIN_SQL}, split_part(cn.number,'/',1),
       min(cn.number COLLATE "C"), max(cn.number COLLATE "C"), count(*)::int, count(*) FILTER (WHERE cn.status = 'cancelled')::int
FROM sales_credit_notes cn JOIN sales_invoices i ON i.id = cn.invoice_id
WHERE i.company_key = ${c} AND cn.issue_date >= ${b.from}::date AND cn.issue_date < ${b.to}::date
GROUP BY 2, 3, 4`;

export interface Q10Row { fy_start: number; invoices: number; taxable_net: bigint }
export const Q10 = (c: CompanyKey) => Prisma.sql`
SELECT fy_start, sum(docs)::int AS invoices, sum(taxable)::bigint AS taxable_net FROM (
  SELECT EXTRACT(YEAR FROM i.issue_date)::int - (CASE WHEN EXTRACT(MONTH FROM i.issue_date) < 4 THEN 1 ELSE 0 END) AS fy_start, 1 AS docs, i.taxable_paise::bigint AS taxable
  FROM sales_invoices i WHERE i.company_key = ${c} AND i.kind = 'tax_invoice' AND i.status IN ('issued','paid') AND i.issue_date IS NOT NULL
  UNION ALL
  SELECT EXTRACT(YEAR FROM cn.issue_date)::int - (CASE WHEN EXTRACT(MONTH FROM cn.issue_date) < 4 THEN 1 ELSE 0 END), 0, -cn.taxable_paise::bigint
  FROM sales_credit_notes cn JOIN sales_invoices i ON i.id = cn.invoice_id WHERE i.company_key = ${c} AND cn.status = 'issued'
) t GROUP BY fy_start`;

export interface Q11Row { k: "cancelled" | "edited" | "credit_note"; id: string; number: string; issue_date: Date; changed_on: Date }
export const Q11 = (c: CompanyKey, b: Bounds) => Prisma.sql`
SELECT 'cancelled' AS k, i.id, i.number, i.issue_date, (i.cancelled_at + interval '330 minutes')::date AS changed_on
  FROM sales_invoices i WHERE i.company_key = ${c} AND i.kind = 'tax_invoice' AND i.status = 'cancelled' AND i.number IS NOT NULL
   AND i.cancelled_at IS NOT NULL AND i.issue_date >= ${b.from}::date AND i.issue_date < ${b.to}::date
UNION ALL
SELECT 'edited', i.id, i.number, i.issue_date, max((e.created_at + interval '330 minutes')::date)
  FROM sales_invoices i JOIN sales_events e ON e.entity_type = 'invoice' AND e.entity_id = i.id AND e.action = 'edited_after_issue'
 WHERE i.company_key = ${c} AND i.kind = 'tax_invoice' AND i.status IN ('issued','paid') AND i.issue_date >= ${b.from}::date AND i.issue_date < ${b.to}::date
 GROUP BY i.id, i.number, i.issue_date
UNION ALL
SELECT 'credit_note', cn.id, cn.number, i.issue_date, cn.issue_date
  FROM sales_credit_notes cn JOIN sales_invoices i ON i.id = cn.invoice_id
 WHERE i.company_key = ${c} AND cn.status = 'issued' AND cn.issue_date >= ${b.from}::date AND cn.issue_date < ${b.to}::date AND i.issue_date < ${b.from}::date
LIMIT 2000`;

// ─── CSV row reads (bounded; the one place documents are listed) ─────────────────────────────

/** One more than the cap, so the caller can tell "exactly 20 000" from "too many". */
export const CSV_ROW_CAP = 20_000;

export interface InvoiceCsvRow {
  id: string; number: string; issue_date: Date; status: string; tax_mode: string; gst_rate_bp: number; gstin: string; section: string;
  place_of_supply_code: string | null; buyer_gstin: string | null; buyer_name: string | null; buyer_state: string | null; buyer_country: string | null;
  taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; round_off_paise: number; total_paise: number; cancelled_on: Date | null;
}
const INVOICE_COLS = Prisma.sql`i.id, i.number, i.issue_date, i.status, i.tax_mode, i.gst_rate_bp, ${GSTIN_SQL} AS gstin, ${SECTION_SQL} AS section,
  i.place_of_supply_code, NULLIF(i.buyer_snapshot->>'gstin','') AS buyer_gstin, i.buyer_snapshot->>'legalName' AS buyer_name,
  NULLIF(i.buyer_snapshot->>'stateCode','') AS buyer_state, NULLIF(i.buyer_snapshot->>'country','') AS buyer_country,
  i.taxable_paise, i.cgst_paise, i.sgst_paise, i.igst_paise, i.round_off_paise, i.total_paise,
  (i.cancelled_at + interval '330 minutes')::date AS cancelled_on`;

export interface CreditNoteCsvRow extends Omit<InvoiceCsvRow, "round_off_paise" | "cancelled_on"> {
  invoice_number: string | null; cancelled_on: Date | null;
}

/** Tax invoices in the period (by issue_date); `statuses` and an optional GSTIN / section filter. */
export const invoiceCsvRows = (c: CompanyKey, from: string, to: string, statuses: string[], gstin: string | null, sections: string[] | null) => Prisma.sql`
SELECT ${INVOICE_COLS} FROM sales_invoices i
WHERE i.company_key = ${c} AND i.kind = 'tax_invoice' AND i.number IS NOT NULL AND i.status IN (${Prisma.join(statuses)})
  AND i.issue_date >= ${from}::date AND i.issue_date < ${to}::date
  ${gstin === null ? Prisma.empty : Prisma.sql`AND ${GSTIN_SQL} = ${gstin}`}
  ${sections === null ? Prisma.empty : Prisma.sql`AND ${SECTION_SQL} IN (${Prisma.join(sections)})`}
ORDER BY i.issue_date, i.number COLLATE "C"
LIMIT ${CSV_ROW_CAP + 1}`;

/** Credit notes in the period (by their own issue_date), with their invoice's registration and section. */
export const creditNoteCsvRows = (c: CompanyKey, from: string, to: string, statuses: string[], gstin: string | null, sections: string[] | null) => Prisma.sql`
SELECT cn.id, cn.number, cn.issue_date, cn.status, cn.tax_mode, cn.gst_rate_bp, ${GSTIN_SQL} AS gstin, ${SECTION_SQL} AS section,
  i.place_of_supply_code, NULLIF(i.buyer_snapshot->>'gstin','') AS buyer_gstin, i.buyer_snapshot->>'legalName' AS buyer_name,
  NULLIF(i.buyer_snapshot->>'stateCode','') AS buyer_state, NULLIF(i.buyer_snapshot->>'country','') AS buyer_country,
  cn.taxable_paise, cn.cgst_paise, cn.sgst_paise, cn.igst_paise, cn.total_paise, i.number AS invoice_number,
  (cn.cancelled_at + interval '330 minutes')::date AS cancelled_on
FROM sales_credit_notes cn JOIN sales_invoices i ON i.id = cn.invoice_id
WHERE i.company_key = ${c} AND cn.status IN (${Prisma.join(statuses)}) AND cn.issue_date >= ${from}::date AND cn.issue_date < ${to}::date
  ${gstin === null ? Prisma.empty : Prisma.sql`AND ${GSTIN_SQL} = ${gstin}`}
  ${sections === null ? Prisma.empty : Prisma.sql`AND ${SECTION_SQL} IN (${Prisma.join(sections)})`}
ORDER BY cn.issue_date, cn.number COLLATE "C"
LIMIT ${CSV_ROW_CAP + 1}`;
