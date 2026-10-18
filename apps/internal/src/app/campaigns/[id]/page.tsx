"use client";
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { ChevronLeft, Download, ExternalLink, Mail } from "lucide-react";
import { apiFetch, API_BASE } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import {
  BTN_GHOST, BTN_GOLD, BTN_RED, CARD, INPUT, ITEM_STATUS, ErrorBar, PageHead, Pill, PlatformDot, StatusPill, fmtDate, fmtWhen, rupees,
} from "../_ds";
import { CREATOR_TARGET_TYPE, LinkChangedError, creatorItemStatus, frozenCreatorItems, isLinkChangedMessage, isOpenOffer, safeHref, type StaffOffer } from "../_creator";
import { OfferPanel } from "./_offer";
import { PayoutPanel, type PayoutPanelProps } from "./_payout";
import { usePayoutDialog } from "../_payout-ui";
import { useBookingPayouts } from "@/lib/hooks/use-creator-payouts";

type Item = {
  id: string; targetType: string; platform: string; format: string; accountName: string; accountHandle: string | null; pricePaise: number;
  audioAddonPaise: number; status: string; nextAttemptAt: string | null; attempts: number; permalink: string | null; postedAt: string | null; lastError: string | null;
  /** Per-account text: null = the booking's. superTextOverride "" = no overlay on this account. */
  captionOverride: string | null; hashtagsOverride: string[]; superTextOverride: string | null; superTextStyleOverride: string | null;
};
type ItemFiles = { itemId: string; custom: boolean; files: Array<{ mediaId: string; kind: string; role: string; status: string; url: string | null }> };
type Booking = {
  id: string; name: string; brand: string; objective: string | null; status: string; format: string | null;
  campaignType: string; audioIntegration: boolean; audioTrack: string | null;
  autoPublish?: { enabled: boolean; dueAt: string };
  launchFrom: string | null; launchTo: string | null; caption: string | null; hashtags: string[]; userTags: string[];
  collaborators: string[]; superText: string | null; superTextStyle: string | null; totalPaise: number | null;
  reviewNote: string | null; paidAt: string | null; deliveredAt: string | null;
  client: { companyName: string; contactName: string; email: string; phone: string | null };
  media: Array<{ id: string; kind: string; role: string; originalName: string; bytes: number; durationMs: number | null; width: number | null; height: number | null; renderStatus: string; renderError: string | null }>;
  items: Item[];
  payments: Array<{ id: string; razorpayOrderId: string; razorpayPaymentId: string | null; amountPaise: number; refundedPaise: number; status: string; createdAt: string }>;
  /** Frozen at checkout; for a creator's post it carries the creator's name and payout (see frozenCreatorItems). */
  pricingSnapshot?: unknown;
  /** Present only when the booking has a creator's post. undefined on a network-only booking. */
  creatorOffers?: StaffOffer[];
  events: Array<{ id: string; actorType: string; fromStatus: string | null; toStatus: string | null; note: string | null; createdAt: string }>;
};
/** What an action answered besides the booking itself. */
type ActExtras = {
  refundError?: string | null; refundNotice?: string | null; withdrawNotice?: string | null;
  offerSummary?: { offered: number; refundDue: number; warnings: string[] };
};
type MediaUrls = { media: Array<{ id: string; kind: string; role: string; renderStatus: string; preview: string; original: string }>; items: ItemFiles[] };

const unwrap = <T,>(u: string) => apiFetch<{ data: T }>(u).then((r) => r.data);

