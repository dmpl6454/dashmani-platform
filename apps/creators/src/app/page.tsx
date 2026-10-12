"use client";
import Link from "next/link";
import { ArrowRight, BadgeCheck, CircleDollarSign, HandCoins, ShieldCheck } from "lucide-react";
import { SiteShell } from "@/components/site-shell";

// Landing page for creators.digitalsukoon.com: what the programme is, who can join, how it works.
// Every claim here matches what the portal actually does (Phase A: sign up, connect, review).

const PROMISES = [
  { icon: HandCoins, title: "Brands book your page", body: "Brands and agencies book promotion on your Facebook Page or Instagram account through Digital Sukoon." },
  { icon: ShieldCheck, title: "You approve every booking", body: "Nothing is posted until you accept the booking and the exact post. You can say no to anything." },
  { icon: CircleDollarSign, title: "You set your price", body: "You decide what a post on your page costs. Brands see your price before they book." },
  { icon: BadgeCheck, title: "We pay you", body: "Once the post is live and we've checked it, we pay you the agreed amount for that booking." },
];

const STEPS = [
  { n: "01", title: "Create your account", body: "Your name, email and country. Confirm your email from the link we send." },
  { n: "02", title: "Connect Facebook", body: "Sign in with Facebook and pick the Pages and Instagram accounts you want to bring. The Facebook window shows our app's name, “Post Automation 2”." },
  { n: "03", title: "Send for review", body: "We check that each page is yours, that it's active, and that we can publish to it. We'll email you the outcome." },
  { n: "04", title: "Get booked", body: "Once approved and your pages are turned on, brands can book them. You accept or decline each booking." },
];

export default function LandingPage() {
  return (
    <SiteShell>
      <section className="border-b-2 border-border bg-[linear-gradient(140deg,#0a06ba,#403cfa)]">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-24">
          <p className="text-[13px] uppercase tracking-[0.12em] text-white/75">Digital Sukoon Creators</p>
          <h1 className="mt-4 text-[clamp(36px,9vw,104px)] font-extrabold tracking-[-0.05em] leading-[0.92] max-w-4xl">
            Your page.<br /><span className="text-indigo-light">Paid promotions,</span><br />on your terms.
          </h1>
          <p className="mt-6 text-[17px] leading-relaxed text-white/90 max-w-2xl">
            Join the Digital Sukoon creator network. Brands book promotion on your Facebook Page or Instagram account, you approve
            each booking before anything is posted, and we pay you once it&apos;s live. Open to creators worldwide.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/signup" className="btn btn-light">
              Join as a creator <ArrowRight size={17} aria-hidden />
            </Link>
            <Link href="/login" className="btn btn-ghost">I already have an account</Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-14 sm:py-20" aria-labelledby="how-title">
        <p className="kicker">What it is</p>
        <h2 id="how-title" className="mt-2 text-[clamp(30px,5vw,48px)] font-extrabold tracking-[-0.04em] leading-[1.02]">Promotion that stays in your hands.</h2>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PROMISES.map(({ icon: Icon, title, body }) => (
            <li key={title} className="card p-5 sm:p-6">
              <Icon size={22} className="text-indigo-light" aria-hidden />
              <h3 className="mt-4 font-extrabold text-lg tracking-[-0.02em]">{title}</h3>
              <p className="mt-2 text-sm text-ink-3 leading-relaxed">{body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="border-y-2 border-border bg-surface" aria-labelledby="req-title">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-14 sm:py-20 grid gap-10 lg:grid-cols-2">
          <div>
            <p className="kicker">Who can join</p>
            <h2 id="req-title" className="mt-2 text-[clamp(30px,5vw,48px)] font-extrabold tracking-[-0.04em] leading-[1.02]">What you need.</h2>
            <p className="mt-4 text-ink-3 leading-relaxed max-w-xl">
              We publish through Meta&apos;s official tools, so the page has to be one Facebook lets you manage and publish to.
            </p>
          </div>
          <ul className="flex flex-col gap-3 text-[15px] leading-relaxed">
            <li className="card p-5">
              <p className="font-bold text-white">A Facebook Page you manage</p>
              <p className="mt-1 text-sm text-ink-3">You need full control of the Page (not just a role that can post comments).</p>
            </li>
            <li className="card p-5">
              <p className="font-bold text-white">or an Instagram professional account</p>
              <p className="mt-1 text-sm text-ink-3">A business or creator account, linked to a Facebook Page you manage. Personal Instagram accounts can&apos;t be connected.</p>
            </li>
            <li className="card p-5">
              <p className="font-bold text-white">You are 18 or older</p>
              <p className="mt-1 text-sm text-ink-3">And the pages you connect are yours to promote on.</p>
            </li>
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-14 sm:py-20" aria-labelledby="steps-title">
        <p className="kicker">How it works</p>
        <h2 id="steps-title" className="mt-2 text-[clamp(30px,5vw,48px)] font-extrabold tracking-[-0.04em] leading-[1.02]">Four steps.</h2>
        <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <li key={s.n} className="card p-5 sm:p-6">
              <span className="font-mono text-sm text-indigo-light">{s.n}</span>
              <h3 className="mt-3 font-extrabold text-lg tracking-[-0.02em]">{s.title}</h3>
              <p className="mt-2 text-sm text-ink-3 leading-relaxed">{s.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-10 card p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center gap-5 justify-between">
          <div>
            <h3 className="text-2xl font-extrabold tracking-[-0.03em]">Ready to join?</h3>
            <p className="mt-1 text-sm text-ink-3">It&apos;s free to sign up. Questions first? <a className="text-indigo-light underline underline-offset-2" href="mailto:creators@digitalsukoon.com">creators@digitalsukoon.com</a></p>
          </div>
          <Link href="/signup" className="btn self-start sm:self-auto">Create a creator account <ArrowRight size={17} aria-hidden /></Link>
        </div>
      </section>
    </SiteShell>
  );
}
