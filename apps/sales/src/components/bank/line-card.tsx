"use client";
import { useState } from "react";
import Link from "next/link";
import { mutate as mutateGlobal } from "swr";
import { BANK_IGNORE_LABELS, bankPct } from "@dashmani/shared/src/sales/bank";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, fmtInr } from "@/lib/format";
import { Confirm, Money, StatusPill } from "@/components/sales-ui";
import type { BankCandidate, BankLineView } from "@/lib/sales-types";

// Shared bank pieces: the cache refresh after any line action, the confidence pill, the one-line
// sentence for a candidate, and the phone-first line card of the /bank queue.

/** After any line action: invoices, payments, the dashboard, clients and every bank list. */
export const refreshAfterBankAction = () =>
  mutateGlobal((k) => typeof k === "string" && ["/sales/invoices", "/sales/payments", "/sales/dashboard", "/sales/clients", "/sales/bank"].some((p) => k.startsWith(p)), undefined, { revalidate: true });

/** One message carried to /bank across a navigation (sessionStorage; never required to work). */
const FLASH_KEY = "sales.bank.flash";
export function setBankFlash(message: string) {
  try { sessionStorage.setItem(FLASH_KEY, message); } catch { /* private window: the summary is lost, the import is not */ }
}
export function takeBankFlash(): string | null {
  try { const m = sessionStorage.getItem(FLASH_KEY); sessionStorage.removeItem(FLASH_KEY); return m; } catch { return null; }
}

/** A credit "Confirm" can record as is — the card's button and "Confirm all sure" use this one rule (as the server does). */
export function isSure(line: BankLineView): boolean {
  const top = line.suggestion?.candidates[0] ?? null;
  return line.status === "suggested" && line.confidence === "high" && !!top && !top.stale && !line.suggestion?.conflict
    && !line.suggestion?.receiptCandidates.length && !line.possibleDuplicate;
}

export function ConfidencePill({ confidence }: { confidence: string | null }) {
  if (confidence === "high") return <StatusPill status="matched" label="sure" />;
  if (confidence === "medium") return <StatusPill status="suggested" label="likely" />;
  if (confidence === "low") return <StatusPill status="ignored" label="check" />;
  return null;
}

/** "Filmy Brands · INV/26-27/0016 · TDS 2% ₹2,000.00" */
export function candidateShort(c: BankCandidate): string {
  const inv = c.kind === "advance" ? "as an advance" : c.allocations.map((a) => a.number).join(" + ");
  const tds = c.tdsPaise > 0 ? ` · TDS${c.tdsRateBp ? ` ${bankPct(c.tdsRateBp)}` : ""} ${fmtInr(c.tdsPaise)}` : "";
  return `${c.client.companyName} · ${inv}${tds}`;
}

export function confirmBody(c: BankCandidate) {
  return {
    clientId: c.clientId, amountPaise: c.amountPaise, tdsPaise: c.tdsPaise, tdsRateBp: c.tdsRateBp, tdsSection: c.tdsSection,
    allocations: c.allocations.map((a) => ({ invoiceId: a.invoiceId, amountPaise: a.amountPaise, tdsPaise: a.tdsPaise })),
  };
}