export default function CampaignBookingDetail() {
  const { id } = useParams<{ id: string }>();
  // A creator accepts, declines and sends links on their own time, so while an offer is open the page re-reads itself. An
  // offer whose link staff verified is finished (the API refuses to withdraw it) and nothing about it can change any more.
  const { data: b, error, mutate } = useSWR<Booking>(`/admin/campaigns/${id}`, unwrap, {
    refreshInterval: (d) => (d?.creatorOffers?.some((o) => isOpenOffer(o) && !o.linkVerifiedAt) ? 30_000 : 0),
  });
  const { data: urls } = useSWR<MediaUrls>(b ? `/admin/campaigns/${id}/media-urls` : null, unwrap, { revalidateOnFocus: false });
  usePageTitle(b?.name ?? "Campaign");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  // The creator payouts of this campaign (only asked for when it has a creator's post). The API lists the open ones.
  const pay = useBookingPayouts(b?.items.some((i) => i.targetType === CREATOR_TARGET_TYPE) ? id : null);
  // One payout dialog for the page: the list under it refreshes by itself and must not take the dialog away.
  const payoutDialog = usePayoutDialog({
    onChanged: () => Promise.all([pay.mutate(), mutate()]),
    onNotice: (n) => { setErr(""); setInfo(n.text); },
  });

  const act = async (key: string, path: string, body?: unknown, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(key);
    setErr("");
    setInfo("");
    try {
      const r = await apiFetch<{ data: Booking & ActExtras }>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      if (r.data?.refundError) setErr(`Rejected, but a refund didn't go through. ${r.data.refundError}`);
      else if (r.data?.refundNotice) setInfo(r.data.refundNotice);
      else if (r.data?.withdrawNotice) setInfo(r.data.withdrawNotice);
      else if (r.data?.offerSummary) setInfo(offerSummaryText(r.data.offerSummary));
      await mutate();
      return true;
    } catch (e: any) {
      setErr(e.message || "That didn't work.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  // "Verify link & release": the dialog shows the API's refusal itself, so this throws instead of using act().
  // ⚠️ The request quotes `linkCanonicalKey`, the key of the link the dialog SHOWED (snapshotted when it opened): the
  // creator may send another link until staff verify, and a hand tick must vouch for one link only.
  const verifyCreatorLink = async (itemId: string, ownershipCheckedByHand: boolean, linkCanonicalKey: string, shown: { check: string | null; detail: string | null }) => {
    setErr("");
    setInfo("");
    try {
      await apiFetch(`/admin/campaigns/${id}/items/${itemId}/verify-creator-link`, { method: "POST", body: JSON.stringify({ ownershipCheckedByHand, linkCanonicalKey }) });
    } catch (e) {
      // Whatever the refusal was, look at the booking again: if the creator's link (or the check on it) is not what the dialog
      // showed, the dialog follows it. The API's 409 LINK_CHANGED says so by its sentence; the comparison also covers a refusal
      // that arrives without a recognisable one.
      const fresh = await mutate().catch(() => undefined);
      const now = fresh?.creatorOffers?.find((o) => o.itemId === itemId);
      const moved = !!now && (now.linkCanonicalKey !== linkCanonicalKey || now.ownershipCheck !== shown.check || now.ownershipDetail !== shown.detail);
      if (isLinkChangedMessage(e) || moved) throw new LinkChangedError(now);
      throw e;
    }
    await mutate();
    setInfo("Verified. The creator's link is now the live post, and the client is emailed that it is live. The creator's payout is scheduled for release: its status is under the offer.");
    void pay.mutate();
  };

  if (error && !b) return <div className="pt-8"><ErrorBar message={error.message || "Couldn't load this booking."} /></div>;
  if (!b) return <div className="pt-8 text-ds-t3 text-[13px]">Loading…</div>;

  const reviewable = b.status === "paid_pending_review";
  const rejectable = ["paid_pending_review", "changes_requested", "approved"].includes(b.status);
  const postable = ["approved", "publishing", "completed", "partially_published"].includes(b.status);
  const captured = b.payments.filter((p) => p.razorpayPaymentId);
  // Submitted without online payment (offline mode): no payment row, yet past the pay step.
  // Rejecting / refunding such a booking changes no money online — staff settle by hand.
  const offline = b.payments.length === 0 && !["draft", "awaiting_payment"].includes(b.status);
  const autoOn = !!b.autoPublish?.enabled;
  const queuedItems = b.items.filter((i) => i.status === "queued");
  // A creator's post is never posted by us, so it is not in "to post": the creator posts it and staff verify the link.
  const isCreatorItem = (i: Item) => i.targetType === CREATOR_TARGET_TYPE;
  const creatorItems = b.items.filter(isCreatorItem);
  const toPostItems = b.items.filter((i) => i.status === "manual_pending" && !isCreatorItem(i));
  const offerOf = (itemId: string) => b.creatorOffers?.find((o) => o.itemId === itemId);
  const waitingOnCreator = creatorItems.filter((i) => i.status === "awaiting_creator").length;
  const linksToVerify = creatorItems.filter((i) => i.status === "manual_pending" && offerOf(i.id)?.status === "accepted" && !!offerOf(i.id)?.linkSubmittedAt).length;
  const creatorsPosting = creatorItems.filter((i) => i.status === "manual_pending" && offerOf(i.id)?.status === "accepted" && !offerOf(i.id)?.linkSubmittedAt).length;
  const beingReturned = creatorItems.filter((i) => i.status === "refund_due" || (i.status === "manual_pending" && !isOpenOffer(offerOf(i.id)))).length;
  const nextAuto = queuedItems.map((i) => i.nextAttemptAt).filter((x): x is string => Boolean(x)).sort()[0] ?? null;
  // launchAt() returns "now" once the window start has passed — then approving posts straight away.
  const dueLater = !!b.autoPublish?.dueAt && new Date(b.autoPublish.dueAt).getTime() > Date.now() + 60_000;

  return (
    <div className="pb-10">
      <Link href="/campaigns" className="mt-6 inline-flex items-center gap-1 text-[12.5px] text-ds-t3 hover:text-ds-text"><ChevronLeft className="h-4 w-4" />All bookings</Link>
      <PageHead
        title={b.name}
        sub={<>{b.client.companyName} · {b.brand} · {b.campaignType === "entertainment" ? "Entertainment" : "Brand"} · {b.format ?? "—"}{b.audioIntegration ? " + song audio" : ""} · go live {fmtDate(b.launchFrom)} – {fmtDate(b.launchTo)}</>}
        right={<StatusPill status={b.status} />}
      />

      <div className="grid gap-4 mb-4">
        {err && <ErrorBar message={err} onClose={() => setErr("")} />}
        {info && <div className="px-3.5 py-2.5 rounded-[8px] bg-[rgba(0,215,160,.08)] border border-[rgba(0,215,160,.3)] text-ds-teal text-[12.5px]">{info}</div>}
        {postable && queuedItems.length > 0 && (autoOn ? (
          <div className="px-3.5 py-2.5 rounded-[8px] bg-[rgba(35,139,255,.08)] border border-[rgba(35,139,255,.3)] text-[#7DB8FF] text-[12.5px]">
            {queuedItems.length === 1 ? "1 account posts" : `${queuedItems.length} accounts post`} automatically through the Meta API
            {nextAuto && new Date(nextAuto) > new Date() ? <> — next on <strong>{fmtWhen(nextAuto)}</strong></> : " — now"}.
            {" "}Press <strong>Publish now</strong> on an account to post it sooner.
          </div>
        ) : (
          <div className="px-3.5 py-2.5 rounded-[8px] bg-[rgba(233,189,98,.08)] border border-[rgba(233,189,98,.35)] text-ds-gold text-[12.5px]">
            Auto-publishing is switched off, so {queuedItems.length === 1 ? "the account" : `the ${queuedItems.length} accounts`} marked Auto-publish will not post by themselves. Press <strong>Post by hand instead</strong> on each, then post it and paste the link.
          </div>
        ))}
        {postable && toPostItems.length > 0 && (
          <div className="px-3.5 py-2.5 rounded-[8px] bg-[rgba(233,189,98,.08)] border border-[rgba(233,189,98,.35)] text-ds-gold text-[12.5px]">
            {toPostItems.length === 1 ? "1 account needs" : `${toPostItems.length} accounts need`} a person to post {toPostItems.length === 1 ? "it" : "them"}: download that account&apos;s file, post it on the page, then paste the post&apos;s link and press <strong>Mark posted</strong>. Each account says why it can&apos;t post automatically. The client is emailed when you mark it posted.
          </div>
        )}
      </div>

      {creatorItems.length > 0 && (waitingOnCreator + linksToVerify + creatorsPosting + beingReturned > 0) && (
        <div className="mb-4 px-3.5 py-2.5 rounded-[8px] bg-[rgba(167,139,250,.08)] border border-[rgba(167,139,250,.3)] text-ds-t5 text-[12.5px]">
          <strong className="text-ds-purple">Creator posts.</strong> The creator posts these by hand; we never post on a creator&apos;s page.
          <ul className="mt-1 grid gap-0.5 list-disc pl-5">
            {waitingOnCreator > 0 && <li>{waitingOnCreator === 1 ? "1 post is" : `${waitingOnCreator} posts are`} waiting for the creator to accept.</li>}
            {creatorsPosting > 0 && <li>{creatorsPosting === 1 ? "1 creator has" : `${creatorsPosting} creators have`} accepted and {creatorsPosting === 1 ? "is" : "are"} posting.</li>}
            {linksToVerify > 0 && <li><strong>{linksToVerify === 1 ? "1 link needs" : `${linksToVerify} links need`} you to verify {linksToVerify === 1 ? "it" : "them"}</strong>: open the link, then press Verify link &amp; release on that account.</li>}
            {beingReturned > 0 && <li>{beingReturned === 1 ? "1 post is" : `${beingReturned} posts are`} being returned: the creator&apos;s payout is taken back first and the client is then refunded automatically within minutes. If {beingReturned === 1 ? "it" : "one"} still shows here after a while, press <strong>Refund this account</strong> on {beingReturned === 1 ? "it" : "that post"}.</li>}
          </ul>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <div className="grid gap-4 content-start">
          <section className={`${CARD} p-5`}>
            <h2 className="text-[15px] font-semibold text-ds-text mb-3">Creative</h2>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {b.media.map((m) => {
                const u = urls?.media.find((x) => x.id === m.id);
                return (
                  <div key={m.id} className="shrink-0 w-[200px]">
                    <div className="relative aspect-[9/16] rounded-[12px] bg-ds-inset overflow-hidden grid place-items-center">
                      {m.role === "thumbnail" && <span className="absolute top-2 left-2 z-10 rounded-full bg-black/70 text-white text-[10.5px] font-semibold px-2 py-0.5">Thumbnail</span>}
                      {u ? (
                        m.kind === "video" ? (
                          <video src={`${API_BASE}${u.preview}`} controls playsInline preload="metadata" className="w-full h-full object-contain" />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`${API_BASE}${u.preview}`} alt={m.originalName} className="w-full h-full object-contain" />
                        )
                      ) : (
                        <span className="text-ds-t3 text-[12px]">Loading…</span>
                      )}
                    </div>
                    <div className="mt-1.5 text-[11.5px] text-ds-t3 truncate" title={m.originalName}>{m.originalName}</div>
                    <div className="text-[11.5px] text-ds-t4">
                      {m.width}×{m.height}{m.durationMs ? ` · ${Math.round(m.durationMs / 1000)}s` : ""} · {(m.bytes / 1048576).toFixed(1)} MB
                    </div>
                    <div className="text-[11.5px] mt-0.5" style={{ color: m.renderStatus === "done" ? "#00D7A0" : m.renderStatus === "failed" ? "#FB7185" : "#E9BD62" }}>
                      {m.renderStatus === "done" ? "Rendered with overlay" : m.renderStatus === "failed" ? `Render failed: ${m.renderError ?? ""}` : "Rendering…"}
                    </div>
                    {u && (
                      <div className="mt-1.5 flex gap-2 text-[12px]">
                        <a href={`${API_BASE}${u.preview}&download=1`} download className="inline-flex items-center gap-1 text-ds-gold hover:underline"><Download className="h-3.5 w-3.5" />Post file</a>
                        <a href={`${API_BASE}${u.original}`} className="inline-flex items-center gap-1 text-ds-t2 hover:underline">Original</a>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <dl className="mt-4 grid gap-2.5 text-[13px]">
              <Kv k="Campaign type" v={b.campaignType === "entertainment" ? "Entertainment (film, OTT, music)" : "Brand promotion"} />
              {b.audioIntegration && <Kv k="Song audio" v={<span className="break-words font-semibold text-ds-gold">{b.audioTrack}</span>} />}
              {b.media.some((m) => m.role === "thumbnail") && <Kv k="Thumbnail" v={autoOn ? "Client-supplied cover image — Instagram takes it through the API; set it by hand on Facebook / YouTube." : "Client-supplied cover image — set it by hand when posting."} />}
              {b.superText && <Kv k="Overlay" v={<span className="whitespace-pre-line">{b.superText} <span className="text-ds-t4">({b.superTextStyle})</span></span>} />}
              <Kv k="Caption" v={b.caption ? <span className="whitespace-pre-line break-words">{b.caption}</span> : "—"} />
              {b.items.some((i) => i.captionOverride != null || i.superTextOverride != null) && (
                <Kv k="Per account" v={<span className="text-ds-gold">Some accounts have their own caption or overlay — see each account below and use ITS post files.</span>} />
              )}
              {b.hashtags.length > 0 && <Kv k="Hashtags" v={b.hashtags.map((h) => `#${h}`).join(" ")} />}
              {b.userTags.length > 0 && <Kv k="Tag" v={b.userTags.map((h) => `@${h}`).join(" ")} />}
              {b.collaborators.length > 0 && <Kv k="Collaborators" v={b.collaborators.map((h) => `@${h}`).join(" ")} />}
              {b.objective && <Kv k="Objective" v={<span className="whitespace-pre-line">{b.objective}</span>} />}
            </dl>
          </section>

          <section className={`${CARD} overflow-hidden`}>
            <div className="px-5 pt-5 pb-3 flex items-center gap-3">
              <h2 className="text-[15px] font-semibold text-ds-text flex-1">Accounts · {rupees(b.totalPaise)}</h2>
              {["completed", "partially_published"].includes(b.status) && (
                <button
                  type="button"
                  className={BTN_GHOST}
                  disabled={busy === "resend"}
                  onClick={async () => {
                    if (await act("resend", `/admin/campaigns/${b.id}/resend-delivery`)) setInfo(`Delivery email sent to ${b.client.email}.`);
                  }}
                >
                  <Mail className="h-4 w-4" /> Resend delivery email
                </button>
              )}
            </div>
            {b.items.map((i) => (
              <ItemRow
                key={i.id}
                item={i}
                booking={b}
                files={urls?.items.find((f) => f.itemId === i.id)}
                bookingId={b.id}
                postable={postable}
                autoPublish={!!b.autoPublish?.enabled}
                offline={offline}
                busy={busy}
                act={act}
                offer={offerOf(i.id)}
                onVerify={(hand, key, shown) => verifyCreatorLink(i.id, hand, key, shown)}
                payout={{
                  row: pay.data?.rows.find((r) => r.bookingItemId === i.id),
                  loading: !pay.data && !pay.error,
                  failed: !pay.data && !!pay.error,
                  stale: !!pay.data && !!pay.error,
                  onRetry: () => void pay.mutate(),
                  releaseOn: pay.data?.switches?.release,
                  onOpen: payoutDialog.open,
                  postVerified: !!offerOf(i.id)?.linkVerifiedAt,
                }}
              />
            ))}
          </section>
        </div>

        <div className="grid gap-4 content-start">
          {(reviewable || rejectable) && (
            <section className={`${CARD} p-5`}>
              <h2 className="text-[15px] font-semibold text-ds-text mb-1">Review</h2>
              <p className="text-[12.5px] text-ds-t3 mb-3">
                {autoOn
                  ? `${dueLater ? `Approving queues each account to post automatically on ${fmtWhen(b.autoPublish?.dueAt ?? null)}, the start of the posting window.` : "The posting window has already opened, so approving starts posting through the Meta API straight away."} Accounts the API can't post — song audio, stories, some Facebook videos — go to "To post" for someone to post by hand.`
                  : "Auto-publishing is switched off: approving sends every account to \"To post\" — someone posts each one by hand and pastes the link."}
                {creatorItems.length > 0 && " Posts on creator pages are not posted by us: approving makes each creator an offer showing their exact payout, and emails it. They accept and post it by hand, and you verify the link they send. If a creator declines, lets the offer lapse or doesn't post in time, that post goes to \"refund due\": the creator's payout is taken back and the client is refunded automatically within minutes (Refund this account on the post does it now). If approving is refused (creator bookings are switched off, or the posting window has ended), press Refund this account on each creator post below, then approve the rest. Once a creator has an open offer, use Withdraw offer: it takes the creator's payout back and refunds the client."}
                {" "}
                {offline
                  ? `No online payment was taken — collect ${rupees(b.totalPaise)} from the client by hand. Rejecting charges nothing.`
                  : "Rejecting refunds the client in full."}
              </p>
              {reviewable && (
                <button type="button" className={`${BTN_GOLD} w-full mb-3`} disabled={!!busy} onClick={() => act("approve", `/admin/campaigns/${b.id}/approve`)}>
                  {busy === "approve" ? "Approving…" : "Approve"}
                </button>
              )}
              <label htmlFor="rv-note" className="block text-[10.5px] uppercase tracking-[.1em] font-semibold text-ds-t3 mb-1.5">Note to the client</label>
              <textarea id="rv-note" rows={3} className={`${INPUT} h-auto py-2`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What needs to change, or why we can't run it" />
              <div className="flex gap-2 mt-2.5">
                {reviewable && (
                  <button type="button" className={`${BTN_GHOST} flex-1`} disabled={!!busy || note.trim().length < 3} onClick={async () => { if (await act("changes", `/admin/campaigns/${b.id}/request-changes`, { note })) setNote(""); }}>
                    Request changes
                  </button>
                )}
                <button
                  type="button"
                  className={`${BTN_RED} flex-1`}
                  disabled={!!busy || note.trim().length < 3}
                  onClick={async () => { if (await act("reject", `/admin/campaigns/${b.id}/reject`, { note }, offline ? `Reject this booking from ${b.client.companyName}?` : `Reject and refund ${rupees(b.totalPaise)} to ${b.client.companyName}?`)) setNote(""); }}
                >
                  {offline ? "Reject" : "Reject & refund"}
                </button>
              </div>
            </section>
          )}

          <section className={`${CARD} p-5`}>
            <h2 className="text-[15px] font-semibold text-ds-text mb-3">Client</h2>
            <dl className="grid gap-2 text-[13px]">
              <Kv k="Company" v={b.client.companyName} />
              <Kv k="Contact" v={b.client.contactName} />
              <Kv k="Email" v={<a className="text-ds-gold hover:underline break-all" href={`mailto:${b.client.email}`}>{b.client.email}</a>} />
              {b.client.phone && <Kv k="Phone" v={b.client.phone} />}
            </dl>
          </section>

          <section className={`${CARD} p-5`}>
            <h2 className="text-[15px] font-semibold text-ds-text mb-3">Payments</h2>
            {b.payments.length === 0 && (
              <p className="text-[13px] text-ds-t3">
                {offline ? `No online payment — submitted without the gateway. Collect ${rupees(b.totalPaise)} from the client by hand.` : "No payment yet."}
              </p>
            )}
            <ul className="grid gap-2.5">
              {b.payments.map((p) => (
                <li key={p.id} className="text-[12.5px]">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ds-text tabular-nums">{rupees(p.amountPaise)}</span>
                    <span className="text-ds-t2">{p.status.replace(/_/g, " ")}</span>
                    {p.refundedPaise > 0 && <span className="text-ds-t3">· refunded {rupees(p.refundedPaise)}</span>}
                  </div>
                  <div className="text-ds-t4 break-all">{p.razorpayPaymentId ?? p.razorpayOrderId} · {fmtWhen(p.createdAt)}</div>
                </li>
              ))}
            </ul>
            {captured.length === 0 && b.payments.length > 0 && <p className="text-[12px] text-ds-t3 mt-2">Orders without a payment id were never paid.</p>}
          </section>

          <section className={`${CARD} p-5`}>
            <h2 className="text-[15px] font-semibold text-ds-text mb-3">History</h2>
            <ol className="grid gap-2.5">
              {b.events.map((e) => (
                <li key={e.id} className="text-[12.5px]">
                  <div className="text-ds-t5">
                    {e.toStatus ? <>→ <span className="font-semibold">{e.toStatus.replace(/_/g, " ")}</span></> : null}
                    {e.note ? <span className="text-ds-t2">{e.toStatus ? " · " : ""}{e.note}</span> : null}
                  </div>
                  <div className="text-ds-t4">{e.actorType} · {fmtWhen(e.createdAt)}</div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
      {payoutDialog.dialog}
    </div>
  );
}

/**
 * What staff are told after approving a booking that had creator posts. The offers EXIST at this point; the emails to the
 * creators go out after the response (and may fail), so the text never says they were sent: each offer's own row says when its
 * creator was emailed, or that the email hasn't gone out.
 */
function offerSummaryText(x: { offered: number; refundDue: number; warnings: string[] }) {
  const parts = [x.offered > 0
    ? `Approved. ${x.offered === 1 ? "1 offer was" : `${x.offered} offers were`} made to creators. Each creator is emailed separately: the offer below shows when, and says so if the email hasn't gone out.`
    : "Approved. No creator offer could be made."];
  if (x.refundDue > 0) parts.push(`${x.refundDue === 1 ? "1 creator post can't" : `${x.refundDue} creator posts can't`} go ahead and ${x.refundDue === 1 ? "is" : "are"} marked "being returned": ${x.refundDue === 1 ? "it is" : "each is"} refunded to the client automatically within minutes, once the creator's payout is out of the way (press Refund on ${x.refundDue === 1 ? "it" : "a post"} to do it now).`);
  return [...parts, ...x.warnings].join(" ");
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-3">
      <dt className="text-ds-t3">{k}</dt>
      <dd className="text-ds-t5 min-w-0">{v}</dd>
    </div>
  );
}

function ItemRow({ item: i, booking: b, files, bookingId, postable, autoPublish, offline, busy, act, offer, onVerify, payout }: {
  item: Item; booking: Booking; files: ItemFiles | undefined; bookingId: string; postable: boolean; autoPublish: boolean; offline: boolean; busy: string | null;
  act: (key: string, path: string, body?: unknown, confirmText?: string) => Promise<boolean | undefined>;
  /** This post's creator offer (creator pages only). */
  offer: StaffOffer | undefined;
  onVerify: (ownershipCheckedByHand: boolean, linkCanonicalKey: string, shown: { check: string | null; detail: string | null }) => Promise<void>;
  /** The creator's payout for this post (creator pages only), as the page read it. */
  payout: Omit<PayoutPanelProps, "accountName" | "bookingId">;
}) {
  const [url, setUrl] = useState(i.permalink ?? "");
  const [editing, setEditing] = useState(false);
  // A creator's page: the creator posts it by hand and staff verify THEIR link. None of the hand/auto posting controls
  // below apply (no "Mark posted" field, no Publish now, no Mark failed): the offer panel carries the actions instead.
  const isCreator = i.targetType === CREATOR_TARGET_TYPE;
  const frozen = isCreator ? frozenCreatorItems(b.pricingSnapshot).get(i.id) : undefined;
  const creatorName = frozen?.creatorName ?? null;
  const creatorStatus = isCreator ? creatorItemStatus(i.status, offer) : null;
  // Refund: a creator's post whose offer is open is withdrawn first; one that is being returned (or has no open offer) is refunded.
  // A post that is still `pending` has no offer to withdraw: while the booking waits for review, Refund is how staff drop it
  // (approve refuses with "refund the creator posts" when creator bookings are off or the window has ended).
  const creatorRefundable = isCreator && (
    i.status === "refund_due" ||
    (["manual_pending", "awaiting_creator"].includes(i.status) && !isOpenOffer(offer)) ||
    (i.status === "pending" && b.status === "paid_pending_review")
  );
  const open = !isCreator && ["manual_pending", "queued", "failed"].includes(i.status);
  const queued = i.status === "queued";
  const live = i.status === "posted_manual" || i.status === "published";
  const ownCaption = i.captionOverride != null;
  const ownOverlay = i.superTextOverride != null;
  const caption = ownCaption ? i.captionOverride : b.caption;
  const hashtags = ownCaption ? i.hashtagsOverride : b.hashtags;
  return (
    <div className="px-5 py-3.5 border-t border-[#132430]">
      <div className="flex flex-wrap items-center gap-2.5">
        <PlatformDot platform={i.platform} />
        <div className="min-w-0 flex-1 basis-[200px]">
          <div className="text-[13.5px] font-semibold text-ds-text truncate">{i.accountName}{i.accountHandle && <span className="text-ds-t3 font-normal"> @{i.accountHandle}</span>}</div>
          <div className="text-[12px] text-ds-t3">{i.platform} · {i.format} · {rupees(i.pricePaise)}{i.audioAddonPaise > 0 ? ` (incl. ${rupees(i.audioAddonPaise)} audio)` : ""}{i.postedAt ? ` · posted ${fmtWhen(i.postedAt)}` : ""}</div>
          {isCreator && (
            <div className="mt-1 inline-flex max-w-full items-center h-5 px-2 rounded-full text-[11px] font-semibold text-ds-purple bg-ds-purple/10" title="A creator's page: the creator is paid a share and posts it by hand">
              <span className="truncate">Creator: {creatorName ?? "name not on record"}</span>
            </div>
          )}
        </div>
        {creatorStatus ? <Pill label={creatorStatus.label} color={creatorStatus.color} /> : <StatusPill status={i.status} map={ITEM_STATUS} />}
        {safeHref(i.permalink) && (
          <a href={safeHref(i.permalink)!} target="_blank" rel="noopener noreferrer" className="text-ds-gold hover:text-ds-gold2" aria-label="Open post"><ExternalLink className="h-4 w-4" /></a>
        )}
      </div>
      {(ownCaption || ownOverlay) && (
        <dl className="mt-2 grid gap-1 text-[12px] rounded-[8px] bg-ds-inset px-3 py-2">
          {ownOverlay && (
            <div className="grid grid-cols-[72px_1fr] gap-2"><dt className="text-ds-t3">Overlay</dt><dd className="text-ds-t5 whitespace-pre-line">{i.superTextOverride ? <>{i.superTextOverride} <span className="text-ds-t4">({i.superTextStyleOverride})</span></> : <span className="text-ds-t3">none on this account</span>}</dd></div>
          )}
          {ownCaption && (
            <div className="grid grid-cols-[72px_1fr] gap-2"><dt className="text-ds-t3">Caption</dt><dd className="text-ds-t5 whitespace-pre-line break-words">{caption || <span className="text-ds-t3">(hashtags only)</span>}{hashtags.length > 0 && <span className="block text-ds-t2">{hashtags.map((h) => `#${h}`).join(" ")}</span>}</dd></div>
          )}
        </dl>
      )}
      {isCreator && (
        <OfferPanel
          itemStatus={i.status}
          accountName={i.accountName}
          platform={i.platform}
          creatorName={creatorName}
          frozenPayoutPaise={frozen?.amountPaise ?? null}
          offer={offer}
          events={b.events}
          postable={postable}
          clientName={b.client.companyName}
          busy={busy}
          offersUnavailable={b.creatorOffers === undefined}
          onWithdraw={(discard) => act(`withdraw-${i.id}`, `/admin/campaigns/${bookingId}/items/${i.id}/withdraw-offer`, { discardSubmittedLink: discard })}
          onVerify={onVerify}
        />
      )}
      {isCreator && <PayoutPanel accountName={i.accountName} bookingId={bookingId} {...payout} />}
      {!isCreator && postable && !live && files && files.files.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          <span className="text-ds-t3">{files.custom ? "This account's files:" : "Files:"}</span>
          {files.files.map((f, n) =>
            f.url ? (
              <a key={f.mediaId} href={`${API_BASE}${f.url}&download=1`} download className="inline-flex items-center gap-1 text-ds-gold hover:underline">
                <Download className="h-3.5 w-3.5" />{f.role === "thumbnail" ? "Thumbnail" : files.files.filter((x) => x.role !== "thumbnail").length > 1 ? `File ${n + 1}` : "Post file"}
              </a>
            ) : (
              <span key={f.mediaId} className="text-ds-t3">{f.role === "thumbnail" ? "Thumbnail" : "Post file"} · {f.status === "failed" ? "render failed" : "rendering…"}</span>
            ),
          )}
        </div>
      )}
      {queued && (
        <div className={`mt-1.5 text-[12px] ${autoPublish ? "text-ds-t2" : "text-ds-gold"}`}>
          {!autoPublish
            ? "Auto-publishing is switched off — this won't post by itself. Choose \"Post by hand instead\"."
            : i.nextAttemptAt && new Date(i.nextAttemptAt) > new Date()
              ? `Posts automatically on ${fmtWhen(i.nextAttemptAt)}`
              : "Publishing through the Meta API now…"}
          {autoPublish && i.attempts > 0 ? ` · attempt ${i.attempts + 1} of 5` : ""}
        </div>
      )}
      {i.lastError && i.status !== "refunded" && i.status !== "posted_manual" && (
        <div className={`mt-1.5 text-[12px] ${isCreator ? (i.status === "refund_due" ? "text-[#F59E66]" : "text-ds-t2") : queued ? "text-ds-t3" : i.status === "manual_pending" ? "text-ds-gold" : "text-[#FB7185]"}`}>
          {isCreator ? i.lastError : queued ? `Last try: ${i.lastError}` : i.status === "manual_pending" ? `Post by hand — ${i.lastError}` : i.lastError}
        </div>
      )}
      {!isCreator && postable && !queued && (open || editing) && (
        <form
          className="mt-2.5 flex flex-col sm:flex-row gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act(`post-${i.id}`, `/admin/campaigns/${bookingId}/items/${i.id}/posted`, { url: url.trim() })) setEditing(false);
          }}
        >
          <input className={INPUT} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={`Paste the ${i.platform} post link`} aria-label="Post link" />
          <button type="submit" className={`${BTN_GOLD} shrink-0`} disabled={!!busy || !url.trim()}>{live ? "Save link" : "Mark posted"}</button>
        </form>
      )}
      {isCreator && creatorRefundable && (
        <div className="mt-2 flex flex-wrap gap-3 text-[12px]">
          <button
            type="button"
            className="text-ds-redsoft hover:underline"
            disabled={!!busy}
            onClick={() =>
              act(
                `refund-${i.id}`,
                `/admin/campaigns/${bookingId}/items/${i.id}/refund`,
                undefined,
                `Refund ${rupees(i.pricePaise)} for ${i.accountName} to ${b.client.companyName}? The post won't happen and the creator's payout is cancelled or taken back first.${i.status === "pending" ? " The creator hasn't been offered it yet, so nobody needs telling." : ""}`,
              )
            }
          >
            Refund this account
          </button>
        </div>
      )}
      {!isCreator && postable && (
        <div className="mt-2 flex flex-wrap gap-3 text-[12px]">
          {live && !editing && <button type="button" className="text-ds-t2 hover:text-ds-text" onClick={() => setEditing(true)}>Edit link</button>}
          {queued && (
            <>
              <button type="button" className="text-ds-gold hover:underline" disabled={!!busy} onClick={() => act(`now-${i.id}`, `/admin/campaigns/${bookingId}/items/${i.id}/publish-now`)}>
                Publish now
              </button>
              <button type="button" className="text-ds-t2 hover:text-ds-text" disabled={!!busy} onClick={() => act(`manual-${i.id}`, `/admin/campaigns/${bookingId}/items/${i.id}/manual`)}>
                Post by hand instead
              </button>
            </>
          )}
          {autoPublish && i.status === "manual_pending" && (
            <button type="button" className="text-ds-t2 hover:text-ds-text" disabled={!!busy} onClick={() => act(`now-${i.id}`, `/admin/campaigns/${bookingId}/items/${i.id}/publish-now`)}>
              Try auto-publish
            </button>
          )}
          {(i.status === "manual_pending" || i.status === "queued") && (
            <button
              type="button"
              className="text-ds-t2 hover:text-ds-text"
              disabled={!!busy}
              onClick={() => {
                const why = window.prompt("Why couldn't it be posted? (kept in the booking history)");
                if (why && why.trim().length >= 3) act(`fail-${i.id}`, `/admin/campaigns/${bookingId}/items/${i.id}/failed`, { note: why.trim() });
              }}
            >
              Mark failed
            </button>
          )}
          {open && (
            <button
              type="button"
              className="text-ds-redsoft hover:underline"
              disabled={!!busy}
              onClick={() =>
                act(
                  `refund-${i.id}`,
                  `/admin/campaigns/${bookingId}/items/${i.id}/refund`,
                  undefined,
                  offline
                    ? `Drop ${i.accountName} (${rupees(i.pricePaise)}) from this booking? It won't be posted and won't be charged.`
                    : `Refund ${rupees(i.pricePaise)} for ${i.accountName}? It won't be posted.`,
                )
              }
            >
              {offline ? "Drop this account" : "Refund this account"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
