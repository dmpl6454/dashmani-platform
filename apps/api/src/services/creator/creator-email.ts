import { sendEmail, notifyAdminByEmail } from "../email.service";
import { creatorConfig } from "./creator-config";

// Creator-facing emails. ⚠️ Everything interpolated is escaped: names come from Meta / Google /
// the creator, and notifyAdminByEmail's own template does NOT escape (adminAlert escapes first).

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function button(href: string, label: string) {
  return `<a href="${esc(href)}" style="display:inline-block;background:#403cfa;color:#fff;text-decoration:none;padding:11px 20px;font-weight:700">${esc(label)}</a>`;
}

export function shell(title: string, body: string) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f4f6;font-family:'Segoe UI',Arial,sans-serif;color:#111">
<div style="max-width:620px;margin:0 auto;background:#fff">
<div style="background:#000;color:#fff;padding:20px 28px"><div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.7">Digital Sukoon Creators</div><h1 style="margin:6px 0 0;font-size:19px;font-weight:700">${esc(title)}</h1></div>
<div style="padding:24px 28px;font-size:14px;line-height:1.6">${body}</div>
<div style="padding:16px 28px;font-size:12px;color:#777;border-top:1px solid #eee">You are receiving this because you have a creator account at ${esc(creatorConfig.appUrl().replace(/^https?:\/\//, ""))}. Questions? Just reply.</div>
</div></body></html>`;
}

/** Send one creator email (no-op without SMTP, like every other mail in the app). */
export function sendCreatorEmail(to: string, subject: string, title: string, bodyHtml: string) {
  return sendEmail({ to, subject, html: shell(title, bodyHtml), fromName: "Digital Sukoon Creators" });
}

/** Staff alert with every value escaped first. `path` is an internal-portal path. */
export function adminAlert(subject: string, details: Array<{ label: string; value: string }>, path?: string) {
  return notifyAdminByEmail(
    subject,
    details.map((d) => ({ label: esc(d.label), value: esc(d.value) })),
    path,
  );
}

export const creatorLink = (path: string) => `${creatorConfig.appUrl()}${path.startsWith("/") ? path : `/${path}`}`;
