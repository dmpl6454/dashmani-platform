"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { ArrowRight, Check, Circle } from "lucide-react";
import { apiFetch, fetcher } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { errorSentence } from "@/lib/messages";
import { fmtDate } from "@/lib/format";
import type { CreatorMe, CreatorMeWithChecklist } from "@/lib/types";
import { Banner, Loading, PageHead } from "@/components/ui";

// Overview: the onboarding checklist from GET /v1/creator/me (verify email → connect Facebook →
// at least one page that can publish → send for review) and a banner for every review outcome.

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
        Brands book promotion on your page through Digital Sukoon, and you approve every booking before anything is posted.
        Finish the steps below and our team will review your profile.
      </PageHead>
      <StatusBanner me={me} />
      <Checklist me={me} onChange={(next) => (next ? mutate({ ...me, ...next }, { revalidate: true }) : mutate())} />
    </div>
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

function Checklist({ me, onChange }: { me: CreatorMeWithChecklist; onChange: (next?: CreatorMe) => void }) {
  const c = me.checklist;
  const [resend, setResend] = useState<{ state: "idle" | "sending" | "sent"; error: string }>({ state: "idle", error: "" });
  const [submit, setSubmit] = useState<{ busy: boolean; error: string }>({ busy: false, error: "" });

  async function resendLink() {
    setResend({ state: "sending", error: "" });
    try {
      await apiFetch("/creator/auth/resend-verification", { method: "POST" });
      setResend({ state: "sent", error: "" });
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
              <p>We sent a link to <span className="text-white font-semibold break-all">{me.email}</span>. Open it to confirm your address — check spam too.</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button type="button" className="btn btn-ghost btn-sm" onClick={resendLink} disabled={resend.state === "sending"}>
                  {resend.state === "sending" ? <><span className="spinner" aria-hidden /> Sending…</> : "Send a new link"}
                </button>
                <span aria-live="polite" className="text-sm">
                  {resend.state === "sent" && <span className="text-success">Sent — check your inbox in a minute.</span>}
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
      </ol>
    </section>
  );
}
