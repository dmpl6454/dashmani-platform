"use client";
import Link from "next/link";
import { LegalPage } from "@/components/site-shell";

// The creator agreement. Plain English on purpose; it describes what the portal actually does.

export default function TermsPage() {
  return (
    <LegalPage kicker="Creator agreement" title="Creator terms" updated="12 October 2026">
      <p>
        These terms are the agreement between you and Digital Sukoon (Dashmani Media Private Limited, “we”, “us”) when you join
        Digital Sukoon Creators at creators.digitalsukoon.com. Please read them — by creating an account you agree to them. If you
        have a question, write to <a href="mailto:creators@digitalsukoon.com">creators@digitalsukoon.com</a>.
      </p>

      <h2>1. What Digital Sukoon Creators is</h2>
      <p>
        Brands and agencies come to Digital Sukoon to promote their products, films, music and campaigns. Through Digital Sukoon
        Creators they can book a promotional post on your Facebook Page or Instagram professional account. We handle the brand,
        prepare the post, publish it on your page once you have accepted it, and pay you.
      </p>

      <h2>2. Who can join</h2>
      <ul>
        <li>You must be <strong>18 or older</strong> and able to enter a binding agreement where you live.</li>
        <li>You may only connect pages that <strong>you own or are authorised to manage</strong> and to accept paid promotions on. If you manage a page for someone else, you confirm you have their permission.</li>
        <li>The details you give us (name, email, country, phone) must be true and kept up to date.</li>
        <li>One person, one account. Don&apos;t share your login.</li>
      </ul>

      <h2>3. Connecting your pages</h2>
      <p>
        You connect pages by signing in with Facebook. The Facebook window shows the name of our Meta app, “Post Automation 2”. You
        choose which Pages and Instagram accounts to share. The permissions let us see those pages, read their follower counts and
        insights, and publish posts to them. We use them only as these terms describe: we never comment, reply or send messages as
        you, never run ads, and never post anything you haven&apos;t accepted. You can disconnect at any time from the Pages screen or
        by removing the app in your Facebook settings.
      </p>

      <h2>4. Review and approval</h2>
      <p>
        After you connect, you send your profile for review. We check that the pages are yours, active and suitable for brands, and
        that we can publish to them. We may approve or decline a profile at our discretion and will tell you the outcome by email. A
        page that is already part of our own network cannot also be booked as a creator page. Approval does not guarantee any
        bookings.
      </p>

      <h2>5. Bookings — you approve each one</h2>
      <ul>
        <li>You set the price for a post on your page.</li>
        <li>Each booking is offered to you with the brand, the post and the price. <strong>Nothing is published until you accept it.</strong> You may decline any booking without giving a reason.</li>
        <li>Once you accept, we publish exactly the post you accepted, on the page and at the time agreed. Please don&apos;t delete or edit it for the period agreed in the booking.</li>
      </ul>

      <h2>6. Your content stays yours</h2>
      <p>
        Your pages, your audience and your own content remain yours. You give us permission to show your page&apos;s name, picture and
        public statistics to brands considering a booking. The brand owns the promotional material it supplies; publishing it on your
        page does not transfer ownership of your page or your other content to anyone.
      </p>

      <h2>7. Paid-partnership labelling</h2>
      <p>
        Promoted posts must be clearly marked as paid or sponsored, as advertising rules and Meta&apos;s branded-content policies require.
        The post we publish will carry a disclosure — such as Meta&apos;s “Paid partnership” label where it is available, or #ad in the
        caption. Don&apos;t remove these labels.
      </p>

      <h2>8. Payment</h2>
      <ul>
        <li>The amount and currency are set per booking and shown to you before you accept.</li>
        <li>We pay you <strong>manually after the post is live and we have verified it</strong> stayed up as agreed. We&apos;ll ask for your payout details before your first payment.</li>
        <li>If a post is removed early, never goes live, or breaks these terms, we may reduce or withhold payment for that booking.</li>
        <li>You are responsible for any taxes on what you earn, unless the law requires us to deduct them.</li>
      </ul>

      <h2>9. Your responsibilities</h2>
      <ul>
        <li>Follow Facebook&apos;s and Instagram&apos;s terms and community standards, and the law where you live.</li>
        <li>Don&apos;t inflate your numbers with bought followers, likes or views, and don&apos;t misrepresent your audience.</li>
        <li>Keep your Facebook connection working while you have bookings, so we can publish what you accepted.</li>
      </ul>

      <h2>10. Suspension</h2>
      <p>
        We may suspend your account — taking your pages off booking — if you break these terms, if a page is no longer yours or no
        longer meets Meta&apos;s rules, or if we see fraud or a risk to brands or audiences. We will tell you why by email, and you can
        reply to discuss it. Bookings you already accepted and that went live as agreed will still be paid.
      </p>

      <h2>11. Closing your account</h2>
      <p>
        You can close your account at any time from Settings. Closing it disconnects Facebook, deletes our copy of your Facebook access
        and takes your pages off booking. Anything owed for posts that already went live as agreed will still be paid. See the{" "}
        <Link href="/privacy">privacy policy</Link> for what we keep afterwards and for how long, and{" "}
        <Link href="/data-deletion">data deletion</Link> for removing your data.
      </p>

      <h2>12. Liability</h2>
      <p>
        We provide the portal as it is and work to keep it reliable, but we can&apos;t promise it will always be available or that you will
        receive bookings. To the extent the law allows, we are not liable for indirect losses, and our total liability to you is limited
        to the amounts we owe you for bookings. Nothing in these terms limits liability that cannot be limited by law.
      </p>

      <h2>13. Changes to these terms</h2>
      <p>
        If we change these terms we will update the date at the top and, for meaningful changes, tell you by email before they apply.
        If you don&apos;t agree, you can close your account.
      </p>

      <h2>14. Contact</h2>
      <p>
        Digital Sukoon (Dashmani Media Private Limited), India. Email <a href="mailto:creators@digitalsukoon.com">creators@digitalsukoon.com</a>.
      </p>
    </LegalPage>
  );
}
