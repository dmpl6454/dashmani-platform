"use client";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { PayoutAccountStatus, PayoutAccountView, PayoutSetupStep } from "@dashmani/shared/src/validators/creator-payout";
import { formatStatus } from "@dashmani/shared/src/utils/status";
import { apiFetch } from "@/lib/api";
import type { AdminCreatorDetail } from "@/lib/hooks/use-creators";
import { BTN_GHOST, BTN_GOLD, CARD, ErrorBar, StatusPill, fmtWhen } from "../campaigns/_ds";

// The "Payout account" card on /creators/[id]: a creator's Razorpay linked account as staff need to see
// it (creator payouts, Phase 2). `_` keeps Next from routing this file.
//
// ⚠️ PRIVACY. The API never sends, and we never keep, a creator's PAN, bank account number, IFSC, name or
// address: only Razorpay ids, status, requirement REFERENCES and reason codes, and a masked hint
// ("HDFC ••••1012"). This card renders exactly those and nothing is read from a form, a URL or storage.
//
// ⚠️ HONEST STATES. A failed load is never drawn as "no payout account": there are four distinct
// answers (not sent by this API yet / could not be read / none yet / an account) and each says what it is.

/** The staff-only fields GET /v1/admin/creators/:id adds to the shared payout view. */
export interface AdminPayoutAccount extends PayoutAccountView {
  razorpayAccountId: string | null;
  razorpayStakeholderId: string | null;
  razorpayProductId: string | null;
  /** A short code such as DETAILS_REJECTED; never Razorpay's own text. */
  lastErrorCode: string | null;
  lastCheckedAt: string | null;
  accountCreatedAt: string | null;
  bankChangePending: boolean;
  releaseHold: { active: boolean; resumesAt: string | null };
}

/** What the detail response carries beyond AdminCreatorDetail (every key optional: an older API sends none). */
interface PayoutDetailFields {
  payoutAccount: AdminPayoutAccount | null;
  payoutRouteEnabled: boolean;
  payoutAccountError: boolean;
}

export type PayoutPanelState =
  | { kind: "unsent" }
  | { kind: "error" }
  | { kind: "none"; routeEnabled: boolean }
  | { kind: "account"; account: AdminPayoutAccount };

/**
 * One place that decides what the response says. The three payout keys are read off the detail through a
 * Partial, because during a deploy this page can be newer than the API: an absent key means "the server
 * did not send it", which is its own state and must not be drawn as "no payout account".
 */
export function payoutPanelState(detail: AdminCreatorDetail): PayoutPanelState {
  const d = detail as AdminCreatorDetail & Partial<PayoutDetailFields>;
  if (d.payoutAccountError === true) return { kind: "error" };
  if (d.payoutAccount === undefined) return { kind: "unsent" };
  if (d.payoutAccount === null) return { kind: "none", routeEnabled: d.payoutRouteEnabled !== false };
  return { kind: "account", account: d.payoutAccount };
}

// ── Wording ─────────────────────────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<PayoutAccountStatus, string> = {
  not_started: "#4E5F70",
  setting_up: "#738395",
  under_review: "#E9BD62",
  needs_clarification: "#F59E66",
  activated: "#00D7A0",
  suspended: "#F59E66",
  failed: "#FB7185",
};
const STATUS_MAP: Record<string, { label: string; color: string }> = Object.fromEntries(
  Object.entries(STATUS_TONE).map(([k, color]) => [k, { label: formatStatus(k), color }]),
);

const STATUS_NOTE: Record<PayoutAccountStatus, string> = {
  not_started: "The creator has not started adding a bank account.",
  setting_up: "Setup is not finished. The creator can resume it from their payouts page.",
  under_review: "Razorpay is verifying the account. It sends no notice of the result, so we re-check every few minutes.",
  needs_clarification: "Razorpay needs something corrected. What it still asks for is listed below.",
  activated: "Verified and active.",
  suspended: "Razorpay has suspended this account. Check it in Razorpay before anything is released.",
  failed: "Razorpay rejected what the creator entered. They need to correct it and submit again.",
};

const STEP_TEXT: Record<PayoutSetupStep, string> = {
  account: "Next: create the Razorpay account (step 1 of 4)",
  stakeholder: "Next: add the stakeholder (step 2 of 4)",
  product: "Next: request Route settlements (step 3 of 4)",
  bank: "Next: add the settlement bank details (step 4 of 4)",
  done: "All four Razorpay steps are done",
};

/** `last_error` is only ever a code. This is what staff read for each one we write. */
const ERROR_TEXT: Record<string, string> = {
  DETAILS_REJECTED: "Razorpay rejected the details the creator entered.",
  PAN_REJECTED: "Razorpay rejected the PAN the creator entered.",
  BANK_DETAILS_REJECTED: "Razorpay rejected the bank details the creator entered.",
  ACCOUNT_CONFLICT: "Razorpay already has an account under this email that we could not safely link. A person needs to check it.",
  ACCOUNT_UNKNOWN: "We did not hear back about creating the account. The creator can submit again; check Razorpay if it repeats.",
  PRODUCT_UNKNOWN: "We did not hear back about the settlement request. Check the account in Razorpay before the creator retries.",
  RAZORPAY_UNAVAILABLE: "Razorpay did not answer on the last attempt.",
};

