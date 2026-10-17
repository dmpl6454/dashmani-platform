import { prisma } from "@dashmani/db";
import { canonicalKey, CAMPAIGN_TYPE_LABELS, CREATOR_TARGET_TYPE, FORMAT_LABELS, formatPaise, LIVE_ITEM_STATUSES, SETTLED_ITEM_STATUSES, type CampaignFormat, type CampaignProvider, type CampaignType, type ItemStatus } from "@dashmani/shared";
import { sendEmail, notifyAdminByEmail } from "../email.service";
import { campaignConfig } from "./config";
import { providersOfItems } from "../creator/payout-ledger";

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
      paidAt: true,
      reviewNote: true,
      campaignType: true,
      audioIntegration: true,
      audioTrack: true,
      launchFrom: true,
      launchTo: true,
      // Read only to NAME a creator's posts (providersOfItems takes the name frozen at checkout from it).
      pricingSnapshot: true,
      client: { select: { email: true, contactName: true, companyName: true } },
      items: {
        orderBy: { createdAt: "asc" },
        select: { id: true, platform: true, format: true, accountName: true, accountHandle: true, status: true, permalink: true, postedAt: true, pricePaise: true, targetType: true, targetId: true },
      },
    },
  });
}

type EmailBooking = NonNullable<Awaited<ReturnType<typeof bookingWithClient>>>;
type EmailItem = EmailBooking["items"][number];

/** The creator's name for the client: the one FROZEN at checkout, never the live account name (see providersOfItems). */
const creatorNameOf = (providers: Map<string, CampaignProvider>, itemId: string) => providers.get(itemId)?.name || "the creator";

/**
 * "<strong>Meera Kapoor</strong> (Meera Eats on Instagram)" for the creator posts given: who makes which post, the
 * way the portal names the provider. Names only: nothing of a creator's payout, share or tax ever goes in an email.
 */
function creatorPostsList(items: EmailItem[], providers: Map<string, CampaignProvider>): string {
  const byCreator = new Map<string, string[]>();
  for (const i of items) {
    const name = providers.get(i.id)?.name || "A creator";
    byCreator.set(name, [...(byCreator.get(name) ?? []), `${i.accountName} on ${PLATFORM_LABEL[i.platform] ?? i.platform}`]);
  }
  return [...byCreator].map(([name, posts]) => `<strong>${esc(name)}</strong> (${esc(posts.join(", "))})`).join("; ");
}

const portalLink = (id: string) => `${campaignConfig.clientAppUrl()}/campaigns/${id}`;

/** launch_from / launch_to are @db.Date (midnight UTC): format them in UTC, never as IST instants. */
const dateOnly = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const isLive = (status: string) => (LIVE_ITEM_STATUSES as readonly string[]).includes(status as ItemStatus);

/**
 * Which of these items have had their money returned, as far as Razorpay has told us: a ledger row
 * of ours that is processed or pending. THE one predicate behind every "refunded" a client reads
 * (this file's delivery email and results, and the booking shape the portal renders), so an email
 * and the portal can never disagree about the same item. An item is marked `refunded` BEFORE
 * Razorpay answers, and stays so if the refund fails or is never confirmed, so its status alone
 * proves nothing: a failed or unanswered refund is not in this set, and that money is still being
 * returned by our team.
 *
 * Two ways in, and only these:
 *   • the item's OWN refund (a row carrying its id) is processed or pending;
 *   • the item's own refund FAILED and the money came back in the payment's remainder instead (see
 *     coveredByPaymentRefund): the sweep refunds what a rejected booking still owes as ONE refund
 *     that carries no item id, so without this the item reads "being returned" for ever.
 * A refund we did not issue (a dashboard refund) is neither: it never makes an item read refunded.
 * Callers pass every `refunded` item of a booking, and only of a booking that was paid online (see
 * confirmedRefundsFor): an offline booking has no ledger rows to read.
 */
