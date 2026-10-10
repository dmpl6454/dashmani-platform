"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { CAMPAIGN_LIMITS, countHashtags, countMentions } from "@dashmani/shared/src/validators/campaign";
import { API_ORIGIN, mutateJson, type Campaign, type CampaignItem, type ItemPreviewFile } from "@/lib/campaign";
import { apiFetch } from "@/lib/api";
import { ErrorBanner, Field, PlatformDot, inputCls, textareaCls } from "./_ui";

// Per-account text: a different caption / hashtags / overlay for ONE booked account. Everything
// defaults to the campaign's; the client opts a single account out of it here. A custom overlay
// queues that account's own render, so the preview shows exactly what that page gets.

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");
const splitTags = (s: string) => s.split(/[\s,]+/).map((t) => t.trim().replace(/^[#@]/, "")).filter(Boolean);

type OverlayMode = "same" | "custom" | "none";

export function ItemTextEditor({ campaign: c, item, onSaved }: { campaign: Campaign; item: CampaignItem; onSaved: (c: Campaign) => void }) {
  const customCaption = item.captionOverride != null;
  const [captionMode, setCaptionMode] = useState<"same" | "custom">(customCaption ? "custom" : "same");
  const [caption, setCaption] = useState(item.captionOverride ?? c.caption ?? "");
  const [hashtags, setHashtags] = useState((customCaption ? item.hashtagsOverride : c.hashtags).map((h) => `#${h}`).join(" "));
  const [overlayMode, setOverlayMode] = useState<OverlayMode>(item.superTextOverride == null ? "same" : item.superTextOverride === "" ? "none" : "custom");
  const [superText, setSuperText] = useState(item.superTextOverride || c.superText || "");
  const [style, setStyle] = useState(item.superTextStyleOverride ?? c.superTextStyle ?? "bottom");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tagCount = countHashtags(caption, splitTags(hashtags));
  const mentionCount = countMentions(caption);
  const captionBad = caption.length > CAMPAIGN_LIMITS.captionMax || tagCount > CAMPAIGN_LIMITS.hashtagsMax || mentionCount > CAMPAIGN_LIMITS.mentionsMax;
  const superBad = superText.length > CAMPAIGN_LIMITS.superTextMax || superText.split("\n").length > CAMPAIGN_LIMITS.superTextLinesMax;

  const save = async () => {
    setError(null);
    if (captionMode === "custom" && captionBad) return setError("Instagram allows 2,200 characters, 30 hashtags and 20 @mentions.");
    if (overlayMode === "custom" && (!superText.trim() || superBad)) return setError("Enter the overlay text — up to 120 characters and 3 lines.");
    setBusy(true);
    try {
      const next = await mutateJson<Campaign>(`/client/campaigns/${c.id}/items/${item.id}/text`, "PUT", {
        caption: captionMode === "custom" ? caption : null,
        hashtags: captionMode === "custom" ? splitTags(hashtags) : [],
        superText: overlayMode === "same" ? null : overlayMode === "none" ? "" : superText.trim(),
        superTextStyle: overlayMode === "custom" ? style : null,
      });
      onSaved(next);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 pt-3">
      <fieldset>
        <legend className="block text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-1.5">Caption on this account</legend>
        <div className="flex flex-wrap gap-2">
          {(["same", "custom"] as const).map((m) => (
            <label key={m} className={`flex items-center gap-2 h-9 px-3 border-2 cursor-pointer text-[13px] font-semibold ${captionMode === m ? "border-ink" : "border-ink/15"}`}>
              <input type="radio" name={`cap-${item.id}`} checked={captionMode === m} onChange={() => setCaptionMode(m)} className="accent-[#403cfa]" />
              {m === "same" ? "Same as the campaign" : "Its own caption"}
            </label>
          ))}
        </div>
        {captionMode === "custom" && (
          <div className="grid gap-3 mt-3">
            <Field
              label="Caption"
              htmlFor={`cap-${item.id}`}
              hint={`${caption.length}/${CAMPAIGN_LIMITS.captionMax} · ${tagCount}/${CAMPAIGN_LIMITS.hashtagsMax} hashtags · ${mentionCount}/${CAMPAIGN_LIMITS.mentionsMax} mentions`}
              error={captionBad ? "Instagram allows 2,200 characters, 30 hashtags and 20 @mentions" : null}
            >
              <textarea id={`cap-${item.id}`} className={textareaCls} rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} />
            </Field>
            <Field label="Hashtags" htmlFor={`tags-${item.id}`} hint="Separate with spaces">
              <input id={`tags-${item.id}`} className={inputCls} value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="#diwali #sale" />
            </Field>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend className="block text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-1.5">Super text on this account</legend>
        <div className="flex flex-wrap gap-2">
          {(["same", "custom", "none"] as const).map((m) => (
            <label key={m} className={`flex items-center gap-2 h-9 px-3 border-2 cursor-pointer text-[13px] font-semibold ${overlayMode === m ? "border-ink" : "border-ink/15"}`}>
              <input type="radio" name={`ov-${item.id}`} checked={overlayMode === m} onChange={() => setOverlayMode(m)} className="accent-[#403cfa]" />
              {m === "same" ? (c.superText ? "Same as the campaign" : "None (campaign has none)") : m === "custom" ? "Its own text" : "No text on this account"}
            </label>
          ))}
        </div>
        {overlayMode === "custom" && (
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start mt-3">
            <Field label="Overlay text" htmlFor={`sup-${item.id}`} hint={`${superText.length}/${CAMPAIGN_LIMITS.superTextMax} · up to 3 lines`} error={superBad ? "Keep it to 120 characters and 3 lines" : null}>
              <textarea id={`sup-${item.id}`} className={textareaCls} rows={3} value={superText} onChange={(e) => setSuperText(e.target.value)} />
            </Field>
            <div>
              <span className="block text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-1.5">Position</span>
              <div className="flex sm:flex-col gap-2">
                {(["top", "center", "bottom"] as const).map((s) => (
                  <label key={s} className={`flex items-center gap-2 h-9 px-3 border-2 cursor-pointer text-[13px] font-semibold ${style === s ? "border-ink" : "border-ink/15"}`}>
                    <input type="radio" name={`style-${item.id}`} checked={style === s} onChange={() => setStyle(s)} className="accent-[#403cfa]" />
                    {s[0].toUpperCase() + s.slice(1)}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
        {overlayMode !== "same" && <p className="text-[12px] text-ink-3 mt-2">We prepare this account&apos;s own files with the text in place — check its preview below before you pay.</p>}
      </fieldset>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="flex justify-end">
        <Button size="sm" variant="ink" onClick={save} disabled={busy} aria-live="polite" icon={<Icon.Check size={14} />}>
          {busy ? "Saving…" : "Save for this account"}
        </Button>
      </div>
    </div>
  );
}

/** What one account will post: its own render when customised, else the campaign's files. */
export function ItemPreview({ campaign: c, item }: { campaign: Campaign; item: CampaignItem }) {
  const [files, setFiles] = useState<ItemPreviewFile[] | null>(null);
  // The default render finishing changes what a caption-only account posts, so refetch on it too.
  const renderSig = [...c.media, ...(c.thumbnail ? [c.thumbnail] : [])].map((m) => `${m.id}:${m.renderStatus}`).join(",");
  useEffect(() => {
    let live = true;
    apiFetch<ItemPreviewFile[]>(`/client/campaigns/${c.id}/items/${item.id}/preview-urls`)
      .then((r) => live && setFiles(r.data))
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [c.id, item.id, item.renderStatus, item.superTextOverride, item.superTextStyleOverride, renderSig]);
  if (!files?.length) return null;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 pt-3">
      {files.map((f) => (
        <div key={f.mediaId} className="relative shrink-0 w-[108px] aspect-[9/16] bg-surface overflow-hidden grid place-items-center">
          {f.url ? (
            f.kind === "video" ? (
              <video src={`${API_ORIGIN}${f.url}`} playsInline muted preload="metadata" className="w-full h-full object-contain" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`${API_ORIGIN}${f.url}`} alt="" className="w-full h-full object-contain" />
            )
          ) : (
            <span className="text-white/60 text-[11px]">{f.status === "failed" ? "Failed" : "Preparing…"}</span>
          )}
          {f.role === "thumbnail" && <span className="absolute top-1 left-1 bg-black/70 text-white text-[10px] font-bold px-1.5 py-0.5">Thumbnail</span>}
        </div>
      ))}
    </div>
  );
}

/** One account row with its current text summary and an expandable editor. */
export function ItemTextRow({ campaign: c, item, onSaved, editable }: { campaign: Campaign; item: CampaignItem; onSaved: (c: Campaign) => void; editable: boolean }) {
  const [open, setOpen] = useState(false);
  const custom = item.captionOverride != null || item.superTextOverride != null;
  return (
    <li className="py-3">
      <div className="flex items-center gap-3 text-[13px]">
        <PlatformDot platform={item.platform} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold text-ink">{item.accountName}</span>
          {item.accountHandle && <span className="text-ink-3"> @{item.accountHandle}</span>}
        </span>
        {custom && <span className="text-[11px] font-bold uppercase tracking-wider text-indigo">Own text</span>}
        {item.renderStatus === "queued" && <span className="text-[11px] text-ink-3">Preparing…</span>}
        {item.renderStatus === "failed" && <span className="text-[11px] text-danger">Couldn&apos;t prepare</span>}
        {editable && (
          <button type="button" className="text-[12.5px] font-semibold text-ink-2 hover:text-ink inline-flex items-center gap-1" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <Icon.Edit size={13} /> {open ? "Close" : "Customise"}
          </button>
        )}
      </div>
      {!open && custom && (
        <div className="mt-1 pl-5 text-[12px] text-ink-3 grid gap-0.5">
          {item.captionOverride != null && <div className="truncate">Caption: <span className="text-ink-2">{item.captionOverride || "(hashtags only)"}</span></div>}
          {item.superTextOverride != null && <div className="truncate">Super text: <span className="text-ink-2">{item.superTextOverride || "none"}</span></div>}
        </div>
      )}
      {open && (
        <>
          <ItemTextEditor campaign={c} item={item} onSaved={(n) => onSaved(n)} />
          {custom && <ItemPreview campaign={c} item={item} />}
        </>
      )}
    </li>
  );
}
