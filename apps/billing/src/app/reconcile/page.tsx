"use client";
// sales.digitalsukoon.com/reconcile (spec-reconcile §7.2): TDS · 26AS, GST · GSTR-1 and Client
// balances for the company in the switcher, plus the Bank tab (bank reconciliation, PR 6). Tab and
// filters live in the URL; nothing on this page changes an invoice or a receipt.
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCompany } from "@/lib/company";
import { Loading, PageHead, Toast } from "@/components/sales-ui";
import { TabBar } from "@/components/reconcile/tab-bar";
import { TdsTab } from "@/components/reconcile/tds-tab";
import { GstTab } from "@/components/reconcile/gst-tab";
import { BalancesTab } from "@/components/reconcile/balances-tab";
import { BankTab } from "@/components/reconcile/bank-tab";
import { useBankAccounts } from "@/lib/hooks";

type Tab = "bank" | "tds" | "gst" | "balances";
const TABS: Array<{ key: Tab; label: string }> = [
  // smart-invoicing: reconcile BRS (PR 6) — the Bank tab goes first here
  { key: "bank", label: "Bank" },
  { key: "tds", label: "TDS · 26AS" },
  { key: "gst", label: "GST · GSTR-1" },
  { key: "balances", label: "Client balances" },
];

function Reconcile() {
  const params = useSearchParams();
  const router = useRouter();
  const { info } = useCompany();
  const tabParam = params.get("tab") as Tab | null;
  // Default: Bank when the company has an active bank account, else TDS (spec §7.2).
  const { data: accounts, error: accountsError } = useBankAccounts();
  const pending = !tabParam && accounts === undefined && !accountsError;
  const hasAccount = (accounts ?? []).some((a) => a.status === "active");
  const tab: Tab = tabParam && TABS.some((t) => t.key === tabParam) ? tabParam : hasAccount ? "bank" : "tds";
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  const say = (message: string, tone: "ok" | "err" = "ok") => setToast({ message, tone });
  const go = (next: Record<string, string | undefined>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k); }
    router.replace(`/reconcile?${p.toString()}`);
  };
  return (
    <>
      <PageHead kicker={`Reconcile · ${info.short}`} title="Reconcile" />
      <TabBar tabs={TABS} current={tab} onPick={(t) => go({ tab: t })} />
      {pending && <Loading />}
      {!pending && tab === "bank" && <BankTab accountId={params.get("account") ?? undefined} onAccount={(account) => go({ account })} />}
      {!pending && tab === "tds" && <TdsTab fy={params.get("fy") ?? undefined} onFy={(fy) => go({ fy })} toast={say} />}
      {tab === "gst" && <GstTab gstin={params.get("gstin") ?? undefined} period={params.get("period") ?? undefined} onScope={(gstin, period) => go({ gstin, period })} toast={say} />}
      {tab === "balances" && <BalancesTab asOf={params.get("asOf") ?? undefined} from={params.get("from") ?? undefined} onDates={(asOf, from) => go({ asOf, from })} toast={say} />}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function ReconcilePage() {
  return <Suspense fallback={<Loading />}><Reconcile /></Suspense>;
}
