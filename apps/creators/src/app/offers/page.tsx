"use client";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ApiError } from "@/lib/api";
import { errorSentence, offerErrorSentence } from "@/lib/messages";
import { fmtInr } from "@/lib/format";
import {
  effectiveStatus,
  formatLabel,
  GROUP_ORDER,
  GROUP_TITLES,
  groupOf,
  handleLabel,
  offerHref,
  platformLabel,
  rowChip,
  type Group,
  type OfferRow,
} from "@/lib/offers";
import { useNow, useOffersList } from "@/lib/use-offers";
import { Banner, Loading, PageHead } from "@/components/ui";
import { StatusChip } from "@/components/offer-ui";
import { InstantBlock, windowText } from "@/components/offer-time";

// Bookings: the creator's own offers (GET /v1/creator/offers), newest first, grouped by what they have to do next.
// Each row carries what the API sends and nothing else: the page, the format, the posting dates, and the one money
// figure there is, what the creator receives. Only a LOADED answer claims a state: while it loads, or when it
// failed, the page says so with a way to retry; it never shows "no offers" for a request that did not succeed.

const HEAD = (
  <PageHead kicker="Bookings" title="Your booking offers.">
    Brands book promotion on your pages through Digital Sukoon. Each offer shows exactly what you would post, when, and what you
    receive for it. You post it yourself, and only if you accept.
  </PageHead>
);

export default function OffersPage() {
  const { data, error, isValidating, mutate } = useOffersList(true);
  const now = useNow();

  if (!data && !error) {
    return (
      <div className="max-w-3xl">
        {HEAD}
        <Loading label="Loading your offers…" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="max-w-3xl">
        {HEAD}
        <LoadFailure error={error} onRetry={() => mutate()} />
      </div>
    );
  }

  const rows = data.map((o) => ({ o, status: effectiveStatus(o, now) }));
  const groups = new Map<Group, Array<{ o: OfferRow; status: string }>>();
  for (const r of rows) {
    const g = groupOf(r.status);
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  // The offers that need an answer: the one that runs out first, first.
  groups.get("answer")?.sort((a, b) => Date.parse(a.o.expiresAt) - Date.parse(b.o.expiresAt));

  return (
    <div className="flex flex-col gap-8 max-w-3xl">
      {HEAD}

      {/* A refresh that failed while an answer is on screen: say the answer may be old. */}
      {error && (
        <Banner tone="warn" role="status" action={<button className="btn btn-ghost btn-sm" onClick={() => mutate()} disabled={isValidating}>Try again</button>}>
          We couldn&apos;t refresh this just now, so what you see may be out of date.
        </Banner>
      )}

      {rows.length === 0 ? (
        <section className="card p-5 sm:p-7">
          <h2 className="text-xl font-extrabold tracking-[-0.03em]">No offers yet</h2>
          <p className="mt-2 text-sm text-ink-3 leading-relaxed max-w-2xl">
            When a brand books one of your pages, the offer appears here and we email you. Nothing is posted unless you accept it.
          </p>
        </section>
      ) : (
        GROUP_ORDER.filter((g) => groups.has(g)).map((g) => (
          <section key={g} aria-labelledby={`group-${g}`}>
            <h2 id={`group-${g}`} className="kicker mb-3">
              {GROUP_TITLES[g]} · {groups.get(g)!.length}
            </h2>
            <ul className="flex flex-col gap-3">
              {groups.get(g)!.map(({ o, status }) => (
                <li key={o.id}>
                  <OfferCard offer={o} status={status} now={now} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function OfferCard({ offer: o, status, now }: { offer: OfferRow; status: string; now: number | null }) {
  const chip = rowChip(status);
  const handle = handleLabel(o.pageHandle);
  const dates = windowText(o.window);
  const open = status === "offered";
  return (
    <Link
      href={offerHref(o.id)}
      className="card block p-5 sm:p-6 hover:border-indigo transition-colors group"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-56">
          <StatusChip label={chip.label} tone={chip.tone} />
          <h3 className="mt-2 text-lg font-extrabold tracking-[-0.02em] break-words">{o.pageName}</h3>
          <p className="mt-1 text-sm text-ink-3 break-words">
            {platformLabel(o.platform)} {formatLabel(o.format).toLowerCase()}
            {handle ? ` · ${handle}` : ""}
          </p>
        </div>
        <div className="sm:text-right">
          <p className="field-label">{status === "offered" || status === "accepted" || status === "completed" ? "Your payout" : "Offered amount"}</p>
          <p className="mt-1 text-2xl font-extrabold tracking-[-0.03em]">{fmtInr(o.payout?.paise)}</p>
        </div>
      </div>
      <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="field-label">Post between</dt>
          <dd className="mt-1 text-white break-words">{dates ? <>{dates} <span className="text-ink-3">(IST)</span></> : <span className="text-ink-3">Not set</span>}</dd>
        </div>
        {open && (
          <div className="min-w-0">
            <dt className="field-label">Accept by</dt>
            <dd className="mt-1">
              <InstantBlock iso={o.expiresAt} now={now} />
            </dd>
          </div>
        )}
      </dl>
      <p className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-bold text-indigo-light group-hover:text-white">
        {open ? "Review the offer" : "Open"} <ArrowRight size={14} aria-hidden />
      </p>
    </Link>
  );
}

/** The failed first load: what went wrong, in a sentence, and the way out that fits it. */
function LoadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === "MARKETPLACE_DISABLED") {
    return (
      <section className="card p-5 sm:p-7">
        <h2 className="text-xl font-extrabold tracking-[-0.03em]">Bookings aren&apos;t open right now</h2>
        <p className="mt-2 text-sm text-ink-3 leading-relaxed max-w-2xl">There&apos;s nothing for you to do for now. Check back here later.</p>
      </section>
    );
  }
  if (code === "NOT_APPROVED") {
    return (
      <Banner tone="info" title="Bookings open once your profile is approved." action={<Link href="/dashboard" className="btn btn-ghost btn-sm">Go to Overview</Link>}>
        Our team reviews every profile first. Finish the steps on the Overview page and send your profile for review.
      </Banner>
    );
  }
  if (code === "ACCOUNT_SUSPENDED") {
    return (
      <Banner tone="danger" role="alert" title="Your account is suspended.">
        {offerErrorSentence(error)}
      </Banner>
    );
  }
  return (
    <Banner tone="danger" role="alert" title="We couldn't load your offers." action={<button className="btn btn-sm" onClick={onRetry}>Try again</button>}>
      {error instanceof ApiError && (error.code === "NETWORK" || error.code === "BAD_RESPONSE") ? errorSentence(error) : "Something went wrong on our side. Please try again in a moment."}
    </Banner>
  );
}
