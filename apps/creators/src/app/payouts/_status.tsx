"use client";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { payoutErrorSentence } from "@/lib/messages";
import type { PayoutAccountResponse, PayoutAccountStatus, PayoutAccountView, PayoutRequirement } from "@/lib/types";
import { Banner, Modal } from "@/components/ui";
import { requirementLabel } from "./_form";

// The status card: what Razorpay's review of the payout account has reached, in one sentence, with the
// masked destination, the details Razorpay named (as human labels), and the bank-change request.
//
// ⚠️ Everything shown comes from PayoutAccountView, which carries status, Razorpay field REFERENCES,
// reason CODES and a masked hint, and nothing a creator typed. A reference is shown as a label
// (requirementLabel); a reason code only as one of a few fixed words, never as the API's text.

type Shown = Exclude<PayoutAccountStatus, "not_started">;
type Tone = "info" | "success" | "warn" | "danger";

const STATUS: Record<Shown, { label: string; tone: Tone; text: string }> = {
  setting_up: {
    label: "Setting up",
    tone: "info",
    text: "We started setting up your payout account with Razorpay, but it isn't finished. Send your details again below to carry on. We don't keep them, so we need them each time.",
  },
  under_review: {
    label: "Under review",
    tone: "info",
    text: "Your details are with Razorpay, which is checking your payout account. Nothing more is needed from you right now. We check on its progress and show it here.",
  },
  needs_clarification: {
    label: "Needs more information",
    tone: "warn",
    text: "Razorpay asked for more information about your payout account; what it named is listed below. Our team is alerted when this happens. If you haven't heard from us, email creators@digitalsukoon.com.",
  },
  activated: {
    label: "Active",
    tone: "success",
    text: "Your payout account is active, so you're ready when paid bookings open.",
  },
  suspended: {
    label: "Suspended",
    tone: "danger",
    text: "Razorpay has suspended this payout account. Email creators@digitalsukoon.com and we'll look into it with you.",
  },
  failed: {
    label: "Not accepted",
    tone: "danger",
    text: "Razorpay didn't accept some of the details. Check the ones marked below, correct them, and send everything again.",
  },
};

const TONE_CLASS: Record<Tone, string> = {
  info: "text-indigo-light",
  success: "text-success",
  warn: "text-attention",
  danger: "text-danger",
};

/** A reason code as one of a few fixed words; anything else shows nothing. */
function reasonWord(reason: string): string | null {
  if (reason === "rejected") return "not accepted";
  if (reason === "field_missing" || reason === "required") return "needed";
  return null;
}

/** One line per distinct label (Razorpay may name several references for one form field). */
function requirementRows(requirements: PayoutRequirement[]): Array<{ label: string; word: string | null }> {
  const rows: Array<{ label: string; word: string | null }> = [];
  for (const r of requirements) {
    const label = requirementLabel(r.field);
    if (!rows.some((x) => x.label === label)) rows.push({ label, word: reasonWord(r.reason) });
  }
  return rows;
}

/** A request is pending until staff clear it; a later request after a clearing is pending again. */
function bankChangeState(view: PayoutAccountView): "none" | "pending" | "cleared" {
  const { requestedAt, clearedAt } = view.bankChange;
  if (!requestedAt) return "none";
  if (!clearedAt || new Date(clearedAt).getTime() < new Date(requestedAt).getTime()) return "pending";
  return "cleared";
}

export interface StatusCardProps {
  account: PayoutAccountView;
  /** The creator can ask for a change here (bank connect is open, the profile is in good standing). */
  actions: boolean;
  email: string | null;
  checking: boolean;
  onCheck: () => void;
  onChanged: (r: PayoutAccountResponse) => void;
}

