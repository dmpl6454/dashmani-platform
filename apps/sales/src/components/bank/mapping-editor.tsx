"use client";
import { useState } from "react";
import { Field } from "@/components/sales-ui";
import type { BankMapping, StatementPreview } from "@/lib/sales-types";

// "Columns look wrong?" — choose the heading row, each column's role, how amounts are signed and
// the date order, then read the file again with that choice. Opens by itself when the reader is
// unsure (preview.needs non-empty).

const ROLES: Array<[keyof BankMapping["columns"], string, boolean]> = [
  ["date", "Date", true], ["valueDate", "Value date", false], ["narration", "Narration / particulars", true], ["reference", "Reference / cheque no.", false],
  ["debit", "Withdrawal (debit)", false], ["credit", "Deposit (credit)", false], ["amount", "Amount", false], ["drCr", "Dr / Cr", false], ["balance", "Balance", false],
];
const STYLES: Array<[BankMapping["amountStyle"], string]> = [
  ["split", "Withdrawal + Deposit columns"], ["drcr_column", "Amount + Dr/Cr column"], ["suffix", "Amount with Cr/Dr"],
  ["signed_credit_positive", "Signed amount: positive = credit"], ["signed_debit_positive", "Signed amount: positive = debit"],
];
const col = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `C${i + 1}`);

export function MappingEditor({ preview, onApply, busy }: { preview: StatementPreview; onApply: (m: BankMapping) => void; busy: boolean }) {
  const [m, setM] = useState<BankMapping>(preview.mapping ?? { headerRow: 1, columns: { date: 0, narration: 1, debit: 2, credit: 3 }, dateOrder: "dmy", amountStyle: "split", sheet: preview.sheet });
  const headers = preview.headers.length ? preview.headers : (preview.firstRows[m.headerRow - 1] ?? []);
  const width = Math.max(headers.length, ...preview.firstRows.map((r) => r.length), 1);
  const setCol = (k: keyof BankMapping["columns"], v: string) => setM({ ...m, columns: { ...m.columns, [k]: v === "" ? null : Number(v) } as BankMapping["columns"] });
  return (
    <section className="card p-4 grid grid-cols-1 gap-4 min-w-0">
      <h3 className="font-bold">Choose the columns</h3>
      {preview.firstRows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="text-[11px] font-mono min-w-[480px]">
            <tbody>{preview.firstRows.slice(0, 25).map((r, i) => (
              <tr key={i} className={i + 1 === m.headerRow ? "bg-indigo/30" : ""}><td className="pr-2 text-ink-3">{i + 1}</td>{r.map((c, j) => <td key={j} className="pr-3 whitespace-nowrap">{c}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {preview.sheets.length > 1 && (
          <Field label="Sheet"><select className="input" value={m.sheet ?? ""} onChange={(e) => setM({ ...m, sheet: e.target.value })}>{preview.sheets.map((s) => <option key={s}>{s}</option>)}</select></Field>
        )}
        <Field label="Headings are in row"><input type="number" min={1} max={200} className="input" value={m.headerRow} onChange={(e) => setM({ ...m, headerRow: Math.max(1, Number(e.target.value) || 1) })} /></Field>
        <Field label="Dates are"><select className="input" value={m.dateOrder} onChange={(e) => setM({ ...m, dateOrder: e.target.value as BankMapping["dateOrder"] })}><option value="dmy">Day/month/year</option><option value="mdy">Month/day/year</option><option value="ymd">Year-month-day</option></select></Field>
      </div>
      <fieldset className="grid grid-cols-1 gap-1 text-sm">
        <legend className="text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-1">Amounts</legend>
        {STYLES.map(([v, label]) => <label key={v} className="flex items-center gap-2"><input type="radio" name="style" checked={m.amountStyle === v} onChange={() => setM({ ...m, amountStyle: v })} /> {label}</label>)}
      </fieldset>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {ROLES.map(([k, label, required]) => (
          <Field key={k} label={label}>
            <select className="input" value={m.columns[k] ?? ""} onChange={(e) => setCol(k, e.target.value)}>
              {!required && <option value="">— not in this file —</option>}
              {Array.from({ length: width }, (_, i) => <option key={i} value={i}>{col(i)}{headers[i] ? ` · ${headers[i]}` : ""}</option>)}
            </select>
          </Field>
        ))}
      </div>
      <div><button type="button" className="btn" disabled={busy} onClick={() => onApply(m)}>{busy ? "Reading…" : "Read again with these columns"}</button></div>
    </section>
  );
}
