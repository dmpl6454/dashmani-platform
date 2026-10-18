"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { BTN_GHOST, BTN_GOLD, BTN_RED, CARD, ErrorBar, Pill, fmtDate, fmtWhen, rupees } from "../_ds";
import {
  LinkChangedError, OFFER_STATUS, closedReasonText, dayOf, isOpenOffer, offerEmailState, offerExpiredNow, ownershipView, safeHref,
  type OwnershipView, type StaffOffer,
} from "../_creator";

// The creator's side of one booked post, as staff see it on the campaign page: who is paid, what the offer says, the
// link the creator sent and what the ownership check made of it, and the three things staff can do (withdraw the offer,
// verify the link, and, on the row itself, refund). STAFF ONLY: it shows the creator's payout.
//
// ⚠️ A creator's post goes live ONLY from the link the creator sent. There is no field to type a link here on purpose:
// the API refuses any other link (LINK_MISMATCH), and "Mark posted" is not offered for these posts.

const TONE: Record<OwnershipView["tone"], { color: string; bg: string; border: string }> = {
  ok: { color: "#00D7A0", bg: "rgba(0,215,160,.07)", border: "rgba(0,215,160,.28)" },
  bad: { color: "#FB7185", bg: "rgba(229,72,77,.08)", border: "rgba(229,72,77,.3)" },
  warn: { color: "#E9BD62", bg: "rgba(233,189,98,.08)", border: "rgba(233,189,98,.35)" },
  none: { color: "#A7B3C2", bg: "rgba(167,179,194,.07)", border: "rgba(167,179,194,.25)" },
};

function OwnershipBox({ v }: { v: OwnershipView }) {
  const t = TONE[v.tone];
  return (
    <div className="rounded-[8px] px-3 py-2 text-[12px]" style={{ background: t.bg, border: `1px solid ${t.border}` }}>
      <div className="font-semibold" style={{ color: t.color }}>{v.headline}</div>
      {v.detail && <div className="mt-0.5 text-ds-t2">{v.detail}</div>}
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] gap-2">
      <dt className="text-ds-t3">{k}</dt>
      <dd className="text-ds-t5 min-w-0 break-words">{children}</dd>
    </div>
  );
}

export interface OfferPanelProps {
  itemStatus: string;
  accountName: string;
  platform: string;
  creatorName: string | null;
  /** What the creator is to be paid, after TDS, as frozen at checkout (shown before there is an offer). */
  frozenPayoutPaise: number | null;
  offer: StaffOffer | undefined;
  /** The booking's History lines (newest first): the only record of failed offer emails and of the staff alert. */
  events: ReadonlyArray<{ note: string | null }>;
  /** Whether the booking is in a state where posts can be verified (approved or later). */
  postable: boolean;
  clientName: string;
  busy: string | null;
  /** True while the offers list could not be read at all, so "no offer" isn't claimed falsely. */
  offersUnavailable: boolean;
  onWithdraw: (discardSubmittedLink: boolean) => Promise<unknown>;
  /**
   * `linkCanonicalKey` is the key of the link the dialog showed (snapshotted when it opened, never the live prop) and `shown`
   * the ownership result it displayed. Throws an Error whose message is shown in the dialog when the API refuses, or a
   * LinkChangedError when the link (or its check) is no longer what the dialog showed.
   */
  onVerify: (ownershipCheckedByHand: boolean, linkCanonicalKey: string, shown: { check: string | null; detail: string | null }) => Promise<void>;
}

/** What the verify dialog is about: the link as staff were shown it. A later change to the offer never alters this by itself. */
interface VerifySnapshot {
  url: string;
  key: string;
  check: string | null;
  detail: string | null;
  /** Why the dialog moved to a new link while it was open. */
  notice?: string;
}

