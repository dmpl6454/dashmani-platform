"use client";
// A booking's creative as the client submitted it — media previews, caption, hashtags, tags,
// collaborators and the overlay text — read-only. Media plays from short-lived signed links
// (GET /sales/bookings/:id/media-urls), the same files the staff portal reviews.
import useSWR from "swr";
import { apiAbsolute, fetcher } from "@/lib/api";
import type { BookingDetail, BookingMediaUrls } from "@/lib/sales-types";

const fmtDuration = (ms: number | null) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}` : null);

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
      <dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3 pt-0.5">{k}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export function BookingContent({ b }: { b: BookingDetail }) {
  // Signed links last 4 h: refetch hourly so a tab left open keeps playing.
  const { data: urls, error } = useSWR<BookingMediaUrls>(b.media.length ? `/sales/bookings/${b.id}/media-urls` : null, fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 3_600_000,
  });
  const creatives = b.media.filter((m) => m.role !== "thumbnail");
  const cover = b.media.find((m) => m.role === "thumbnail");
  const ownText = b.items.filter((i) => i.captionOverride != null || i.superTextOverride != null);

  return (
    <section className="card p-4 text-sm mb-4">
      <h2 className="font-bold mb-3">Content</h2>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4">
        <div>
          {b.media.length === 0 ? (
            <p className="text-ink-3">No media uploaded{b.status === "draft" ? " yet" : ""}.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {[...creatives, ...(cover ? [cover] : [])].map((m) => {
                const u = urls?.media.find((x) => x.id === m.id);
                return (
                  <figure key={m.id} className={creatives.length === 1 && m.role !== "thumbnail" ? "col-span-2" : ""}>
                    <div className="aspect-[9/16] max-h-[420px] w-full bg-black/40 border border-rule rounded overflow-hidden flex items-center justify-center">
                      {!u ? (
                        <span className="text-xs text-ink-4">{error ? "Preview unavailable" : "Loading preview…"}</span>
                      ) : m.kind === "video" ? (
                        <video src={apiAbsolute(u.preview)} controls playsInline preload="metadata" className="w-full h-full object-contain" />
                      ) : (
                        <img loading="lazy" decoding="async" src={apiAbsolute(u.preview)} alt={m.originalName} className="w-full h-full object-contain" />
                      )}
                    </div>
                    <figcaption className="text-[11px] text-ink-4 mt-1 break-all">
                      {m.role === "thumbnail" ? "Cover image · " : ""}
                      {m.kind === "video" ? "Video" : "Image"}
                      {m.width && m.height ? ` · ${m.width}×${m.height}` : ""}
                      {fmtDuration(m.durationMs) ? ` · ${fmtDuration(m.durationMs)}` : ""}
                      {b.superText && m.role !== "thumbnail" ? (m.renderStatus === "done" ? " · with overlay" : m.renderStatus === "failed" ? " · overlay render failed" : " · overlay rendering") : ""}
                      {u && <> · <a href={apiAbsolute(u.original)} target="_blank" rel="noopener noreferrer" className="underline hover:text-indigo-light">original</a></>}
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          )}
        </div>
        <dl className="grid gap-3 content-start">
          {b.objective && <Row k="Brief"><span className="whitespace-pre-line break-words">{b.objective}</span></Row>}
          <Row k="Caption">{b.caption ? <span className="whitespace-pre-line break-words">{b.caption}</span> : <span className="text-ink-4">No caption</span>}</Row>
          {b.hashtags.length > 0 && <Row k="Hashtags"><span className="text-indigo-light break-words">{b.hashtags.map((h) => `#${h}`).join(" ")}</span></Row>}
          {b.userTags.length > 0 && <Row k="Tag">{b.userTags.map((h) => `@${h}`).join(" ")}</Row>}
          {b.collaborators.length > 0 && <Row k="Collab">{b.collaborators.map((h) => `@${h}`).join(" ")}</Row>}
          {b.superText && <Row k="Overlay"><span className="whitespace-pre-line">{b.superText}</span>{b.superTextStyle && <span className="text-ink-4"> ({b.superTextStyle})</span>}</Row>}
          {b.audioIntegration && <Row k="Song">{b.audioTrack || "Client's song (no title given)"}</Row>}
          {ownText.length > 0 && (
            <Row k="Per account">
              <ul className="grid gap-2">
                {ownText.map((i) => (
                  <li key={i.id} className="border-l-2 border-rule pl-2">
                    <div className="font-bold">{i.accountName}</div>
                    {i.captionOverride != null && (
                      <div className="whitespace-pre-line break-words">
                        {i.captionOverride || <span className="text-ink-4">(hashtags only)</span>}
                        {i.hashtagsOverride.length > 0 && <span className="block text-indigo-light">{i.hashtagsOverride.map((h) => `#${h}`).join(" ")}</span>}
                      </div>
                    )}
                    {i.superTextOverride != null && <div className="text-ink-3 text-xs">Overlay: {i.superTextOverride || "none on this account"}</div>}
                  </li>
                ))}
              </ul>
            </Row>
          )}
        </dl>
      </div>
    </section>
  );
}
