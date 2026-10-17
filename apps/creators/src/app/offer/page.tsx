"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { ArrowLeft } from "lucide-react";
import { ApiError, fetcher } from "@/lib/api";
import { offerErrorSentence } from "@/lib/messages";
import { fmtDate, fmtInr } from "@/lib/format";
import { detailChip, effectiveStatus, formatLabel, handleLabel, OFFERS_PATH, offerPath, platformLabel, type OfferDetail } from "@/lib/offers";
import { useNow } from "@/lib/use-offers";
import { Banner, Loading } from "@/components/ui";
import { StatusChip } from "@/components/offer-ui";
import { InstantBlock, WindowBlock } from "@/components/offer-time";
import { Brief } from "./_brief";
import { AnswerCard, type Answered } from "./_answer";
import { PostAndLink } from "./_link";

// One booking offer (GET /v1/creator/offers/:id; the id rides in `?id=` because a static export has no dynamic
// segments). What the page claims comes only from that answer: while it loads, or when it failed, the page says so,
// and a failed load is never drawn as "nothing here".
//
// The order follows the job. An OPEN offer: the facts (amount, dates, deadline), the paid-partnership instruction,
// what to post, then the answer. An ACCEPTED one leads with what to do next (post it, send the link) and keeps the brief
// below for reference. A verified, declined, expired or withdrawn offer is read-only and says so in a plain sentence.
//
// ⚠️ The only money figure is what the creator receives, from the offer itself. No brand price, no booking total, no
// client and no other creator is anywhere in this answer, so none is shown.

const DISCLOSURE_FALLBACK =
  "This is a paid partnership. Before you publish, switch on the platform's paid-partnership / branded-content label and tag the brand if it asks you to. Do not publish it without the label.";

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-6 max-w-3xl">{children}</div>;
}

function Back() {
  return (
    <Link href="/offers" className="inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-white self-start">
      <ArrowLeft size={14} aria-hidden /> All bookings
    </Link>
  );
}

/** Why an offer could not be read, in a sentence and with the way out that fits. */
function LoadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === "NOT_FOUND") {
    return (
      <Banner tone="info" title="We couldn't find this offer." action={<Link href="/offers" className="btn btn-ghost btn-sm">See your bookings</Link>}>
        {offerErrorSentence(error)}
      </Banner>
    );
  }
  if (code === "MARKETPLACE_DISABLED") {
    return (
      <Banner tone="info" title="Bookings aren't open right now.">
        There&apos;s nothing for you to do for now. Check back here later.
      </Banner>
    );
  }
  if (code === "NOT_APPROVED") {
    return (
      <Banner tone="info" title="Bookings open once your profile is approved." action={<Link href="/dashboard" className="btn btn-ghost btn-sm">Go to Overview</Link>}>
        Our team reviews every profile first.
      </Banner>
    );
  }
  if (code === "ACCOUNT_SUSPENDED") {
    return <Banner tone="danger" role="alert" title="Your account is suspended.">{offerErrorSentence(error)}</Banner>;
  }
  return (
    <Banner tone="danger" role="alert" title="We couldn't load this offer." action={<button className="btn btn-sm" onClick={onRetry}>Try again</button>}>
      {error instanceof ApiError && (error.code === "NETWORK" || error.code === "BAD_RESPONSE") ? error.message : "Something went wrong on our side. Please try again in a moment."}
    </Banner>
  );
}

