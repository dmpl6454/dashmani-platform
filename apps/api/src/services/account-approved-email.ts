import { sendEmail } from "./email.service";
import { escapeHtml } from "./pipeline/email-template";

const HR_PORTAL_URL = process.env.HR_APP_URL || "https://hr.digitalsukoon.com";

/**
 * Tells a person their HR portal account was approved (ONBOARDING → ACTIVE).
 * Since 2026-10-28 a new sign-up waits for an admin; without this they only
 * find out by trying to sign in again. Never throws: an approval must not
 * fail because the email did. Returns true only when the email was sent.
 */
export async function sendAccountApprovedEmail(user: { name: string; email: string }): Promise<boolean> {
  try {
    const name = escapeHtml(user.name || "there");
    const loginUrl = `${HR_PORTAL_URL}/login`;
    const html = `<!DOCTYPE html>
<html>
<body style="font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:0;background:#f5f5f5;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;">
    <div style="background:#1A1A1A;color:#fff;padding:20px 30px;"><h1 style="margin:0;font-size:18px;font-weight:600;">Your account is approved</h1></div>
    <div style="padding:24px 30px;font-size:15px;color:#333;line-height:1.6;">
      <p>Hi ${name},</p>
      <p>An admin has approved your Digital Sukoon HR portal account. You can sign in now with the email and password you signed up with, or with Google if you used Google.</p>
      <a href="${loginUrl}" style="display:inline-block;background:#F5D547;color:#1A1A1A;padding:10px 24px;border-radius:20px;font-size:13px;font-weight:600;text-decoration:none;margin-top:8px;">Sign in →</a>
      <p style="font-size:13px;color:#777;margin-top:20px;">Forgot your password? Use “Forgot password” on the sign-in page.</p>
    </div>
    <div style="padding:16px 30px;background:#f8f9fa;text-align:center;font-size:11px;color:#999;">Digital Sukoon</div>
  </div>
</body>
</html>`;
    const result = await sendEmail({
      to: user.email,
      subject: "[Digital Sukoon] Your HR portal account is approved",
      html,
    });
    return result != null;
  } catch (err) {
    console.error("[account-approved-email] send failed:", err);
    return false;
  }
}