export async function confirmedRefundItemIds(itemIds: string[]): Promise<Set<string>> {
  const confirmed = new Set<string>();
  if (itemIds.length === 0) return confirmed;
  const own = await prisma.campaignRefund.findMany({
    where: { bookingItemId: { in: itemIds }, origin: "ours" },
    select: { bookingItemId: true, status: true },
  });
  // Per item: has a refund Razorpay accepted, has one still unanswered, or has only failed ones.
  const stateOf = new Map<string, "accepted" | "unanswered" | "failed">();
  for (const r of own) {
    const id = r.bookingItemId as string;
    if (r.status === "processed" || r.status === "pending") stateOf.set(id, "accepted");
    else if (r.status === "requested") {
      if (stateOf.get(id) !== "accepted") stateOf.set(id, "unanswered");
    } else if (!stateOf.has(id)) stateOf.set(id, "failed");
  }
  for (const [id, state] of stateOf) if (state === "accepted") confirmed.add(id);
  const failedOnly = itemIds.filter((id) => stateOf.get(id) === "failed");
  if (failedOnly.length > 0) for (const id of await coveredByPaymentRefund(failedOnly)) confirmed.add(id);
  return confirmed;
}

/**
 * Of items whose own refunds all failed: the ones whose money the payment's remainder refund has
 * already returned. The sweep refunds what a REJECTED booking still owes under `rf-stale-<payment>`
 * with no item id, so that row's amount is what it can vouch for. An item counts only when
 *   • its booking is `rejected` or `refunded` (the only bookings whose remainder is refunded this way;
 *     a duplicate or outdated payment's refund carries another reason and is never read here),
 *   • the item has no live or finished row of its own (those decide for it), and
 *   • the item-less rejection refunds of the payment its own refund was drawn on, counting only those
 *     Razorpay accepted (processed or pending), add up to at least what ALL such items of that payment
 *     are owed (each one's amount read from its own failed ledger row).
 * All of a payment's items or none: when the refunds cover less than is owed there is no telling
 * which item they paid, and "being returned" never over-claims. An item with no ledger row at all
 * (its refund could not even be claimed) also stays "being returned".
 */