export function OfferPanel(p: OfferPanelProps) {
  const [verifying, setVerifying] = useState<VerifySnapshot | null>(null);
  // Shown when the dialog had to close because the creator's link went away (withdrawn, or no link any more) while it was open.
  const [closedNotice, setClosedNotice] = useState("");
  const who = p.creatorName ?? "the creator";
  const o = p.offer;

  if (!o) {
    // No offer row. Before approval that is expected; after it, it is something staff should know rather than a silent gap.
    if (p.itemStatus === "pending") {
      return (
        <p className="mt-2 text-[12px] text-ds-t3">
          When you approve the campaign this post is offered to {who}, who has to accept it and post it by hand.
          {p.frozenPayoutPaise != null && <> They would be paid <strong className="text-ds-t5">{rupees(p.frozenPayoutPaise)}</strong> after TDS.</>}
        </p>
      );
    }
    if (["awaiting_creator", "manual_pending"].includes(p.itemStatus)) {
      return (
        <p role="alert" className="mt-2 text-[12px] text-ds-gold">
          {p.offersUnavailable
            ? "This post should have an offer, but the offers couldn't be loaded. Reload the page."
            : "This post has no offer on record. Reload the page; if it is still missing, refund the post."}
        </p>
      );
    }
    return null;
  }

  const open = isOpenOffer(o);
  const expired = offerExpiredNow(o);
  const verified = !!o.linkVerifiedAt;
  const hasLink = !!o.linkSubmittedAt && !!o.linkUrl;
  const own = ownershipView(o.ownershipCheck, o.ownershipDetail);
  const href = safeHref(o.linkUrl);
  const st = OFFER_STATUS[o.status] ?? { label: o.status, color: "#738395" };
  const closed = !open ? closedReasonText(o.closedReason, o.notifiedAt) : null;
  const anyBusy = !!p.busy;
  const email = offerEmailState(o, p.events);
  // The creator has seen the offer once they accepted it or were emailed it: only then do they get a "don't post" email on withdrawal.
  const seen = o.status === "accepted" || !!o.notifiedAt;
  const canVerify = !!o.linkUrl && !!o.linkCanonicalKey;

  return (
    <div role="group" className="mt-2.5 rounded-[10px] bg-ds-inset px-3 py-3 text-[12px]" aria-label={`Offer to ${who} for ${p.accountName}`}>
      <dl className="grid gap-1.5">
        <Row k="Offer">
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <Pill label={expired ? "Expired — closing" : st.label} color={expired ? "#A7B3C2" : st.color} />
            {closed && <span className="text-ds-t2">{closed}</span>}
          </span>
        </Row>
        <Row k="Creator">{p.creatorName ?? "—"}</Row>
        <Row k="Payout"><strong className="text-ds-text tabular-nums">{rupees(o.payoutPaise)}</strong> <span className="text-ds-t3">after TDS: the amount the creator is shown</span></Row>
        <Row k="Window">{fmtDate(dayOf(o.windowFrom))} – {fmtDate(dayOf(o.windowTo))} <span className="text-ds-t3">(IST days)</span></Row>
        {o.status === "offered" && <Row k="Expires">{fmtWhen(o.expiresAt)}{expired ? <span className="text-ds-t3"> — passed; it closes in a few minutes</span> : null}</Row>}
        {email && (
          <Row k="Emailed">
            {email.kind === "sent" ? (
              fmtWhen(email.at)
            ) : email.kind === "pending" ? (
              <span className="text-ds-t3">Not yet. The email goes out in the minutes after approval; one that fails is retried automatically.</span>
            ) : (
              <span className="text-ds-gold">
                {email.staffAlerted ? "Email not delivered — staff alerted. " : "Email not delivered yet. "}
                {email.stopped ? "We have stopped retrying. " : email.staffAlerted ? "We are still retrying. " : "We are retrying automatically. "}
                Until it arrives, {who} may not know about this offer: contact them directly, or withdraw it. It still expires on its own at the time above.
              </span>
            )}
          </Row>
        )}
        {o.acceptedAt && <Row k="Accepted">{fmtWhen(o.acceptedAt)}</Row>}
        {o.creatorNote && <Row k="Their note"><span className="whitespace-pre-line">{o.creatorNote}</span></Row>}
        {hasLink && (
          <Row k="Link">
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-start gap-1 text-ds-gold hover:underline break-all">
                <span>{o.linkUrl}</span><ExternalLink className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              </a>
            ) : (
              <span className="break-all">{o.linkUrl} <span className="text-ds-t3">(not a web link)</span></span>
            )}
            <span className="block text-ds-t3">
              Sent {fmtWhen(o.linkSubmittedAt)}{o.linkPostedAt ? ` · posted ${fmtWhen(o.linkPostedAt)} on Meta` : ""}
            </span>
          </Row>
        )}
        {hasLink && <Row k="On their page"><OwnershipBox v={own} /></Row>}
        {verified && <Row k="Verified">{fmtWhen(o.linkVerifiedAt)}{o.ownershipCheck === "manual_ok" ? " · ownership checked by hand" : ""}</Row>}
      </dl>

      {open && !hasLink && o.status === "accepted" && !o.postMissingAt && (
        <p className="mt-2 text-ds-t2">The creator accepted and is posting by hand. Their link appears here when they send it.</p>
      )}
      {o.postMissingAt && !verified && (
        <p className="mt-2 text-ds-gold">The posting window has ended{hasLink ? ", but the creator did send a link: check it and verify it, or discard it." : " without a link from the creator. This offer is closing and the post will need a refund."}</p>
      )}
      {verified && (
        <p className="mt-2 text-ds-t3">
          The creator&apos;s link is the live post. Verifying scheduled their payout for release: where it stands, and what you can do about it, is in the payout panel below.
          {" "}This is final: the offer can no longer be withdrawn.
        </p>
      )}
      {closedNotice && !verifying && open && !verified && <p role="alert" className="mt-2 text-ds-gold">{closedNotice}</p>}

      {/* A verified post is finished: Verify and Withdraw are both gone (the API refuses a withdrawal with ALREADY_VERIFIED). */}
      {open && !verified && (
        <div className="mt-3 flex flex-col sm:flex-row sm:flex-wrap gap-2">
          {o.status === "accepted" && hasLink && (
            <button
              type="button"
              className={`${BTN_GOLD} w-full sm:w-auto`}
              disabled={anyBusy || !p.postable || !canVerify}
              onClick={() => {
                if (!o.linkUrl || !o.linkCanonicalKey) return;
                setClosedNotice("");
                // The dialog is about THIS link: its key goes back with the request, so a link the creator sends after this click is refused.
                setVerifying({ url: o.linkUrl, key: o.linkCanonicalKey, check: o.ownershipCheck, detail: o.ownershipDetail });
              }}
            >
              Verify link &amp; release
            </button>
          )}
          {hasLink && !verified ? (
            <button
              type="button"
              className={`${BTN_RED} w-full sm:w-auto`}
              disabled={anyBusy}
              onClick={() => {
                if (!window.confirm(`Discard ${who}'s link and withdraw the offer for ${p.accountName}? Only do this if the link is not their post. The post goes to "refund due", their payout is taken back (a held transfer is reversed at Razorpay) and the client is then refunded for it automatically. ${who} is emailed not to post it (the email names the page only: no brand, no price). You are told right after how far it got.`)) return;
                void p.onWithdraw(true);
              }}
            >
              Discard link &amp; withdraw offer
            </button>
          ) : (
            <button
              type="button"
              className={`${BTN_RED} w-full sm:w-auto`}
              disabled={anyBusy}
              onClick={() => {
                if (!window.confirm(`Withdraw the offer to ${who} for ${p.accountName}? The post goes to "refund due", their payout is taken back (a held transfer is reversed at Razorpay) and the client is then refunded for it automatically.${seen ? ` ${who} has seen this offer, so they are emailed not to post it (the email names the page only: no brand, no price).` : ""} You are told right after how far it got.`)) return;
                void p.onWithdraw(false);
              }}
            >
              Withdraw offer
            </button>
          )}
        </div>
      )}
      {open && !verified && !p.postable && hasLink && <p className="mt-2 text-ds-t3">Approve the campaign before verifying a post.</p>}
      {open && !verified && o.status === "accepted" && hasLink && !o.linkCanonicalKey && (
        <p role="alert" className="mt-2 text-ds-gold">This link has no reference on record, so it can&apos;t be verified from here. Reload the page; if this stays, discard the link and withdraw the offer.</p>
      )}

      {verifying && (
        <VerifyDialog
          // A new key = a new link: the dialog starts again (tick cleared, no stale error).
          key={`${verifying.key}|${verifying.check}|${verifying.detail}`}
          accountName={p.accountName}
          platform={p.platform}
          creatorName={who}
          clientName={p.clientName}
          linkUrl={verifying.url}
          own={ownershipView(verifying.check, verifying.detail)}
          notice={verifying.notice}
          onCancel={() => setVerifying(null)}
          onConfirm={async (hand) => {
            try {
              await p.onVerify(hand, verifying.key, { check: verifying.check, detail: verifying.detail });
              setVerifying(null);
            } catch (e) {
              if (!(e instanceof LinkChangedError)) throw e;
              // The creator's link (or the check on it) moved on while the dialog was open, and nothing was verified. The
              // dialog follows to what the offer says now, with the tick cleared, so the next verify is about a link staff have seen.
              const n = e.offer;
              if (n && n.status === "accepted" && !n.linkVerifiedAt && n.linkUrl && n.linkCanonicalKey) {
                setVerifying({
                  url: n.linkUrl,
                  key: n.linkCanonicalKey,
                  check: n.ownershipCheck,
                  detail: n.ownershipDetail,
                  notice: n.linkCanonicalKey !== verifying.key
                    ? `${who} sent a different link since you opened this. Nothing was verified. The new link is shown below: open it, check it, then verify again.`
                    : "The check on this link changed since you opened this. Nothing was verified. Its result is shown below: look again, then verify.",
                });
              } else {
                setVerifying(null);
                setClosedNotice(`${who}'s link is no longer waiting to be verified (the offer or the link changed while the dialog was open). Nothing was verified. What the page shows now is current.`);
              }
            }
          }}
        />
      )}
    </div>
  );
}

