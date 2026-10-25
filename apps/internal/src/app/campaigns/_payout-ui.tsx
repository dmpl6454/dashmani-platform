"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { mutate as globalMutate } from "swr";
import { ChevronDown, ChevronUp, PauseCircle, RefreshCw } from "lucide-react";
import { PAYOUTS_BASE, isUnconfirmed, runPayoutAction, usePayoutDetail, type PayoutDetail, type PayoutRow } from "@/lib/hooks/use-creator-payouts";
import { BTN_GHOST, BTN_GOLD, BTN_RED, CARD, ErrorBar, INPUT, Pill, fmtWhen, rupees } from "./_ds";
import {
  RELEASE_SWITCH_TEXT, actionsFor, actorWord, buildTimeline, eventTitle, isLiveItem, manualNeedsReverseFirst, payoutHint, payoutStatusView, pauseEffect, pausedChip, pauseText, referenceProblem,
  splitRefusal, statusWord, transferIdProblem,
  type PayoutActionKey, type PayoutActionView, type StepState, type TimelineStep,
} from "./_payout";

// The pieces the staff payout queue (/campaigns/payouts) and the payout panel on a campaign page share: the status pill, the
// action buttons with their confirm dialogs, the timeline, and the history. `_` keeps Next from routing this file.
//
// ⚠️ EVERY ACTION GOES THROUGH A CONFIRM DIALOG THAT SAYS WHAT WILL HAPPEN, AND THE API'S REFUSAL APPEARS INSIDE IT. These buttons move,
// hold, release or take back real money. The dialog never closes on a refusal: the sentence the API gave ("the hold has not run out",
// "a dispute is open on the client's payment", …) is the thing to read, and nothing was changed. A button is never pressed twice by
// accident: the confirm button is disabled while the request runs, and every API action is idempotent anyway.

// ── Pills ───────────────────────────────────────────────────────────────────────────────────────

export function PayoutPill({ row }: { row: Pick<PayoutRow, "status" | "releaseAfter"> & { linkVerifiedAt?: string | null } }) {
  const v = payoutStatusView(row);
  return <Pill label={v.label} color={v.color} />;
}

/**
 * The chip beside a paused payout. ⚠️ A pause on a payout that was already released (or whose release was requested, or whose settlement
 * failed) stops nothing: Razorpay settles it anyway. Such a row gets a red chip that says so, never the gold "Paused" a real hold gets. Draws
 * nothing for a payout that is not paused or has finished.
 */
export function PausedChip({ row }: { row: { status: string; pausedAt?: string | null; pausedReason?: string | null } }) {
  const c = pausedChip(row);
  if (!c) return null;
  return (
    <span
      title={c.title}
      className={`inline-flex items-center h-6 px-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap border ${c.holds ? "text-ds-gold border-[rgba(233,189,98,.4)] bg-[rgba(233,189,98,.08)]" : "text-[#FB7185] border-[rgba(251,113,133,.45)] bg-[rgba(251,113,133,.08)]"}`}
    >
      {c.label}
    </span>
  );
}

// ── Notices ─────────────────────────────────────────────────────────────────────────────────────

export interface Notice {
  tone: "ok" | "info";
  text: string;
}

export function NoticeBar({ notice, onClose }: { notice: Notice; onClose?: () => void }) {
  const ok = notice.tone === "ok";
  return (
    <div
      role="status"
      className={`px-3.5 py-2.5 rounded-[8px] text-[12.5px] flex items-start justify-between gap-3 border ${ok ? "bg-[rgba(0,215,160,.08)] border-[rgba(0,215,160,.3)] text-ds-teal" : "bg-[rgba(35,139,255,.08)] border-[rgba(35,139,255,.3)] text-[#7DB8FF]"}`}
    >
      <span className="min-w-0 break-words">{notice.text}</span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="shrink-0 underline-offset-2 hover:underline">
          Dismiss
        </button>
      )}
    </div>
  );
}

/**
 * The red banner for "ALL releases are paused" (the runtime switch). Shown on the payout queue (with the Resume button) and on a campaign
 * page that has creator posts (with a link to the queue), so a held payout that isn't moving always has its reason on the page it is read on.
 * `line` is who paused it and when (releaseChangeLine), when known.
 */
export function ReleasePausedBanner({ line, onResume, href }: { line?: string | null; onResume?: () => void; href?: string }) {
  return (
    <div role="status" className="rounded-[12px] border border-[rgba(229,45,71,.5)] bg-[rgba(229,45,71,.08)] px-4 py-3.5 flex flex-wrap items-center gap-x-4 gap-y-2.5">
      <PauseCircle aria-hidden className="h-5 w-5 text-ds-redsoft shrink-0" />
      <div className="min-w-0 flex-1 basis-[240px]">
        <div className="text-[14px] font-semibold text-ds-redsoft">Releases are paused</div>
        <div className="mt-0.5 text-[12.5px] text-ds-t2">
          {RELEASE_SWITCH_TEXT.banner}
          {line ? ` ${line}` : ""}
        </div>
      </div>
      {onResume ? (
        <button type="button" className={`${BTN_GOLD} w-full sm:w-auto`} onClick={onResume}>Resume releases</button>
      ) : href ? (
        <Link href={href} className={`${BTN_GHOST} w-full sm:w-auto`}>Resume from Creator payouts</Link>
      ) : null}
    </div>
  );
}

