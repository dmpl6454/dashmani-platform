import { prisma } from "@dashmani/db";
import { canonicalKey, FORMAT_LABELS, formatPaise, type CampaignFormat } from "@dashmani/shared";
import { sendEmail, notifyAdminByEmail } from "../email.service";
import { campaignConfig } from "./config";

// Client emails for the campaign lifecycle, and the results the client sees in the portal.
//
// ⚠️ The delivery email (every post's link) is sent ONCE per booking, guarded by an atomic
// claim on campaign_bookings.delivered_at. A "post is live" email is sent once per item, guarded
// by campaign_booking_items.notified_at. Staff can explicitly resend the delivery email.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube" };

function fmtIST(d: Date | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d) + " IST";
}

function shell(title: string, body: string) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif;color:#1a1a1a">
<div style="max-width:640px;margin:0 auto;background:#fff">
<div style="background:#1a1a1a;color:#fff;padding:20px 28px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.7">Digital Sukoon</div><h1 style="margin:6px 0 0;font-size:19px;font-weight:600">${esc(title)}</h1></div>
<div style="padding:24px 28px;font-size:14px;line-height:1.55">${body}</div>
<div style="padding:16px 28px;font-size:12px;color:#777;border-top:1px solid #eee">Questions? Just reply to this email.</div>
</div></body></html>`;
}

function button(href: string, label: string) {
  return `<a href="${esc(href)}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">${esc(label)}</a>`;
}

async function bookingWithClient(bookingId: string) {
  return prisma.campaignBooking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      name: true,
      brand: true,
      status: true,
      totalPaise: true,
      reviewNote: true,
      client: { select: { email: true, contactName: true, companyName: true } },
      items: {
        orderBy: { createdAt: "asc" },
        select: { id: true, platform: true, format: true, accountName: true, accountHandle: true, status: true, permalink: true, postedAt: true, pricePaise: true },
      },
    },
  });
}

const portalLink = (id: string) => `${campaignConfig.clientAppUrl()}/campaigns/${id}`;

function itemStatusText(status: string): string {
  switch (status) {
    case "posted_manual":
    case "published":
      return "Live";
    case "refunded":
      return "Not posted — refunded";
    case "failed":
      return "Not posted";
    default:
      return "Scheduled";
  }
}

/** Every post with its link — sent once the last item has settled. */
export async function sendDeliveryEmail(bookingId: string, opts: { force?: boolean } = {}): Promise<boolean> {
  if (!opts.force) {
    const claim = await prisma.campaignBooking.updateMany({
      where: { id: bookingId, deliveredAt: null, status: { in: ["completed", "partially_published"] } },
      data: { deliveredAt: new Date() },
    });
    if (claim.count !== 1) return false;
  }
  const b = await bookingWithClient(bookingId);
  if (!b) return false;

  const rows = b.items
    .map((i) => {
      const acct = i.accountHandle ? `${esc(i.accountName)} <span style="color:#777">@${esc(i.accountHandle)}</span>` : esc(i.accountName);
      const link = i.permalink ? `<a href="${esc(i.permalink)}" style="color:#1a56db;font-weight:600">View post</a>` : esc(itemStatusText(i.status));
      return `<tr>
<td style="padding:10px 8px;border-bottom:1px solid #eee">${esc(PLATFORM_LABEL[i.platform] ?? i.platform)}</td>
<td style="padding:10px 8px;border-bottom:1px solid #eee">${acct}</td>
<td style="padding:10px 8px;border-bottom:1px solid #eee">${esc(FORMAT_LABELS[i.format as CampaignFormat] ?? i.format)}</td>
<td style="padding:10px 8px;border-bottom:1px solid #eee;white-space:nowrap">${esc(i.postedAt ? fmtIST(i.postedAt) : "—")}</td>
<td style="padding:10px 8px;border-bottom:1px solid #eee">${link}</td></tr>`;
    })
    .join("");
  const notLive = b.items.filter((i) => !i.permalink);
  const refundNote = notLive.length
    ? `<p style="color:#8a4b00">${notLive.length} booking${notLive.length === 1 ? "" : "s"} could not be posted. ${
        notLive.some((i) => i.status === "refunded") ? "The amount for those has been refunded to your original payment method." : "Our team will contact you about them."
      }</p>`
    : "";

  const anyLive = b.items.some((i) => i.permalink);
  const html = shell(anyLive ? `Your campaign "${b.name}" is live` : `Update on your campaign "${b.name}"`, `
