"use client";
// The items behind one formula row (spec-reconcile §7.6): date, reference, narration, reason,
// amount and the actions — one-tap Link through Bank's own route, Open on Bank, Open receipt.
import Link from "next/link";
import { fmtDate } from "@/lib/format";
import type { BrsItem } from "@/lib/sales-types";
import { Money } from "@/components/sales-ui";

export function BrsItems({ items, onLink, busy }: { items: BrsItem[]; onLink?: (i: BrsItem) => void; busy?: boolean }) {
  if (!items.length) return <p className="text-sm text-ink-3 px-1 py-2">Nothing here.</p>;
  return (
    <ul className="grid grid-cols-1 gap-2 py-2">
      {items.map((i) => (
        <li key={i.key} className={`card p-3 grid grid-cols-1 gap-1 text-sm ${i.open ? "border-attention" : ""}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="min-w-0">
              <span className="text-ink-3">{fmtDate(i.day)}</span>
              {" · "}
              <span className="font-mono text-xs break-all">{i.receipt ? i.receipt.number : i.line ? `row ${i.line.rowNo} of ${i.line.fileName}` : ""}</span>
              {i.receipt && <span className="text-ink-3"> · {i.receipt.clientName}</span>}
            </span>
            <Money paise={i.amountPaise} className={i.amountPaise < 0 ? "text-danger" : ""} />
          </div>
          {i.line && <p className="font-mono text-xs break-all text-ink-3 line-clamp-2">{i.line.narration}</p>}
          <p>{i.reason.text}{i.open && <span className="text-attention"> · open</span>}</p>
          {(i.link || i.line || i.receipt) && (
            <div className="flex flex-wrap gap-2 pt-1">
              {i.link && onLink && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onLink(i)}>{i.link.text}</button>}
              {i.line && <Link href={`/bank/line?id=${i.line.id}`} className="btn btn-ghost btn-sm">Open on Bank →</Link>}
              {i.receipt && <Link href={`/payments/view?id=${i.receipt.id}`} className="btn btn-ghost btn-sm">Open receipt →</Link>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
