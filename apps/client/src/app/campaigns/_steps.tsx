"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import {
  BOOKABLE_FORMATS,
  CAMPAIGN_LIMITS,
  CAMPAIGN_TYPE_LABELS,
  CAMPAIGN_TYPES,
  FORMAT_LABELS,
  PLATFORM_FORMATS,
  countHashtags,
  countMentions,
  type CampaignFormat,
  type CampaignType,
} from "@dashmani/shared/src/validators/campaign";
import { todayIST } from "@dashmani/shared/src/utils/date";
import {
  compact,
  mutateJson,
  offerPrice,
  previewUrl,
  rupees,
  uploadChunked,
  useCatalogue,
  PLATFORM_LABEL,
  type Campaign,
  type CampaignMedia,
} from "@/lib/campaign";
import { Card, ErrorBanner, Field, PlatformDot, inputCls, textareaCls } from "./_ui";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");

// ── Step 1: details ─────────────────────────────────────────────────────────────

export function InfoForm({ initial, submitLabel, onSubmit, disabled }: {
  initial?: Partial<Pick<Campaign, "name" | "brand" | "objective" | "launchFrom" | "launchTo" | "campaignType">>;
  submitLabel: string;
  onSubmit: (v: { name: string; brand: string; objective: string | null; campaignType: CampaignType; launchFrom: string; launchTo: string }) => Promise<void>;
  disabled?: boolean;
}) {
  const today = todayIST();
  const [name, setName] = useState(initial?.name ?? "");
  const [brand, setBrand] = useState(initial?.brand ?? "");
  const [objective, setObjective] = useState(initial?.objective ?? "");
  const [campaignType, setCampaignType] = useState<CampaignType>(initial?.campaignType ?? "brand");
  const [from, setFrom] = useState(initial?.launchFrom ?? today);
  const [to, setTo] = useState(initial?.launchTo ?? today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const local =
    name.trim().length < 2 ? "Give the campaign a name" :
    brand.trim().length < 2 ? "Enter the brand" :
    from < today ? "The start date can't be in the past" :
    to < from ? "The end date must be on or after the start" : null;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (local) return setError(local);
        setBusy(true);
        setError(null);
        try {
          await onSubmit({ name: name.trim(), brand: brand.trim(), objective: objective.trim() || null, campaignType, launchFrom: from, launchTo: to });
        } catch (err) {
          setError(errMsg(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Card title="Campaign details" sub="Tell us what you're promoting and when it should go live.">
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Campaign name" htmlFor="c-name">
              <input id="c-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Diwali launch" disabled={disabled} />
            </Field>
            <Field label="Brand" htmlFor="c-brand">
              <input id="c-brand" className={inputCls} value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={200} placeholder="Your brand or product" disabled={disabled} />
            </Field>
          </div>
          <fieldset>
            <legend className="block text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-1.5">Campaign type</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {CAMPAIGN_TYPES.map((t) => (
                <label key={t} className={`flex items-start gap-2.5 rounded-xl border-2 px-3 py-2.5 cursor-pointer ${campaignType === t ? "border-ink" : "border-ink/15"}`}>
                  <input type="radio" name="ctype" value={t} checked={campaignType === t} onChange={() => setCampaignType(t)} disabled={disabled} className="mt-0.5 accent-[#1a1a1a]" />
                  <span>
                    <span className="block text-[13.5px] font-semibold text-ink">{CAMPAIGN_TYPE_LABELS[t]}</span>
                    <span className="block text-[12px] text-ink-3">{t === "brand" ? "A product, app or brand." : "A film, OTT show, song or event."}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-[12px] text-ink-3 mt-1.5">Prices on our accounts differ by campaign type.</p>
          </fieldset>
          <Field label="Objective (optional)" htmlFor="c-obj" hint="What should the posts achieve? Any do's and don'ts for our team.">
            <textarea id="c-obj" className={textareaCls} rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} maxLength={2000} disabled={disabled} />
          </Field>
          <div className="grid gap-4 grid-cols-2">
            <Field label="Go live from" htmlFor="c-from">
              <input id="c-from" type="date" className={inputCls} value={from} min={today} onChange={(e) => setFrom(e.target.value)} disabled={disabled} />
            </Field>
            <Field label="Go live by" htmlFor="c-to" hint={`Up to ${CAMPAIGN_LIMITS.launchWindowMaxDays} days`}>
              <input id="c-to" type="date" className={inputCls} value={to} min={from} onChange={(e) => setTo(e.target.value)} disabled={disabled} />
            </Field>
          </div>
          {error && <ErrorBanner>{error}</ErrorBanner>}
          {!disabled && (
            <div className="flex justify-end">
              <Button type="submit" variant="ink" disabled={busy} aria-live="polite" iconRight={<Icon.ArrowRight size={15} />}>
                {busy ? "Saving…" : submitLabel}
              </Button>
            </div>
          )}
        </div>
      </Card>
    </form>
  );
}

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
    <div className="relative rounded-xl overflow-hidden bg-ink/90 aspect-[4/5] grid place-items-center">
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
  // After payment the format and the audio option are what was paid for — frozen.
  const termsLocked = campaign.status === "changes_requested";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMedia(campaign.media), [campaign.media]);

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
    if (uploads.some((u) => !u.error)) return setError("Wait for the uploads to finish.");
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
                className={`text-left rounded-xl border-2 p-3 transition-colors disabled:opacity-40 ${active ? "border-ink bg-ink text-white" : "border-ink/15 bg-surface hover:border-ink/40"}`}
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
            <input type="checkbox" checked={audio} disabled={termsLocked} onChange={(e) => setAudio(e.target.checked)} className="h-4 w-4 accent-[#1a1a1a]" />
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

      <Card title="Super text" sub="Text we add on top of your image or video, exactly as you type it. Leave empty for none.">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
          <Field label="Overlay text" htmlFor="c-super" hint={`${superText.length}/${CAMPAIGN_LIMITS.superTextMax} · up to 3 lines`} error={superText.length > CAMPAIGN_LIMITS.superTextMax || superLines > 3 ? "Keep it to 120 characters and 3 lines" : null}>
            <textarea id="c-super" className={textareaCls} rows={3} value={superText} onChange={(e) => setSuperText(e.target.value)} placeholder={"FLAT 50% OFF\nToday only"} />
          </Field>
          <fieldset>
            <legend className="block text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-1.5">Position</legend>
            <div className="flex sm:flex-col gap-2">
              {(["top", "center", "bottom"] as const).map((s) => (
                <label key={s} className={`flex items-center gap-2 h-9 px-3 rounded-xl border-2 cursor-pointer text-[13px] font-semibold ${style === s ? "border-ink" : "border-ink/15"}`}>
                  <input type="radio" name="superstyle" value={s} checked={style === s} onChange={() => setStyle(s)} className="accent-[#1a1a1a]" />
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

// ── Step 3: accounts ────────────────────────────────────────────────────────────

type Sort = "followers" | "price" | "engagement";

export function AccountsStep({ campaign, onSaved }: { campaign: Campaign; onSaved: (c: Campaign) => void }) {
  const format = campaign.format as CampaignFormat;
  const { data, error: loadError, isLoading } = useCatalogue(true);
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState<"all" | "instagram" | "facebook" | "youtube">("all");
  const [sort, setSort] = useState<Sort>("followers");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(campaign.items.map((i) => i.rateCardId)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offers = useMemo(() => {
    const rows = (data ?? []).flatMap((a) => {
      const o = a.offers.find((x) => x.format === format);
      const price = o ? offerPrice(o, campaign) : null;
      return o && price ? [{ ...a, offer: o, price }] : [];
    });
    return rows;
  }, [data, format, campaign]);

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/^@/, "");
    return offers
      .filter((a) => platform === "all" || a.platform === platform)
      .filter((a) => !term || a.name.toLowerCase().includes(term) || (a.username ?? "").toLowerCase().includes(term) || (a.category ?? "").toLowerCase().includes(term))
      .sort((a, b) =>
        sort === "price" ? a.price.total - b.price.total :
        sort === "engagement" ? (b.engagementRatePct ?? -1) - (a.engagementRatePct ?? -1) :
        (b.followers ?? 0) - (a.followers ?? 0),
      );
  }, [offers, q, platform, sort]);

  const selected = offers.filter((a) => picked.has(a.offer.rateCardId));
  const total = selected.reduce((s, a) => s + a.price.total, 0);
  const withAudio = campaign.audioIntegration && format === "reel";
  const reach = selected.reduce((s, a) => s + (a.followers ?? 0), 0);
  const counts = { all: offers.length, instagram: 0, facebook: 0, youtube: 0 } as Record<string, number>;
  for (const a of offers) counts[a.platform]++;

  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const save = async () => {
    setError(null);
    if (picked.size === 0) return setError("Pick at least one account.");
    setBusy(true);
    try {
      onSaved(await mutateJson<Campaign>(`/client/campaigns/${campaign.id}/items`, "PUT", { rateCardIds: [...picked].filter((id) => offers.some((a) => a.offer.rateCardId === id)) }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 pb-24">
      <Card
        title="Choose accounts"
        sub={`Accounts on our network that carry a ${FORMAT_LABELS[format].toLowerCase()}. Prices are per account, for ${CAMPAIGN_TYPE_LABELS[campaign.campaignType].toLowerCase()}${withAudio ? ", including song audio integration" : ""}.`}
      >
        <div className="flex flex-wrap gap-2 items-center mb-3">
          <div className="relative flex-1 min-w-[180px]">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"><Icon.Search size={15} /></span>
            <input className={`${inputCls} pl-9`} placeholder="Search name, @handle or category" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search accounts" />
          </div>
          <select className={`${inputCls} !w-auto`} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
            <option value="followers">Most followers</option>
            <option value="engagement">Highest engagement</option>
            <option value="price">Lowest price</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-1.5 mb-4" role="tablist">
          {(["all", "instagram", "facebook", "youtube"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={platform === p}
              onClick={() => setPlatform(p)}
              className={`h-8 px-3 rounded-full text-[12.5px] font-semibold border-2 ${platform === p ? "bg-ink text-white border-ink" : "border-ink/15 text-ink-2"}`}
            >
              {p === "all" ? "All" : PLATFORM_LABEL[p]} <span className="opacity-70 tabular-nums">{counts[p] ?? 0}</span>
            </button>
          ))}
        </div>

        {loadError && <ErrorBanner>Couldn't load the accounts. Refresh the page.</ErrorBanner>}
        {isLoading && <div className="text-[13px] text-ink-3 py-6 text-center">Loading accounts…</div>}
        {data && visible.length === 0 && (
          <div className="text-[13px] text-ink-3 py-8 text-center">
            {offers.length === 0 ? `No accounts are open for ${FORMAT_LABELS[format].toLowerCase()} bookings yet. Try another format, or contact us.` : "No accounts match your search."}
          </div>
        )}

        <ul className="grid gap-2">
          {visible.map((a) => {
            const on = picked.has(a.offer.rateCardId);
            return (
              <li key={a.offer.rateCardId}>
                <label className={`flex items-center gap-3 rounded-xl border-2 px-3 py-2.5 cursor-pointer transition-colors ${on ? "border-ink bg-indigo/5" : "border-ink/10 hover:border-ink/30"}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(a.offer.rateCardId)} className="h-4 w-4 accent-[#1a1a1a] shrink-0" />
                  {a.pictureUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.pictureUrl} alt="" className="h-9 w-9 rounded-full object-cover shrink-0 bg-muted" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="h-9 w-9 rounded-full bg-muted grid place-items-center text-[13px] font-bold text-ink-2 shrink-0">{a.name[0]?.toUpperCase()}</span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <PlatformDot platform={a.platform} />
                      <span className="text-[13.5px] font-semibold text-ink truncate">{a.name}</span>
                      {a.profileUrl && (
                        <a href={a.profileUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-ink-3 hover:text-ink shrink-0" aria-label={`Open ${a.name}`}>
                          <Icon.External size={12} />
                        </a>
                      )}
                    </div>
                    <div className="text-[12px] text-ink-3 flex flex-wrap gap-x-3 gap-y-0.5">
                      {a.username && <span className="truncate max-w-[160px]">@{a.username}</span>}
                      <span>{PLATFORM_LABEL[a.platform]}</span>
                      {a.category && <span>{a.category}</span>}
                    </div>
                  </div>
                  <div className="hidden sm:grid grid-cols-2 gap-x-5 text-right shrink-0">
                    <span className="text-[13px] font-semibold text-ink tabular-nums">{compact(a.followers)}</span>
                    <span className="text-[13px] font-semibold text-ink tabular-nums" title="Engagements per view over the last 28 days">{a.engagementRatePct != null ? `${a.engagementRatePct}%` : "—"}</span>
                    <span className="text-[10.5px] uppercase tracking-wider text-ink-3">Followers</span>
                    <span className="text-[10.5px] uppercase tracking-wider text-ink-3">Engagement</span>
                  </div>
                  <div className="text-right shrink-0 w-[96px]">
                    <div className="text-[14px] font-bold text-ink tabular-nums">{rupees(a.price.total)}</div>
                    {a.price.addon > 0 && <div className="text-[10.5px] text-ink-3 tabular-nums" title="Base price + song audio">incl. {rupees(a.price.addon)} audio</div>}
                    <div className="sm:hidden text-[11px] text-ink-3 tabular-nums">{compact(a.followers)} followers</div>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="fixed bottom-0 left-0 right-0 lg:left-auto lg:right-6 lg:bottom-6 z-20 bg-surface border-t-2 lg:border-2 border-ink lg:rounded-2xl shadow-hard-ink px-4 py-3 flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-ink-3">{selected.length} account{selected.length === 1 ? "" : "s"} · {compact(reach)} followers</div>
          <div className="text-[17px] font-bold text-ink tabular-nums">{rupees(total)}</div>
        </div>
        {error && <span className="text-[12px] text-danger font-medium max-w-[220px]">{error}</span>}
        <Button variant="ink" onClick={save} disabled={busy || picked.size === 0} iconRight={<Icon.ArrowRight size={15} />}>
          {busy ? "Saving…" : "Continue"}
        </Button>
      </div>
    </div>
  );
}
