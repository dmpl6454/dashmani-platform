"use client";
import Link from "next/link";
import useSWR from "swr";
import { ArrowRight } from "lucide-react";
import { fetcher } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import type { CreatorOfferList } from "@/lib/types";
import { Banner, Loading, PageHead } from "@/components/ui";
import { OfferStatus, PLATFORM, fmtIst, fmtWindow, rupees } from "./_offer";

// Bookings: every post a brand booked on the creator's pages, newest first. Open offers (the
// creator still has to accept or decline) and accepted posts the creator posts themselves are
// summarised at the top.

export default function OffersPage() {
  const { data, error, isLoading, mutate } = useSWR<CreatorOfferList>("/creator/offers", fetcher, {
    revalidateOnFocus: true,
    dedupingInterval: 5_000,
  });

  if (isLoading && !data) return <Loading label="Loading your bookings…" />;
  if (error && !data) {
    return (
      <Banner tone="danger" role="alert" title="We couldn't load your bookings." action={<button className="btn btn-sm" onClick={() => mutate()}>Try again</button>}>
        {errorSentence(error)}
      </Banner>
    );
  }
  if (!data) return null;
  const { offers, counts } = data;

  return (
    <div className="flex flex-col gap-6">
      <PageHead kicker="Bookings" title="Paid posts on your pages">
        When a brand books one of your pages, our team checks the content first, then it lands here. Nothing is posted until you accept.
        Your payout is paid by our team after the post is live.
      </PageHead>

      {counts.waiting > 0 && (
        <Banner tone="warn" title={`${counts.waiting} post${counts.waiting === 1 ? " is" : "s are"} waiting for your answer.`}>
          Open each one to see the content, then accept or decline before the time shown.
        </Banner>
      )}
      {counts.toPost > 0 && (
        <Banner tone="info" title={`${counts.toPost} accepted post${counts.toPost === 1 ? "" : "s"} to post yourself.`}>
          We can&apos;t post these through Facebook for you. Post them on your page, then paste the link.
        </Banner>
      )}

      {offers.length === 0 ? (
        <div className="card p-6 text-ink-3 text-sm">
          No bookings yet. Once our team switches your pages on, brands can book them and their posts will appear here.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {offers.map((o) => (
            <li key={o.id}>
              <Link href={`/offers/view?id=${o.id}`} className="card p-4 sm:p-5 flex flex-wrap items-center gap-x-5 gap-y-2 hover:border-white/40">
                <div className="min-w-0 flex-1 basis-[240px]">
                  <p className="font-bold text-white truncate">{o.campaign.brand} · {o.formatLabel}</p>
                  <p className="text-[13px] text-ink-3 truncate">
                    {o.page.name} ({PLATFORM[o.platform] ?? o.platform}) · posting {fmtWindow(o.campaign.launchFrom, o.campaign.launchTo)}
                  </p>
                  {o.canAccept && o.respondBy && <p className="text-[12px] text-attention mt-0.5">Answer by {fmtIst(o.respondBy)}</p>}
                </div>
                <div className="text-right shrink-0">
                  <p className="font-bold tabular-nums">{rupees(o.payoutPaise)}</p>
                  <p className="text-[11px] uppercase tracking-[0.08em] text-ink-3">Your payout</p>
                </div>
                <OfferStatus o={o} />
                <ArrowRight size={16} className="text-ink-3 shrink-0" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
