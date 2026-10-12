"use client";
import Link from "next/link";
import { LegalPage } from "@/components/site-shell";

// Privacy policy for the creator portal. Linked from sign-up and listed as the Meta app's
// privacy policy URL for the creator connect flow, so it names exactly what we read from Meta.

export default function PrivacyPage() {
  return (
    <LegalPage kicker="Privacy" title="Privacy policy" updated="12 October 2026">
      <p>
        This policy explains what Digital Sukoon (Dashmani Media Private Limited, “we”, “us”) collects when you use Digital Sukoon
        Creators at creators.digitalsukoon.com, why, how long we keep it, and how to delete it. Questions or requests:{" "}
        <a href="mailto:creators@digitalsukoon.com">creators@digitalsukoon.com</a>.
      </p>

      <h2>What we store</h2>
      <h3>Your account</h3>
      <ul>
        <li>Your name, email address, country and (if you give it) phone number.</li>
        <li>Your password, stored only as a one-way hash — we can&apos;t read it. If you sign in with Google, we receive your name and verified email from Google, nothing else.</li>
        <li>When you accepted the creator terms and confirmed you are 18 or older, and your account&apos;s review status and any note our team wrote about it.</li>
      </ul>
      <h3>From Facebook and Instagram (Meta)</h3>
      <ul>
        <li>Your Facebook user ID and name, which permissions you granted, and when the access expires.</li>
        <li>The access tokens Meta issues for your account and your Pages. These are <strong>stored encrypted</strong> and are never shown to anyone, including our staff.</li>
        <li>For each Page and Instagram professional account you choose to share: its ID, name, username, profile picture, follower and post counts, your role on the Page, whether we can publish to it, and its recent insights (such as views and engagement over 28 days).</li>
      </ul>
      <p>
        We do <strong>not</strong> read your personal Facebook profile, friends list, private messages, comments, ad accounts or payment
        methods. We don&apos;t ask Meta for permission to do any of those things.
      </p>
      <h3>Technical data</h3>
      <p>
        Our servers keep short-lived logs of requests (time, IP address, the page asked for) to keep the service secure and working.
        The portal stores your sign-in session in your browser&apos;s local storage; we don&apos;t use advertising cookies or trackers.
      </p>

      <h2>Why we use it</h2>
      <ul>
        <li>To run your account: signing in, confirming your email, password resets and messages about your account.</li>
        <li>To review your profile: checking that the pages are yours, active, and that we can publish to them.</li>
        <li>To offer your pages to brands: showing a page&apos;s name, picture and public statistics to brands considering a booking.</li>
        <li>To publish the campaigns you accept, report how they performed, and pay you.</li>
        <li>To prevent fraud and keep the service secure, and to meet legal obligations such as tax and accounting records.</li>
      </ul>
      <p>We don&apos;t sell your data, and we don&apos;t use your Meta data to advertise to you.</p>

      <h2>Who sees it</h2>
      <p>
        Our team, to review and support your account. Brands see only what is needed to choose a booking (page name, picture, public
        statistics, price). We use service providers to host the service and send email, under agreements that let them use the data
        only for us. We share data with authorities only when the law requires it.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li><strong>While your account is open</strong>, we keep your account and page data so the service works.</li>
        <li><strong>When you disconnect Facebook or close your account</strong>, we delete our copy of your Meta access tokens straight away and stop reading your pages.</li>
        <li>Page details and insights we collected are deleted within 30 days of closing your account or receiving a deletion request from Meta.</li>
        <li>Records of bookings and payments are kept for as long as tax and accounting law requires, then deleted.</li>
        <li>Email links (confirmation and password reset) expire after 7 days and 24 hours respectively, and work only once.</li>
      </ul>

      <h2>Deleting your data</h2>
      <p>You can delete your data in any of these ways:</p>
      <ul>
        <li>Close your account in <Link href="/settings">Settings</Link>.</li>
        <li>Remove “Post Automation 2” from your Facebook account (Facebook → Settings → Business integrations). Meta tells us, and we delete the data we hold from that connection.</li>
        <li>Email <a href="mailto:creators@digitalsukoon.com">creators@digitalsukoon.com</a> from the address on your account.</li>
      </ul>
      <p>See <Link href="/data-deletion">data deletion</Link> for details and to check the status of a request.</p>

      <h2>Your rights</h2>
      <p>
        Depending on where you live, you may have the right to see the data we hold about you, correct it, delete it, object to how we
        use it, or take a copy with you. Write to us and we will reply within 30 days. You can also complain to your local data
        protection authority.
      </p>

      <h2>Security</h2>
      <p>
        Access tokens are encrypted at rest, passwords are hashed, all traffic is encrypted in transit, and staff access is limited to
        the people who need it.
      </p>

      <h2>Changes</h2>
      <p>If we change this policy we will update the date at the top and tell you by email about meaningful changes.</p>

      <h2>Contact</h2>
      <p>
        Digital Sukoon (Dashmani Media Private Limited), India — <a href="mailto:creators@digitalsukoon.com">creators@digitalsukoon.com</a>.
      </p>
    </LegalPage>
  );
}
