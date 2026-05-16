import nodemailer from "nodemailer";

let _transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

export async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("⚠ Email not configured (SMTP_USER/SMTP_PASS missing). Skipping email.");
    return null;
  }

  try {
    const transporter = getTransporter();
    const result = await transporter.sendMail({
      from: `"Digital Sukoon HR" <${process.env.SMTP_USER}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      replyTo: options.replyTo,
    });
    console.log(`✉ Email sent to ${options.to}: ${result.messageId}`);
    return result;
  } catch (err) {
    console.error("✉ Email send failed:", err);
    return null;
  }
}

// ============ Activity Notification Emails ============

function activityEmailHtml(title: string, details: { label: string; value: string }[], actionUrl?: string, actionLabel?: string) {
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #1A1A1A, #333); color: #fff; padding: 20px 30px; }
    .header h1 { margin: 0; font-size: 18px; font-weight: 600; }
    .body { padding: 24px 30px; }
    .info-table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    .info-table td { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    .info-table td:first-child { font-weight: 600; color: #555; width: 140px; }
    .info-table td:last-child { color: #1A1A1A; }
    .action-btn { display: inline-block; background: #F5D547; color: #1A1A1A; padding: 10px 24px; border-radius: 20px; font-size: 13px; font-weight: 600; text-decoration: none; margin-top: 16px; }
    .footer { padding: 16px 30px; background: #f8f9fa; text-align: center; font-size: 11px; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>${title}</h1></div>
    <div class="body">
      <table class="info-table">
        ${details.map((d) => `<tr><td>${d.label}</td><td>${d.value}</td></tr>`).join("")}
      </table>
      ${actionUrl ? `<a href="${actionUrl}" class="action-btn">${actionLabel || "View in Portal"} →</a>` : ""}
    </div>
    <div class="footer">Dashmani Media Private Limited · Digital Sukoon</div>
  </div>
</body>
</html>`;
}

export function announcementEmailHtml(senderName: string, title: string, message: string): string {
  const portalUrl = process.env.INTERNAL_APP_URL || "https://portal.digitalsukoon.com";
  const safeMessage = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #1A1A1A, #333); color: #fff; padding: 24px 30px; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 600; }
    .header p { margin: 6px 0 0; font-size: 13px; opacity: 0.7; }
    .body { padding: 28px 30px; }
    .badge { display: inline-block; background: #F5D547; color: #1A1A1A; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-bottom: 16px; }
    .message-body { font-size: 15px; color: #333; line-height: 1.7; }
    .action-btn { display: inline-block; background: #F5D547; color: #1A1A1A; padding: 10px 24px; border-radius: 20px; font-size: 13px; font-weight: 600; text-decoration: none; margin-top: 24px; }
    .footer { padding: 16px 30px; background: #f8f9fa; text-align: center; font-size: 11px; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${title}</h1>
      <p>Announcement from ${senderName}</p>
    </div>
    <div class="body">
      <span class="badge">Announcement</span>
      <p class="message-body">${safeMessage}</p>
      <a href="${portalUrl}" class="action-btn">Open Portal →</a>
    </div>
    <div class="footer">Dashmani Media Private Limited · Digital Sukoon</div>
  </div>
</body>
</html>`;
}

const HR_EMAIL = "hr@digitalsukoon.com";
const ADMIN_EMAIL = "admin@digitalsukoon.com";
const PORTAL_URL = process.env.INTERNAL_APP_URL || "https://portal.digitalsukoon.com";
const HR_PORTAL_URL = process.env.HR_APP_URL || "https://hr.digitalsukoon.com";

export async function notifyHrByEmail(subject: string, details: { label: string; value: string }[], actionPath?: string) {
  const html = activityEmailHtml(subject, details, actionPath ? `${PORTAL_URL}${actionPath}` : undefined);
  return sendEmail({ to: HR_EMAIL, subject: `[HR Portal] ${subject}`, html });
}

export async function notifyAdminByEmail(subject: string, details: { label: string; value: string }[], actionPath?: string) {
  const html = activityEmailHtml(subject, details, actionPath ? `${PORTAL_URL}${actionPath}` : undefined);
  return sendEmail({ to: ADMIN_EMAIL, subject: `[Admin] ${subject}`, html });
}

export async function sendApplicationNotification(application: {
  applicantName: string;
  applicantEmail: string;
  applicantPhone?: string;
  experience?: string;
  currentCompany?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  coverLetter?: string;
  resumeUrl?: string;
  jobTitle: string;
  jobDepartment?: string;
}) {
  const hrEmail = process.env.HR_EMAIL || "hr@digitalsukoon.com";

  const html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #1A1A1A, #333); color: #fff; padding: 24px 30px; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 600; }
    .header p { margin: 6px 0 0; font-size: 13px; opacity: 0.8; }
    .body { padding: 30px; }
    .badge { display: inline-block; background: #F5D547; color: #1A1A1A; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-bottom: 16px; }
    .info-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    .info-table td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    .info-table td:first-child { font-weight: 600; color: #555; width: 140px; }
    .info-table td:last-child { color: #1A1A1A; }
    .cover-letter { background: #f8f9fa; border-left: 3px solid #F5D547; padding: 16px; margin: 16px 0; border-radius: 0 6px 6px 0; font-size: 14px; color: #555; line-height: 1.6; }
    .links a { display: inline-block; margin-right: 12px; color: #2563eb; text-decoration: none; font-size: 13px; }
    .footer { padding: 20px 30px; background: #f8f9fa; text-align: center; font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>New Job Application</h1>
      <p>Digital Sukoon Careers Portal</p>
    </div>
    <div class="body">
      <span class="badge">${application.jobTitle}${application.jobDepartment ? ` · ${application.jobDepartment}` : ""}</span>

      <table class="info-table">
        <tr><td>Name</td><td>${application.applicantName}</td></tr>
        <tr><td>Email</td><td><a href="mailto:${application.applicantEmail}">${application.applicantEmail}</a></td></tr>
        ${application.applicantPhone ? `<tr><td>Phone</td><td>${application.applicantPhone}</td></tr>` : ""}
        ${application.experience ? `<tr><td>Experience</td><td>${application.experience}</td></tr>` : ""}
        ${application.currentCompany ? `<tr><td>Company</td><td>${application.currentCompany}</td></tr>` : ""}
      </table>

      ${application.coverLetter ? `
      <p style="font-size:13px;font-weight:600;color:#555;margin-bottom:8px;">Cover Letter:</p>
      <div class="cover-letter">${application.coverLetter.replace(/\n/g, "<br>")}</div>
      ` : ""}

      <div class="links">
        ${application.linkedinUrl ? `<a href="${application.linkedinUrl}">LinkedIn Profile →</a>` : ""}
        ${application.portfolioUrl ? `<a href="${application.portfolioUrl}">Portfolio / Work Samples →</a>` : ""}
        ${application.resumeUrl ? `<a href="${process.env.API_PUBLIC_URL || "https://api.digitalsukoon.com"}${application.resumeUrl}">Download Resume →</a>` : ""}
      </div>

      <p style="margin-top:24px;font-size:13px;color:#999;">Review this application at <a href="${process.env.INTERNAL_APP_URL || "https://portal.digitalsukoon.com"}/jobs" style="color:#2563eb;">Admin Portal → Job Listings</a></p>
    </div>
    <div class="footer">
      Dashmani Media Private Limited · Digital Sukoon
    </div>
  </div>
</body>
</html>`;

  // Send to HR
  await sendEmail({
    to: hrEmail,
    subject: `New Application: ${application.applicantName} for ${application.jobTitle}`,
    html,
    replyTo: application.applicantEmail,
  });

  // Send confirmation to applicant
  const confirmHtml = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #1A1A1A, #333); color: #fff; padding: 24px 30px; text-align: center; }
    .header h1 { margin: 0; font-size: 22px; }
    .body { padding: 30px; line-height: 1.7; font-size: 14px; color: #555; }
    .body h2 { color: #1A1A1A; font-size: 18px; }
    .footer { padding: 20px 30px; background: #f8f9fa; text-align: center; font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Digital Sukoon</h1>
    </div>
    <div class="body">
      <h2>Thank you for applying, ${application.applicantName}!</h2>
      <p>We have received your application for the <strong>${application.jobTitle}</strong> position at Digital Sukoon.</p>
      <p>Our HR team will review your application and get back to you shortly. If your profile matches our requirements, we will reach out to schedule the next steps.</p>
      <p>In the meantime, feel free to reach out to us at <a href="mailto:hr@digitalsukoon.com" style="color:#2563eb;">hr@digitalsukoon.com</a> if you have any questions.</p>
      <p style="margin-top:24px;">Best regards,<br><strong>Digital Sukoon HR Team</strong></p>
    </div>
    <div class="footer">
      Dashmani Media Private Limited · Digital Sukoon
    </div>
  </div>
</body>
</html>`;

  await sendEmail({
    to: application.applicantEmail,
    subject: `Application Received - ${application.jobTitle} at Digital Sukoon`,
    html: confirmHtml,
  });
}
