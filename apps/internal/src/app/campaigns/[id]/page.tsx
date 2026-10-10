"use client";
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { ChevronLeft, Download, ExternalLink, Mail } from "lucide-react";
import { apiFetch, API_BASE } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import {
  BTN_GHOST, BTN_GOLD, BTN_RED, CARD, INPUT, ITEM_STATUS, ErrorBar, PageHead, PlatformDot, StatusPill, fmtDate, fmtWhen, rupees,
} from "../_ds";

type Item = {
  id: string; platform: string; format: string; accountName: string; accountHandle: string | null; pricePaise: number;
  audioAddonPaise: number; status: string; nextAttemptAt: string | null; attempts: number; permalink: string | null; postedAt: string | null; lastError: string | null;
};
type Booking = {
  id: string; name: string; brand: string; objective: string | null; status: string; format: string | null;
  campaignType: string; audioIntegration: boolean; audioTrack: string | null;
  autoPublish?: { enabled: boolean; dueAt: string };
  launchFrom: string | null; launchTo: string | null; caption: string | null; hashtags: string[]; userTags: string[];
  collaborators: string[]; superText: string | null; superTextStyle: string | null; totalPaise: number | null;
  reviewNote: string | null; paidAt: string | null; deliveredAt: string | null;
  client: { companyName: string; contactName: string; email: string; phone: string | null };
  media: Array<{ id: string; kind: string; originalName: string; bytes: number; durationMs: number | null; width: number | null; height: number | null; renderStatus: string; renderError: string | null }>;
  items: Item[];
  payments: Array<{ id: string; razorpayOrderId: string; razorpayPaymentId: string | null; amountPaise: number; refundedPaise: number; status: string; createdAt: string }>;
  events: Array<{ id: string; actorType: string; fromStatus: string | null; toStatus: string | null; note: string | null; createdAt: string }>;
};
type MediaUrls = Array<{ id: string; kind: string; renderStatus: string; preview: string; original: string }>;

const unwrap = <T,>(u: string) => apiFetch<{ data: T }>(u).then((r) => r.data);

export default function CampaignBookingDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: b, error, mutate } = useSWR<Booking>(`/admin/campaigns/${id}`, unwrap);
  const { data: urls } = useSWR<MediaUrls>(b ? `/admin/campaigns/${id}/media-urls` : null, unwrap, { revalidateOnFocus: false });
  usePageTitle(b?.name ?? "Campaign");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const act = async (key: string, path: string, body?: unknown, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(key);
    setErr("");
    setInfo("");
    try {
      const r = await apiFetch<{ data: Booking & { refundError?: string | null } }>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      if (r.data?.refundError) setErr(`Rejected, but the refund failed: ${r.data.refundError}. Retry from Razorpay.`);
      await mutate();
      return true;
    } catch (e: any) {
      setErr(e.message || "That didn't work.");
      return false;
    } finally {
      setBusy(null);
    }
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
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <div className="grid gap-4 content-start">
          <section className={`${CARD} p-5`}>
            <h2 className="text-[15px] font-semibold text-ds-text mb-3">Creative</h2>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {b.media.map((m) => {
                const u = urls?.find((x) => x.id === m.id);
                return (
                  <div key={m.id} className="shrink-0 w-[200px]">
                    <div className="aspect-[9/16] rounded-[12px] bg-ds-inset overflow-hidden grid place-items-center">
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
                        <a href={`${API_BASE}${u.preview}`} download className="inline-flex items-center gap-1 text-ds-gold hover:underline"><Download className="h-3.5 w-3.5" />Post file</a>
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
              {b.superText && <Kv k="Overlay" v={<span className="whitespace-pre-line">{b.superText} <span className="text-ds-t4">({b.superTextStyle})</span></span>} />}
              <Kv k="Caption" v={b.caption ? <span className="whitespace-pre-line break-words">{b.caption}</span> : "—"} />
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
              <ItemRow key={i.id} item={i} bookingId={b.id} postable={postable} autoPublish={!!b.autoPublish?.enabled} offline={offline} busy={busy} act={act} />
            ))}
          </section>
        </div>

        <div className="grid gap-4 content-start">
          {(reviewable || rejectable) && (
            <section className={`${CARD} p-5`}>
              <h2 className="text-[15px] font-semibold text-ds-text mb-1">Review</h2>
              <p className="text-[12.5px] text-ds-t3 mb-3">
                {offline
                  ? `Approving schedules every account for posting. No online payment was taken — collect ${rupees(b.totalPaise)} from the client by hand. Rejecting charges nothing.`
                  : "Approving schedules every account for posting. Rejecting refunds the client in full."}
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
    </div>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-3">
      <dt className="text-ds-t3">{k}</dt>
      <dd className="text-ds-t5 min-w-0">{v}</dd>
    </div>
  );
}

function ItemRow({ item: i, bookingId, postable, autoPublish, offline, busy, act }: {
  item: Item; bookingId: string; postable: boolean; autoPublish: boolean; offline: boolean; busy: string | null;
  act: (key: string, path: string, body?: unknown, confirmText?: string) => Promise<boolean | undefined>;
}) {
  const [url, setUrl] = useState(i.permalink ?? "");
  const [editing, setEditing] = useState(false);
  const open = ["manual_pending", "queued", "failed"].includes(i.status);
  const queued = i.status === "queued";
  const live = i.status === "posted_manual" || i.status === "published";
  return (
    <div className="px-5 py-3.5 border-t border-[#132430]">
      <div className="flex flex-wrap items-center gap-2.5">
        <PlatformDot platform={i.platform} />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ds-text truncate">{i.accountName}{i.accountHandle && <span className="text-ds-t3 font-normal"> @{i.accountHandle}</span>}</div>
          <div className="text-[12px] text-ds-t3">{i.platform} · {i.format} · {rupees(i.pricePaise)}{i.audioAddonPaise > 0 ? ` (incl. ${rupees(i.audioAddonPaise)} audio)` : ""}{i.postedAt ? ` · posted ${fmtWhen(i.postedAt)}` : ""}</div>
        </div>
        <StatusPill status={i.status} map={ITEM_STATUS} />
        {i.permalink && (
          <a href={i.permalink} target="_blank" rel="noopener noreferrer" className="text-ds-gold hover:text-ds-gold2" aria-label="Open post"><ExternalLink className="h-4 w-4" /></a>
        )}
      </div>
      {queued && (
        <div className="mt-1.5 text-[12px] text-ds-t2">
          {i.nextAttemptAt && new Date(i.nextAttemptAt) > new Date()
            ? `Publishes through the Meta API · ${fmtWhen(i.nextAttemptAt)}`
            : "Publishing through the Meta API now…"}
          {i.attempts > 0 ? ` · attempt ${i.attempts + 1} of 5` : ""}
        </div>
      )}
      {i.lastError && <div className={`mt-1.5 text-[12px] ${queued ? "text-ds-t3" : "text-[#FB7185]"}`}>{queued ? `Last try: ${i.lastError}` : i.lastError}</div>}
      {postable && !queued && (open || editing) && (
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
      {postable && (
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
