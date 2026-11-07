"use client";
import { useState } from "react";
import { BANK_PRESET_LABELS } from "@dashmani/shared/src/sales/bank";
import { useBankAccounts, useSeller } from "@/lib/hooks";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate } from "@/lib/format";
import { Field, LoadError, StatusPill, Toast } from "@/components/sales-ui";
import type { BankAccount } from "@/lib/sales-types";

// Settings → Bank accounts (#bank). Each company's bank account(s), set by an Admin; statements are
// uploaded against them on /bank. Credits before "Match credits from" are imported but never
// matched (owner: from 1 April 2023). Non-admins read the list.

const BANKS = Object.keys(BANK_PRESET_LABELS);

export function BankAccountsCard() {
  const { company, info } = useCompany();
  const { user } = useAuth();
  const admin = isAdminUser(user);
  const { data: accounts, error: accError, mutate } = useBankAccounts();
  const { data: seller } = useSeller();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BankAccount | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  async function run(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); await mutate(); setToast({ message: ok, tone: "ok" }); setAdding(false); setEditing(null); }
    catch (err) { setToast({ message: errorSentence(err), tone: "err" }); }
  }
  const p = seller?.profile;
  return (
    <section id="bank" className="card p-4 mt-6 grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">Bank accounts <span className="text-ink-3 font-normal text-xs">{info.name}</span></h2>
        {admin && !adding && <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>Add account</button>}
      </div>
      {accError ? <LoadError error={accError} retry={() => mutate()} /> : !accounts ? <p className="text-sm text-ink-3">Loading…</p> : !accounts.length ? <p className="text-sm text-ink-3">No bank account yet. {admin ? "Add the account the company's money comes into." : "An admin adds it here."}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-[0.1em] text-ink-3"><th className="p-2">Label</th><th className="p-2">Bank</th><th className="p-2">Account</th><th className="p-2">IFSC</th><th className="p-2">Matching from</th><th className="p-2">Last statement</th><th className="p-2"></th></tr></thead>
            <tbody className="divide-y divide-rule">
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td className="p-2">{a.label} {a.status === "archived" && <StatusPill status="ignored" label="archived" />}</td>
                  <td className="p-2">{BANK_PRESET_LABELS[a.bank]}</td>
                  <td className="p-2 font-mono">••{a.last4}</td>
                  <td className="p-2 font-mono">{a.ifsc ?? "—"}</td>
                  <td className="p-2">{a.matchFrom ? fmtDate(a.matchFrom) : "every credit"}</td>
                  <td className="p-2">{a.lastStatementTo ? fmtDate(a.lastStatementTo) : "—"}</td>
                  <td className="p-2 text-right whitespace-nowrap">{admin && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(a)}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {admin && adding && (
        <AccountForm title="Add a bank account" initial={{ label: p?.bankName ? `${p.bankName} current` : "", bank: "other", accountNumber: (p?.accountNumber ?? "").replace(/\D/g, ""), ifsc: p?.ifsc ?? "", matchFrom: "2023-04-01" }}
          prefilled={!!p?.accountNumber} onCancel={() => setAdding(false)}
          onSave={(v) => run(() => apiFetch("/sales/bank/accounts", { method: "POST", body: JSON.stringify({ companyKey: company, label: v.label, bank: v.bank, accountNumber: v.accountNumber, ifsc: v.ifsc || null, matchFrom: v.matchFrom || null }) }), "Bank account added.")} />
      )}
      {admin && editing && (
        <AccountForm title={`Edit ${editing.label}`} editing initial={{ label: editing.label, bank: editing.bank, accountNumber: editing.accountNumber, ifsc: editing.ifsc ?? "", matchFrom: editing.matchFrom ?? "" }}
          onCancel={() => setEditing(null)} archived={editing.status === "archived"}
          onArchive={() => run(() => apiFetch(`/sales/bank/accounts/${editing.id}`, { method: "PUT", body: JSON.stringify({ status: editing.status === "archived" ? "active" : "archived" }) }), editing.status === "archived" ? "Account restored." : "Account archived.")}
          onSave={(v) => run(() => apiFetch(`/sales/bank/accounts/${editing.id}`, { method: "PUT", body: JSON.stringify({ label: v.label, ifsc: v.ifsc || null, matchFrom: v.matchFrom || null }) }), "Bank account saved.")} />
      )}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </section>
  );
}

type Values = { label: string; bank: string; accountNumber: string; ifsc: string; matchFrom: string };
function AccountForm({ title, initial, onSave, onCancel, editing, prefilled, archived, onArchive }: { title: string; initial: Values; onSave: (v: Values) => void; onCancel: () => void; editing?: boolean; prefilled?: boolean; archived?: boolean; onArchive?: () => void }) {
  const [v, setV] = useState<Values>(initial);
  const set = (k: keyof Values, val: string) => setV({ ...v, [k]: val });
  return (
    <div className="card-inset p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
      <h3 className="font-bold sm:col-span-2">{title}</h3>
      {prefilled && <p className="text-xs text-ink-3 sm:col-span-2">Pre-filled from the bank details printed on invoices.</p>}
      <Field label="Label"><input className="input" value={v.label} onChange={(e) => set("label", e.target.value)} placeholder="IDFC First current" /></Field>
      <Field label="Bank"><select className="input" value={v.bank} disabled={editing} onChange={(e) => set("bank", e.target.value)}>{BANKS.map((b) => <option key={b} value={b}>{BANK_PRESET_LABELS[b]}</option>)}</select></Field>
      <Field label="Account number" hint={editing ? "The number cannot change — archive and add a new account instead" : "Digits only"}><input className="input font-mono" inputMode="numeric" value={v.accountNumber} disabled={editing} onChange={(e) => set("accountNumber", e.target.value.replace(/\D/g, ""))} /></Field>
      <Field label="IFSC"><input className="input font-mono uppercase" value={v.ifsc} onChange={(e) => set("ifsc", e.target.value.toUpperCase())} /></Field>
      <Field label="Match credits from" hint="Credits before this date are imported but never matched — their invoices may still be in Swipe"><input type="date" className="input" value={v.matchFrom} onChange={(e) => set("matchFrom", e.target.value)} /></Field>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="button" className="btn" onClick={() => onSave(v)}>{editing ? "Save" : "Add account"}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        {editing && onArchive && <button type="button" className="btn btn-ghost" onClick={onArchive}>{archived ? "Restore" : "Archive"}</button>}
      </div>
    </div>
  );
}