// ── The confirm dialog ──────────────────────────────────────────────────────────────────────────

export interface DialogField {
  name: string;
  label: string;
  help?: string;
  required?: boolean;
  min?: number;
  max: number;
  multiline?: boolean;
  placeholder?: string;
  /** A reason this value can't be sent (null = fine). Checked before the request. */
  validate?: (value: string) => string | null;
}

export interface DialogSpec {
  title: string;
  /** The words on the confirm button. */
  confirm: string;
  busy: string;
  danger?: boolean;
  body: ReactNode;
  fields?: DialogField[];
  /** Does it. Throws an Error whose message is shown inside the open dialog. */
  run: (values: Record<string, string>) => Promise<unknown>;
}

/**
 * The one confirm dialog. Focus goes to Cancel (the safe default for a money action) and returns to the button that opened it;
 * Escape closes (not mid-request); Tab stays inside; a refusal stays on screen and the dialog stays open.
 */
export function ActionDialog({ spec, onCancel, onDone, onUnconfirmed }: {
  spec: DialogSpec;
  onCancel: () => void;
  onDone: (result: unknown, values: Record<string, string>) => void;
  /** The request got no usable answer (a gateway error, a dropped connection): it MAY have gone through, so the page re-reads what is behind this dialog. */
  onUnconfirmed?: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; code: string | null; unconfirmed: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const fields = spec.fields ?? [];

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Cancel is the safe place to land for an action with nothing to type. When a REQUIRED field must be filled first (a reason, a bank
    // reference) the cursor goes there: that is the next thing the person has to do.
    (box.current?.querySelector<HTMLElement>("[data-autofocus]") ?? box.current?.querySelector<HTMLElement>("[data-first]") ?? box.current)?.focus();
    return () => opener?.focus?.();
  }, []);

  // After a failed attempt the controls are enabled again: put the cursor back on the safe one (Cancel). While the request ran every control was
  // disabled and the browser had dropped focus to the page behind the dialog.
  useEffect(() => {
    if (!busy && refocus.current) {
      refocus.current = false;
      box.current?.querySelector<HTMLElement>("[data-first]")?.focus();
    }
  }, [busy]);

  const problem = (f: DialogField): string | null => {
    const v = (values[f.name] ?? "").trim();
    if (v === "") return f.required ? "Required." : null;
    if (f.min && v.length < f.min) return `At least ${f.min} characters.`;
    return f.validate ? f.validate(v) : null;
  };
  const invalid = fields.some((f) => problem(f) !== null);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !busy) {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    const f = [...box.current.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled])")];
    // Mid-request every control is disabled: Tab must not walk out to the page behind the dialog.
    if (f.length === 0) { e.preventDefault(); box.current.focus(); return; }
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const confirm = async () => {
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    box.current?.focus();
    const clean = Object.fromEntries(fields.map((f) => [f.name, (values[f.name] ?? "").trim()]));
    try {
      const result = await spec.run(clean);
      onDone(result, clean);
    } catch (e) {
      // Stay open: the API's reason is the thing to read. Nothing was changed by a refusal. An UNCONFIRMED request is different: it may have
      // gone through, so it says so (never "nothing was changed") and the page re-reads the payout so the row behind shows the truth.
      const unconfirmed = isUnconfirmed(e);
      setError({ ...splitRefusal(e instanceof Error && e.message ? e.message : "That didn't work. Nothing was changed."), unconfirmed });
      refocus.current = true;
      setBusy(false);
      if (unconfirmed) onUnconfirmed?.();
    }
  };

  return (
    // 100dvh, not 100vh: on iOS Safari 100vh is the LARGE viewport (the toolbar hidden), so a tall dialog (Reverse and Release have long lists) was taller
    // than what is visible and its buttons sat under the toolbar. The padding keeps clear of the notch and the home bar; the box scrolls inside.
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      onKeyDown={onKeyDown}
    >
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="payout-dialog-title" tabIndex={-1} className={`${CARD} w-full max-w-[520px] max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain p-5`}>
        <h2 id="payout-dialog-title" className="text-[16px] font-semibold text-ds-text">{spec.title}</h2>
        <div className="mt-2 text-[13px] text-ds-t2 grid gap-2.5">{spec.body}</div>

        {fields.map((f, i) => {
          const id = `payout-field-${f.name}`;
          const auto = i === 0 && f.required ? { "data-autofocus": true } : {};
          const p = (values[f.name] ?? "") !== "" ? problem(f) : null;
          return (
            <div key={f.name} className="mt-3.5">
              <label htmlFor={id} className="block text-[12px] text-ds-t3 mb-1.5">{f.label}{f.required ? "" : " (optional)"}</label>
              {f.multiline ? (
                <textarea id={id} rows={3} maxLength={f.max} disabled={busy} value={values[f.name] ?? ""} placeholder={f.placeholder} aria-invalid={!!p} aria-describedby={`${id}-help`} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} className={`${INPUT} h-auto py-2 resize-y`} />
              ) : (
                <input id={id} {...auto} type="text" autoComplete="off" spellCheck={false} maxLength={f.max} disabled={busy} value={values[f.name] ?? ""} placeholder={f.placeholder} aria-invalid={!!p} aria-describedby={`${id}-help`} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} className={INPUT} />
              )}
              <div id={`${id}-help`} className={`mt-1 text-[11.5px] ${p ? "text-[#FB7185]" : "text-ds-t4"}`}>{p ?? f.help ?? ""}</div>
            </div>
          );
        })}

        {error && (
          <div className="mt-3">
            {error.unconfirmed ? (
              // Amber, not red: this is not "it failed", it is "we don't know".
              <div role="alert" className="px-3.5 py-2.5 rounded-[8px] border border-[rgba(233,189,98,.4)] bg-[rgba(233,189,98,.08)] text-ds-gold text-[12.5px]">
                {error.text}
              </div>
            ) : (
              <ErrorBar message={error.text} />
            )}
            {error.code && <div className="mt-1 text-[11px] text-ds-t4 font-mono break-all">code: {error.code}</div>}
          </div>
        )}
        <div className="mt-4 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button data-first type="button" className={`${BTN_GHOST} w-full sm:w-auto`} onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" aria-live="polite" className={`${spec.danger ? BTN_RED : BTN_GOLD} w-full sm:w-auto`} onClick={confirm} disabled={busy || invalid}>
            {busy ? spec.busy : spec.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── What each action says before it runs ────────────────────────────────────────────────────────

const who = (p: PayoutRow) => p.creatorName ?? "the creator";
const forPage = (p: PayoutRow) => (p.pageName ? ` for ${p.pageName}` : "");

/** The dialog for one action on one payout. The wording says what will happen and what it does NOT do. */
export function dialogFor(key: PayoutActionKey, row: PayoutRow): DialogSpec {
  const act = (path: Parameters<typeof runPayoutAction>[1], body?: Record<string, string | undefined>) => runPayoutAction(row.id, path, body);
  const amount = rupees(row.amountPaise);
  switch (key) {
    case "pause": {
      // What pausing does depends on where the payout is: only a HELD one has money set aside that pausing leaves where it is.
      const eff = pauseEffect(row.status);
      return {
        title: "Pause this payout?",
        confirm: "Pause",
        busy: "Pausing…",
        body: (
          <>
            <p>Pausing stops this payout going any further until you resume it.</p>
            <p className={eff.warn ? "text-ds-gold" : undefined}>{eff.text}</p>
          </>
        ),
        fields: [{ name: "reason", label: "Reason (kept in the payout's history)", max: 120, placeholder: "For example: creator asked to wait" }],
        run: (v) => act("pause", { reason: v.reason }),
      };
    }
    case "resume":
      return {
        title: "Resume this payout?",
        confirm: "Resume",
        busy: "Resuming…",
        body: (
          <>
            <p>It was paused: {pauseText(row.pausedReason)}.</p>
            <p>Resuming does not release it. It is released only when every check passes, after the hold: the post verified, no dispute open, no bank change pending, releases switched on. The system refuses to resume while a dispute is still open.</p>
          </>
        ),
        run: () => act("resume"),
      };
    case "retry": {
      const planned = row.status === "planned";
      return {
        title: planned ? "Make the transfer now?" : "Retry the transfer?",
        confirm: planned ? "Make transfer" : "Retry transfer",
        busy: planned ? "Making transfer…" : "Retrying…",
        body: (
          <>
            <p>
              {planned
                ? `The worker normally does this by itself within minutes. This runs it now: ${amount} is set aside for ${who(row)} at Razorpay, on hold.`
                : `Razorpay refused the transfer of ${amount} for ${who(row)}. This asks it to set the money aside again, on hold.`}
            </p>
            <p>Nothing is paid to the creator by this: the transfer is created on hold and is released only after the post is verified.</p>
            {!planned && (
              <p>
                Razorpay can&apos;t make the same transfer safely twice, so just before sending a new one the system reads Razorpay&apos;s list of the client payment&apos;s transfers once, and refuses if a live transfer already carries this payout&apos;s id, or if that list can&apos;t be read. It is refused once the client has been refunded for the payment; then, if the post is live, pay the creator by bank transfer.
              </p>
            )}
          </>
        ),
        run: () => act("retry-transfer"),
      };
    }
    case "reverse": {
      const out = rupees(Math.max(0, row.amountPaise - row.amountReversedPaise));
      const moved = ["released", "settlement_failed"].includes(row.status);
      return {
        title: `Take back ${out}${forPage(row)}?`,
        confirm: "Reverse",
        busy: "Reversing…",
        danger: true,
        body: (
          <>
            <p>This takes the creator&apos;s share back from their linked account at Razorpay into our Razorpay balance. {who(row)} is not paid for this post.</p>
            <ul className="grid gap-1.5 list-disc pl-5">
              <li>The amount is read fresh from Razorpay just before it is reversed, and only this payout&apos;s transfer is touched. It is never &ldquo;reverse all&rdquo;.</li>
              <li>
                It does <strong className="text-ds-t5">not</strong> refund the client&apos;s {rupees(row.itemPricePaise)} for this post. A post that was withdrawn, declined, expired or rejected is refunded to the client automatically once its payout is taken back; for any other post, press Refund on the campaign page afterwards.
              </li>
              <li>To cancel a post whose offer is still open, use Withdraw offer or Refund this account on the campaign page instead: they end the offer, take this payout back and refund the client in the right order. Reversing from here leaves the offer open.</li>
              <li>To pay a creator by bank transfer instead (their payout account was suspended, say) take it back first: the payout then appears under Owed after reversal, where Pay by bank transfer instead records the payment.</li>
              {moved && (
                <li className="text-ds-gold">
                  The money has already been released to the creator&apos;s account. Razorpay can only take it back while it is still there, before it settles to their bank. If Razorpay refuses, the payout is parked as Needs attention for a person.
                </li>
              )}
            </ul>
          </>
        ),
        fields: [{ name: "reason", label: "Reason (kept in the payout's history)", max: 120, placeholder: "For example: duplicate booking" }],
        run: (v) => act("reverse", { reason: v.reason }),
      };
    }
    case "release":
      return {
        title: `Release ${amount} to ${who(row)} now?`,
        confirm: "Release now",
        busy: "Releasing…",
        body: (
          <>
            <p>This tells Razorpay to let go of the held transfer. The money then settles to {who(row)}&apos;s bank account{row.destinationHint ? ` (${row.destinationHint})` : ""}.</p>
            <ul className="grid gap-1.5 list-disc pl-5">
              <li>It counts as paid only once Razorpay has settled it. Until then it shows as Released · settling.</li>
              <li>Everything is checked again, fresh from Razorpay, just before it is released: the post is verified and live, no dispute is open, no bank change is pending, the transfer is still on hold, the creator&apos;s payout account is active and releases are switched on. If any check fails, nothing is released and the reason appears here.</li>
              <li>You can&apos;t undo it from here. Taking it back later only works while Razorpay still has the money in the creator&apos;s account.</li>
            </ul>
          </>
        ),
        run: () => act("release-now"),
      };
    case "require_manual": {
      const taken = row.status === "reversed";
      const planned = row.status === "planned";
      // ⚠️ A parked payout that records a transfer: the system refuses this while that transfer could still release money (it would pay the
      // creator twice). Said up front, so nobody types a reason only to be refused for something they could have done first.
      const reverseFirst = manualNeedsReverseFirst(row) ? (
        <p className="text-ds-gold">
          This payout records a transfer at Razorpay. Unless that transfer failed or was fully taken back, the system refuses this, because the transfer could still release money and the creator would be paid twice. Take it back first with Reverse:{" "}
          {isLiveItem(row.itemStatus) ? "the payout then shows under Owed after reversal, where Pay by bank transfer instead records the payment." : "once it is taken back, the post can be refunded from the campaign page."}
        </p>
      ) : null;
      // ⚠️ Offered for a post that never went live only on a PARKED payout ("Stop this payout"): nothing is owed, and this is how the payout is stopped
      // so the post can be refunded. The API refuses a hand payment for such a post (post_not_live), so the dialog never says "pay them yourself".
      if (!taken && !isLiveItem(row.itemStatus)) {
        return {
          title: "Stop this payout?",
          confirm: "Stop the payout",
          busy: "Stopping…",
          body: (
            <>
              <p>{who(row)}&apos;s post never went live, so nothing is owed to them. This stops the payout: no transfer is made or retried for it. The system refuses it while Razorpay could still have money out for it.</p>
              {reverseFirst}
              <p>It pays nobody, and it can&apos;t be recorded as paid. Refund the post from the campaign page afterwards (a post already waiting for its refund is refunded automatically once the payout is out of the way).</p>
            </>
          ),
          fields: [{ name: "reason", label: "Why", required: true, min: 3, max: 80, placeholder: "For example: no transfer exists at Razorpay" }],
          run: (v) => act("require-manual", { reason: v.reason }),
        };
      }
      return {
        title: "Pay this creator by bank transfer instead?",
        confirm: "Switch to manual payment",
        busy: "Switching…",
        body: (
          <>
            {taken ? (
              <p>
                {who(row)}&apos;s share was taken back into our Razorpay balance, but the post is live, so they are still owed {amount}. This marks the payout as one to pay by bank transfer. No money moves. The system refuses it once the client has been refunded for the post.
              </p>
            ) : planned ? (
              <p>
                Use this when the transfer can&apos;t be made (a suspended payout account, new transfers switched off). The payout stops going through Razorpay: no transfer is made for it, and it no longer holds up refunds on the same client payment.
              </p>
            ) : (
              <p>Use this when Razorpay can&apos;t pay {who(row)}. The payout stops going through Razorpay: no transfer is made or retried for it.</p>
            )}
            {reverseFirst}
            <p>Afterwards you pay {amount} to the creator yourself, then press Mark paid manually and record the bank reference. Nothing is paid by this step.</p>
          </>
        ),
        fields: [{ name: "reason", label: "Why", required: true, min: 3, max: 80, placeholder: "For example: payout account suspended" }],
        run: (v) => act("require-manual", { reason: v.reason }),
      };
    }
    case "mark_paid":
      return {
        title: `Record ${amount} as paid to ${who(row)}?`,
        confirm: "Mark paid",
        busy: "Recording…",
        body: (
          <>
            <p>Use this once you have paid {who(row)} {amount} by bank transfer, outside Razorpay. It records the payment: it moves no money.</p>
            <p>The system refuses it while a Razorpay transfer for this payout could still release money, because that would pay the creator twice.</p>
          </>
        ),
        fields: [
          { name: "reference", label: "Bank transfer reference (UTR)", required: true, min: 4, max: 100, placeholder: "The reference your bank gave", help: "Never type a PAN, an account number or an IFSC code here.", validate: referenceProblem },
          { name: "note", label: "Note", max: 500, multiline: true, help: "Kept in the payout's history. No bank details." },
        ],
        run: (v) => act("mark-manual-paid", { reference: v.reference, note: v.note }),
      };
    // ── After looking in the Razorpay dashboard. None of these moves money: what the person found is recorded with their name. ──
    case "adopt_transfer":
      return {
        title: "Adopt this payout's transfer?",
        confirm: "Adopt transfer",
        busy: "Checking at Razorpay…",
        body: (
          <>
            <p>Use this when you found this payout&apos;s transfer in the Razorpay dashboard (the client&apos;s payment, its transfers) and Razorpay&apos;s list here couldn&apos;t be read, or never showed it.</p>
            <ul className="grid gap-1.5 list-disc pl-5">
              <li>The system reads that transfer at Razorpay and records it only if it is this payout&apos;s: it carries this payout&apos;s id, and the same linked account, payment and amount. Your word alone records nothing.</li>
              <li>It is then judged like any transfer the system finds: confirmed held, failed, or parked if something doesn&apos;t match. A payout whose request was sent twice also waits for the check that no second transfer carries its id.</li>
              <li>It pays nothing and refunds nothing. It is recorded in the payout&apos;s history with your name.</li>
            </ul>
          </>
        ),
        fields: [{ name: "transferId", label: "Razorpay transfer id", required: true, min: 8, max: 44, placeholder: "trf_…", help: "Copy it from the Razorpay dashboard. Never a payment, account or bank number.", validate: transferIdProblem }],
        run: (v) => act("adopt-transfer", { transferId: v.transferId }),
      };
    case "attest_no_transfer":
      return {
        title: "Record that no transfer exists?",
        confirm: "Record: no transfer",
        busy: "Recording…",
        body: (
          <>
            <p>Use this only after you looked in the Razorpay dashboard, at the client&apos;s payment and its transfers, and found no transfer for this payout (none carries its id).</p>
            <ul className="grid gap-1.5 list-disc pl-5">
              <li>It is recorded with your name in the payout&apos;s history. It pays nothing and refunds nothing.</li>
              <li>While Razorpay&apos;s list of the payment&apos;s transfers can&apos;t be read, your record stands in for that list for {isLiveItem(row.itemStatus) ? "Pay by bank transfer instead and for recording the payment" : "Stop this payout"}, until the payout is sent to Razorpay again. It is never used for a refund.</li>
              <li>A request made less than 10 minutes before can still be on its way in, so the system refuses this until then: look again a little later.</li>
            </ul>
          </>
        ),
        fields: [{ name: "note", label: "What you checked", required: true, min: 3, max: 300, multiline: true, placeholder: "For example: payment's transfers in the dashboard at 10:40, none for this payout", help: "Kept in the payout's history with your name. No bank details." }],
        run: (v) => act("attest-no-transfer", { note: v.note }),
      };
    case "attest_no_other":
      return {
        title: "Record that no other transfer exists?",
        confirm: "Record: no other transfer",
        busy: "Recording…",
        body: (
          <>
            <p>This payout&apos;s request was sent to Razorpay twice, so before it is called held (or released) the system checks that no SECOND transfer carries its id. Use this only when Razorpay&apos;s list of the payment&apos;s transfers can&apos;t be read and you looked in the Razorpay dashboard yourself: the client&apos;s payment shows no transfer for this payout other than the one it records.</p>
            <ul className="grid gap-1.5 list-disc pl-5">
              <li>It is recorded with your name in the payout&apos;s history. It pays nothing and refunds nothing.</li>
              <li>It stands in for that list for the hold check and the release only, never for a refund. If the payout is waiting on the hold check, that check runs straight away and its answer appears here.</li>
              <li>A request made less than 10 minutes before can still be on its way in, so the system refuses this until then.</li>
            </ul>
          </>
        ),
        fields: [{ name: "note", label: "What you checked", required: true, min: 3, max: 300, multiline: true, placeholder: "For example: only one transfer carries this payout in the dashboard at 10:40", help: "Kept in the payout's history with your name. No bank details." }],
        run: (v) => act("attest-no-transfer", { note: v.note }),
      };
  }
}

/** What staff are told after an action went through: the new status, and whatever the engine said was still pending. */
export function noticeFor(key: PayoutActionKey, d: PayoutDetail, values: Record<string, string>): Notice {
  const now = `Now: ${statusWord(d.payout.status)}.`;
  const note = d.result?.note ? ` ${d.result.note}` : "";
  switch (key) {
    case "pause":
      return { tone: "ok", text: "Paused. Nothing more is done with it until you resume it." };
    case "resume":
      return { tone: "ok", text: d.result?.outcome === "not_paused" ? "It wasn't paused." : `Resumed. ${now} It is released only when every check passes.` };
    case "retry":
      return { tone: note ? "info" : "ok", text: `Done. ${now}${note}` };
    case "reverse":
      return { tone: d.payout.status === "reversed" ? "ok" : "info", text: `${d.payout.status === "reversed" ? "Taken back: the money is in our Razorpay balance." : "Reversal requested."} ${now}${note}` };
    case "release":
      return { tone: d.payout.status === "released" ? "ok" : "info", text: d.payout.status === "released" ? `Released. Razorpay now settles it to the creator's bank: it shows as Paid only once it has.${note}` : `Release requested. ${now}${note}` };
    case "require_manual":
      // A post that never went live is owed nothing: the payout is only stopped (the API refuses a hand payment for it).
      return isLiveItem(d.payout.itemStatus ?? d.item?.status)
        ? { tone: "ok", text: "Marked to be paid by bank transfer. Pay the creator, then press Mark paid manually and record the reference." }
        : { tone: "ok", text: "The payout is stopped: no transfer is made for it. Nothing is owed to the creator, because the post never went live. Refund the post from the campaign page." };
    case "mark_paid":
      return { tone: "ok", text: `Recorded as paid by bank transfer (reference ${values.reference ?? ""}).` };
    // The engine's own words say what it decided (held, waiting for the twin check, failed, parked again): never a guess here.
    case "adopt_transfer":
    case "attest_no_transfer":
    case "attest_no_other":
      return { tone: d.payout.status === "held" ? "ok" : "info", text: `${(d.result?.note ?? "Recorded.").trim()} ${now}` };
  }
}

// ── The buttons ─────────────────────────────────────────────────────────────────────────────────

const TONE: Record<PayoutActionView["tone"], string> = { gold: BTN_GOLD, ghost: BTN_GHOST, red: BTN_RED };

/**
 * ONE confirm dialog per page, not one per row. The dialog belongs to the PAGE because the list under it refreshes by itself: a row
 * whose payout moves on (the worker released it, a webhook took it back) leaves its view, and a dialog owned by that row would vanish
 * under the person reading it. Held here it stays, still showing what it was opened for, and the API (which re-checks everything
 * fresh) answers a stale click with the reason it can't.
 * `onChanged` re-reads whatever list the page shows; the payout's own detail is refreshed here.
 */
export function usePayoutDialog({ onChanged, onNotice }: { onChanged: () => unknown; onNotice: (n: Notice) => void }) {
  const [state, setState] = useState<{ key: PayoutActionKey; row: PayoutRow } | null>(null);
  const dialog = state ? (
    <ActionDialog
      spec={dialogFor(state.key, state.row)}
      onCancel={() => setState(null)}
      // No usable answer: the move may have been made, so the row behind the dialog is re-read now rather than at the next 30 s refresh.
      onUnconfirmed={() => {
        void globalMutate(`${PAYOUTS_BASE}/${state.row.id}`);
        void onChanged();
      }}
      onDone={(result, values) => {
        const d = result as PayoutDetail;
        const { key, row } = state;
        setState(null);
        void globalMutate(`${PAYOUTS_BASE}/${row.id}`, d, { revalidate: false });
        onNotice(noticeFor(key, d, values));
        void onChanged();
      }}
    />
  ) : null;
  return { open: (key: PayoutActionKey, row: PayoutRow) => setState({ key, row }), dialog };
}

/**
 * The action buttons for one payout. "Release now" is the one button shown while disabled, with the reason beneath (printed, not a
 * tooltip): "why isn't this paid yet" is the question it answers.
 */
export function PayoutActions({ row, releaseOn, onOpen, postVerified }: {
  row: PayoutRow;
  /** The runtime release switch as the page last read it (undefined = unknown: the API decides). */
  releaseOn: boolean | undefined;
  onOpen: (key: PayoutActionKey, row: PayoutRow) => void;
  /** The creator's link was verified, as the page knows it (the campaign page reads the offer). The row's own linkVerifiedAt counts too. */
  postVerified?: boolean;
}) {
  const actions = actionsFor(row, { releaseOn, now: Date.now(), postVerified });
  if (actions.length === 0) return null;
  const blocked = actions.filter((a) => !a.enabled && a.why);
  return (
    <div className="mt-2.5">
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <button key={a.key} type="button" className={`${TONE[a.tone]} !h-8 !px-3 !text-[12.5px]`} disabled={!a.enabled} aria-describedby={!a.enabled && a.why ? `why-${row.id}-${a.key}` : undefined} onClick={() => onOpen(a.key, row)}>
            {a.label}
          </button>
        ))}
      </div>
      {blocked.map((a) => (
        <p key={a.key} id={`why-${row.id}-${a.key}`} className="mt-1.5 text-[12px] text-ds-t3">{a.label} isn&apos;t available: {a.why}</p>
      ))}
    </div>
  );
}