/**
 * A Razorpay requirement reference as a person would say it. Keyword based, like the creator form, because
 * Razorpay spells one field more than one way; the raw reference is always shown beside it. An unknown
 * reference is made readable rather than hidden.
 */
const REFERENCE_LABELS: Array<[RegExp, string]> = [
  [/ifsc/i, "Bank IFSC code"],
  [/account.?number|bank.?account/i, "Bank account number"],
  [/beneficiary/i, "Account holder name"],
  [/(^|[^a-z])pan([^a-z]|$)/i, "PAN"],
  [/postal|pin.?code/i, "PIN code"],
  [/state/i, "State"],
  [/city/i, "City"],
  [/street/i, "Street address"],
  [/phone|contact.?number/i, "Phone number"],
  [/tnc|terms/i, "Razorpay terms"],
  [/email/i, "Email"],
  [/name/i, "Name"],
  [/address/i, "Address"],
];
export function requirementLabel(reference: string): string {
  for (const [re, label] of REFERENCE_LABELS) if (re.test(reference)) return label;
  const words = reference.replace(/[._[\]-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Something Razorpay needs";
}

// ── Layout bits ─────────────────────────────────────────────────────────────────────────────────

// The label stacks above its value on a phone and sits beside it from `sm`; the value may wrap anywhere,
// so an id or reference never pushes the card wider than the screen.
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3 py-2 border-b border-[#132430] last:border-0 text-[13px]">
      <div className="sm:w-[150px] sm:shrink-0 text-ds-t3">{label}</div>
      <div className="min-w-0 flex-1 text-ds-text break-words">{children}</div>
    </div>
  );
}

const MONO = "font-mono text-[12px] text-ds-t2 break-all";

function BankChangeDialog({
  busy, error, onCancel, onConfirm,
}: { busy: boolean; error: string; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="bank-change-title" className={`${CARD} w-full max-w-[480px] p-5`}>
        <h2 id="bank-change-title" className="text-[16px] font-semibold text-ds-text">Mark the bank change processed?</h2>
        <p className="mt-1.5 text-[13px] text-ds-t2">
          Do this only once Razorpay support has confirmed the new bank details. The creator is emailed that it is done (no bank details are in the email).
        </p>
        <p className="mt-2 text-[13px] text-ds-gold">Payouts for this creator stay paused until 72 hours after you mark it processed.</p>
        {error && <div className="mt-3"><ErrorBar message={error} /></div>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={BTN_GHOST} onClick={onCancel} disabled={busy} autoFocus>Cancel</button>
          <button type="button" className={BTN_GOLD} onClick={onConfirm} disabled={busy}>{busy ? "Working…" : "Mark processed"}</button>
        </div>
      </div>
    </div>
  );
}

// ── The card ────────────────────────────────────────────────────────────────────────────────────

export function PayoutAccountCard({
  creatorId, detail, refreshing, refreshFailed, onRefresh, onProcessed,
}: {
  creatorId: string;
  detail: AdminCreatorDetail;
  /** A re-read is in flight (the Check again button). */
  refreshing: boolean;
  /** The last re-read failed, so what is shown is the last answer we did get. */
  refreshFailed: boolean;
  onRefresh: () => void;
  /** The action worked: the page swaps its data for the answer and says whether the creator was emailed. */
  onProcessed: (next: AdminCreatorDetail, emailSent: boolean | undefined) => void;
}) {
  const state = payoutPanelState(detail);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const markProcessed = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await apiFetch<{ data: AdminCreatorDetail }>(`/admin/creators/${creatorId}/payout-account/bank-change/cleared`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const { emailSent, ...next } = r.data;
      setConfirming(false);
      onProcessed(next, emailSent);
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "That didn't work.");
      // Most likely another staff member got there first: show what is true now.
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const account = state.kind === "account" ? state.account : null;

  return (
    <section className={`${CARD} p-5 mb-4`} aria-labelledby="payout-account-title" aria-busy={refreshing}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-2">
        <h2 id="payout-account-title" className="text-[15px] font-semibold text-ds-text">Payout account</h2>
        {account && <StatusPill status={account.status} map={STATUS_MAP} />}
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1.5 text-[12.5px] text-ds-t3 hover:text-ds-text disabled:opacity-50"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden />
          {refreshing ? "Checking…" : "Check again"}
        </button>
      </div>

      {refreshFailed && (
        <div role="alert" className="mb-3 px-3 py-2 rounded-[8px] bg-[rgba(233,189,98,.08)] border border-[rgba(233,189,98,.35)] text-ds-gold text-[12.5px]">
          Couldn&apos;t refresh just now. This is the last answer we did get.
        </div>
      )}

      {state.kind === "unsent" && (
        <p className="text-[13px] text-ds-t3">
          The server did not send payout details with this creator. It may be updating; check again in a minute. This does not mean they have no payout account.
        </p>
      )}

      {state.kind === "error" && (
        <div className="space-y-2">
          <ErrorBar message="Couldn't read this creator's payout account. That is a loading problem, not a sign they have none." />
          <p className="text-[12.5px] text-ds-t3">Try again; if it keeps failing, tell engineering (payout reads are failing on the server).</p>
        </div>
      )}

      {state.kind === "none" && (
        <p className="text-[13px] text-ds-t3">
          No payout account yet. This creator has not started adding a bank account.
          {!state.routeEnabled && " Adding one is switched off for creators right now."}
        </p>
      )}

      {account && (
        <>
          <p className="text-[13px] text-ds-t2 mb-2">{STATUS_NOTE[account.status]}</p>

          <Line label="Setup">{STEP_TEXT[account.setupStep]}</Line>
          <Line label="Bank account">
            {account.destinationHint ? (
              <>
                <span className="font-mono">{account.destinationHint}</span>
                <span className="block text-[11.5px] text-ds-t4">Masked. We never keep the full number.</span>
              </>
            ) : "—"}
          </Line>
          <Line label="Activated">{fmtWhen(account.activatedAt)}</Line>
          <Line label="Can be booked after">
            {fmtWhen(account.bookableAfter)}
            {account.bookableAfter && <span className="block text-[11.5px] text-ds-t4">A day after activation.</span>}
          </Line>
          <Line label="Last checked">{account.lastCheckedAt ? fmtWhen(account.lastCheckedAt) : "Not checked yet"}</Line>

          {account.requirements.length > 0 && (
            <Line label="Razorpay still needs">
              <ul className="space-y-1.5">
                {account.requirements.map((r, i) => (
                  <li key={`${r.field}-${i}`} className="min-w-0">
                    <span className="font-semibold">{requirementLabel(r.field)}</span>
                    <span className="text-ds-t3"> · {formatStatus(r.reason)}</span>
                    <span className={`block ${MONO}`}>{r.field}</span>
                  </li>
                ))}
              </ul>
            </Line>
          )}

          {account.lastErrorCode && (
            <Line label="Last problem">
              <span className="text-[#FB7185]">{ERROR_TEXT[account.lastErrorCode] ?? formatStatus(account.lastErrorCode)}</span>
              <span className={`block ${MONO}`}>{account.lastErrorCode}</span>
            </Line>
          )}

          <Line label="Razorpay account">
            {account.razorpayAccountId ? <span className={MONO}>{account.razorpayAccountId}</span> : <span className="text-ds-t3">Not created yet</span>}
            {account.razorpayStakeholderId && <span className={`block ${MONO}`}>{account.razorpayStakeholderId} · stakeholder</span>}
            {account.razorpayProductId && <span className={`block ${MONO}`}>{account.razorpayProductId} · route product</span>}
            {account.accountCreatedAt && <span className="block text-[11.5px] text-ds-t4">Created {fmtWhen(account.accountCreatedAt)}</span>}
          </Line>

          <div className="mt-3 border-t border-[#132430] pt-3">
            <div className="text-[13px] font-semibold text-ds-text">Bank change</div>
            {!account.bankChange.requestedAt ? (
              <p className="mt-1 text-[13px] text-ds-t3">None requested.</p>
            ) : account.bankChangePending ? (
              <div className="mt-2 rounded-[10px] border border-[rgba(233,189,98,.35)] bg-[rgba(233,189,98,.06)] p-3.5">
                <p className="text-[13px] text-ds-gold font-semibold">Bank change requested {fmtWhen(account.bankChange.requestedAt)}</p>
                <p className="mt-1 text-[12.5px] text-ds-t2">
                  Razorpay&apos;s API cannot change a bank account: raise it with Razorpay support, then mark it processed here once they confirm.
                  Payouts for this creator are paused from the request until then.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <button type="button" className={BTN_GOLD} onClick={() => { setErr(""); setConfirming(true); }}>Mark bank change processed</button>
                </div>
                <p className="mt-2 text-[12px] text-ds-t3">Payouts for this creator stay paused until 72 hours after you mark it processed.</p>
              </div>
            ) : (
              <p className="mt-1 text-[13px] text-ds-t2">
                Requested {fmtWhen(account.bankChange.requestedAt)}, marked processed {fmtWhen(account.bankChange.clearedAt)}.{" "}
                {account.releaseHold.active && account.releaseHold.resumesAt
                  ? <span className="text-ds-gold">Payouts stay paused until {fmtWhen(account.releaseHold.resumesAt)}.</span>
                  : "Payouts are not paused by it any more."}
              </p>
            )}
          </div>
        </>
      )}

      {confirming && (
        <BankChangeDialog busy={busy} error={err} onCancel={() => setConfirming(false)} onConfirm={markProcessed} />
      )}
    </section>
  );
}
