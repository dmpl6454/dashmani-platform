"use client";
// One TDS row's detail: its receipts / invoices and its 26AS entries, with links.
import Link from "next/link";
import { fmtDate, fmtInr } from "@/lib/format";
import { BOOKING_STATUS_TEXT } from "@/lib/reconcile";
import type { TdsRow } from "@/lib/sales-types";

export function TdsRowDetail({ r }: { r: TdsRow }) {
  return (
    <div className="text-xs grid grid-cols-1 gap-1 py-2 border-t border-rule min-w-0">
      <p className="text-sm">{r.reason.text}</p>
      {r.items.map((i) => (
        <p key={i.key} className="text-ink-3 break-words">
          Ours: <Link href={`/payments/view?id=${i.paymentId}`} className="font-mono hover:text-indigo-light">{i.receiptNumber}</Link> ({fmtDate(i.paidOn)})
          {i.invoiceId && <> on <Link href={`/invoices/view?id=${i.invoiceId}`} className="font-mono hover:text-indigo-light">{i.invoiceNumber}</Link> ({fmtDate(i.homeDay)})</>} · TDS <span className="font-mono">{fmtInr(i.tdsPaise)}</span>
        </p>
      ))}
      {r.entries.map((e) => (
        <p key={e.id} className="text-ink-3 break-words">
          26AS line {e.rowNo}: {fmtDate(e.txnDate)} · {e.section ?? "—"} · paid <span className="font-mono">{fmtInr(e.amountPaidPaise)}</span> · TDS <span className="font-mono">{fmtInr(e.tdsPaise)}</span>
          {e.depositedPaise != null && <> · deposited <span className="font-mono">{fmtInr(e.depositedPaise)}</span></>}
          {e.bookingStatus && <> · <span title={BOOKING_STATUS_TEXT[e.bookingStatus]}>status {e.bookingStatus}</span></>}
        </p>
      ))}
    </div>
  );
}
