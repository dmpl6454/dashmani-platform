"use client";
import { useState, type Ref } from "react";
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

/** What a failed setup asks of the creator: correct what is marked, or write to us (the API's `attention`). */
type Failure = "fix_details" | "contact_us";

/**
 * `attention` comes from the API. A response without it (an older server during a deploy) is read from what
 * it does carry: fields named → correct them, nothing named → nothing to correct, so write to us.
 */
export function failureOf(account: PayoutAccountView): Failure {
  return account.attention ?? (account.requirements.length > 0 ? "fix_details" : "contact_us");
}

const STATUS: Record<Exclude<Shown, "setting_up" | "failed">, { label: string; tone: Tone; text: string }> = {
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
};

/**
 * The label, tone and sentence for a status. ⚠️ A sentence may point at "below" only when the bank form is
 * really on the page (`formShown`): while bank connect is paused, or the creator is not (or no longer)
 * approved, the form is not rendered and the text says when they can carry on instead of promising it.
 * A refusal only our team can resolve never says "correct the marked details" with nothing marked.
 */
function describeStatus(account: PayoutAccountView, formShown: boolean): { label: string; tone: Tone; text: string } {
  if (account.status === "setting_up") {
    return {
      label: "Setting up",
      tone: "info",
      text: formShown
        ? "We started setting up your payout account with Razorpay, but it isn't finished. Send your details again below to carry on. We don't keep them, so we need them each time."
        : "We started setting up your payout account with Razorpay, but it isn't finished. You can carry on from this page once adding a bank account is available to you again.",
    };
  }
  if (account.status === "failed") {
    if (failureOf(account) === "contact_us") {
      return {
        label: "Needs our team",
        tone: "warn",
        text: "Razorpay couldn't finish setting up your payout account, and this isn't something you can correct on this page. Our team needs to look at it. Email creators@digitalsukoon.com and we'll sort it out with you.",
      };
    }
    return {
      label: "Not accepted",
      tone: "danger",
      text: formShown
        ? "Razorpay didn't accept some of the details. Check the ones marked below, correct them, and send everything again."
        : "Razorpay didn't accept some of the details, listed below. You can correct them and send everything again once adding a bank account is available to you again.",
    };
  }
  // StatusCard returns before calling this for "not_started", the only status the table has no entry for.
  return STATUS[account.status as keyof typeof STATUS];
}

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

/**
 * A request is pending until staff close it; a later request after a closing is pending again. A closed request
 * ended one of two ways, and the API says which (`outcome`): staff carried the change out, or closed the request
 * WITHOUT a change. Only the first may be described as the payout account having been updated; a response that
 * does not say (an older server) gets the neutral "closed" sentence, never "updated".
 */
function bankChangeState(view: PayoutAccountView): "none" | "pending" | "processed" | "declined" | "closed" {
  const { requestedAt, clearedAt, outcome } = view.bankChange;
  if (!requestedAt) return "none";
  if (!clearedAt || new Date(clearedAt).getTime() < new Date(requestedAt).getTime()) return "pending";
  if (outcome === "processed" || outcome === "declined") return outcome;
  return "closed";
}

export interface StatusCardProps {
  account: PayoutAccountView;
  /** The creator can ask for a change here (bank connect is open, the profile is in good standing). */
  actions: boolean;
  email: string | null;
  checking: boolean;
  onCheck: () => void;
  onChanged: (r: PayoutAccountResponse) => void;
  /** The bank form is on this page right now: only then may the text say "below". */
  formShown: boolean;
  /** The details were just sent: a notice leads the card, so it is read after the heading that takes focus. */
  justSent?: boolean;
  /** Lets the page move focus to the heading (it is programmatically focusable, never a tab stop). */
  headingRef?: Ref<HTMLHeadingElement>;
  /**
   * Set when a refusal needs our team and the form can be offered again: the creator opens it themselves,
   * after we have been in touch (a retype in the meantime only spends attempts and clears their fields).
   */
  onTryAgain?: () => void;
}

export function StatusCard({ account, actions, email, checking, onCheck, onChanged, formShown, justSent, headingRef, onTryAgain }: StatusCardProps) {
  const [modal, setModal] = useState(false);
  if (account.status === "not_started") return null;
  const s = describeStatus(account, formShown);
  const rows = requirementRows(account.requirements);
  const change = bankChangeState(account);
  const canChange = actions && account.setupStep === "done" && change !== "pending";

  return (
    <section className="card p-5 sm:p-7 flex flex-col gap-5" aria-labelledby="payout-status-title">
      <div>
        <p className={`inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] font-bold ${TONE_CLASS[s.tone]}`}>
          <span className="w-2 h-2 rounded-full bg-current" aria-hidden /> {s.label}
        </p>
        <h2 ref={headingRef} tabIndex={-1} id="payout-status-title" className="mt-2 text-xl font-extrabold tracking-[-0.03em] outline-none">Payout account</h2>
        {justSent && (
          <div className="mt-3">
            <Banner tone="success" role="status" title="Sent to Razorpay.">
              Your details went to Razorpay and weren&apos;t kept by us. Its review of your payout account is shown here.
            </Banner>
          </div>
        )}
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
          Our team raises it with Razorpay and emails you when it&apos;s done. While the change is pending, any payout that would go to this account is held.
        </Banner>
      )}
      {/* Only what is true and stays true: when it was recorded and what we did. No hold or timing is stated here,
          because the card is read long after the request and this view carries no end date for one. */}
      {change === "processed" && (
        <p className="text-sm text-ink-3 leading-relaxed max-w-2xl">
          Bank change recorded as done on <span className="text-white">{fmtDate(account.bankChange.clearedAt)}</span>. Our team updated your payout account with Razorpay.
        </p>
      )}
      {change === "declined" && (
        <p className="text-sm text-ink-3 leading-relaxed max-w-2xl">
          Your bank change request was closed on <span className="text-white">{fmtDate(account.bankChange.clearedAt)}</span> without a change. Your payout account with Razorpay is as it was. You can ask again whenever you like.
        </p>
      )}
      {change === "closed" && (
        <p className="text-sm text-ink-3 leading-relaxed max-w-2xl">
          Your bank change request was closed on <span className="text-white">{fmtDate(account.bankChange.clearedAt)}</span>.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCheck} disabled={checking}>
          {checking ? <><span className="spinner" aria-hidden /> Checking…</> : <><RefreshCw size={14} aria-hidden /> Check again</>}
        </button>
        {canChange && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModal(true)}>Change bank account</button>
        )}
        {onTryAgain && !formShown && account.status === "failed" && failureOf(account) === "contact_us" && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onTryAgain}>Try again after we&apos;ve been in touch</button>
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
        <p>While the change is pending, any payout that would go to this account is held. Please don&apos;t send bank details by email.</p>
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