// ── The timeline ────────────────────────────────────────────────────────────────────────────────

const DOT: Record<StepState, { fill: string; border: string; word: string }> = {
  done: { fill: "#00D7A0", border: "#00D7A0", word: "done" },
  current: { fill: "#238BFF", border: "#7DB8FF", word: "in progress" },
  todo: { fill: "transparent", border: "#4E5F70", word: "not yet" },
  error: { fill: "#FB7185", border: "#FB7185", word: "failed" },
  warn: { fill: "#E9BD62", border: "#E9BD62", word: "needs a person" },
  skipped: { fill: "transparent", border: "#2E3E4D", word: "will not happen" },
};

export function TimelineList({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol aria-label="Payout timeline" className="grid">
      {steps.map((s, i) => {
        const d = DOT[s.state];
        const muted = s.state === "todo" || s.state === "skipped";
        return (
          <li key={s.key} className="relative flex gap-3 pb-3 last:pb-0" aria-current={s.state === "current" ? "step" : undefined}>
            {i < steps.length - 1 && <span aria-hidden className="absolute left-[5px] top-4 bottom-0 w-px bg-ds-line2" />}
            <span aria-hidden className="relative mt-[3px] h-[11px] w-[11px] shrink-0 rounded-full border-2" style={{ background: d.fill, borderColor: d.border, boxShadow: s.state === "current" ? "0 0 0 3px rgba(35,139,255,.22)" : undefined }} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={`font-semibold ${muted ? "text-ds-t4" : s.state === "error" ? "text-[#FB7185]" : s.state === "warn" ? "text-ds-gold" : "text-ds-t5"} ${s.state === "skipped" ? "line-through" : ""}`}>{s.label}</span>
                <span className="sr-only"> ({d.word})</span>
                {s.at && <span className="text-ds-t4">{fmtWhen(s.at)}</span>}
              </div>
              {s.detail && <div className="text-ds-t3 break-words">{s.detail}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── Detail: facts, timeline, history ────────────────────────────────────────────────────────────

function Fact({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[104px_1fr] gap-2">
      <dt className="text-ds-t3">{k}</dt>
      <dd className="text-ds-t5 min-w-0 break-words">{children}</dd>
    </div>
  );
}

const HISTORY_SHOWN = 6;

/**
 * One payout in full: where it stands, its timeline, the facts staff look up (Razorpay references, the settlement's bank reference,
 * the creator's share and tax), any dispute on the client's payment, and the history. The timeline draws at once from the row the
 * caller already has; the rest loads when this opens. A failed load says so: it is never drawn as "no history".
 */
export function PayoutDetailView({ row }: { row: PayoutRow }) {
  const { data, error, isLoading, mutate } = usePayoutDetail(row.id);
  const [all, setAll] = useState(false);
  // The row comes from a list that refreshes; the detail is read once. The row's fields win (they are newer), the detail fills in what
  // the list doesn't carry (references, the steps' own times), and the detail is re-read whenever the row says the payout moved.
  const p = { ...data?.payout, ...row };
  const loadedAt = data?.payout.updatedAt;
  useEffect(() => {
    if (loadedAt && loadedAt !== row.updatedAt) void mutate();
    // Deliberately keyed on updatedAt only: `mutate` is stable and `loadedAt` is what is being compared.
  }, [row.updatedAt]);
  const steps = buildTimeline(p);
  const events = data?.events ?? [];
  const shown = all ? events : events.slice(0, HISTORY_SHOWN);
  const facts = data?.payout;
  return (
    <div className="mt-3 grid gap-4 md:grid-cols-2 text-[12px]">
      <div className="min-w-0">
        <h3 className="text-[10.5px] uppercase tracking-[.1em] font-semibold text-ds-t3 mb-2">Timeline</h3>
        <TimelineList steps={steps} />
        {data?.account?.bankChangePending && <p className="mt-2 text-ds-gold">The creator has a bank change pending: nothing is released until it is cleared and 72 hours have passed.</p>}
        {data?.account && data.account.activationStatus !== "activated" && <p className="mt-2 text-ds-gold">The creator&apos;s payout account is {statusWord(data.account.activationStatus)}, not activated: nothing is released until it is.</p>}
        {data && data.disputes.length > 0 && (
          <div className="mt-3">
            <h3 className="text-[10.5px] uppercase tracking-[.1em] font-semibold text-ds-t3 mb-1.5">Dispute on the client&apos;s payment</h3>
            <ul className="grid gap-1">
              {data.disputes.map((x) => (
                <li key={x.razorpayDisputeId} className="text-[#FB7185]">
                  {statusWord(x.status)}{x.amountPaise != null ? ` · ${rupees(x.amountPaise)}` : ""}{x.openedAt ? ` · opened ${fmtWhen(x.openedAt)}` : ""}{x.closedAt ? ` · closed ${fmtWhen(x.closedAt)}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="min-w-0 grid gap-4 content-start">
        <div>
          <h3 className="text-[10.5px] uppercase tracking-[.1em] font-semibold text-ds-t3 mb-2">Amounts and references</h3>
          <dl className="grid gap-1.5">
            <Fact k="Client paid">{rupees(p.itemPricePaise)} <span className="text-ds-t3">for this post</span></Fact>
            <Fact k="Creator share">{rupees(p.grossPaise)}{facts?.shareBps != null ? <span className="text-ds-t3"> ({facts.shareBps / 100}% of the price)</span> : null}</Fact>
            <Fact k="Tax withheld">{rupees(p.tdsPaise)}{facts?.tdsBps ? <span className="text-ds-t3"> ({facts.tdsBps / 100}%)</span> : null}</Fact>
            <Fact k="Creator gets"><strong className="text-ds-text tabular-nums">{rupees(p.amountPaise)}</strong></Fact>
            {p.amountReversedPaise > 0 && <Fact k="Taken back">{rupees(p.amountReversedPaise)}</Fact>}
            {p.destinationHint && <Fact k="Destination">{p.destinationHint}</Fact>}
            {p.releaseAfter && <Fact k="Release after">{fmtWhen(p.releaseAfter)}</Fact>}
            {facts?.razorpayTransferId && <Fact k="Transfer"><span className="font-mono">{facts.razorpayTransferId}</span></Fact>}
            {facts?.recipientSettlementId && <Fact k="Settlement"><span className="font-mono">{facts.recipientSettlementId}</span></Fact>}
            {p.settlementUtr && <Fact k="Bank reference"><span className="font-mono">{p.settlementUtr}</span></Fact>}
            {p.manualReference && <Fact k="Paid by hand"><span className="font-mono">{p.manualReference}</span>{p.manualPaidAt ? <span className="text-ds-t3"> · {fmtWhen(p.manualPaidAt)}</span> : null}</Fact>}
            {facts?.manualNote && <Fact k="Note"><span className="whitespace-pre-line">{facts.manualNote}</span></Fact>}
            {(facts?.transferStatus || facts?.settlementStatus) && (
              <Fact k="Razorpay says">
                {[facts.transferStatus && `transfer ${facts.transferStatus.replace(/_/g, " ")}`, facts.settlementStatus && `settlement ${facts.settlementStatus.replace(/_/g, " ")}`, facts.recipientSettlementStatus && `payout ${facts.recipientSettlementStatus}`].filter(Boolean).join(" · ")}
              </Fact>
            )}
            {facts?.lastCheckedAt && <Fact k="Last checked">{fmtWhen(facts.lastCheckedAt)}</Fact>}
            {p.attempts > 0 && <Fact k="Attempts">{p.attempts}</Fact>}
            {facts?.lastError && <Fact k="Last problem"><span className="text-[#F59E66]">{facts.lastError}</span></Fact>}
          </dl>
        </div>

        <div>
          <h3 className="text-[10.5px] uppercase tracking-[.1em] font-semibold text-ds-t3 mb-2">History</h3>
          {isLoading && <p className="text-ds-t3">Loading history…</p>}
          {error && !data && (
            <div role="alert" className="grid gap-1.5 text-[#FB7185]">
              <span>Couldn&apos;t load this payout&apos;s history. This is a loading problem, not an empty history.</span>
              <button type="button" onClick={() => void mutate()} className="inline-flex items-center gap-1.5 text-ds-gold hover:underline justify-self-start"><RefreshCw className="h-3.5 w-3.5" />Try again</button>
            </div>
          )}
          {data && events.length === 0 && <p className="text-ds-t3">No history lines yet.</p>}
          {shown.length > 0 && (
            <ol className="grid gap-2">
              {shown.map((e) => (
                <li key={e.id}>
                  <div className="text-ds-t5">{eventTitle(e)}{e.note ? <span className="text-ds-t2"> · {e.note}</span> : null}</div>
                  <div className="text-ds-t4">{actorWord(e.actorType)} · {fmtWhen(e.createdAt)}</div>
                </li>
              ))}
            </ol>
          )}
          {events.length > HISTORY_SHOWN && (
            <button type="button" onClick={() => setAll((v) => !v)} className="mt-2 inline-flex items-center gap-1 text-ds-gold hover:underline">
              {all ? <><ChevronUp className="h-3.5 w-3.5" />Show fewer</> : <><ChevronDown className="h-3.5 w-3.5" />Show all {events.length} lines</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The sentence under a payout: where it stands, and why it is paused if it is. Never predicts a release that a pause or the global switch is holding back. */
export function PayoutHint({ row, postVerified, releaseOn }: { row: PayoutRow; postVerified?: boolean; releaseOn?: boolean }) {
  return (
    <>
      <p className="text-ds-t2">{payoutHint(row, Date.now(), { postVerified, releaseOn })}</p>
      {row.pausedAt && !["settled", "paid_manual", "void", "reversed"].includes(row.status) && <p className="mt-1 text-ds-gold">Paused: {pauseText(row.pausedReason)}.</p>}
    </>
  );
}
