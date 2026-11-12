"use client";
import { useEffect } from "react";
import Link from "next/link";
import { SUPPORT_WHATSAPP_DISPLAY, whatsappSupportUrl } from "@/lib/support";

// The client agreement for campaigns booked on client.digitalsukoon.com (owner decision
// 2026-11-12, G60: standard terms now, changed over time as needed — bump UPDATED when they do).
// Plain English on purpose; every promise here is something the portal actually does.
const UPDATED = "12 November 2026";

export default function ClientTermsPage() {
  useEffect(() => { document.title = "Terms · Digital Sukoon"; }, []);
  return (
    <main className="min-h-screen bg-bg text-ink">
      <div className="max-w-[760px] mx-auto px-4 sm:px-6 py-10 sm:py-14">
        <Link href="/login" className="text-[12.5px] text-ink-3 hover:text-ink">← Digital Sukoon client portal</Link>
        <p className="kicker mt-6">Client agreement</p>
        <h1 className="text-[28px] sm:text-[34px] font-bold mt-1">Terms for campaigns</h1>
        <p className="text-[13px] text-ink-3 mt-1">Last updated {UPDATED}</p>

        <div className="terms-body mt-8 space-y-4 text-[14.5px] leading-relaxed text-ink-2">
          <p>
            These terms are the agreement between your business and Digital Sukoon Private Limited (“Digital Sukoon”, “we”, “us”)
            when you use the client portal at client.digitalsukoon.com to book promotion on our network. By creating an account or
            submitting a campaign you agree to them. Questions: <a href="mailto:hello@digitalsukoon.com">hello@digitalsukoon.com</a>.
          </p>

          <h2>1. What we do</h2>
          <p>
            You choose accounts from our catalogue — pages we run, and pages of independent creators — and give us a video or image,
            a caption and the dates you want. We review the campaign, prepare the post (including any printed text you asked for)
            and post it, or have the creator post it, on each account you booked, within your posting dates. We then send you the
            link to every post.
          </p>

          <h2>2. Your account</h2>
          <ul>
            <li>You must be authorised to act for the business you sign up for. The details you give us must be true.</li>
            <li>Everyone you add on the Team page acts for your business. You are responsible for what is done from your account.</li>
          </ul>

          <h2>3. Your content</h2>
          <ul>
            <li>You confirm you own, or have permission to use, everything you give us — video, images, music, logos, text and any people shown — for promotion on social media.</li>
            <li>You allow us, and the creators you book, to copy, resize, add your printed text to, and publish that material on the accounts you booked, and to keep it there for the period in section 6.</li>
            <li>Your content must be lawful and follow the rules of each platform. We may decline or ask you to change a campaign that doesn&apos;t, or that we think could harm an audience or an account.</li>
          </ul>

          <h2>4. Prices and GST</h2>
          <ul>
            <li>Prices come from our current rate card and are shown before you submit. GST is added on top and shown separately.</li>
            <li>The price is fixed for your campaign when you submit it. If a rate changes while you are still choosing accounts, we show you the new total before you submit.</li>
            <li>We issue a GST tax invoice from Digital Sukoon Private Limited.</li>
          </ul>

          <h2>5. Review, approval and payment</h2>
          <ul>
            <li>We review every submitted campaign. We may approve it, ask you for changes, or decline it.</li>
            <li>If you pay online at checkout, a campaign we decline is refunded in full.</li>
            <li>If your campaign is submitted without online payment, you pay against our invoice by the date shown on it.</li>
            <li>A booked post that can&apos;t go live — for example because a creator declines it — is not charged, or is refunded if you already paid for it.</li>
          </ul>

          <h2>6. Posting and how long posts stay up</h2>
          <ul>
            <li>We post within the posting dates you chose. Once a campaign is submitted, its dates, accounts, format and song are fixed; your caption and files can still change if we ask for changes.</li>
            <li>A post stays up on each account for <strong>at least 3 months</strong>, and up to 6 months where we have agreed that with you, unless you ask us to remove it or the law or a platform requires it.</li>
            <li>A creator&apos;s page is posted only after that creator accepts your post. Creators are responsible for labelling the post as paid or sponsored where the platform or advertising rules require it.</li>
          </ul>

          <h2>7. Results</h2>
          <p>
            We send you the link to every post and, where the platform lets us read them, views, likes and comments. Reach and
            engagement depend on the platforms and their audiences, so we don&apos;t guarantee any particular result.
          </p>

          <h2>8. Withdrawing or cancelling a campaign</h2>
          <ul>
            <li>Before you submit, you can cancel a campaign at any time.</li>
            <li>After you submit and before we approve it, you can withdraw it from the campaign page, as long as it wasn&apos;t paid online. Nothing is posted or charged.</li>
            <li>A campaign paid online, or one we have already approved, can be withdrawn only by writing to us. Posts already live are charged.</li>
          </ul>

          <h2>9. Liability</h2>
          <p>
            We work carefully, but platforms can remove posts, limit their reach or go down, and we can&apos;t control that. To the
            extent the law allows, we are not liable for indirect losses, and our total liability for a campaign is limited to the
            amount you paid for it. Nothing here limits liability that the law does not allow us to limit.
          </p>

          <h2>10. Changes to these terms</h2>
          <p>
            We may update these terms as our service changes. The date at the top shows the latest version. Changes apply to
            campaigns submitted after that date; a campaign already submitted keeps the terms it was submitted under.
          </p>

          <h2>11. Contact</h2>
          <p>
            Digital Sukoon Private Limited, 702, Parinee I, Andheri West, Mumbai 400053, India. Email{" "}
            <a href="mailto:hello@digitalsukoon.com">hello@digitalsukoon.com</a> or{" "}
            <a href={whatsappSupportUrl("the client terms")} target="_blank" rel="noopener noreferrer">WhatsApp {SUPPORT_WHATSAPP_DISPLAY}</a>.
          </p>
        </div>
      </div>
      <style jsx global>{`
        .terms-body h2 { color: #fff; font-weight: 700; font-size: 17px; margin-top: 28px; }
        .terms-body ul { list-style: disc; padding-left: 20px; }
        .terms-body li + li { margin-top: 6px; }
        .terms-body a { color: #fff; text-decoration: underline; }
      `}</style>
    </main>
  );
}