<p>Hi ${esc(b.client.contactName)},</p>
<p>${anyLive ? `Your campaign for <strong>${esc(b.brand)}</strong> has been delivered. Here is every post:` : `Here is the final status of your campaign for <strong>${esc(b.brand)}</strong>:`}</p>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0">
<thead><tr style="text-align:left;color:#777;font-size:12px"><th style="padding:6px 8px">Platform</th><th style="padding:6px 8px">Account</th><th style="padding:6px 8px">Format</th><th style="padding:6px 8px">Posted</th><th style="padding:6px 8px">Link</th></tr></thead>
<tbody>${rows}</tbody></table>
${refundNote}
<p>You can also see these links, and views and likes as they come in, in your portal.</p>
<p>${button(portalLink(b.id), "See campaign results")}</p>`);

  await sendEmail({ to: b.client.email, subject: anyLive ? `Delivered: ${b.name} — your post links` : `Delivered: ${b.name} — final status`, html, fromName: "Digital Sukoon", replyTo: campaignConfig.teamEmail() });
  await sendEmail({ to: campaignConfig.teamEmail(), subject: `[Copy] Delivered: ${b.name} (${b.client.companyName})`, html, fromName: "Digital Sukoon" });
  return true;
}

/** "Your post is live on @account" — once per item. */
export async function sendItemLiveEmail(itemId: string): Promise<boolean> {
  const claim = await prisma.campaignBookingItem.updateMany({
    where: { id: itemId, notifiedAt: null, permalink: { not: null } },
    data: { notifiedAt: new Date() },
  });
  if (claim.count !== 1) return false;
  const item = await prisma.campaignBookingItem.findUnique({ where: { id: itemId }, select: { bookingId: true, accountName: true, accountHandle: true, platform: true, format: true, permalink: true, postedAt: true } });
  if (!item?.permalink) return false;
  const b = await bookingWithClient(item.bookingId);
  if (!b) return false;
  // When this is the last item the delivery email follows immediately — skip the single one.
  if (b.items.every((i) => ["posted_manual", "published", "failed", "refunded"].includes(i.status)) && b.items.length > 1) return false;
  const where = item.accountHandle ? `@${item.accountHandle}` : item.accountName;
  const html = shell(`Your post is live on ${where}`, `
<p>Hi ${esc(b.client.contactName)},</p>
<p>Your ${esc(FORMAT_LABELS[item.format as CampaignFormat] ?? item.format)} for <strong>${esc(b.name)}</strong> is now live on ${esc(PLATFORM_LABEL[item.platform] ?? item.platform)} (${esc(where)}), posted ${esc(fmtIST(item.postedAt))}.</p>
<p>${button(item.permalink, "View post")}</p>
<p style="color:#777">We'll send every link together once the whole campaign is live.</p>`);
  await sendEmail({ to: b.client.email, subject: `Live on ${where}: ${b.name}`, html, fromName: "Digital Sukoon", replyTo: campaignConfig.teamEmail() });
  return true;
}

export async function sendStatusEmail(bookingId: string, kind: "paid" | "approved" | "changes_requested" | "rejected") {
  const b = await bookingWithClient(bookingId);
  if (!b) return;
  const total = b.totalPaise != null ? formatPaise(b.totalPaise) : "";
  const copy: Record<typeof kind, { subject: string; title: string; body: string }> = {
    paid: {
      subject: `Payment received: ${b.name}`,
      title: "Payment received — we're reviewing your campaign",
      body: `<p>We received your payment of <strong>${esc(total)}</strong> for <strong>${esc(b.name)}</strong>. Our team will review the creative, usually within one working day, and let you know.</p>`,
    },
    approved: {
      subject: `Approved: ${b.name}`,
      title: "Your campaign is approved",
      body: `<p><strong>${esc(b.name)}</strong> is approved and scheduled. You'll get an email with the link as each post goes live.</p>`,
    },
    changes_requested: {
      subject: `Changes needed: ${b.name}`,
      title: "A small change is needed",
      body: `<p>Our team reviewed <strong>${esc(b.name)}</strong> and needs a change before it can go live:</p><blockquote style="margin:12px 0;padding:10px 14px;background:#f7f7f7;border-left:3px solid #1a1a1a">${esc(b.reviewNote ?? "")}</blockquote><p>Your payment is safe — update the creative in the portal and resubmit.</p>`,
    },
    rejected: {
      subject: `Not approved: ${b.name}`,
      title: "We couldn't run this campaign",
      body: `<p>We're sorry — we can't run <strong>${esc(b.name)}</strong> on our network.</p>${b.reviewNote ? `<blockquote style="margin:12px 0;padding:10px 14px;background:#f7f7f7;border-left:3px solid #1a1a1a">${esc(b.reviewNote)}</blockquote>` : ""}<p>The full amount (${esc(total)}) is being refunded to your original payment method. Refunds usually arrive in 5–7 working days.</p>`,
    },
  };
  const c = copy[kind];
  await sendEmail({
    to: b.client.email,
    subject: c.subject,
    html: shell(c.title, `<p>Hi ${esc(b.client.contactName)},</p>${c.body}<p>${button(portalLink(b.id), "Open campaign")}</p>`),
    fromName: "Digital Sukoon",
    replyTo: campaignConfig.teamEmail(),
  });
}

