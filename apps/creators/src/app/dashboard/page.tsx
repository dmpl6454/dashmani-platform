"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { ArrowRight, Check, Circle } from "lucide-react";
import { apiFetch, fetcher, PAYOUT_ACCOUNT_PATH } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { errorSentence } from "@/lib/messages";
import { fmtDate } from "@/lib/format";
import type { CreatorMe, CreatorMeWithChecklist, PayoutAccountResponse, PayoutAccountStatus } from "@/lib/types";
import { useAwaitingAnswerCount } from "@/lib/use-offers";
import { Banner, Loading, PageHead } from "@/components/ui";

// Overview: the onboarding checklist from GET /v1/creator/me (verify email → connect Facebook →
// at least one page that can publish → send for review) and a banner for every review outcome.
// A fifth row, "Add your bank account", is drawn ONLY when the API sends checklist.payoutAccount (it
// does so only while bank connect is open); it is never assumed, so while that is dark nothing changes.
// A "Bookings" card sits above the checklist ONLY when GET /creator/marketplace-status said bookings are open and the
// creator is approved (an unapproved creator has no offers to count); dark, it is not drawn at all.

export default function DashboardPage() {
  const { updateCreator } = useAuth();
  const { data: me, error, isLoading, mutate } = useSWR<CreatorMeWithChecklist>("/creator/me", fetcher, {
    revalidateOnFocus: true,
    dedupingInterval: 5_000,
  });

  // Keep the header's cached name/status in step with the server.
  useEffect(() => {
    if (!me) return;
    const { checklist: _checklist, ...creator } = me;
    updateCreator(creator);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  if (isLoading && !me) return <Loading label="Loading your account…" />;
  if (error && !me) {
    return (
      <Banner tone="danger" role="alert" title="We couldn't load your account." action={<button className="btn btn-sm" onClick={() => mutate()}>Try again</button>}>
        {errorSentence(error)}
      </Banner>
    );
  }
  if (!me) return null;

  const first = me.name.split(" ")[0] || me.name;
  return (
    <div className="flex flex-col gap-8">
      <PageHead kicker="Overview" title={<>Hi {first}.</>}>
        Paid bookings are coming soon: brands will book promotion on your page through Digital Sukoon, and you approve every
        booking before anything is posted. Anyone can join; paid bookings will need a PAN and an Indian bank account. Finish the
        steps below and our team will review your profile.
      </PageHead>
      <StatusBanner me={me} />
      <BookingsCard approved={me.status === "approved"} />
      <Checklist me={me} onChange={(next) => (next ? mutate({ ...me, ...next }, { revalidate: true }) : mutate())} />
    </div>
  );
}

/** The offers waiting for an answer. The count is shown only once it is known: until then (or if it failed) the card just points at Bookings. */
function BookingsCard({ approved }: { approved: boolean }) {
  const { open, count } = useAwaitingAnswerCount();
  if (!open || !approved) return null;
  return (
    <section className="card p-5 sm:p-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-4" aria-labelledby="bookings-title">
      <div className="min-w-0 flex-1 basis-56">
        <h2 id="bookings-title" className="font-extrabold text-lg tracking-[-0.02em]">Bookings</h2>
        <p className="mt-1 text-sm text-ink-3 leading-relaxed">
          {count == null
            ? "See the booking offers made for your pages."
            : count === 0
              ? "No offers are waiting for your answer."
              : `${count} ${count === 1 ? "offer is" : "offers are"} waiting for your answer.`}
        </p>
      </div>
      <Link href="/offers" className={`btn btn-sm ${count ? "" : "btn-ghost"}`}>See bookings <ArrowRight size={14} aria-hidden /></Link>
    </section>
  );
}

function StatusBanner({ me }: { me: CreatorMeWithChecklist }) {
  switch (me.status) {
    case "in_review":
      return (
        <Banner tone="info" title="Your profile is in review.">
          You sent it on {fmtDate(me.submittedAt)}. Our team is checking your pages; we&apos;ll email {me.email} when we&apos;ve decided.
          Keep your Facebook connection in place meanwhile — if you disconnect, we can&apos;t check your pages.
        </Banner>
      );
    case "approved":
      return (
        <Banner tone="success" title="You're approved.">
          Welcome to Digital Sukoon Creators. Our team turns on each of your pages for booking, and we&apos;ll email you when brands can book them.
          Keep your Facebook connection active so we can publish the campaigns you accept.
        </Banner>
      );
    case "rejected":
      return (
        <Banner tone="danger" title="Your profile wasn't approved this time.">
          {me.reviewNote && <p className="whitespace-pre-line"><span className="text-white font-semibold">Our note: </span>{me.reviewNote}</p>}
          <p className={me.reviewNote ? "mt-2" : ""}>
            You can make changes — for example connect a different page — and send your profile again below.
            Questions: <a className="underline" href="mailto:creators@digitalsukoon.com">creators@digitalsukoon.com</a>.
          </p>
        </Banner>
      );
    case "suspended":
      return (
        <Banner tone="danger" title="Your account is suspended.">
          {me.reviewNote && <p className="whitespace-pre-line"><span className="text-white font-semibold">Our note: </span>{me.reviewNote}</p>}
          <p className={me.reviewNote ? "mt-2" : ""}>
            Your pages aren&apos;t offered for booking while the account is suspended. Email{" "}
            <a className="underline" href="mailto:creators@digitalsukoon.com">creators@digitalsukoon.com</a> to talk to us.
          </p>
        </Banner>
      );
    default:
      return null;
  }
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className="card p-5 sm:p-6 flex gap-4">
      <span
        className={`shrink-0 w-9 h-9 grid place-items-center border-2 font-extrabold text-sm ${done ? "bg-indigo border-indigo text-white" : "border-white/30 text-ink-3"}`}
        aria-hidden
      >
        {done ? <Check size={16} strokeWidth={3} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="font-extrabold text-lg tracking-[-0.02em] flex items-center gap-2 flex-wrap">
          {title}
          <span className={`text-[11px] uppercase tracking-[0.1em] font-bold ${done ? "text-success" : "text-ink-4"}`}>
            {done ? "Done" : "To do"}
          </span>
        </h2>
        <div className="mt-2 text-sm text-ink-3 leading-relaxed">{children}</div>
      </div>
    </li>
  );
}

/** POST /creator/auth/resend-verification: `sent` is false when the address was already confirmed. */
type ResendResult = { sent: boolean; alreadyVerified?: boolean };

function Checklist({ me, onChange }: { me: CreatorMeWithChecklist; onChange: (next?: CreatorMe) => void }) {
  const c = me.checklist;
  const [resend, setResend] = useState<{ state: "idle" | "sending" | "sent" | "verified"; error: string }>({ state: "idle", error: "" });
  const [submit, setSubmit] = useState<{ busy: boolean; error: string }>({ busy: false, error: "" });

  async function resendLink() {
    setResend({ state: "sending", error: "" });
    try {
      const r = await apiFetch<ResendResult>("/creator/auth/resend-verification", { method: "POST" });
      if (r.data?.alreadyVerified) {
        // Confirmed in another tab (or on another device) since this page loaded: say so and
        // re-read the account so the checklist ticks this step.
        setResend({ state: "verified", error: "" });
        onChange();
      } else if (r.data?.sent) {
        setResend({ state: "sent", error: "" });
      } else {
        setResend({ state: "idle", error: "We couldn't send a new link. Please try again in a moment." });
      }
    } catch (err: any) {
      setResend({
        state: "idle",
        error: err?.code === "TOO_SOON" ? "We sent one moments ago — wait two minutes before asking for another." : errorSentence(err),
      });
    }
  }

  async function sendForReview() {
    setSubmit({ busy: true, error: "" });
    try {
      const r = await apiFetch<CreatorMe>("/creator/me/submit", { method: "POST" });
      setSubmit({ busy: false, error: "" });
      onChange(r.data);
    } catch (err) {
      setSubmit({ busy: false, error: errorSentence(err) });
      onChange();
    }
  }

  const canSend = me.status === "draft" || me.status === "rejected";
  const ready = c.emailVerified && c.publishablePages > 0;

  return (
    <section aria-labelledby="steps-title">
      <h2 id="steps-title" className="kicker mb-4">Your setup</h2>
      <ol className="flex flex-col gap-3">
        <Step n={1} done={c.emailVerified} title="Confirm your email">
          {c.emailVerified ? (
            <p>{me.email} is confirmed.</p>
          ) : (
            <>
              <p>Confirm <span className="text-white font-semibold break-all">{me.email}</span> with the link we email you — check spam too, and open it while signed in. No email? Send a new one.</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button type="button" className="btn btn-ghost btn-sm" onClick={resendLink} disabled={resend.state === "sending"}>
                  {resend.state === "sending" ? <><span className="spinner" aria-hidden /> Sending…</> : "Send a new link"}
                </button>
                <span aria-live="polite" className="text-sm">
                  {resend.state === "sent" && <span className="text-success">Sent — check your inbox in a minute.</span>}
                  {resend.state === "verified" && <span className="text-success">Your email is already confirmed.</span>}
                  {resend.error && <span className="text-danger">{resend.error}</span>}
                </span>
              </div>
              <p className="mt-2 text-xs text-ink-4">Wrong address? Change it by emailing creators@digitalsukoon.com.</p>
            </>
          )}
        </Step>

        <Step n={2} done={c.connected} title="Connect Facebook">
          {c.connected ? (
            <p>Your Facebook account is connected. <Link href="/connect" className="text-indigo-light underline underline-offset-2">See your pages</Link>.</p>
          ) : (
            <>
              <p>Sign in with Facebook so we can see the Pages and Instagram professional accounts you manage. Facebook will show our app&apos;s name, “Post Automation 2”.</p>
              <Link href="/connect" className="btn btn-sm mt-3">Connect Facebook <ArrowRight size={14} aria-hidden /></Link>
            </>
          )}
        </Step>

        <Step n={3} done={c.publishablePages > 0} title="A page that can publish">
          {c.publishablePages > 0 ? (
            <p>{c.publishablePages} {c.publishablePages === 1 ? "page is" : "pages are"} ready to publish.</p>
          ) : c.connected ? (
            <>
              <p>None of your connected pages can publish yet. Usually Facebook didn&apos;t grant the publishing permission, or the Instagram account isn&apos;t a professional account linked to a Page you manage.</p>
              <Link href="/connect" className="btn btn-ghost btn-sm mt-3">See what&apos;s missing <ArrowRight size={14} aria-hidden /></Link>
            </>
          ) : (
            <p>Once Facebook is connected, we check each page and show which ones we can publish to.</p>
          )}
        </Step>

        <Step n={4} done={c.submitted} title="Send your profile for review">
          {me.status === "in_review" && <p>Sent on {fmtDate(me.submittedAt)}. We&apos;ll email you with the outcome.</p>}
          {me.status === "approved" && <p>Approved — you&apos;re part of Digital Sukoon Creators.</p>}
          {me.status === "suspended" && <p>Not available while your account is suspended.</p>}
          {canSend && (
            <>
              <p>
                {me.status === "rejected"
                  ? "Made your changes? Send your profile again and our team will take another look."
                  : "When the steps above are done, send your profile and our team will review your pages."}
              </p>
              {!ready && (
                <ul className="mt-2 list-none flex flex-col gap-1">
                  {!c.emailVerified && <li className="flex gap-2"><Circle size={8} className="mt-1.5 shrink-0" aria-hidden /> Confirm your email first.</li>}
                  {c.publishablePages === 0 && <li className="flex gap-2"><Circle size={8} className="mt-1.5 shrink-0" aria-hidden /> Connect at least one page that can publish first.</li>}
                </ul>
              )}
              <div className="mt-3 flex flex-col gap-3">
                <div>
                  <button type="button" className="btn btn-sm" onClick={sendForReview} disabled={submit.busy}>
                    {submit.busy ? <><span className="spinner" aria-hidden /> Sending…</> : <>Send for review <ArrowRight size={14} aria-hidden /></>}
                  </button>
                </div>
                {submit.error && <Banner tone="danger" role="alert">{submit.error}</Banner>}
              </div>
            </>
          )}
        </Step>

        {c.payoutAccount && (
          <Step n={5} done={c.payoutAccount.done} title="Add your bank account">
            <PayoutStepBody status={c.payoutAccount.status} ready={me.status === "approved" && me.emailVerified} />
          </Step>
        )}
      </ol>
    </section>
  );
}

/** What the bank-connect row says for the status the API reported. Wording only: nothing here decides the status. */
function PayoutStepBody({ status, ready }: { status: PayoutAccountStatus; ready: boolean }) {
  const open = (label: string, ghost = true) => (
    <Link href="/payouts" className={`btn ${ghost ? "btn-ghost " : ""}btn-sm mt-3`}>{label} <ArrowRight size={14} aria-hidden /></Link>
  );
  switch (status) {
    case "not_started":
      return ready ? (
        <>
          <p>Add your bank account now so you&apos;re ready when paid bookings open. Paid bookings need a PAN and an Indian bank account. You can do this any time; it isn&apos;t needed to send your profile for review.</p>
          {open("Add bank account", false)}
        </>
      ) : (
        <p>You can add your bank account once your email is confirmed and our team has approved your profile.</p>
      );
    case "setting_up":
    case "failed":
      return <PayoutUnfinishedBody status={status} ready={ready} open={open} />;
    case "under_review":
      return (
        <>
          <p>Your details are with Razorpay, which is checking your payout account.</p>
          {open("See status")}
        </>
      );
    case "needs_clarification":
      return (
        <>
          <p>Razorpay asked for more information about your payout account.</p>
          {open("See what it asked")}
        </>
      );
    case "suspended":
      return (
        <>
          <p>Razorpay has suspended your payout account.</p>
          {open("See status")}
        </>
      );
    case "activated":
      return <p>Your payout account is active, so you&apos;re ready when paid bookings open.</p>;
    default:
      return null;
  }
}

/**
 * An account that is unfinished or refused. Two things decide what the row may promise, and the checklist
 * item carries neither: whether the creator can act at all (`ready`: approved with a confirmed email, else the
 * Payouts page has no form), and whether the refusal is theirs to correct (`attention`, from the same payout
 * answer the Payouts page and the nav already share, so this costs no extra request). Until that answer is in,
 * the row says nothing about WHAT to do and only points at the page.
 */
function PayoutUnfinishedBody({ status, ready, open }: { status: "setting_up" | "failed"; ready: boolean; open: (label: string, ghost?: boolean) => React.ReactNode }) {
  const { data } = useSWR<PayoutAccountResponse>(PAYOUT_ACCOUNT_PATH, fetcher, { revalidateOnFocus: false, shouldRetryOnError: false });
  if (!ready) {
    return (
      <>
        <p>
          {status === "failed" ? "Razorpay didn't accept some of the details." : "Your bank account setup was started but isn't finished."}{" "}
          Adding a bank account is on hold until your profile is approved and your email is confirmed.
        </p>
        {open("See status")}
      </>
    );
  }
  if (status === "setting_up") {
    return (
      <>
        <p>Your bank account setup was started but isn&apos;t finished. Send your details again to finish it.</p>
        {open("Finish setup")}
      </>
    );
  }
  const account = data?.account;
  const attention = account?.status === "failed" ? account.attention ?? (account.requirements.length > 0 ? "fix_details" : "contact_us") : null;
  if (attention === "fix_details") {
    return (
      <>
        <p>Razorpay didn&apos;t accept some of the details. Correct them and send them again.</p>
        {open("Correct details", false)}
      </>
    );
  }
  if (attention === "contact_us") {
    return (
      <>
        <p>Razorpay couldn&apos;t finish setting up your payout account. Our team needs to look at it: email creators@digitalsukoon.com.</p>
        {open("See status")}
      </>
    );
  }
  return (
    <>
      <p>Razorpay didn&apos;t accept your bank account setup. The Payouts page says what to do next.</p>
      {open("See status")}
    </>
  );
}
