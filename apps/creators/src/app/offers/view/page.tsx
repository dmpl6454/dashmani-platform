"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { API_ORIGIN, apiFetch, fetcher } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import type { CreatorOffer } from "@/lib/types";
import { Banner, FieldError, Loading, Modal, PageHead } from "@/components/ui";
import { OfferStatus, PLATFORM, fmtIst, fmtWindow, rupees } from "../_offer";

// One booked post: what will go on the creator's page (the prepared files with the brand's text
// already on them, the caption, tags), the posting window and the payout — then accept or decline.
// A static export has no dynamic segments, so the post is picked with ?id=.

export default function OfferViewPage() {
  return (
    <Suspense fallback={<Loading label="Loading the post…" />}>
      <OfferView />
    </Suspense>
  );
}

function OfferView() {
  const id = useSearchParams().get("id") ?? "";
  const { data: o, error, isLoading, mutate } = useSWR<CreatorOffer>(id ? `/creator/offers/${id}` : null, fetcher, { revalidateOnFocus: false });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [declining, setDeclining] = useState(false);
  const [done, setDone] = useState("");

  if (!id) return <Banner tone="danger" title="No post selected."><Link href="/offers" className="underline">Back to bookings</Link></Banner>;
  if (isLoading && !o) return <Loading label="Loading the post…" />;
  if (error && !o) {
    return (
      <Banner tone="danger" role="alert" title="We couldn't load this post." action={<Link href="/offers" className="btn btn-sm btn-ghost">Back to bookings</Link>}>
        {errorSentence(error)}
      </Banner>
    );
  }
  if (!o) return null;

  const act = async (path: string, body?: unknown, message = "") => {
    setBusy(true);
    setActionError("");
    setDone("");
    try {
      const r = await apiFetch<CreatorOffer>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      await mutate(r.data, { revalidate: false });
      setDone(message);
      return true;
    } catch (e) {
      setActionError(errorSentence(e));
      await mutate();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const creative = (o.files ?? []).filter((f) => f.role !== "thumbnail");
  const cover = (o.files ?? []).find((f) => f.role === "thumbnail");

  return (
    <div className="flex flex-col gap-6">
      <Link href="/offers" className="inline-flex items-center gap-1 text-[13px] text-ink-3 hover:text-white w-fit"><ChevronLeft size={16} aria-hidden /> All bookings</Link>
      <PageHead kicker={`${PLATFORM[o.platform] ?? o.platform} · ${o.formatLabel}`} title={<>{o.campaign.brand}</>}>
        On <b className="text-white">{o.page.name}</b>{o.page.handle ? ` (@${o.page.handle})` : ""} · posting {fmtWindow(o.campaign.launchFrom, o.campaign.launchTo)}
      </PageHead>

      <div className="flex flex-wrap items-center gap-3">
        <OfferStatus o={o} />
        <span className="text-[14px]">Your payout: <b className="tabular-nums">{rupees(o.payoutPaise)}</b></span>
        {o.payoutPaise == null && <span className="text-[12px] text-ink-3">(our team will confirm the amount)</span>}
      </div>

      {done && <Banner tone="success" role="status" title={done} />}
      {actionError && <Banner tone="danger" role="alert" title="That didn't work.">{actionError}</Banner>}

      {o.canAccept && (
        <Banner
          tone="warn"
          title={`Accept or decline by ${fmtIst(o.respondBy)}.`}
          action={
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => act(`/creator/offers/${o.id}/accept`, undefined, "Accepted. Thank you!")}
              >
                {busy ? "Working…" : "Accept this post"}
              </button>
              <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setDeclining(true)}>Decline</button>
            </>
          }
        >
          If you accept, it is posted on your page on the first posting day (10:00 am IST) — or, when we can&apos;t post it for you, you post it yourself and paste the link here.
          If you don&apos;t answer in time, it is treated as declined.
        </Banner>
      )}
      {o.status === "queued" && (
        <Banner tone="info" title={`Scheduled — we post it on your page around ${fmtIst(o.scheduledFor)}.`}>
          Keep your Facebook connection in place until it is live; if it lapses, we&apos;ll ask you to post it yourself.
        </Banner>
      )}
      {o.status === "creator_declined" && (
        <Banner tone="info" title="You declined this post.">{o.declineReason && o.declineReason !== "No answer in time" ? `Reason: ${o.declineReason}` : "No answer was received in time."}</Banner>
      )}
      {o.canRecordPost && <RecordPost o={o} busy={busy} onSubmit={(url) => act(`/creator/offers/${o.id}/posted`, { url }, "Thanks — the post is recorded as live.")} />}
      {o.permalink && (
        <a href={o.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-indigo-light hover:underline w-fit">
          View the live post <ExternalLink size={14} aria-hidden />
        </a>
      )}

      <section className="card p-5 flex flex-col gap-4">
        <h2 className="text-lg font-extrabold">What will be posted</h2>
        {creative.length === 0 ? (
          <p className="text-sm text-ink-3">The files are no longer available.</p>
        ) : (
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))]">
            {creative.map((f, n) =>
              !f.ready ? (
                <div key={n} className="card-inset aspect-[9/16] grid place-items-center text-[13px] text-ink-3">Being prepared…</div>
              ) : f.kind === "video" ? (
                <video key={n} src={`${API_ORIGIN}${f.url}`} controls playsInline preload="metadata" poster={cover?.ready ? `${API_ORIGIN}${cover.url}` : undefined} className="w-full bg-black max-h-[480px]" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={n} src={`${API_ORIGIN}${f.url}`} alt={`File ${n + 1}`} className="w-full bg-black object-contain max-h-[480px]" />
              ),
            )}
          </div>
        )}
        <dl className="grid gap-3 text-sm">
          <Row label="Caption">{o.caption ? <span className="whitespace-pre-wrap break-words">{o.caption}</span> : <span className="text-ink-3">No caption</span>}</Row>
          {o.hashtags.length > 0 && <Row label="Hashtags">{o.hashtags.map((h) => `#${h}`).join(" ")}</Row>}
          {o.userTags.length > 0 && <Row label="Tagged accounts">{o.userTags.map((h) => `@${h}`).join(", ")}</Row>}
          {o.collaborators.length > 0 && <Row label="Collaborators">{o.collaborators.map((h) => `@${h}`).join(", ")}</Row>}
          {o.campaign.songTrack && <Row label="Song to add">{o.campaign.songTrack} <span className="text-ink-3">(added in the app — you post this one yourself; your payout includes the song add-on in full)</span></Row>}
          <Row label="Campaign">{o.campaign.name}</Row>
        </dl>
      </section>

      {declining && <DeclineDialog busy={busy} onClose={() => setDeclining(false)} onSubmit={async (reason) => { if (await act(`/creator/offers/${o.id}/decline`, { reason }, "Declined. We've let our team know.")) setDeclining(false); }} />}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[160px_minmax(0,1fr)]">
      <dt className="text-[12px] uppercase tracking-[0.1em] text-ink-3">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function RecordPost({ o, busy, onSubmit }: { o: CreatorOffer; busy: boolean; onSubmit: (url: string) => void }) {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  return (
    <section className="card p-5 flex flex-col gap-3">
      <h2 className="text-lg font-extrabold">Post it yourself</h2>
      <p className="text-sm text-ink-3">
        {o.note ?? "We can't post this one for you."} Post the files and caption below on {o.page.name} during the posting dates, then paste the link to the post here.
      </p>
      <form
        className="flex flex-col sm:flex-row gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = url.trim();
          if (!/^https?:\/\//i.test(v)) return setErr(`Paste the full ${PLATFORM[o.platform] ?? ""} link (starting with https://).`);
          setErr("");
          onSubmit(v);
        }}
      >
        <label className="field flex-1">
          <span className="field-label">Link to the post</span>
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={o.platform === "instagram" ? "https://www.instagram.com/p/…" : "https://www.facebook.com/…"}
            aria-invalid={!!err}
            aria-describedby={err ? "post-url-err" : undefined}
          />
        </label>
        <button type="submit" className="btn sm:self-end" disabled={busy || !url.trim()}>{busy ? "Saving…" : "It's posted"}</button>
      </form>
      {err && <FieldError id="post-url-err">{err}</FieldError>}
    </section>
  );
}

function DeclineDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const short = reason.trim().length < 3;
  return (
    <Modal title="Decline this post?" onClose={() => { if (!busy) onClose(); }}>
      <p className="text-sm text-ink-3">The brand&apos;s post won&apos;t go on your page. Tell our team why — it helps us send you better bookings.</p>
      <label className="field">
        <span className="field-label">Why</span>
        <textarea className="input min-h-[96px]" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} autoFocus />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} disabled={busy}>Keep it</button>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy || short} onClick={() => onSubmit(reason.trim())}>{busy ? "Working…" : "Decline"}</button>
      </div>
    </Modal>
  );
}
