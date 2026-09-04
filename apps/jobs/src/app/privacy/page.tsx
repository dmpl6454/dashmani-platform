import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Privacy policy for the Dashmani Media employee app and Digital Sukoon portals.",
  alternates: { canonical: "https://jobs.digitalsukoon.com/privacy" },
};

// Public privacy policy — required by Apple App Store review for the
// Dashmani Media iOS app (com.dashmani.employee). Server-rendered so it is
// reachable with no JS, per this portal's SEO conventions.
export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 20px", lineHeight: 1.7, color: "#1a1a1a", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <h1 style={{ fontSize: 32, marginBottom: 4 }}>Privacy Policy</h1>
      <p style={{ color: "#666", marginBottom: 32 }}>
        Dashmani Media Private Limited (operating as Digital Sukoon) · Last updated: 1 September 2026
      </p>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>Who this covers</h2>
      <p>
        This policy covers the <strong>Dashmani Media mobile app</strong> and the Digital Sukoon web portals
        (hr.digitalsukoon.com, portal.digitalsukoon.com). These are internal workplace tools for employees and
        administrators of Dashmani Media Private Limited. Accounts are created by the company — the app offers no
        public sign-up.
      </p>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>Data we collect</h2>
      <p>When you use the app with your work account, we process:</p>
      <ul>
        <li><strong>Account &amp; profile data</strong> — name, work email, phone, designation, and employment records your employer maintains (attendance, leave, payroll documents).</li>
        <li><strong>Work submissions</strong> — daily report links, plans of action, tasks, comments, and related workplace activity.</li>
        <li><strong>Approximate location at report submission</strong> (optional) — captured only when you submit a daily report and only if you grant permission, to verify work location.</li>
      </ul>
      <p>We do not collect data for advertising, do not sell data, and do not share data with third parties for marketing.</p>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>How data is used</h2>
      <p>
        Data is used solely to operate workplace functions: attendance and leave management, daily reporting,
        payroll documents, task management, and team analytics — visible to you and to authorized administrators
        of your employer.
      </p>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>Storage & security</h2>
      <p>
        Data is stored on Dashmani Media's servers. Transport is encrypted (HTTPS). Sign-in tokens are stored in the
        device's secure keychain. Access is role-based and audited.
      </p>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>Your choices</h2>
      <ul>
        <li>Location permission is optional and can be revoked anytime in iOS Settings.</li>
        <li>You can sign out at any time; tokens are removed from the device.</li>
        <li>To correct or delete account data, contact HR — accounts are employer-managed. Account deletion requests: <a href="mailto:hr@digitalsukoon.com">hr@digitalsukoon.com</a>.</li>
      </ul>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>Contact</h2>
      <p>
        Dashmani Media Private Limited<br />
        Email: <a href="mailto:hr@digitalsukoon.com">hr@digitalsukoon.com</a>
      </p>
    </main>
  );
}
