"use client";
// Reconcile → Bank (spec-reconcile §7.6): one card per month of the chosen account, newest first;
// each opens the bank reconciliation statement. Figures come from Bank's uploaded statements.
import Link from "next/link";
import { useBrsMonths } from "@/lib/hooks";
import { useCompany } from "@/lib/company";
import { fmtDate } from "@/lib/format";
import { Empty, LoadError, Loading, Money, StatusPill } from "@/components/sales-ui";

export const BRS_STATE_LABEL: Record<string, string> = { running: "figures so far", open: "open", reconciled: "reconciled", changed: "changed" };

export function BankTab({ accountId, onAccount }: { accountId?: string; onAccount: (id: string) => void }) {
  const { info } = useCompany();
  const { data, error, isLoading, mutate } = useBrsMonths(accountId);
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !data) return <Loading label="Reading the statements…" />;
  if (!data.account) {
    return <Empty title={`No bank account set up for ${info.name}.`} body="An admin adds it in Settings → Bank accounts; statements uploaded on Bank are reconciled here." action={<Link href="/bank" className="btn">Open Bank</Link>} />;
  }
  const acc = data.account;
  return (
    <div className="grid grid-cols-1 gap-4">
      {data.accounts.length > 1 && (
        <label className="grid grid-cols-[minmax(0,1fr)] gap-1 max-w-md">
          <span className="text-xs text-ink-3">Account</span>
          <select className="input" value={acc.id} onChange={(e) => onAccount(e.target.value)}>
            {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.label} ••{a.last4}{a.isDefault ? " · counts receipts not on any statement" : ""}</option>)}
          </select>
        </label>
      )}
      <p className="text-sm text-ink-3">
        {acc.label} ••{acc.last4} — receipts side: the bank statement next to the receipts recorded in the portal, month by month.
        {data.defaultAccount?.id === acc.id && " Receipts by transfer, UPI or cheque that are not on any statement count against this account."}
      </p>
      {!data.months.length ? (
        <Empty title={`No statement of ${acc.label} ••${acc.last4} yet.`} body="Upload a statement on Bank — each month it covers can then be reconciled here." action={<Link href="/bank/upload" className="btn">Upload a statement</Link>} />
      ) : (
        <ul className="grid grid-cols-1 gap-2">
          {data.months.map((m) => (
            <li key={m.month}>
              <Link href={`/reconcile/brs?accountId=${acc.id}&month=${m.month}`} className="card p-4 grid grid-cols-1 gap-1 hover:border-indigo-light">
                <span className="flex flex-wrap items-center gap-2 min-w-0">
                  <span className="font-bold">{m.label}</span>
                  <StatusPill status={m.state} label={BRS_STATE_LABEL[m.state]} />
                </span>
                <span className="text-sm text-ink-3">Credits <Money paise={m.creditsPaise} /> · Withdrawals <Money paise={m.debitsPaise} /> · {m.lineCount} line{m.lineCount === 1 ? "" : "s"}</span>
                <span className="text-xs text-ink-3">
                  {m.state === "reconciled" && m.reconciledAt ? `Reconciled ${fmtDate(m.reconciledAt)} by ${m.reconciledByName} · v${m.version}`
                    : m.state === "changed" && m.reconciledAt ? `Reopened automatically — changed since ${fmtDate(m.reconciledAt)}`
                    : m.coverage === "none" ? "No statement covers this month"
                    : m.coverageNote ? m.coverageNote
                    : m.state === "running" ? "Figures so far" : "Not reconciled yet"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
