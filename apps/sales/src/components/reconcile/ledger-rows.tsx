"use client";
// The statement's lines: a table in its own horizontal scroller on sm+, a stacked list on phones.
import Link from "next/link";
import { fmtDate, fmtInr } from "@/lib/format";
import { drCrText } from "@/lib/reconcile";
import type { LedgerView } from "@/lib/sales-types";

const hrefOf = (kind: string, id: string) => (kind === "invoice" ? `/invoices/view?id=${id}` : kind === "receipt" || kind === "tds" ? `/payments/view?id=${id}` : null);

export function LedgerRows({ l }: { l: LedgerView }) {
  return (
    <>
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2">Date</th><th className="p-2">Document</th><th className="p-2">Particulars</th><th className="p-2 text-right">Debit</th><th className="p-2 text-right">Credit</th><th className="p-2 text-right">Balance</th></tr></thead>
          <tbody>
            <tr className="border-b border-rule font-bold"><td className="p-2">{fmtDate(l.from)}</td><td className="p-2" /><td className="p-2">Opening balance</td><td className="p-2" /><td className="p-2" /><td className="p-2 text-right font-mono">{drCrText(l.openingPaise, false)}</td></tr>
            {l.lines.map((x, i) => {
              const href = hrefOf(x.kind, x.docId);
              return (
                <tr key={`${x.docId}-${x.kind}-${i}`} className="border-b border-rule">
                  <td className="p-2 whitespace-nowrap">{fmtDate(x.day)}</td>
                  <td className="p-2 font-mono text-xs">{href ? <Link href={href} className="hover:text-indigo-light">{x.number}</Link> : x.number}</td>
                  <td className="p-2">{x.particulars}</td>
                  <td className="p-2 text-right font-mono">{x.debitPaise ? fmtInr(x.debitPaise) : ""}</td>
                  <td className="p-2 text-right font-mono">{x.creditPaise ? fmtInr(x.creditPaise) : ""}</td>
                  <td className="p-2 text-right font-mono whitespace-nowrap">{drCrText(x.balancePaise, false)}</td>
                </tr>
              );
            })}
            <tr className="font-bold"><td className="p-2">{fmtDate(l.to)}</td><td className="p-2" /><td className="p-2">Closing balance</td><td className="p-2 text-right font-mono">{fmtInr(l.totals.debitPaise)}</td><td className="p-2 text-right font-mono">{fmtInr(l.totals.creditPaise)}</td><td className="p-2 text-right font-mono">{drCrText(l.closingPaise, false)}</td></tr>
          </tbody>
        </table>
      </div>
      <ul className="sm:hidden divide-y divide-rule text-sm">
        <li className="py-2 flex justify-between gap-2 font-bold"><span>Opening · {fmtDate(l.from)}</span><span className="font-mono">{drCrText(l.openingPaise, false)}</span></li>
        {l.lines.map((x, i) => (
          <li key={`${x.docId}-${x.kind}-${i}`} className="py-2 min-w-0">
            <div className="flex justify-between gap-2"><span>{fmtDate(x.day)}</span><span className="font-mono">{x.debitPaise ? `+${fmtInr(x.debitPaise)}` : `−${fmtInr(x.creditPaise)}`}</span></div>
            <p className="text-ink-3 break-words">{x.particulars}</p>
            <p className="text-xs text-right font-mono">{drCrText(x.balancePaise, false)}</p>
          </li>
        ))}
        <li className="py-2 flex justify-between gap-2 font-bold"><span>Closing · {fmtDate(l.to)}</span><span className="font-mono">{drCrText(l.closingPaise, false)}</span></li>
      </ul>
    </>
  );
}
