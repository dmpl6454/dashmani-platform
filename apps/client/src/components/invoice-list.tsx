"use client";
import { useState } from "react";
import { Button, Tag } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { downloadFile } from "@/lib/api";
import { INVOICE_STATUS_LABEL, fmtDay, inr, type ClientInvoice } from "@/lib/hooks/use-invoices";

/** The client's invoices with a PDF download each. Shared by /invoices and a campaign's page. */
export function InvoiceList({ invoices }: { invoices: ClientInvoice[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(inv: ClientInvoice) {
    setBusy(inv.id);
    setError(null);
    try {
      await downloadFile(`/client/invoices/${inv.id}/pdf`, `${(inv.number ?? "invoice").replace(/[^\w.-]+/g, "-")}.pdf`);
    } catch (e: any) {
      setError(e?.message ? `Couldn't download ${inv.number ?? "the invoice"}: ${e.message}` : "Couldn't download the invoice — try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {error && <div role="alert" className="mb-3 px-3 py-2 text-[12.5px] border border-danger/40 text-danger bg-danger-bg">{error}</div>}
      <ul className="border-t-2 border-[rgba(255,255,255,0.18)]">
        {invoices.map((inv) => (
          <li key={inv.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 border-b-2 border-[rgba(255,255,255,0.18)]">
            <div className="min-w-0 flex-1 basis-[220px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-semibold text-ink truncate">{inv.number ?? "Invoice"}</span>
                <Tag tone={inv.status === "paid" ? "success" : inv.status === "overdue" ? "attention" : "neutral"}>{INVOICE_STATUS_LABEL[inv.status]}</Tag>
                {inv.kind === "proforma" && <Tag>Proforma</Tag>}
              </div>
              <div className="text-[12px] text-ink-3 mt-1">
                {fmtDay(inv.issueDate)} · {inv.company}
                {inv.status !== "paid" && inv.status !== "cancelled" && inv.dueDate && <> · due {fmtDay(inv.dueDate)}</>}
              </div>
            </div>
            <div className="text-right tabular-nums">
              <div className="font-semibold text-ink">{inr(inv.totalPaise)}</div>
              <div className="text-[12px] text-ink-3">
                {inv.status === "cancelled" ? "Cancelled" : inv.balancePaise === 0 ? "Paid in full" : `${inr(inv.balancePaise)} due`}
              </div>
            </div>
            <Button size="sm" variant="default" icon={<Icon.Download size={14} />} onClick={() => download(inv)} disabled={busy === inv.id} aria-label={`Download ${inv.number ?? "invoice"} as PDF`}>
              {busy === inv.id ? "Downloading…" : "PDF"}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
