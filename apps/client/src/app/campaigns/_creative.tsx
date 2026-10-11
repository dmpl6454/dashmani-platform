"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import {
  BOOKABLE_FORMATS,
  CAMPAIGN_LIMITS,
  FORMAT_LABELS,
  PLATFORM_FORMATS,
  countHashtags,
  countMentions,
  type CampaignFormat,
} from "@dashmani/shared/src/validators/campaign";
import { mutateJson, previewUrl, uploadChunked, type Campaign, type CampaignMedia } from "@/lib/campaign";
import { Card, ErrorBanner, Field, inputCls, textareaCls } from "./_ui";

// Step 2 of a campaign: format, upload, song, thumbnail, printed text, caption and tags.
// Its own module (re-exported from _steps.tsx) so the step can grow without crowding the others.

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");

// ── Step 2: creative ────────────────────────────────────────────────────────────

const FORMAT_HINT: Record<CampaignFormat, string> = {
  reel: `Vertical video, up to ${CAMPAIGN_LIMITS.reelMaxSec}s`,
  story: `Image or video up to ${CAMPAIGN_LIMITS.storyMaxSec}s · 24 hours`,
  post: "Feed image or video",
  carousel: `${CAMPAIGN_LIMITS.carouselMin}–${CAMPAIGN_LIMITS.carouselMax} images or videos`,
};
const FORMAT_ICON: Record<CampaignFormat, (p: { size?: number }) => JSX.Element> = {
  reel: Icon.Reel,
  story: Icon.Story,
  post: Icon.Image,
  carousel: Icon.Carousel,
};

function acceptFor(format: CampaignFormat) {
  return format === "reel" ? "video/mp4,video/quicktime" : "image/jpeg,image/png,video/mp4,video/quicktime";
}

