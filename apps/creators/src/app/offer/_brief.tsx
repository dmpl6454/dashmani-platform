"use client";
import { useState, type ReactNode } from "react";
import { Download, ImageOff, RefreshCw } from "lucide-react";
import { mediaUrl, useStableFileUrls } from "@/lib/use-offers";
import type { OfferBrief, OfferFile } from "@/lib/offers";
import { CopyButton } from "@/components/offer-ui";

// What to post: the files (preview and download), then the caption, hashtags, tags, collaborators and the printed
// text, each in its own box with its own Copy button, because the creator posts by hand and pastes these one by one.
//
// ⚠️ This is the creator's part of the booking and nothing more. The brief the API sends carries no price, no client
// and no other creator, so there is nothing of that kind to show; do not add a field here that the API does not send.

const POSITION_WORDS: Record<string, string> = { top: "at the top", center: "in the centre", bottom: "at the bottom" };

function CopyField({ title, text, what, note }: { title: string; text: string; what: string; note?: ReactNode }) {
  return (
    <div className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 className="field-label">{title}</h3>
        <CopyButton text={text} what={what} />
      </div>
      <p className="mt-3 text-sm text-white whitespace-pre-wrap break-words leading-relaxed">{text}</p>
      {note && <p className="mt-3 text-xs text-ink-3 leading-relaxed break-words">{note}</p>}
    </div>
  );
}

function fileTitle(f: OfferFile, creativeIndex: number, creativeCount: number): string {
  if (f.role === "thumbnail") return "Cover image";
  const noun = f.kind === "video" ? "Video" : "Image";
  return creativeCount > 1 ? `${noun} ${creativeIndex} of ${creativeCount}` : noun;
}

function FileCard({ file, title, urls, onRefresh }: { file: OfferFile; title: string; urls: { url: string | null; downloadUrl: string | null }; onRefresh: () => void }) {
  // The URL that failed to load, not just "something failed": a fresh link (a new URL) starts clean.
  const [failed, setFailed] = useState<string | null>(null);
  const src = urls.url ? mediaUrl(urls.url) : null;
  const broken = !!src && failed === src;
  return (
    <li className="card-inset p-3 flex flex-col gap-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold break-words min-w-0">{title}</h3>
        {src && urls.downloadUrl && (
          <a href={mediaUrl(urls.downloadUrl)} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm shrink-0">
            <Download size={14} aria-hidden /> Download<span className="sr-only"> {title}</span>
          </a>
        )}
      </div>
      {!file.ready || !src ? (
        <div className="grid place-items-center gap-3 bg-black py-10 px-4 text-center">
          <p className="text-sm text-ink-3">This file is still being prepared. Reload the page to check again.</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh}><RefreshCw size={14} aria-hidden /> Reload</button>
        </div>
      ) : broken ? (
        <div className="grid place-items-center gap-3 bg-black py-10 px-4 text-center">
          <ImageOff size={20} className="text-ink-3" aria-hidden />
          <p className="text-sm text-ink-3">This preview couldn&apos;t load. Its link may have run out: reload to get a fresh one.</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setFailed(null); onRefresh(); }}><RefreshCw size={14} aria-hidden /> Reload</button>
        </div>
      ) : file.kind === "video" ? (
        <video src={src} controls playsInline preload="metadata" onError={() => setFailed(src)} className="w-full max-h-[420px] bg-black" aria-label={`Preview of ${title}`} />
      ) : (
        <img src={src} alt={`Preview of ${title}`} loading="lazy" onError={() => setFailed(src)} className="w-full max-h-[420px] object-contain bg-black" />
      )}
    </li>
  );
}

export function Brief({ brief, onRefresh }: { brief: OfferBrief; onRefresh: () => void }) {
  const urls = useStableFileUrls(brief.files);
  const creatives = brief.files.filter((f) => f.role !== "thumbnail");
  const ordered = [...creatives, ...brief.files.filter((f) => f.role === "thumbnail")];
  const hashtags = brief.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  const tags = brief.userTags.map((h) => `@${h.replace(/^@/, "")}`).join(" ");
  const collabs = brief.collaborators.map((h) => `@${h.replace(/^@/, "")}`).join(" ");
  const printed = brief.printedText?.text.trim() ? brief.printedText : null;
  const hasText = !!brief.caption.trim() || !!hashtags || !!tags || !!collabs || !!printed;

  return (
    <section aria-labelledby="brief-title" className="flex flex-col gap-4">
      <h2 id="brief-title" className="kicker">What to post</h2>

      {ordered.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {ordered.map((f) => (
            <FileCard
              key={f.id}
              file={f}
              title={fileTitle(f, creatives.indexOf(f) + 1, creatives.length)}
              urls={urls.get(f.id) ?? { url: f.url, downloadUrl: f.downloadUrl }}
              onRefresh={onRefresh}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-3">No files came with this booking.</p>
      )}

      {brief.caption.trim() && <CopyField title="Caption" text={brief.caption} what="caption" />}
      {hashtags && <CopyField title="Hashtags" text={hashtags} what="hashtags" />}
      {tags && <CopyField title="Tag these accounts" text={tags} what="tags" note="Tag them in the post." />}
      {collabs && (
        <CopyField title="Collaborators" text={collabs} what="collaborators" note="Add these accounts as collaborators on the post, where the platform allows it." />
      )}
      {printed && (
        <CopyField
          title="Printed on the media"
          text={printed.text}
          what="printed text"
          note={<>This text is already printed on the files above{printed.position && POSITION_WORDS[printed.position] ? `, ${POSITION_WORDS[printed.position]}` : ""}. You don&apos;t need to add it.</>}
        />
      )}
      {!hasText && <p className="text-sm text-ink-3">No caption, hashtags or tags were given for this post.</p>}
    </section>
  );
}
