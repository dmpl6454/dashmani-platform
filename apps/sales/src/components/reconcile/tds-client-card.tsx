"use client";
// One client on the TDS tab: verdict, PAN / TAN, the four quarters "ours / 26AS", the reasons and
// the entries; "Copy what to ask" puts the chase sentences on the clipboard.
import Link from "next/link";
import { StatusPill } from "@/components/sales-ui";
import { fmtInr } from "@/lib/format";
import { TDS_GROUP_LABEL } from "@/lib/reconcile";
import type { TdsReconView, TdsRow } from "@/lib/sales-types";
import { TdsRowDetail } from "./tds-row";

const TONE: Record<string, string> = { matched: "text-success", not_in_26as: "text-danger", short: "text-danger", extra: "text-attention", link_first: "text-attention", not_due: "text-ink-3", none: "text-ink-4" };

export function TdsClientCard({ c, rows, ourPan, onCopied }: { c: TdsReconView["clients"][number]; rows: TdsRow[]; ourPan: string | null; onCopied: (msg: string) => void }) {
  const chase = rows.filter((r) => r.group === "chase");
  const copy = async () => {
    const text = [...chase.map((r) => r.reason.text), `Your PAN: ${c.pan ?? "—"} · Our PAN: ${ourPan ?? "—"}`].join("\n\n");
    try { await navigator.clipboard.writeText(text); onCopied("Copied — paste it into your email to the client"); } catch { onCopied("Couldn't copy — select the text in Entries instead"); }
  };
  return (
    <article className="card p-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h3 className="font-bold truncate min-w-0">{c.name}</h3>
        <StatusPill status={c.verdict} label={TDS_GROUP_LABEL[c.verdict]} />
      </div>
      <p className="text-xs text-ink-3 font-mono break-all mb-2">PAN {c.pan ?? "—"} · TAN {c.tans.join(", ") || "—"}</p>
      <div className="grid grid-cols-4 gap-1 text-xs font-mono mb-2" aria-label="Quarters: ours / 26AS">
        {c.quarters.map((q) => (
          <div key={q.q} className={`border border-rule p-1 min-w-0 ${TONE[q.verdict] ?? ""}`} title={q.verdict.replace(/_/g, " ")}>
            <div className="text-ink-3">Q{q.q}{q.pairedFrom.length ? ` ↔ Q${q.pairedFrom.join(",")}` : ""}</div>
            <div className="truncate">{fmtInr(q.booksPaise, { whole: true })}</div>
            <div className="truncate">{fmtInr(q.form26Paise, { whole: true })}</div>
          </div>
        ))}
      </div>
      {rows.filter((r) => r.group !== "matched").slice(0, 4).map((r) => <p key={r.key} className="text-sm mb-1">{r.reason.text}</p>)}
      <details className="mt-1">
        <summary className="text-xs text-ink-3 cursor-pointer">Entries ({rows.length})</summary>
        {rows.map((r) => <TdsRowDetail key={r.key} r={r} />)}
      </details>
      <div className="flex flex-wrap gap-2 mt-3">
        {chase.length > 0 && <button type="button" className="btn btn-light btn-sm" onClick={copy}>Copy what to ask</button>}
        <Link href={`/clients/view?id=${c.clientId}`} className="btn btn-ghost btn-sm">Open client</Link>
      </div>
    </article>
  );
}
