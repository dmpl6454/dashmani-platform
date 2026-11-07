"use client";
// One GSTR-1 comparison row: the number, date and recipient, the issues with their exact
// differences, what to do, and a link to the document.
import Link from "next/link";
import { StatusPill } from "@/components/sales-ui";
import { fmtDate } from "@/lib/format";
import { GST_STATUS_LABEL, IMPORT_PAGE } from "@/lib/reconcile";
import type { GstRow } from "@/lib/sales-types";

export function GstRowCard({ r }: { r: GstRow }) {
  const number = r.books?.number ?? r.filed?.number ?? "—";
  const date = r.books?.date ?? r.filed?.date ?? null;
  const who = r.books?.buyerName ?? r.filed?.receiverName ?? null;
  const gstin = r.books?.buyerGstin ?? r.filed?.ctin ?? null;
  const href = r.books ? (r.books.kind === "invoice" ? `/invoices/view?id=${r.books.id}` : null) : r.hint?.invoiceId ? `/invoices/view?id=${r.hint.invoiceId}` : null;
  return (
    <article className="card p-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0"><span className="font-mono text-xs break-all">{number}</span> · {fmtDate(date)}{r.section === "cdnr" ? " · credit note" : ""}</p>
        <StatusPill status={r.status} label={GST_STATUS_LABEL[r.status]} />
      </div>
      {(who || gstin) && <p className="text-xs text-ink-3 mt-1 min-w-0 break-words">{who}{who && gstin ? " · " : ""}{gstin ? <span className="font-mono break-all">{gstin}</span> : null}</p>}
      {r.books && r.filed && r.books.number !== r.filed.number && <p className="text-xs text-ink-3">filed as <span className="font-mono break-all">{r.filed.number}</span></p>}
      <ul className="text-sm mt-2 grid gap-0.5">{r.issues.map((i, k) => <li key={k}>{i.message}</li>)}</ul>
      {r.hint && (
        <p className="text-sm mt-1">
          {r.hint.text}
          {r.hint.importable && IMPORT_PAGE && <> <Link href={IMPORT_PAGE} className="text-indigo-light underline">Import old invoices →</Link></>}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
        {r.action && !(r.status === "not_in_books" && r.hint) ? <p className="text-xs text-ink-3 min-w-0 flex-1">{r.action}</p> : <span />}
        {href && <Link href={href} className="btn btn-ghost btn-sm">Open invoice</Link>}
      </div>
    </article>
  );
}