async function coveredByPaymentRefund(itemIds: string[]): Promise<Set<string>> {
  const covered = new Set<string>();
  const items = await prisma.campaignBookingItem.findMany({
    where: { id: { in: itemIds }, status: "refunded", booking: { status: { in: ["rejected", "refunded"] } } },
    select: { bookingId: true },
  });
  const bookingIds = [...new Set(items.map((i) => i.bookingId))];
  if (bookingIds.length === 0) return covered;
  const [siblings, rows] = await Promise.all([
    prisma.campaignBookingItem.findMany({ where: { bookingId: { in: bookingIds }, status: "refunded" }, select: { id: true } }),
    prisma.campaignRefund.findMany({
      where: { bookingId: { in: bookingIds }, origin: "ours", paymentId: { not: null } },
      select: { bookingItemId: true, paymentId: true, amountPaise: true, status: true, reason: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  // What each payment's item-less rejection refunds hold, as Razorpay has accepted them.
  const returned = new Map<string, number>();
  const byItem = new Map<string, typeof rows>();
  for (const r of rows) {
    const paymentId = r.paymentId as string;
    if (r.bookingItemId === null) {
      if (r.reason === "booking_rejected" && (r.status === "processed" || r.status === "pending")) returned.set(paymentId, (returned.get(paymentId) ?? 0) + r.amountPaise);
    } else byItem.set(r.bookingItemId, [...(byItem.get(r.bookingItemId) ?? []), r]);
  }
  // What each payment's refunded items are still owed: those whose own rows have ALL failed.
  const owed = new Map<string, Array<{ id: string; amountPaise: number }>>();
  for (const { id } of siblings) {
    const mine = byItem.get(id) ?? [];
    if (mine.length === 0 || mine.some((r) => r.status !== "failed")) continue;
    const last = mine[mine.length - 1];
    owed.set(last.paymentId as string, [...(owed.get(last.paymentId as string) ?? []), { id, amountPaise: last.amountPaise }]);
  }
  const wanted = new Set(itemIds);
  for (const [paymentId, list] of owed) {
    if (list.reduce((n, i) => n + i.amountPaise, 0) > (returned.get(paymentId) ?? 0)) continue;
    for (const i of list) if (wanted.has(i.id)) covered.add(i.id);
  }
  return covered;
}

/**
 * The refunded items of a booking whose refund is confirmed (see confirmedRefundItemIds). THE one
 * place the paidAt rule lives: a booking with no paidAt (offline mode) was never charged, has no
 * ledger rows, and must not read campaign_refunds at all, so its answer is always "none".
 */
export async function confirmedRefundsFor(b: { paidAt: Date | null; items: Array<{ id: string; status: string }> }): Promise<Set<string>> {
  if (!b.paidAt) return new Set<string>();
  return confirmedRefundItemIds(b.items.filter((i) => i.status === "refunded").map((i) => i.id));
}

/**
 * paidOnline = the booking has a paidAt; without one nothing was charged, so nothing is "refunded".
 * refundConfirmed = Razorpay has accepted (processed or pending) the refund of this item: a failed
 * or unanswered one is still being returned by our team, and the email must not say it was.
 */
function itemStatusText(status: string, paidOnline: boolean, refundConfirmed = false): string {
  switch (status) {
    case "posted_manual":
    case "published":
      return "Live";
    case "refunded":
      return paidOnline ? (refundConfirmed ? "Not posted — refunded" : "Not posted — being returned") : "Not posted — not charged";
    case "refund_due":
      // Paid, will not be posted, the refund is still to be made.
      return paidOnline ? "Not posted — being returned" : "Not posted — not charged";
    case "awaiting_creator":
      return "Waiting for the creator";
    case "failed":
      return "Not posted";
    default:
      return "Scheduled";
  }
}

/**
 * What the delivery email says about the money for the posts that did not go live. ⚠️ It speaks
 * per GROUP, because the groups differ: a post can be refunded (and Razorpay has the refund), be
 * refunded with the refund still being returned by our team, or merely be `failed` (nothing was
 * refunded, and staff may still re-post or refund it). One sentence for all of them said "has been
 * refunded" of a post that was only marked failed. When every post is in ONE group the wording is
 * the plain one; a mixed set lists each group with its own count. Offline bookings were never
 * charged, so they never read "refunded".
 */
function notLiveSentence(notLive: Array<{ id: string; status: string }>, paidOnline: boolean, confirmed: Set<string>): string {
  const refunded = notLive.filter((i) => i.status === "refunded");
  if (refunded.length === 0) return "Our team will contact you about them.";
  if (!paidOnline) return "They will not be charged — our team will confirm the final amount with you.";
  const done = refunded.filter((i) => confirmed.has(i.id)).length;
  const returning = refunded.length - done;
  const other = notLive.length - refunded.length;
  if (done === notLive.length) return "The amount for those has been refunded to your original payment method.";
  if (returning === notLive.length) return "Our team is returning the amount for those to you.";
  return [
    done > 0 ? `The amount for ${done} of them has been refunded to your original payment method.` : "",
    returning > 0 ? `Our team is returning the amount for ${returning} of them.` : "",
    other > 0 ? `Our team will contact you about ${other} of them.` : "",
  ]
    .filter(Boolean)
    .join(" ");
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
  // A creator's post names its provider (empty, and no query, for a network-only booking).
  const providers = await providersOfItems(b);

  // "Refunded" is said only of an item whose money Razorpay has accepted back (see confirmedRefundItemIds).
  const confirmedRefunds = await confirmedRefundsFor(b);

  const rows = b.items
    .map((i) => {
      const acctName = i.accountHandle ? `${esc(i.accountName)} <span style="color:#777">@${esc(i.accountHandle)}</span>` : esc(i.accountName);
      const acct = providers.has(i.id) ? `${acctName}<br><span style="color:#777">Posted by ${esc(creatorNameOf(providers, i.id))}</span>` : acctName;
      const link = i.permalink
        ? `<a href="${esc(i.permalink)}" style="color:#1a56db;font-weight:600">View post</a>`
        : isLive(i.status) ? "Live — link to follow" : esc(itemStatusText(i.status, Boolean(b.paidAt), confirmedRefunds.has(i.id)));
      return `<tr>
<td style="padding:10px 8px;border-bottom:1px solid #eee">${esc(PLATFORM_LABEL[i.platform] ?? i.platform)}</td>
<td style="padding:10px 8px;border-bottom:1px solid #eee">${acct}</td>
<td style="padding:10px 8px;border-bottom:1px solid #eee">${esc(FORMAT_LABELS[i.format as CampaignFormat] ?? i.format)}</td>
<td style="padding:10px 8px;border-bottom:1px solid #eee;white-space:nowrap">${esc(i.postedAt ? fmtIST(i.postedAt) : "—")}</td>
<td style="padding:10px 8px;border-bottom:1px solid #eee">${link}</td></tr>`;
    })
    .join("");
  // Decided by status, never by the link: a post the API published but whose link Meta didn't
  // return yet IS live, and must not be reported as "could not be made".
  const notLive = b.items.filter((i) => !isLive(i.status));
  const refundNote = notLive.length
    ? `<p style="color:#8a4b00">${notLive.length} post${notLive.length === 1 ? "" : "s"} could not be made. ${notLiveSentence(notLive, Boolean(b.paidAt), confirmedRefunds)}</p>`
    : "";

  const anyLive = b.items.some((i) => isLive(i.status));
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
  const pre = await prisma.campaignBookingItem.findUnique({ where: { id: itemId }, select: { bookingId: true } });
  if (!pre) return false;
  const pb = await prisma.campaignBooking.findUnique({ where: { id: pre.bookingId }, select: { deliveredAt: true, items: { select: { status: true } } } });
  if (!pb) return false;
  // The last item of a multi-item booking: the delivery email (every link) follows immediately,
  // so this one is skipped — decided BEFORE claiming, so the claim is never spent on a skip. A
  // link that arrives AFTER delivery (a post the API published without a readable link) is
  // still sent on its own: the delivery email told the client "link to follow".
  if (!pb.deliveredAt && pb.items.length > 1 && pb.items.every((i) => (SETTLED_ITEM_STATUSES as readonly string[]).includes(i.status))) return false;
  const claim = await prisma.campaignBookingItem.updateMany({
    where: { id: itemId, notifiedAt: null, permalink: { not: null } },
    data: { notifiedAt: new Date() },
  });
  if (claim.count !== 1) return false;
  const item = await prisma.campaignBookingItem.findUnique({ where: { id: itemId }, select: { id: true, bookingId: true, targetType: true, accountName: true, accountHandle: true, platform: true, format: true, permalink: true, postedAt: true } });
  if (!item?.permalink) return false;
  const b = await bookingWithClient(item.bookingId);
  if (!b) return false;
  const where = item.accountHandle ? `@${item.accountHandle}` : item.accountName;
  // A creator's post says who made it. A network post's wording is exactly what it was.
  const providers = item.targetType === CREATOR_TARGET_TYPE ? await providersOfItems(b) : new Map<string, CampaignProvider>();
  const postedBy = providers.has(item.id) ? ` by <strong>${esc(creatorNameOf(providers, item.id))}</strong>` : "";
  const html = shell(`Your post is live on ${where}`, `
<p>Hi ${esc(b.client.contactName)},</p>
<p>Your ${esc(FORMAT_LABELS[item.format as CampaignFormat] ?? item.format)} for <strong>${esc(b.name)}</strong> is now live on ${esc(PLATFORM_LABEL[item.platform] ?? item.platform)} (${esc(where)}), posted ${esc(fmtIST(item.postedAt))}${postedBy}.</p>
<p>${button(item.permalink, "View post")}</p>
${pb.deliveredAt ? "" : `<p style="color:#777">We'll send every link together once the whole campaign is live.</p>`}`);
  await sendEmail({ to: b.client.email, subject: `Live on ${where}: ${b.name}`, html, fromName: "Digital Sukoon", replyTo: campaignConfig.teamEmail() });
  return true;
}

/**
 * What a booking's emails say about its CREATOR posts: the receipt line (who makes which post) and the approval text.
 * Mirrors the portal's own wording (client campaigns/[id]/page.tsx), so an email and the page never disagree.
 * ⚠️ It never says a creator's post is "scheduled" or promises a time: the creator confirms, posts by hand inside
 * the window, and the link follows once our team has checked it. A creator post that went `refund_due` (its page
 * changed hands after the payment) is said to be returned, not waited for.
 */
async function creatorEmailParts(b: EmailBooking, creatorItems: EmailItem[], paidOnline: boolean) {
  const providers = await providersOfItems(b);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const dropped = creatorItems.filter((i) => i.status === "refund_due");
  const withCreators = creatorItems.filter((i) => i.status !== "refund_due");
  return {
    receipt: `<p>This includes ${plural(creatorItems.length, "post", "posts")} made by creators: ${creatorPostsList(creatorItems, providers)}. Once we approve your campaign, each creator is asked to confirm their post; a post a creator doesn't confirm is refunded to you.</p>`,
    approved: (alsoNetwork: boolean) => {
      const head = alsoNetwork
        ? `<p><strong>${esc(b.name)}</strong> is approved. Posts on our own accounts are scheduled, and you'll get an email with each link as it goes live.</p>`
        : `<p><strong>${esc(b.name)}</strong> is approved.</p>`;
      const waiting =
        withCreators.length > 0
          ? `<p>Posts by creators: ${creatorPostsList(withCreators, providers)}. Each creator is asked to confirm their post and posts it by hand within your go-live window. A post a creator doesn't confirm is refunded to you. You'll get an email with each link once our team has checked the post.</p>`
          : "";
      const gone =
        dropped.length > 0
          ? `<p>${plural(dropped.length, "creator post won't", "creator posts won't")} go ahead. ${
              paidOnline ? `The amount for ${dropped.length === 1 ? "it is" : "them is"} being returned to you.` : "You weren't charged for it."
            }</p>`
          : "";
      return head + waiting + gone;
    },
  };
}

export async function sendStatusEmail(bookingId: string, kind: "paid" | "approved" | "changes_requested" | "rejected") {
  const b = await bookingWithClient(bookingId);
  if (!b) return;
  const total = b.totalPaise != null ? formatPaise(b.totalPaise) : "";
  // paidAt is set only by the Razorpay webhook; a booking submitted without online payment
  // (offline mode) has none, and its money wording must not claim a payment or a refund.
  const paidOnline = Boolean(b.paidAt);
  // A creator's posts are named (the name FROZEN at checkout) and never called "scheduled": the creator is asked to
  // confirm each one, may decline or not answer, and the amount for a post that doesn't go ahead is refunded.
  // `creatorMoney` is empty for a network-only booking, whose wording below is exactly what it always was.
  const creatorItems = b.items.filter((i) => i.targetType === CREATOR_TARGET_TYPE);
  const creatorMoney = creatorItems.length > 0 && (kind === "paid" || kind === "approved") ? await creatorEmailParts(b, creatorItems, paidOnline) : null;
  const copy: Record<typeof kind, { subject: string; title: string; body: string }> = {
    paid: paidOnline
      ? {
          subject: `Payment received: ${b.name}`,
          title: "Payment received — we're reviewing your campaign",
          body: `<p>We received your payment of <strong>${esc(total)}</strong> for <strong>${esc(b.name)}</strong>. Our team will review your campaign, usually within one working day, and let you know.</p>${creatorMoney?.receipt ?? ""}`,
        }
      : {
          subject: `Submitted for review: ${b.name}`,
          title: "We've got your campaign — we're reviewing it",
          body: `<p><strong>${esc(b.name)}</strong> has been submitted. The campaign total is <strong>${esc(total)}</strong>; our team will confirm the amount and the payment details with you, review your campaign (usually within one working day), and let you know.</p>`,
        },
    approved: {
      subject: `Approved: ${b.name}`,
      title: "Your campaign is approved",
      body: `${
        creatorMoney
          ? creatorMoney.approved(creatorItems.length < b.items.length)
          : `<p><strong>${esc(b.name)}</strong> is approved and scheduled. You'll get an email with the link as each post goes live.</p>`
      }${b.launchFrom && b.launchTo ? `<p>Your go-live window is ${esc(dateOnly(b.launchFrom))} – ${esc(dateOnly(b.launchTo))}.</p>` : ""}`,
    },
    changes_requested: {
      subject: `Changes needed: ${b.name}`,
      title: "A small change is needed",
      body: `<p>Our team reviewed <strong>${esc(b.name)}</strong> and needs a change before it can go live:</p><blockquote style="margin:12px 0;padding:10px 14px;background:#f7f7f7;border-left:3px solid #1a1a1a">${esc(b.reviewNote ?? "")}</blockquote>${paidOnline ? "<p>Your payment is safe — make the change in the portal and resubmit.</p>" : "<p>Make the change in the portal and resubmit.</p>"}`,
    },
    rejected: {
      subject: `Not approved: ${b.name}`,
      title: "We couldn't run this campaign",
      body: `<p>We're sorry — we can't run <strong>${esc(b.name)}</strong> on our network.</p>${b.reviewNote ? `<blockquote style="margin:12px 0;padding:10px 14px;background:#f7f7f7;border-left:3px solid #1a1a1a">${esc(b.reviewNote)}</blockquote>` : ""}${
        paidOnline
          ? `<p>The full amount (${esc(total)}) is being refunded to your original payment method. Refunds usually arrive in 5–7 working days.</p>`
          : "<p>Nothing has been charged for this campaign. If you have already paid us for it, our team will arrange the refund with you.</p>"
      }`,
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
  const paidOnline = Boolean(b.paidAt);
  await notifyAdminByEmail(
    paidOnline ? `New paid campaign to review: ${b.name}` : `New campaign to review (payment to be collected): ${b.name}`,
    [
      { label: "Client", value: b.client.companyName },
      { label: "Brand", value: b.brand },
      { label: "Type", value: CAMPAIGN_TYPE_LABELS[b.campaignType as CampaignType] ?? b.campaignType },
      ...(b.audioIntegration ? [{ label: "Song audio", value: b.audioTrack ?? "yes" }] : []),
      { label: "Accounts", value: String(b.items.length) },
      { label: paidOnline ? "Paid" : "Amount (not yet collected)", value: b.totalPaise != null ? formatPaise(b.totalPaise) : "—" },
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
      paidAt: true,
      pricingSnapshot: true,
      items: {
        orderBy: { createdAt: "asc" },
        select: { id: true, targetType: true, targetId: true, platform: true, format: true, accountName: true, accountHandle: true, status: true, permalink: true, postedAt: true, remotePostId: true, nextAttemptAt: true, attempts: true, containerId: true },
      },
    },
  });
  if (!b) return null;
  // A creator's post names its provider, here as everywhere the client sees it.
  const providers = await providersOfItems(b);

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

  const autoOn = campaignConfig.publishEnabled();
  const refundConfirmed = await confirmedRefundsFor(b);
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
        provider: providers.get(i.id) ?? { type: "network" as const, name: null },
        status: i.status,
        // True only for a `refunded` item whose refund Razorpay has accepted: the portal says "refunded" on that and nothing else.
        refundConfirmed: refundConfirmed.has(i.id),
        permalink: i.permalink,
        postedAt: i.postedAt,
        // When an automatic post is due — only for its FIRST scheduled run with the publisher on.
        // Retry / processing times are not a promise, and with auto-publishing switched off a
        // queued post will not go out by itself, so no time is shown then.
        scheduledFor: autoOn && i.status === "queued" && i.attempts === 0 && !i.containerId ? i.nextAttemptAt : null,
        metrics: measured ? { views: p!.views, likes: p!.likes, comments: p!.comments, measuredAt: p!.metricsFetchedAt } : null,
      };
    }),
  };
}