function VerifyDialog({ accountName, platform, creatorName, clientName, linkUrl, own, notice, onCancel, onConfirm }: {
  accountName: string;
  platform: string;
  creatorName: string;
  clientName: string;
  linkUrl: string;
  own: OwnershipView;
  /** Set when the dialog moved to a different link or check while it was open. */
  notice?: string;
  onCancel: () => void;
  onConfirm: (ownershipCheckedByHand: boolean) => Promise<void>;
}) {
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  // The tick is needed exactly when the API would refuse without it: the check did not pass.
  const needsTick = !own.passed;
  const href = safeHref(linkUrl);

  // Focus moves into the dialog (to Cancel: the safe default for an action that can't be undone) and returns to the button
  // that opened it; Escape closes (not mid-request); Tab stays inside.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    (box.current?.querySelector<HTMLElement>("[data-first]") ?? box.current)?.focus();
    return () => opener?.focus?.();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !busy) {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    const f = [...box.current.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),input:not([disabled])")];
    if (f.length === 0) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm(needsTick && ticked);
    } catch (e: any) {
      // Stay open: the API's reason (ownership not checked, link already used, payout void…) is the thing to read.
      setError(e?.message || "That didn't work.");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      onKeyDown={onKeyDown}
    >
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="verify-title" tabIndex={-1} className={`${CARD} w-full max-w-[520px] max-h-[calc(100vh-32px)] overflow-y-auto p-5`}>
        <h2 id="verify-title" className="text-[16px] font-semibold text-ds-text">Verify this link &amp; release</h2>
        {notice && <div role="alert" className="mt-2 rounded-[8px] px-3 py-2 text-[12.5px] text-ds-gold" style={{ background: TONE.warn.bg, border: `1px solid ${TONE.warn.border}` }}>{notice}</div>}
        <p className="mt-1.5 text-[13px] text-ds-t2">
          {creatorName} sent this <span className="capitalize">{platform}</span> link for <strong className="text-ds-text">{accountName}</strong>. Open it and look at the post before you verify.
        </p>
        <div className="mt-3 rounded-[8px] bg-ds-inset px-3 py-2 text-[12.5px] break-all">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-start gap-1 text-ds-gold hover:underline">
              <span>{linkUrl}</span><ExternalLink className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            </a>
          ) : (
            <span className="text-ds-t5">{linkUrl} <span className="text-ds-t3">(not a web link)</span></span>
          )}
        </div>
        <div className="mt-3"><OwnershipBox v={own} /></div>

        {needsTick && (
          <label className="mt-3 flex items-start gap-2.5 text-[13px] text-ds-t5 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#E9BD62]"
              checked={ticked}
              disabled={busy}
              onChange={(e) => setTicked(e.target.checked)}
            />
            <span>I checked this link on the creator&apos;s page myself <span className="text-ds-t3">(required: it wasn&apos;t confirmed automatically)</span></span>
          </label>
        )}

        <ul className="mt-3 grid gap-1 text-[12.5px] text-ds-t2 list-disc pl-5">
          <li>The creator&apos;s link becomes the live post{clientName ? <>, and {clientName} is emailed that it is live</> : ""}.</li>
          <li>
            The creator&apos;s payout is scheduled for release, not paid at once: it goes out when its hold has run out
            {needsTick ? " (at least a day, because ownership wasn't confirmed automatically)" : ""}, and only if every check still passes at that moment (no dispute open, no bank change pending, releases switched on). Until then you can pause it or take it back from the payout panel on this post.
          </li>
          <li>It can&apos;t be undone from here.</li>
        </ul>

        {error && <div className="mt-3"><ErrorBar message={error} /></div>}
        <div className="mt-4 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button data-first type="button" className={`${BTN_GHOST} w-full sm:w-auto`} onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className={`${BTN_GOLD} w-full sm:w-auto`} onClick={confirm} disabled={busy || (needsTick && !ticked)}>
            {busy ? "Verifying…" : "Verify link & release"}
          </button>
        </div>
      </div>
    </div>
  );
}