export function StatusCard({ account, actions, email, checking, onCheck, onChanged }: StatusCardProps) {
  const [modal, setModal] = useState(false);
  if (account.status === "not_started") return null;
  const s = STATUS[account.status];
  const rows = requirementRows(account.requirements);
  const change = bankChangeState(account);
  const canChange = actions && account.setupStep === "done" && change !== "pending";

  return (
    <section className="card p-5 sm:p-7 flex flex-col gap-5" aria-labelledby="payout-status-title">
      <div>
        <p className={`inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] font-bold ${TONE_CLASS[s.tone]}`}>
          <span className="w-2 h-2 rounded-full bg-current" aria-hidden /> {s.label}
        </p>
        <h2 id="payout-status-title" className="mt-2 text-xl font-extrabold tracking-[-0.03em]">Payout account</h2>
        <p className="mt-2 text-sm text-ink-3 leading-relaxed max-w-2xl">{s.text}</p>
      </div>

      {rows.length > 0 && (
        <div>
          <h3 className="field-label">{account.status === "failed" ? "Razorpay didn't accept" : "Razorpay asked about"}</h3>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm">
            {rows.map((r) => (
              <li key={r.label} className="flex flex-wrap gap-x-2">
                <span className="font-semibold text-white">{r.label}</span>
                {r.word && <span className="text-ink-3">{r.word}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(account.destinationHint || account.activatedAt || account.updatedAt) && (
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
          {account.destinationHint && (
            <div>
              <dt className="field-label">Bank account</dt>
              <dd className="mt-1 font-mono text-white break-all">{account.destinationHint}</dd>
            </div>
          )}
          {account.status === "activated" && account.activatedAt && (
            <div>
              <dt className="field-label">Active since</dt>
              <dd className="mt-1 text-white">{fmtDate(account.activatedAt)}</dd>
            </div>
          )}
          {account.updatedAt && (
            <div>
              <dt className="field-label">Last updated</dt>
              <dd className="mt-1 text-white">{fmtDate(account.updatedAt)}</dd>
            </div>
          )}
        </dl>
      )}

      {change === "pending" && (
        <Banner tone="info" title={`Bank change requested on ${fmtDate(account.bankChange.requestedAt)}`}>
          Our team raises it with Razorpay and emails you when it&apos;s done. Any payout to this account is paused until then.
        </Banner>
      )}
      {change === "cleared" && (
        <Banner tone="success" title={`Bank change recorded as done on ${fmtDate(account.bankChange.clearedAt)}`}>
          Payouts to this account stay on hold for a further checking period after a bank change.
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCheck} disabled={checking}>
          {checking ? <><span className="spinner" aria-hidden /> Checking…</> : <><RefreshCw size={14} aria-hidden /> Check again</>}
        </button>
        {canChange && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModal(true)}>Change bank account</button>
        )}
      </div>

      <p className="text-xs text-ink-4 leading-relaxed max-w-2xl">
        We don&apos;t store your PAN or bank details. We keep only Razorpay&apos;s reference to your account, its status and the masked account above.
      </p>

      {modal && <BankChangeModal email={email} onClose={() => setModal(false)} onDone={(r) => { setModal(false); onChanged(r); }} />}
    </section>
  );
}

function BankChangeModal({ email, onClose, onDone }: { email: string | null; onClose: () => void; onDone: (r: PayoutAccountResponse) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function ask() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch<PayoutAccountResponse>("/creator/payout-account/bank-change", { method: "POST" });
      onDone(r.data);
    } catch (err) {
      setError(payoutErrorSentence(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Change your bank account?" onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm text-ink-3 leading-relaxed">
        <p>
          Razorpay changes a payout bank account through a support request, so it can&apos;t be switched here. If you continue, our team
          raises the change with Razorpay and emails you{email ? <> at <span className="text-white break-words">{email}</span></> : null} when
          it&apos;s done.
        </p>
        <p>Any payout to this account is paused while the change is pending. Please don&apos;t send bank details by email.</p>
      </div>
      {error && <Banner tone="danger" role="alert">{error}</Banner>}
      <div className="flex flex-wrap gap-2 justify-end">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Keep my current account</button>
        <button type="button" className="btn btn-sm" onClick={ask} disabled={busy}>
          {busy ? <><span className="spinner" aria-hidden /> Sending…</> : "Ask us to change it"}
        </button>
      </div>
    </Modal>
  );
}