/** The facts of the offer: the amount, the posting dates, the deadline to answer. */
function Summary({ offer, status, now }: { offer: OfferDetail; status: string; now: number | null }) {
  const live = status === "offered" || status === "accepted" || status === "completed";
  return (
    <section className="card p-5 sm:p-7 flex flex-col gap-5" aria-label="Offer details">
      <div>
        <p className="field-label">{live ? "Your payout" : "Offered amount"}</p>
        <p className="mt-1 text-[clamp(32px,7vw,44px)] font-extrabold tracking-[-0.04em] leading-none">{fmtInr(offer.payout?.paise)}</p>
        <p className="mt-2 text-xs text-ink-3 leading-relaxed">After any tax deducted at source.</p>
      </div>
      <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="field-label">Post between</dt>
          <dd className="mt-1"><WindowBlock window={offer.window} /></dd>
        </div>
        {status === "offered" && (
          <div className="min-w-0">
            <dt className="field-label">Accept by</dt>
            <dd className="mt-1"><InstantBlock iso={offer.expiresAt} now={now} /></dd>
          </div>
        )}
        {status === "expired" && (
          <div className="min-w-0">
            <dt className="field-label">Expired</dt>
            <dd className="mt-1"><InstantBlock iso={offer.expiresAt} now={null} /></dd>
          </div>
        )}
        {status !== "offered" && status !== "expired" && offer.acceptedAt && (
          <div className="min-w-0">
            <dt className="field-label">Accepted</dt>
            <dd className="mt-1 text-white">{fmtDate(offer.acceptedAt)}</dd>
          </div>
        )}
        {offer.brand && (
          <div className="min-w-0">
            <dt className="field-label">Promotes</dt>
            <dd className="mt-1 text-white break-words">{offer.brand}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/** A plain statement for an offer that is over, or whose post is verified. Nothing is promised about money or timing. */
function Statement({ offer, status }: { offer: OfferDetail; status: string }) {
  if (status === "declined") {
    return (
      <Banner tone="info" title="You declined this offer.">
        This booking goes back to the brand and is refunded to them. Nothing is owed to you or by you, and nothing is posted on {offer.pageName}.
      </Banner>
    );
  }
  if (status === "expired") {
    return (
      <Banner tone="info" title="This offer expired.">
        It wasn&apos;t accepted in time, so the booking goes back to the brand. Nothing is owed either way.
      </Banner>
    );
  }
  if (status === "withdrawn") {
    return (
      <Banner tone="info" title="This booking was withdrawn.">
        Our team withdrew it, so there&apos;s nothing more for you to do. If you think that&apos;s a mistake, email creators@digitalsukoon.com.
      </Banner>
    );
  }
  if (status === "completed" || (status === "accepted" && offer.link?.verified)) {
    return (
      <Banner tone="success" title="Our team verified your post.">
        There&apos;s nothing more for you to do on this booking.
      </Banner>
    );
  }
  return (
    <Banner tone="info" title="This offer isn't open.">
      If you have a question about it, email creators@digitalsukoon.com.
    </Banner>
  );
}

function OfferInner() {
  const id = useSearchParams().get("id");
  const { mutate: mutateGlobal } = useSWRConfig();
  const { data, error, isValidating, mutate } = useSWR<OfferDetail>(id ? offerPath(id) : null, fetcher, {
    revalidateOnFocus: true,
    dedupingInterval: 5_000,
    shouldRetryOnError: false,
  });
  const now = useNow();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [note, setNote] = useState<"accepted" | null>(null);
  // Focus goes to the heading when an answer changes what the page shows: the button that was pressed is gone.
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus > 0) headingRef.current?.focus();
  }, [refocus]);

  // An offer the server still calls open after our own clock says it ran out: the server's word stands (a device clock
  // that is ahead must not take the buttons away from an offer that is still open).
  const [serverSaysOpen, setServerSaysOpen] = useState<string | null>(null);
  const status = data ? (serverSaysOpen === data.expiresAt ? data.status : effectiveStatus(data, now)) : "";
  // An open offer whose expiry passes while the page is open: read it again, so the answer is the server's own.
  const ranOut = !!data && data.status === "offered" && status === "expired";
  useEffect(() => {
    if (!ranOut || !data) return;
    const expiresAt = data.expiresAt;
    void mutate().then((fresh) => {
      if (fresh && fresh.status === "offered" && fresh.expiresAt === expiresAt) setServerSaysOpen(expiresAt);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranOut]);

  const refreshAll = () => {
    void mutate();
    void mutateGlobal(OFFERS_PATH);
  };

  if (!id) {
    return (
      <Shell>
        <Back />
        <Banner tone="info" title="This link is missing its offer.">
          Open the offer from your bookings.
        </Banner>
        <div><Link href="/offers" className="btn btn-sm">See your bookings</Link></div>
      </Shell>
    );
  }
  if (!data && !error) {
    return (
      <Shell>
        <Back />
        <Loading label="Loading your offer…" />
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell>
        <Back />
        <LoadFailure error={error} onRetry={() => mutate()} />
      </Shell>
    );
  }

  const chip = detailChip(status, data.link);
  const handle = handleLabel(data.pageHandle);
  const open = status === "offered";
  const accepted = status === "accepted" && !data.link?.verified;
  const showBrief = !!data.brief && (open || accepted);
  const showDisclosure = open || accepted;

  return (
    <Shell>
      <Back />
      <header>
        <p className="kicker">Booking offer</p>
        <h1 ref={headingRef} tabIndex={-1} className="mt-2 text-[clamp(28px,5vw,44px)] font-extrabold tracking-[-0.04em] leading-[1.05] outline-none break-words">
          {formatLabel(data.format)} on {data.pageName}
        </h1>
        <p className="mt-3 text-ink-3 text-[15px] break-words">
          {platformLabel(data.platform)}{handle ? ` · ${handle}` : ""}
        </p>
        <div className="mt-3"><StatusChip label={chip.label} tone={chip.tone} /></div>
      </header>

      {/* A refresh that failed while an answer is on screen: say the answer may be old. */}
      {error && (
        <Banner tone="warn" role="status" action={<button className="btn btn-ghost btn-sm" onClick={() => mutate()} disabled={isValidating}>Try again</button>}>
          We couldn&apos;t refresh this just now, so what you see may be out of date.
        </Banner>
      )}
      {note === "accepted" && status === "accepted" && (
        <Banner tone="success" role="status" title="You accepted this offer.">
          Post it on {data.pageName} as described below, then send us the link.
        </Banner>
      )}

      <Summary offer={data} status={status} now={now} />

      {!open && !accepted && <Statement offer={data} status={status} />}

      {accepted && (
        <PostAndLink
          offer={data}
          onSent={(next) => {
            void mutate(next, { revalidate: false });
            void mutateGlobal(OFFERS_PATH);
          }}
          onStale={refreshAll}
        />
      )}

      {showDisclosure && (
        <Banner tone="warn" title="Switch on the paid-partnership label">
          {data.disclosure || DISCLOSURE_FALLBACK}
        </Banner>
      )}

      {showBrief && data.brief && <Brief brief={data.brief} onRefresh={() => mutate()} />}

      {open && data.actions.accept && data.actions.decline && (
        <AnswerCard
          offer={data}
          onAnswered={(next, answer: Answered) => {
            void mutate(next, { revalidate: false });
            void mutateGlobal(OFFERS_PATH);
            setNote(answer === "accepted" ? "accepted" : null);
            setRefocus((n) => n + 1);
          }}
          onStale={refreshAll}
        />
      )}
      {open && !(data.actions.accept && data.actions.decline) && (
        <Banner tone="info" title="This offer can't be answered right now.">
          If you think that&apos;s a mistake, email creators@digitalsukoon.com.
        </Banner>
      )}
    </Shell>
  );
}

export default function OfferPage() {
  return (
    <Suspense
      fallback={
        <Shell>
          <Back />
          <header>
            <p className="kicker">Booking offer</p>
            <h1 className="mt-2 text-[clamp(28px,5vw,44px)] font-extrabold tracking-[-0.04em] leading-[1.05]">Your offer.</h1>
          </header>
          <Loading label="Loading your offer…" />
        </Shell>
      }
    >
      <OfferInner />
    </Suspense>
  );
}
