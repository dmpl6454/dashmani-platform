"use client";
import { fmtDate } from "@/lib/format";
import type { LineItem, Order, Quote, SalesEvent } from "@/lib/sales-types";
import { Money, StatusPill, platformLabel, titleCase } from "@/components/sales-ui";

// Read-only line table + totals shared by the quote and order views, and the audit trail list.

export function DocumentLines({ doc, lineExtra }: { doc: Quote | Order; lineExtra?: (item: LineItem) => React.ReactNode }) {
  return (
    <section className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-3">Line</th><th className="p-3">SAC</th><th className="p-3 text-right">Qty</th><th className="p-3 text-right">Unit</th><th className="p-3 text-right">Discount</th><th className="p-3 text-right">Amount</th>{lineExtra && <th className="p-3">Delivery</th>}</tr></thead>
        <tbody>
          {doc.items.map((it, i) => (
            <tr key={it.id ?? i} className="border-b border-rule align-top">
              <td className="p-3"><div className="font-bold">{it.description}</div><div className="text-xs text-ink-3">{it.kind === "placement" ? `${platformLabel(it.platform)} · ${titleCase(it.format)}` : "Custom"}{it.scheduledOn ? ` · ${fmtDate(it.scheduledOn)}` : ""}</div></td>
              <td className="p-3 font-mono text-xs">{it.sac ?? "—"}</td>
              <td className="p-3 text-right">{it.quantity}</td>
              <td className="p-3 text-right"><Money paise={it.unitPricePaise} /></td>
              <td className="p-3 text-right">{it.discountPaise ? <Money paise={it.discountPaise} /> : <span className="text-ink-4">—</span>}</td>
              <td className="p-3 text-right"><Money paise={it.amountPaise ?? Math.max(0, it.quantity * it.unitPricePaise - it.discountPaise)} /></td>
              {lineExtra && <td className="p-3">{lineExtra(it)}</td>}
            </tr>
          ))}
        </tbody>
        <tfoot className="text-sm">
          <tr><td colSpan={lineExtra ? 5 : 4} /><td className="p-2 pt-4 text-right text-ink-3">Subtotal</td><td className="p-2 pt-4 text-right"><Money paise={doc.subtotalPaise} /></td></tr>
          {doc.discountPaise > 0 && <tr><td colSpan={lineExtra ? 5 : 4} /><td className="p-2 text-right text-ink-3">Discount</td><td className="p-2 text-right">− <Money paise={doc.discountPaise} /></td></tr>}
          <tr><td colSpan={lineExtra ? 5 : 4} /><td className="p-2 text-right text-ink-3">Taxable</td><td className="p-2 text-right"><Money paise={doc.taxablePaise} /></td></tr>
          {doc.taxMode === "intra" && (<><tr><td colSpan={lineExtra ? 5 : 4} /><td className="p-2 text-right text-ink-3">CGST {doc.gstRateBp / 200}%</td><td className="p-2 text-right"><Money paise={doc.cgstPaise} /></td></tr><tr><td colSpan={lineExtra ? 5 : 4} /><td className="p-2 text-right text-ink-3">SGST {doc.gstRateBp / 200}%</td><td className="p-2 text-right"><Money paise={doc.sgstPaise} /></td></tr></>)}
          {doc.taxMode === "inter" && <tr><td colSpan={lineExtra ? 5 : 4} /><td className="p-2 text-right text-ink-3">IGST {doc.gstRateBp / 100}%</td><td className="p-2 text-right"><Money paise={doc.igstPaise} /></td></tr>}
          <tr className="font-extrabold text-base"><td colSpan={lineExtra ? 5 : 4} /><td className="p-3 text-right">Total</td><td className="p-3 text-right"><Money paise={doc.totalPaise} /></td></tr>
        </tfoot>
      </table>
    </section>
  );
}

export function EventList({ events }: { events: SalesEvent[] | undefined }) {
  return (
    <aside className="card p-4 h-fit">
      <h2 className="font-bold mb-3">History</h2>
      {!events ? <p className="text-sm text-ink-3">Loading…</p> : events.length === 0 ? <p className="text-sm text-ink-3">No activity yet.</p> : (
        <ul className="text-sm divide-y divide-rule">
          {events.map((e) => (
            <li key={e.id} className="py-2">
              <div className="flex items-center gap-2 flex-wrap"><span className="font-bold">{e.action.replace(/_/g, " ")}</span>{e.toStatus && <StatusPill status={e.toStatus} />}</div>
              <div className="text-xs text-ink-3">{fmtDate(e.createdAt)}{e.note ? ` · ${e.note}` : ""}</div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