export async function notifyStaffPaid(bookingId: string) {
  const b = await bookingWithClient(bookingId);
  if (!b) return;
  await notifyAdminByEmail(
    `New paid campaign to review: ${b.name}`,
    [
      { label: "Client", value: b.client.companyName },
      { label: "Brand", value: b.brand },
      { label: "Accounts", value: String(b.items.length) },
      { label: "Paid", value: b.totalPaise != null ? formatPaise(b.totalPaise) : "—" },
    ],
    `/campaigns/${b.id}`,
  );
}

// ── Results (portal) ────────────────────────────────────────────────────────────

/**
 * Each booked post with its link and, once our Meta sync has picked the post up, its views /
 * likes / comments. ⚠️ A metric the sync hasn't measured yet is null ("Collecting…"), never 0.
 */
export async function getResults(clientId: string, bookingId: string) {
  const b = await prisma.campaignBooking.findFirst({
    where: { id: bookingId, clientId },
    select: {
      id: true,
      status: true,
      deliveredAt: true,
      items: {
        orderBy: { createdAt: "asc" },
        select: { id: true, platform: true, format: true, accountName: true, accountHandle: true, status: true, permalink: true, postedAt: true, remotePostId: true },
      },
    },
  });
  if (!b) return null;

  const matchIds = new Map<string, string>(); // itemId → matchId
  for (const i of b.items) {
    if (!i.permalink) continue;
    const key = canonicalKey(i.permalink);
    const id = key.includes(":") && !key.startsWith("raw:") ? key.slice(key.indexOf(":") + 1) : null;
    if (id) matchIds.set(i.id, id);
  }
  const remoteIds = b.items.map((i) => i.remotePostId).filter((x): x is string => Boolean(x));
  const posts = matchIds.size || remoteIds.length
    ? await prisma.metaPost.findMany({
        where: { OR: [{ matchId: { in: [...matchIds.values()] } }, { metaPostId: { in: remoteIds } }] },
        select: { matchId: true, metaPostId: true, views: true, likes: true, comments: true, metricsStatus: true, metricsFetchedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 500,
      })
    : [];
  const byMatch = new Map<string, (typeof posts)[number]>();
  const byRemote = new Map<string, (typeof posts)[number]>();
  for (const p of posts) {
    if (p.matchId && !byMatch.has(p.matchId)) byMatch.set(p.matchId, p);
    if (!byRemote.has(p.metaPostId)) byRemote.set(p.metaPostId, p);
  }

  return {
    id: b.id,
    status: b.status,
    deliveredAt: b.deliveredAt,
    items: b.items.map((i) => {
      const p = (i.remotePostId && byRemote.get(i.remotePostId)) || (matchIds.has(i.id) ? byMatch.get(matchIds.get(i.id)!) : undefined);
      const measured = p && p.metricsStatus !== "pending";
      return {
        id: i.id,
        platform: i.platform,
        format: i.format,
        accountName: i.accountName,
        accountHandle: i.accountHandle,
        status: i.status,
        permalink: i.permalink,
        postedAt: i.postedAt,
        metrics: measured ? { views: p!.views, likes: p!.likes, comments: p!.comments, measuredAt: p!.metricsFetchedAt } : null,
      };
    }),
  };
}
