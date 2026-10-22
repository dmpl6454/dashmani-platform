"use client";
import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import type { PayoutRow, PayoutSummary } from "@/lib/hooks/use-creator-payouts";
import { rupees } from "../_ds";
import { payoutHint, type PayoutActionKey } from "../_payout";
import { PausedChip, PayoutActions, PayoutDetailView, PayoutHint, PayoutPill } from "../_payout-ui";

// The creator's payout for one booked post, as staff see it on the campaign page: where the money stands, the timeline from "planned"
// to "settled" (or to taken back / void / failed / paid by hand), and the same actions the payout queue has. STAFF ONLY: it shows what the
// creator earns.
//
// ⚠️ HONEST STATES. The page reads EVERY payout of the campaign, finished ones too, so a payout that was paid shows "Paid" with its bank
// reference and one that was taken back says so (and says when the creator is still owed). "No payout" means none exists for the post. A
// failed load is never drawn as "no payout": the booking's own compact summary (creatorOffers[].payout) stands in for the status and the
// references while the full read is missing, and the actions say they couldn't load.

export interface PayoutPanelProps {
  accountName: string;
  bookingId: string;
  /** This post's payout, when the campaign's payouts have been read. */
  row: PayoutRow | undefined;
  /** The compact summary the booking itself carries for this post (null/undefined: none created, or an older API). Used only while `row` is missing. */
  summary?: PayoutSummary | null;
  /** The campaign's payouts have not come back yet. */
  loading: boolean;
  /** They could not be read (and nothing earlier is held). */
  failed: boolean;
  /** A refresh failed but an earlier read is still shown. */
  stale: boolean;
  onRetry: () => void;
  releaseOn: boolean | undefined;
  onOpen: (key: PayoutActionKey, row: PayoutRow) => void;
  /** The creator's link for this post has been verified by staff (the offer says so). */
  postVerified: boolean;
}

const shell = "mt-2.5 rounded-[10px] bg-ds-inset px-3 py-3 text-[12px]";

/** The booking's own compact view of a payout: status, amount, the sentence and the bank references. No actions (they need the full row). */
function SummaryView({ s, label, note, onRetry }: { s: PayoutSummary; label: string; note: string | null; onRetry?: () => void }) {
  const reference = s.settlementUtr ?? s.manualReference;
  return (
    <div role="group" aria-label={label} className={shell}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-[10.5px] uppercase tracking-[.1em] font-semibold text-ds-t3">Creator payout</span>
        <PayoutPill row={s} />
        {s.pausedAt && !["settled", "paid_manual", "void", "reversed"].includes(s.status) && <PausedChip />}
        <strong className="ml-auto text-ds-text tabular-nums">{rupees(s.amountPaise)}</strong>
      </div>
      <p className="mt-1.5 text-ds-t2">{payoutHint(s)}</p>
      {reference && <p className="mt-1 text-ds-t3">Bank reference <span className="font-mono text-ds-t5">{reference}</span></p>}
      {note && (
        <div role="alert" className="mt-1.5 text-ds-gold">
          {note}
          {onRetry && <button type="button" onClick={onRetry} className="ml-2 inline-flex items-center gap-1.5 text-ds-gold underline-offset-2 hover:underline"><RefreshCw className="h-3.5 w-3.5" />Try again</button>}
        </div>
      )}
    </div>
  );
}

export function PayoutPanel(p: PayoutPanelProps) {
  const [open, setOpen] = useState(false);
  const label = `Creator payout for ${p.accountName}`;

  if (!p.row) {
    if (p.summary) {
      return <SummaryView s={p.summary} label={label} note={p.failed ? "Couldn't load the actions and history for this payout: this is the booking's own summary. Nothing here means a payout is missing." : p.loading ? "Loading the actions and history…" : null} onRetry={p.failed ? p.onRetry : undefined} />;
    }
    if (p.loading) {
      return <div role="group" aria-label={label} className={`${shell} text-ds-t3`}>Loading the creator&apos;s payout…</div>;
    }
    if (p.failed) {
      return (
        <div role="group" aria-label={label} className={shell}>
          <p role="alert" className="text-[#FB7185]">Couldn&apos;t load this campaign&apos;s payouts. This is a loading problem: it does not mean there is no payout.</p>
          <button type="button" onClick={p.onRetry} className="mt-1.5 inline-flex items-center gap-1.5 text-ds-gold hover:underline"><RefreshCw className="h-3.5 w-3.5" />Try again</button>
        </div>
      );
    }
    return (
      <div role="group" aria-label={label} className={`${shell} text-ds-t3`}>
        <span className="text-[10.5px] uppercase tracking-[.1em] font-semibold">Creator payout</span>
        <p className="mt-1">No payout exists for this post yet. One is made when the client has paid for a creator&apos;s post.</p>
      </div>
    );
  }

  const r = p.row;
  return (
    <div role="group" aria-label={label} className={shell}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-[10.5px] uppercase tracking-[.1em] font-semibold text-ds-t3">Creator payout</span>
        <PayoutPill row={r} />
        {r.pausedAt && !["settled", "paid_manual", "void", "reversed"].includes(r.status) && <PausedChip />}
        <strong className="ml-auto text-ds-text tabular-nums">{rupees(r.amountPaise)}</strong>
      </div>
      <div className="mt-1.5"><PayoutHint row={r} postVerified={p.postVerified} releaseOn={p.releaseOn} /></div>
      {p.stale && <p className="mt-1.5 text-ds-gold">Couldn&apos;t refresh this just now: what&apos;s shown is the last read.</p>}
      <PayoutActions row={r} releaseOn={p.releaseOn} onOpen={p.onOpen} postVerified={p.postVerified} />
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <button type="button" className="inline-flex items-center gap-1 text-ds-t2 hover:text-ds-text" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} {open ? "Hide timeline & history" : "Show timeline & history"}
        </button>
        <Link href={`/campaigns/payouts?booking=${p.bookingId}&filter=all`} className="text-ds-gold hover:underline">Open in the payout queue</Link>
      </div>
      {open && <PayoutDetailView row={r} />}
    </div>
  );
}
