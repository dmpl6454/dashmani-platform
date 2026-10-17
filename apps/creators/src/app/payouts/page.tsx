"use client";
import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetcher, PAYOUT_ACCOUNT_PATH } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { errorSentence } from "@/lib/messages";
import type { PayoutAccountResponse } from "@/lib/types";
import { Banner, Loading, PageHead } from "@/components/ui";
import { PayoutForm, fieldsForReferences } from "./_form";
import { StatusCard } from "./_status";

// Payouts: add a bank account so a creator is ready when paid bookings open (bank connect, Phase 2 of
// the payouts plan). Everything this page claims comes from GET /v1/creator/payout-account, and ONLY a
// loaded answer may claim a state: while it loads, or when it failed, the page says so with a way to
// retry; it never shows "not started" or an empty page for a request that did not succeed.
//
// States (see PayoutAccountResponse):
//   routeEnabled false, no account  → a calm "isn't open yet" card, no form (the dark state).
//   blockedReason                   → why, and where to go next; no form.
//   no account, canSetUp            → the form.
//   an account                      → the status card; plus the form while setup is unfinished or refused
//                                     (the details are never kept, so a resume asks for them again).
//
// ⚠️ PRIVACY. No query string, no storage, no draft: see _form.tsx. This page reads no URL state at all.

export default function PayoutsPage() {
  const { creator } = useAuth();
  const { data, error, isValidating, mutate } = useSWR<PayoutAccountResponse>(PAYOUT_ACCOUNT_PATH, fetcher, {
    revalidateOnFocus: true,
    dedupingInterval: 5_000,
  });
  const [sent, setSent] = useState(false);

  if (!data && !error) {
    return (
      <div className="max-w-3xl">
        <PageHead kicker="Payouts" title="Your payout account." />
        <Loading label="Loading your payout details…" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="max-w-3xl">
        <PageHead kicker="Payouts" title="Your payout account." />
        <Banner tone="danger" role="alert" title="We couldn't load your payout details." action={<button className="btn btn-sm" onClick={() => mutate()}>Try again</button>}>
          {errorSentence(error)}
        </Banner>
      </div>
    );
  }

  const { routeEnabled, canSetUp, blockedReason, termsVersion } = data;
  // A row that exists but was never touched (a request that stopped before reaching Razorpay) reads
  // "not_started": for this page that is the same as no account at all.
  const account = data.account && data.account.status !== "not_started" ? data.account : null;
  const email = creator?.email ?? null;
  const open = routeEnabled && blockedReason === null;
  const showForm = routeEnabled && canSetUp && (!account || account.status === "failed" || account.status === "setting_up");
  const dark = !routeEnabled && !account;

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <PageHead kicker="Payouts" title="Your payout account.">
        {dark ? (
          <p>Paid bookings will need a PAN and an Indian bank account (INR).</p>
        ) : (
          <>
            <p>
              Add your bank account now so you&apos;re ready when paid bookings open. We send your PAN and bank details to Razorpay, our
              payments partner, to set up your payout account. We do not store them — we keep only a masked reference.
            </p>
            <p className="mt-2">Paid bookings need a PAN and an Indian bank account (INR).</p>
          </>
        )}
      </PageHead>

      {/* A refresh that failed while an answer is on screen: say the answer may be old. */}
      {error && (
        <Banner tone="warn" role="status" action={<button className="btn btn-ghost btn-sm" onClick={() => mutate()} disabled={isValidating}>Try again</button>}>
          We couldn&apos;t refresh this just now, so what you see may be out of date.
        </Banner>
      )}

      {dark && (
        <section className="card p-5 sm:p-7">
          <h2 className="text-xl font-extrabold tracking-[-0.03em]">Bank connect isn&apos;t open yet</h2>
          <p className="mt-2 text-sm text-ink-3 leading-relaxed max-w-2xl">
            There&apos;s nothing for you to do for now. Check back here later.
          </p>
        </section>
      )}

      {!routeEnabled && account && (
        <Banner tone="info" title="Changes to your bank account are paused right now.">
          You can still see where your payout account stands below.
        </Banner>
      )}

      {routeEnabled && blockedReason === "not_approved" && (
        <Banner
          tone="info"
          title="You can add your bank account once your profile is approved."
          action={<Link href="/dashboard" className="btn btn-ghost btn-sm">Go to Overview</Link>}
        >
          Our team reviews every profile first. Finish the steps on the Overview page and send your profile for review.
        </Banner>
      )}
      {routeEnabled && blockedReason === "email_not_verified" && (
        <Banner
          tone="info"
          title="Confirm your email first."
          action={<Link href="/dashboard" className="btn btn-ghost btn-sm">Go to Overview</Link>}
        >
          We open your payout account under your confirmed email address. Use the link we emailed you, or ask for a new one on the Overview page.
        </Banner>
      )}
      {routeEnabled && blockedReason === "closed" && <Banner tone="danger" title="This account is closed." />}
      {routeEnabled && !blockedReason && !canSetUp && !account && (
        <Banner tone="info" title="Adding a bank account isn't available for your account right now.">
          If you think this is a mistake, email creators@digitalsukoon.com.
        </Banner>
      )}

      {sent && account && (
        <Banner tone="success" role="status" title="Sent to Razorpay.">
          Your details went to Razorpay and weren&apos;t kept by us. Its review of your payout account is shown below.
        </Banner>
      )}

      {account && (
        <StatusCard
          account={account}
          actions={open}
          email={email}
          checking={isValidating}
          onCheck={() => void mutate()}
          onChanged={(r) => void mutate(r, { revalidate: false })}
        />
      )}

      {showForm && (
        <PayoutForm
          termsVersion={termsVersion}
          email={email}
          rejected={account?.status === "failed" ? fieldsForReferences(account.requirements.map((r) => r.field)) : []}
          onDone={(r) => {
            setSent(true);
            void mutate(r, { revalidate: false });
          }}
          onChanged={() => void mutate()}
        />
      )}
    </div>
  );
}
