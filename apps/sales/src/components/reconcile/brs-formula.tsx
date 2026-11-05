"use client";
// The §5.4.5 formula as rows; each opens its items. Negatives in parentheses, the last row bold.
import type { BrsItem, BrsView } from "@/lib/sales-types";
import { fmtInr } from "@/lib/format";
import { BrsItems } from "./brs-items";

const sign: Record<string, string> = { books: "", not_credited: "−", credited_other_month: "+", unmatched: "+", ignored: "+", rounding: "±", over_matched: "+", credits: "=" };
const paren = (p: number) => (p < 0 ? `(${fmtInr(-p)})` : fmtInr(p));

export function BrsFormula({ v, onLink, busy }: { v: BrsView; onLink: (i: BrsItem) => void; busy: boolean }) {
  return (
    <section className="card p-4 grid grid-cols-1 gap-1" aria-label="Reconciliation">
      <h2 className="font-bold mb-1">Reconciliation</h2>
      {v.formula.map((f) => {
        const items = f.key === "books" || f.key === "credits" ? [] : v.items.filter((i) => i.group === f.key);
        const row = (
          <span className={`grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-2 items-baseline ${f.key === "credits" ? "font-bold border-t-2 border-border pt-2 mt-1" : ""}`}>
            <span className="text-ink-3 text-center">{sign[f.key]}</span>
            <span className="min-w-0">{f.label}{f.count && f.key !== "books" && f.key !== "credits" ? <span className="text-ink-3"> ({f.count})</span> : null}</span>
            <span className="font-mono tabular-nums text-right">{f.key === "not_credited" ? paren(-f.paise) : paren(f.paise)}</span>
          </span>
        );
        if (!items.length) return <div key={f.key} className="py-1 text-sm">{row}</div>;
        return (
          <details key={f.key} className="text-sm py-1">
            <summary className="cursor-pointer list-none">{row}</summary>
            <div className="pl-0 sm:pl-8"><BrsItems items={items} onLink={onLink} busy={busy} /></div>
          </details>
        );
      })}
      <p className={`text-sm mt-1 ${v.ties ? "text-success" : "text-danger"}`}>{v.ties ? "Agrees with the credits on the bank statement." : "The figures do not add up — this is a bug; reconciling is refused."}</p>
      <p className="text-xs text-ink-3 mt-2">As per books: receipts recorded in {v.month.label.split(" ")[0]} {fmtInr(v.books.receiptsPaise)} ({v.books.receiptCount}).</p>
      {(v.books.excluded.razorpayCount + v.books.excluded.cashCount + v.books.excluded.otherAccountsCount) > 0 && (
        <p className="text-xs text-ink-3">
          Not in this statement:
          {v.books.excluded.razorpayCount > 0 && <> Razorpay {fmtInr(v.books.excluded.razorpayPaise)} ({v.books.excluded.razorpayCount}) — settled by Razorpay in batches net of fees ·</>}
          {v.books.excluded.cashCount > 0 && <> cash {fmtInr(v.books.excluded.cashPaise)} ({v.books.excluded.cashCount}) ·</>}
          {v.books.excluded.otherAccountsCount > 0 && <> on other accounts {fmtInr(v.books.excluded.otherAccountsPaise)} ({v.books.excluded.otherAccountsCount})</>}
        </p>
      )}
    </section>
  );
}
