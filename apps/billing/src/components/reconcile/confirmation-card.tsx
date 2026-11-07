"use client";
// One client on the balances tab: balance (Dr/Cr), confirmation state, and the actions.
import Link from "next/link";
import { StatusPill } from "@/components/sales-ui";
import { daysBetween, fmtDate, todayIST } from "@/lib/format";
import { drCrText } from "@/lib/reconcile";
import type { ConfirmationsView } from "@/lib/sales-types";

export function ConfirmationCard({ r, asOf, from, checked, onCheck, onSend, onReply }: {
  r: ConfirmationsView["rows"][number]; asOf: string; from: string; checked: boolean; onCheck: (v: boolean) => void; onSend: () => void; onReply: () => void;
}) {
  const s = r.confirmation;
  const pill = !s || s.sentCount === 0 ? { status: "not_sent", label: "not sent" } : s.stale ? { status: "stale", label: "changed" } : s.overdue ? { status: "overdue", label: "overdue" } : { status: s.status, label: s.status };
  const state = !s ? (r.balancePaise !== 0 ? "Not sent" : "No balance")
    : s.sending ? "Sending…"
    : s.stuck ? "Not sent — send again"
    : s.lastSendError && s.sentCount === 0 ? s.lastSendError
    : s.sentCount === 0 ? "Not sent"
    : `Sent ${fmtDate(s.lastSentAt)} to ${s.lastSentTo ?? "—"}${s.status === "pending" && s.lastSentAt ? ` · waiting ${daysBetween(s.lastSentAt.slice(0, 10), todayIST())} days` : ""}`;
  return (
    <article className="card p-3 min-w-0">
      <div className="flex items-start gap-2 min-w-0">
        <input type="checkbox" className="mt-1" aria-label={`Select ${r.name}`} checked={checked} onChange={(e) => onCheck(e.target.checked)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold truncate min-w-0">{r.name}</h3><StatusPill status={pill.status} label={pill.label} /></div>
          <p className="text-sm"><span className="font-mono">{drCrText(r.balancePaise)}</span>{r.lastConfirmed ? ` · last confirmed ${fmtDate(r.lastConfirmed)}` : ""}</p>
          <p className="text-xs text-ink-3 break-words">{state}</p>
          {s?.stale && <p className="text-xs text-attention">Our figures changed since it was sent ({drCrText(s.ourBalancePaise, false)} → {drCrText(r.balancePaise, false)})</p>}
          {s?.status === "disputed" && <p className="text-xs text-danger">Their figure {drCrText(s.theirBalancePaise ?? 0, false)} · difference {drCrText(s.differencePaise ?? 0, false)}{s.responseNote ? ` · ${s.responseNote}` : ""}</p>}
          <div className="flex flex-wrap gap-2 mt-2">
            <Link href={`/reconcile/ledger?clientId=${r.clientId}&from=${from}&to=${asOf}`} className="btn btn-ghost btn-sm">Statement</Link>
            <button type="button" className="btn btn-light btn-sm" disabled={!!s?.sending || (s ? s.status !== "pending" : false)} onClick={onSend}>{s && s.sentCount > 0 ? "Resend" : "Send"}</button>
            {s && <button type="button" className="btn btn-ghost btn-sm" onClick={onReply}>Record reply</button>}
          </div>
        </div>
      </div>
    </article>
  );
}