function splitTags(s: string) {
  return s.split(/[\s,]+/).map((t) => t.trim().replace(/^[#@]/, "")).filter(Boolean);
}

interface Uploading {
  key: string;
  name: string;
  progress: number;
  error: string | null;
  file: File;
  resumeId: string | null;
}

function MediaPreview({ media, renderPending }: { media: CampaignMedia; renderPending: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    previewUrl(media.id).then((u) => live && setUrl(u)).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [media.id, media.renderStatus]);
  return (
    <div className="relative rounded-xl overflow-hidden bg-surface aspect-[4/5] grid place-items-center">
      {url && !failed ? (
        media.kind === "video" ? (
          <video src={url} controls playsInline preload="metadata" className="w-full h-full object-contain" onError={() => setFailed(true)} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={media.originalName} className="w-full h-full object-contain" onError={() => setFailed(true)} />
        )
      ) : (
        <span className="text-white/70 text-[12px]">{failed ? "Preview unavailable" : "Loading…"}</span>
      )}
      {renderPending && (
        <span className="absolute top-2 left-2 rounded-full bg-black/70 text-white text-[11px] font-semibold px-2.5 py-1">Preparing preview…</span>
      )}
      {media.renderStatus === "failed" && (
        <span className="absolute top-2 left-2 rounded-full bg-danger text-white text-[11px] font-semibold px-2.5 py-1">Couldn't prepare — upload again</span>
      )}
    </div>
  );
}

export function CreativeStep({ campaign, onSaved, submitLabel }: { campaign: Campaign; onSaved: (c: Campaign) => void; submitLabel: string }) {
  const [format, setFormat] = useState<CampaignFormat>((campaign.format as CampaignFormat) ?? "reel");
  const [media, setMedia] = useState<CampaignMedia[]>(campaign.media);
  const [uploads, setUploads] = useState<Uploading[]>([]);
  const [caption, setCaption] = useState(campaign.caption ?? "");
  const [hashtags, setHashtags] = useState(campaign.hashtags.map((h) => `#${h}`).join(" "));
  const [userTags, setUserTags] = useState(campaign.userTags.map((h) => `@${h}`).join(" "));
  const [collabs, setCollabs] = useState(campaign.collaborators.map((h) => `@${h}`).join(" "));
  const [superText, setSuperText] = useState(campaign.superText ?? "");
  const [style, setStyle] = useState(campaign.superTextStyle ?? "bottom");
  const [audio, setAudio] = useState(campaign.audioIntegration);
  const [audioTrack, setAudioTrack] = useState(campaign.audioTrack ?? "");
  const [thumb, setThumb] = useState<CampaignMedia | null>(campaign.thumbnail);
  const [thumbUpload, setThumbUpload] = useState<Uploading | null>(null);
  const thumbRef = useRef<HTMLInputElement>(null);
  // After payment the format and the audio option are what was paid for — frozen.
  const termsLocked = campaign.status === "changes_requested";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // A refetch (render polling, saving one account's text) must not wipe edits the client has
  // not saved yet: take the server's render state for files we already show, keep the rest.
  useEffect(() => {
    setMedia((cur) => cur.map((m) => campaign.media.find((x) => x.id === m.id) ?? m));
    setThumb((cur) => (cur && campaign.thumbnail && campaign.thumbnail.id === cur.id ? campaign.thumbnail : cur));
  }, [campaign.media, campaign.thumbnail]);

  const maxFiles = format === "carousel" ? CAMPAIGN_LIMITS.carouselMax : 1;
  const tagCount = countHashtags(caption, splitTags(hashtags));
  const mentionCount = countMentions(caption);
  const superLines = superText.split("\n").length;

  const startUpload = (u: Uploading) => {
    setUploads((list) => [...list.filter((x) => x.key !== u.key), { ...u, error: null }]);
    uploadChunked(u.file, {
      resumeId: u.resumeId,
      onId: (id) => setUploads((l) => l.map((x) => (x.key === u.key ? { ...x, resumeId: id } : x))),
      onProgress: (p) => setUploads((l) => l.map((x) => (x.key === u.key ? { ...x, progress: p } : x))),
    })
      .then((m) => {
        setUploads((l) => l.filter((x) => x.key !== u.key));
        setMedia((cur) => (format === "carousel" ? [...cur, m] : [m]));
      })
      .catch((e) => setUploads((l) => l.map((x) => (x.key === u.key ? { ...x, error: errMsg(e) } : x))));
  };

  const pick = (files: FileList | null) => {
    if (!files) return;
    const room = Math.max(0, maxFiles - media.length - uploads.length);
    const list = [...files].slice(0, format === "carousel" ? room : 1);
    if (format !== "carousel") setMedia([]);
    for (const f of list) {
      const isVideo = f.type.startsWith("video/");
      const max = isVideo ? CAMPAIGN_LIMITS.videoMaxBytes : CAMPAIGN_LIMITS.imageMaxBytes;
      const key = `${f.name}-${f.size}-${f.lastModified}`;
      if (f.size > max) {
        setUploads((l) => [...l, { key, name: f.name, progress: 0, file: f, resumeId: null, error: `Too large — ${isVideo ? "videos" : "images"} can be up to ${Math.round(max / 1048576)} MB` }]);
        continue;
      }
      startUpload({ key, name: f.name, progress: 0, file: f, resumeId: null, error: null });
    }
  };

  const startThumbUpload = (u: Uploading) => {
    setThumbUpload({ ...u, error: null });
    uploadChunked(u.file, {
      resumeId: u.resumeId,
      onId: (id) => setThumbUpload((x) => (x ? { ...x, resumeId: id } : x)),
      onProgress: (p) => setThumbUpload((x) => (x ? { ...x, progress: p } : x)),
    })
      .then((m) => {
        setThumbUpload(null);
        setThumb(m);
      })
      .catch((e) => setThumbUpload((x) => (x ? { ...x, error: errMsg(e) } : x)));
  };
  const pickThumb = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const key = `thumb-${f.name}-${f.size}-${f.lastModified}`;
    if (f.type !== "image/jpeg" && f.type !== "image/png") {
      setThumbUpload({ key, name: f.name, progress: 0, file: f, resumeId: null, error: "Too large or wrong type — the thumbnail must be a JPG or PNG image" });
      return;
    }
    if (f.size > CAMPAIGN_LIMITS.imageMaxBytes) {
      setThumbUpload({ key, name: f.name, progress: 0, file: f, resumeId: null, error: `Too large — images can be up to ${Math.round(CAMPAIGN_LIMITS.imageMaxBytes / 1048576)} MB` });
      return;
    }
    startThumbUpload({ key, name: f.name, progress: 0, file: f, resumeId: null, error: null });
  };
  // A thumbnail is a cover for a video: it only applies to a single-video reel or post.
  const thumbApplies = format !== "carousel" && media.some((m) => m.kind === "video");

  const move = (i: number, d: -1 | 1) => setMedia((m) => {
    const j = i + d;
    if (j < 0 || j >= m.length) return m;
    const c = m.slice();
    [c[i], c[j]] = [c[j], c[i]];
    return c;
  });

  const save = async () => {
    setError(null);
    if (media.length === 0) return setError("Upload your creative first.");
    if (format === "carousel" && media.length < CAMPAIGN_LIMITS.carouselMin) return setError("A carousel needs at least 2 files.");
    if (format === "reel" && media.some((m) => m.kind !== "video")) return setError("A reel needs a video.");
    if (uploads.some((u) => !u.error) || (thumbApplies && thumbUpload && !thumbUpload.error)) return setError("Wait for the uploads to finish.");
    const withAudio = format === "reel" && audio;
    if (withAudio && audioTrack.trim().length < 2) return setError("Tell us which song to integrate, or turn song audio off.");
    setBusy(true);
    try {
      const c = await mutateJson<Campaign>(`/client/campaigns/${campaign.id}/creative`, "PUT", {
        format,
        mediaIds: media.map((m) => m.id),
        caption,
        hashtags: splitTags(hashtags),
        userTags: splitTags(userTags),
        collaborators: splitTags(collabs),
        superText: superText.trim() || null,
        superTextStyle: superText.trim() ? style : null,
        audioIntegration: withAudio,
        audioTrack: withAudio ? audioTrack.trim() : null,
        thumbnailMediaId: thumbApplies && thumb ? thumb.id : null,
      });
      onSaved(c);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const savedMediaIds = new Set(campaign.media.map((m) => m.id));

  return (
    <div className="grid gap-4">
      <Card title="Format" sub="How the content appears on each account.">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {BOOKABLE_FORMATS.map((f) => {
            const F = FORMAT_ICON[f];
            const active = format === f;
            return (
              <button
                key={f}
                type="button"
                disabled={termsLocked && f !== format}
                onClick={() => {
                  if (f === format || termsLocked) return;
                  setFormat(f);
                  if (f !== "carousel") setMedia((m) => m.slice(0, 1));
                }}
                aria-pressed={active}
                className={`text-left rounded-xl border-2 p-3 transition-colors disabled:opacity-40 ${active ? "border-indigo bg-indigo text-white" : "border-ink/15 bg-surface hover:border-ink/40"}`}
              >
                <F size={18} />
                <div className="mt-2 text-[13.5px] font-bold">{FORMAT_LABELS[f]}</div>
                <div className={`text-[11.5px] mt-0.5 ${active ? "text-white/75" : "text-ink-3"}`}>{FORMAT_HINT[f]}</div>
              </button>
            );
          })}
        </div>
        <p className="text-[12px] text-ink-3 mt-3">
          YouTube takes {PLATFORM_FORMATS.youtube.map((f) => FORMAT_LABELS[f].toLowerCase()).join(" and ")} only — Shorts for reels.
        </p>
      </Card>

      <Card
        title="Your creative"
        sub={format === "carousel" ? "Upload 2–10 images or videos, in the order they should appear." : "Upload one file. JPG, PNG, MP4 or MOV."}
        right={
          media.length + uploads.length < maxFiles || format !== "carousel" ? (
            <Button size="sm" variant="default" icon={<Icon.Upload size={14} />} onClick={() => fileRef.current?.click()}>
              {media.length && format !== "carousel" ? "Replace" : "Upload"}
            </Button>
          ) : undefined
        }
      >
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept={acceptFor(format)}
          multiple={format === "carousel"}
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
        {media.length === 0 && uploads.length === 0 ? (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              pick(e.dataTransfer.files);
            }}
            className="w-full rounded-xl border-2 border-dashed border-ink/20 py-10 grid place-items-center text-ink-3 hover:border-ink/40 transition-colors"
          >
            <Icon.Upload size={22} />
            <span className="mt-2 text-[13.5px] font-semibold text-ink">Drop a file here or click to upload</span>
            <span className="text-[12px]">Videos up to 500 MB · images up to 20 MB</span>
          </button>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {media.map((m, i) => (
              <div key={m.id} className="min-w-0">
                <MediaPreview media={m} renderPending={savedMediaIds.has(m.id) && (m.renderStatus === "queued" || m.renderStatus === "rendering")} />
                <div className="mt-1.5 flex items-center gap-1 text-[12px] text-ink-2">
                  <span className="truncate flex-1" title={m.originalName}>{format === "carousel" ? `${i + 1}. ` : ""}{m.originalName}</span>
                  {format === "carousel" && (
                    <>
                      <button type="button" aria-label="Move earlier" className="p-1 hover:text-ink disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)}><Icon.ChevLeft size={14} /></button>
                      <button type="button" aria-label="Move later" className="p-1 hover:text-ink disabled:opacity-30" disabled={i === media.length - 1} onClick={() => move(i, 1)}><Icon.ChevRight size={14} /></button>
                    </>
                  )}
                  <button type="button" aria-label={`Remove ${m.originalName}`} className="p-1 hover:text-danger" onClick={() => setMedia((x) => x.filter((y) => y.id !== m.id))}><Icon.Close size={14} /></button>
                </div>
              </div>
            ))}
            {uploads.map((u) => (
              <div key={u.key} className="rounded-xl border-2 border-ink/10 p-3 aspect-[4/5] flex flex-col justify-end min-w-0">
                <div className="text-[12px] font-semibold text-ink truncate" title={u.name}>{u.name}</div>
                {u.error ? (
                  <>
                    <div className="text-[12px] text-danger mt-1">{u.error}</div>
                    <div className="flex gap-2 mt-2">
                      {u.resumeId !== null || !u.error.startsWith("Too large") ? (
                        <Button size="sm" variant="default" onClick={() => startUpload(u)}>Retry</Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => setUploads((l) => l.filter((x) => x.key !== u.key))}>Dismiss</Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={Math.round(u.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                      <div className="h-full bg-indigo transition-all" style={{ width: `${Math.round(u.progress * 100)}%` }} />
                    </div>
                    <div className="text-[11.5px] text-ink-3 mt-1 tabular-nums">{u.progress >= 1 ? "Checking file…" : `Uploading ${Math.round(u.progress * 100)}%`}</div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {format === "reel" && (
        <Card title="Song audio integration" sub="Optional, reels only. We set your song as the reel's audio. Each account charges an extra fee for this.">
          <label className="flex items-center gap-2.5 text-[13.5px] font-semibold text-ink cursor-pointer">
            <input type="checkbox" checked={audio} disabled={termsLocked} onChange={(e) => setAudio(e.target.checked)} className="h-4 w-4 accent-[#403cfa]" />
            Integrate a song in this reel
          </label>
          {audio && (
            <div className="mt-3">
              <Field label="Song" htmlFor="c-audio" hint="Song name and artist, or a link to it on Instagram, Spotify or YouTube">
                <input id="c-audio" className={inputCls} value={audioTrack} maxLength={300} onChange={(e) => setAudioTrack(e.target.value)} placeholder="Song name – artist, or a link" />
              </Field>
              <p className="text-[12px] text-ink-3 mt-2">Accounts that don&apos;t offer song integration are hidden from the account list.</p>
            </div>
          )}
        </Card>
      )}

      {thumbApplies && (
        <Card
          title="Thumbnail"
          sub="Optional. Your own cover image for the video (JPG or PNG). Leave it out and the platform picks a frame."
          right={
            !thumbUpload ? (
              <Button size="sm" variant="default" icon={<Icon.Upload size={14} />} onClick={() => thumbRef.current?.click()}>
                {thumb ? "Replace" : "Upload"}
              </Button>
            ) : undefined
          }
        >
          <input
            ref={thumbRef}
            type="file"
            className="hidden"
            accept="image/jpeg,image/png"
            onChange={(e) => {
              pickThumb(e.target.files);
              e.target.value = "";
            }}
          />
          {thumb || thumbUpload ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {thumb && !thumbUpload && (
                <div className="min-w-0">
                  <MediaPreview media={thumb} renderPending={campaign.thumbnail?.id === thumb.id && (thumb.renderStatus === "queued" || thumb.renderStatus === "rendering")} />
                  <div className="mt-1.5 flex items-center gap-1 text-[12px] text-ink-2">
                    <span className="truncate flex-1" title={thumb.originalName}>{thumb.originalName}</span>
                    <button type="button" aria-label="Remove thumbnail" className="p-1 hover:text-danger" onClick={() => setThumb(null)}><Icon.Close size={14} /></button>
                  </div>
                </div>
              )}
              {thumbUpload && (
                <div className="rounded-xl border-2 border-ink/10 p-3 aspect-[4/5] flex flex-col justify-end min-w-0">
                  <div className="text-[12px] font-semibold text-ink truncate" title={thumbUpload.name}>{thumbUpload.name}</div>
                  {thumbUpload.error ? (
                    <>
                      <div className="text-[12px] text-danger mt-1">{thumbUpload.error}</div>
                      <div className="flex gap-2 mt-2">
                        {thumbUpload.resumeId !== null || !thumbUpload.error.startsWith("Too large") ? (
                          <Button size="sm" variant="default" onClick={() => startThumbUpload(thumbUpload)}>Retry</Button>
                        ) : null}
                        <Button size="sm" variant="ghost" onClick={() => setThumbUpload(null)}>Dismiss</Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={Math.round(thumbUpload.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                        <div className="h-full bg-indigo transition-all" style={{ width: `${Math.round(thumbUpload.progress * 100)}%` }} />
                      </div>
                      <div className="text-[11.5px] text-ink-3 mt-1 tabular-nums">{thumbUpload.progress >= 1 ? "Checking file…" : `Uploading ${Math.round(thumbUpload.progress * 100)}%`}</div>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => thumbRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                pickThumb(e.dataTransfer.files);
              }}
              className="w-full rounded-xl border-2 border-dashed border-ink/20 py-6 grid place-items-center text-ink-3 hover:border-ink/40 transition-colors"
            >
              <Icon.Image size={20} />
              <span className="mt-2 text-[13px] font-semibold text-ink">Drop a cover image here or click to upload</span>
              <span className="text-[12px]">Vertical works best for reels · the super text is added to it too</span>
            </button>
          )}
          <p className="text-[12px] text-ink-3 mt-3">Instagram takes the thumbnail automatically. On Facebook our team sets it when posting.</p>
        </Card>
      )}

      <Card title="Super text" sub="Text we add on top of your image or video, exactly as you type it. Leave empty for none. You can give any single account its own text (or none) at the review step.">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
          <Field label="Overlay text" htmlFor="c-super" hint={`${superText.length}/${CAMPAIGN_LIMITS.superTextMax} · up to 3 lines`} error={superText.length > CAMPAIGN_LIMITS.superTextMax || superLines > 3 ? "Keep it to 120 characters and 3 lines" : null}>
            <textarea id="c-super" className={textareaCls} rows={3} value={superText} onChange={(e) => setSuperText(e.target.value)} placeholder={"FLAT 50% OFF\nToday only"} />
          </Field>
          <fieldset>
            <legend className="block text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-1.5">Position</legend>
            <div className="flex sm:flex-col gap-2">
              {(["top", "center", "bottom"] as const).map((s) => (
                <label key={s} className={`flex items-center gap-2 h-9 px-3 rounded-xl border-2 cursor-pointer text-[13px] font-semibold ${style === s ? "border-ink" : "border-ink/15"}`}>
                  <input type="radio" name="superstyle" value={s} checked={style === s} onChange={() => setStyle(s)} className="accent-[#403cfa]" />
                  {s[0].toUpperCase() + s.slice(1)}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <p className="text-[12px] text-ink-3 mt-2">After you save, we prepare a preview with the text in place — check it before you pay.</p>
      </Card>

      <Card title="Caption & tags" sub={format === "story" ? "Stories don't show captions or tags on Instagram — they are used on Facebook only." : undefined}>
        <div className="grid gap-4">
          <Field
            label="Caption"
            htmlFor="c-caption"
            hint={`${caption.length}/${CAMPAIGN_LIMITS.captionMax} characters · ${tagCount}/${CAMPAIGN_LIMITS.hashtagsMax} hashtags · ${mentionCount}/${CAMPAIGN_LIMITS.mentionsMax} mentions`}
            error={caption.length > CAMPAIGN_LIMITS.captionMax || tagCount > CAMPAIGN_LIMITS.hashtagsMax || mentionCount > CAMPAIGN_LIMITS.mentionsMax ? "Instagram allows 2,200 characters, 30 hashtags and 20 @mentions" : null}
          >
            <textarea id="c-caption" className={textareaCls} rows={5} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Write the caption that goes with the post…" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Hashtags" htmlFor="c-tags" hint="Separate with spaces">
              <input id="c-tags" className={inputCls} value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="#diwali #sale" />
            </Field>
            <Field label="Tag accounts" htmlFor="c-users" hint="Instagram usernames">
              <input id="c-users" className={inputCls} value={userTags} onChange={(e) => setUserTags(e.target.value)} placeholder="@yourbrand" />
            </Field>
            <Field label="Collaborators" htmlFor="c-collab" hint="Up to 3 · they accept on Instagram">
              <input id="c-collab" className={inputCls} value={collabs} onChange={(e) => setCollabs(e.target.value)} placeholder="@yourbrand" />
            </Field>
          </div>
        </div>
      </Card>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="flex justify-end">
        <Button variant="ink" onClick={save} disabled={busy} aria-live="polite" iconRight={<Icon.ArrowRight size={15} />}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
    </div>
  );
}
