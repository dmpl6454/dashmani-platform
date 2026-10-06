import type { SiteEnquiryInput } from "@dashmani/shared";
import { sendEmail } from "./email.service";

// Campaign enquiries from the public marketing site (digitalsukoon.com, CH 06 Contact).
// Not stored: each enquiry is emailed to the sales inbox (SITE_ENQUIRY_TO), with
// Reply-To set to the enquirer so the team can answer straight from the inbox.

const DEFAULT_TO = "hello@digitalsukoon.com";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function siteEnquiryEmailHtml(input: SiteEnquiryInput): string {
  const rows: [string, string | undefined][] = [
    ["Looking to amplify", input.intent],
    ["Campaign name", input.campaignName],
    ["Company", input.company],
    ["Budget range", input.budget],
    ["Launch date", input.launchDate || undefined],
    ["Email", input.email],
  ];
  const body = rows
    .map(([k, v]) => `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#555;width:160px">${esc(k)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee">${v ? esc(v) : "—"}</td></tr>`)
    .join("");
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;margin:0;padding:24px;background:#f5f5f5"><div style="max-width:600px;margin:0 auto;background:#fff"><div style="background:linear-gradient(135deg,#0A06BA,#403CFA);color:#fff;padding:20px 24px;font-size:18px;font-weight:700">New campaign enquiry · digitalsukoon.com</div><table style="width:100%;border-collapse:collapse;font-size:14px">${body}</table><p style="padding:16px 24px;margin:0;font-size:12px;color:#888">Reply to this email to answer ${esc(input.email)} directly.</p></div></body></html>`;
}

/** Returns false when the email could not be sent (SMTP missing or failing). */
export async function submitSiteEnquiry(input: SiteEnquiryInput): Promise<boolean> {
  const result = await sendEmail({
    to: process.env.SITE_ENQUIRY_TO || DEFAULT_TO,
    subject: `[Website] ${input.intent} enquiry${input.company ? ` · ${input.company}` : ""}`,
    html: siteEnquiryEmailHtml(input),
    replyTo: input.email,
    fromName: "Digital Sukoon Website",
  });
  return result !== null;
}
