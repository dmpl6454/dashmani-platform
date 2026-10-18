"use client";
import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import type { PayoutRow } from "@/lib/hooks/use-creator-payouts";
import { rupees } from "../_ds";
import type { PayoutActionKey } from "../_payout";
import { PausedChip, PayoutActions, PayoutDetailView, PayoutHint, PayoutPill } from "../_payout-ui";

// The creator's payout for one booked post, as staff see it on the campaign page: where the money stands, the timeline from "planned"
// to "settled" (or to taken back / void / failed), and the same actions the payout queue has. STAFF ONLY: it shows what the creator earns.
//
// ⚠️ HONEST STATES. The API lists only payouts that are not finished, so "no row" never means "no payout was ever made": it says
// "no open payout" and what that can mean. A failed load is never drawn as "no payout".

export interface PayoutPanelProps {
  accountName: string;
  bookingId: string;
  /** This post's payout, when one is open. */
  row: PayoutRow | undefined;
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

export function PayoutPanel(p: PayoutPanelProps) {
  const [open, setOpen] = useState(false);
  const label = `Creator payout for ${p.accountName}`;

  if (p.loading) {
    return <div role="group" aria-label={label} className="mt-2.5 rounded-[10px] bg-ds-inset px-3 py-3 text-[12px] text-ds-t3">Loading the creator&apos;s payout…</div>;
  }
  if (p.failed) {
    return (
      <div role="group" aria-label={label} className="mt-2.5 rounded-[10px] bg-ds-inset px-3 py-3 text-[12px]">
        <p role="alert" className="text-[#FB7185]">Couldn&apos;t load this campaign&apos;s payouts. This is a loading problem: it does not mean there is no payout.</p>
        <button type="button" onClick={p.onRetry} className="mt-1.5 inline-flex items-center gap-1.5 text-ds-gold hover:underline"><RefreshCw className="h-3.5 w-3.5" />Try again</button>
      </div>
    );
  }
  if (!p.row) {
    return (
      <div role="group" aria-label={label} className="mt-2.5 rounded-[10px] bg-ds-inset px-3 py-3 text-[12px] text-ds-t3">
        <span className="text-[10.5px] uppercase tracking-[.1em] font-semibold">Creator payout</span>
        <p className="mt-1">No open payout for this post. It has finished (paid out, taken back or void), or none was created. Finished payouts are not listed here.</p>
      </div>
    );
  }

  const r = p.row;
  return (
    <div role="group" aria-label={label} className="mt-2.5 rounded-[10px] bg-ds-inset px-3 py-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-[10.5px] uppercase tracking-[.1em] font-semibold text-ds-t3">Creator payout</span>
        <PayoutPill row={r} />
        {r.pausedAt && <PausedChip />}
        <strong className="ml-auto text-ds-text tabular-nums">{rupees(r.amountPaise)}</strong>
      </div>
      <div className="mt-1.5"><PayoutHint row={r} postVerified={p.postVerified} /></div>
      {p.stale && <p className="mt-1.5 text-ds-gold">Couldn&apos;t refresh this just now: what&apos;s shown is the last read.</p>}
      <PayoutActions row={r} releaseOn={p.releaseOn} onOpen={p.onOpen} postVerified={p.postVerified} />
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <button type="button" className="inline-flex items-center gap-1 text-ds-t2 hover:text-ds-text" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} {open ? "Hide timeline & history" : "Show timeline & history"}
        </button>
        <Link href={`/campaigns/payouts?booking=${p.bookingId}&filter=open`} className="text-ds-gold hover:underline">Open in the payout queue</Link>
      </div>
      {open && <PayoutDetailView row={r} />}
    </div>
  );
}