export function LineCard({ line, onToast }: { line: BankLineView; onToast: (message: string, tone?: "ok" | "err") => void }) {
  const [confirming, setConfirming] = useState(false);
  const [reopen, setReopen] = useState(false);
  const top = line.suggestion?.candidates[0] ?? null;
  const isDebit = line.debitPaise > 0;
  const sure = isSure(line);
  const open = ["unmatched", "suggested", "partly_matched"].includes(line.status);
  async function confirmIt() {
    try {
      const r = await apiFetch<{ payment: { number: string } }>(`/sales/bank/lines/${line.id}/confirm`, { method: "POST", body: JSON.stringify(confirmBody(top!)) });
      await refreshAfterBankAction();
      setConfirming(false);
      onToast(`${r.data.payment.number} recorded${top!.allocations.length ? ` — ${top!.allocations.map((a) => a.number).join(", ")} is now paid.` : " as an advance."}`);
    } catch (err) { setConfirming(false); onToast(errorSentence(err), "err"); }
  }
  async function reopenIt() {
    try { await apiFetch(`/sales/bank/lines/${line.id}/reopen`, { method: "POST" }); await refreshAfterBankAction(); setReopen(false); onToast("The credit is back in the review queue."); }
    catch (err) { setReopen(false); onToast(errorSentence(err), "err"); }
  }
  return (
    <li className="card p-3 grid grid-cols-1 gap-2 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="text-sm text-ink-3">{fmtDate(line.txnDate)} · row {line.rowNo}{line.account ? ` · ${line.account.label} ••${line.account.last4}` : ""}</span>
        <span className="flex flex-wrap items-center gap-2">
          <Money paise={isDebit ? line.debitPaise : line.creditPaise} className={`font-bold ${isDebit ? "text-ink-3" : ""}`} />
          {isDebit ? <StatusPill status="ignored" label="withdrawal" /> : <StatusPill status={line.status} />}
          {!isDebit && open && <ConfidencePill confidence={line.confidence} />}
        </span>
      </div>
      {line.redacted ? <p className="text-xs text-ink-4">Withdrawal details are visible to admins.</p>
        : <p className="font-mono text-xs break-all line-clamp-2">{line.narration}</p>}
      {isDebit && line.debitHint?.refund && <p className="text-xs text-attention">Looks like refund {line.debitHint.refund.number}</p>}
      {isDebit && line.debitHint?.reversalOf && <p className="text-xs text-attention">Possible reversal of the credit of {fmtDate(line.debitHint.reversalOf.txnDate)} ({line.debitHint.reversalOf.receiptNumbers.join(", ")}) — void that receipt?</p>}
      {!isDebit && open && top && <p className="text-sm min-w-0 truncate">→ {candidateShort(top)}</p>}
      {!isDebit && open && !top && line.suggestion?.note === "too_large" && <p className="text-sm text-attention">Larger than one receipt can hold — record it in parts.</p>}
      {!isDebit && line.status === "partly_matched" && <p className="text-xs text-ink-3"><Money paise={line.remainingPaise} /> of this credit is left to record.</p>}
      {top?.stale && <p className="text-xs text-attention">Balances changed since — review it.</p>}
      {line.suggestion?.conflict && <p className="text-xs text-ink-3">{line.suggestion.conflict.invoiceNumber} is suggested for the credit of {fmtDate(line.suggestion.conflict.txnDate)}.</p>}
      {line.possibleDuplicate && open && <p className="text-xs text-attention">Possible duplicate of an earlier line.</p>}
      {!!line.suggestion?.receiptCandidates.length && open && <p className="text-xs text-attention">Already recorded? {line.suggestion.receiptCandidates.map((r) => r.number).join(", ")}</p>}
      {line.status === "matched" && line.receipts.filter((r) => r.status === "recorded").map((r) => (
        <p key={r.id} className="text-sm">→ <Link href={`/payments/view?id=${r.id}`} className="font-mono hover:text-indigo-light">{r.number}</Link> · {r.clientName}</p>
      ))}
      {!isDebit && line.status === "ignored" && <p className="text-sm text-ink-3">Ignored — {BANK_IGNORE_LABELS[line.ignoreReason ?? "other"] ?? line.ignoreReason}{line.ignoreNote ? ` · ${line.ignoreNote}` : ""}</p>}
      {!isDebit && (
        <div className="flex flex-wrap gap-2">
          {open && sure && <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>Confirm</button>}
          {open && <Link href={`/bank/line?id=${line.id}`} className={`btn btn-sm ${sure ? "btn-ghost" : ""}`}>Review</Link>}
          {line.status === "ignored" && line.ignoreReason !== "before_cutover" && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReopen(true)}>Reopen</button>}
          {line.status === "ignored" && line.ignoreReason === "before_cutover" && <Link href={`/bank/line?id=${line.id}`} className="btn btn-ghost btn-sm">Open</Link>}
          {line.status === "matched" && <Link href={`/bank/line?id=${line.id}`} className="btn btn-ghost btn-sm">Open</Link>}
        </div>
      )}
      {confirming && top && (
        <Confirm title="Record this receipt?" confirmLabel="Record receipt" onConfirm={confirmIt} onClose={() => setConfirming(false)}
          body={<p>{fmtInr(top.amountPaise)} from {candidateShort(top)}.{top.allocations.length ? " The invoice will be emailed to the client." : ""}</p>} />
      )}
      {reopen && <Confirm title="Put this credit back in the review queue?" confirmLabel="Reopen" onConfirm={reopenIt} onClose={() => setReopen(false)} />}
    </li>
  );
}
