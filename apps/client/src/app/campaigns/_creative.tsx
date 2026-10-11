"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import {
  BOOKABLE_FORMATS,
  CAMPAIGN_LIMITS,
  FORMAT_LABELS,
  HANDLE_RE,
  HASHTAG_RE,
  countHashtags,
  countMentions,
  type CampaignFormat,
} from "@dashmani/shared/src/validators/campaign";
import { ApiError, apiFetch } from "@/lib/api";
import { deleteCampaignUpload, mutateJson, previewUrl, uploadChunked, type Campaign, type CampaignMedia } from "@/lib/campaign";
import { Card, ErrorBanner, Field, inputCls, textareaCls } from "./_ui";

// Step 2 of a campaign: format, upload, song, printed text, caption, and the optional extras
// (hashtags, tagged accounts, collaborators, thumbnail).
// Its own module (re-exported from _steps.tsx) so the step can grow without crowding the others.

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");

// ── Step 2: content ─────────────────────────────────────────────────────────────

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

/** Two files upload at once; the rest wait as "Queued" (the server allows 3 in flight per client, the thumbnail is the third). */
const UPLOAD_CONCURRENCY = 2;
/** The server's per-client cap on uploads in flight (CAMPAIGN_MAX_UPLOADS_IN_FLIGHT, default 3). */
const SERVER_UPLOAD_SLOTS = 3;

// Drag-and-drop bypasses the input's `accept`, and some systems report no type at all (an
// empty `file.type` would reach the server as application/octet-stream and be refused). The
// type is settled here: a known browser type, else the extension. The server still sniffs the
// real type from the file's bytes when the upload completes.
const EXT_MIME: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };
const KNOWN_MIME = new Set(Object.values(EXT_MIME));
const WRONG_TYPE = "Use JPG, PNG, MP4 or MOV — export it from your editor and try again.";

function mimeOf(f: File): string | null {
  const t = f.type.toLowerCase();
  if (KNOWN_MIME.has(t)) return t;
  if (t && t !== "application/octet-stream") return null;
  const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "";
  return EXT_MIME[ext] ?? null;
}

/** The same file, carrying the settled type (uploadChunked sends `file.type` to the server). */
function withMime(f: File, mime: string): File {
  return f.type === mime ? f : new File([f], f.name, { type: mime, lastModified: f.lastModified });
}

/** Errors a retry cannot fix: the file itself was refused, or the upload no longer exists. */
function isFatal(e: unknown): boolean {
  if (e instanceof ApiError) return ["UNSUPPORTED_TYPE", "TOO_LARGE", "FILE_REJECTED", "UPLOAD_CLOSED", "NOT_FOUND"].includes(e.code ?? "");
  return !!(e as { fatal?: boolean } | null)?.fatal;
}

/** Upload endpoints return the upload's own fields only; fill the rest of the media shape. */
function asMedia(m: Partial<CampaignMedia> & { id: string }): CampaignMedia {
  return {
    position: 0,
    kind: "image",
    role: "creative",
    originalName: "",
    mime: null,
    bytes: 0,
    durationMs: null,
    width: null,
    height: null,
    uploadStatus: "complete",
    rejectReason: null,
    renderStatus: "none",
    renderError: null,
    ...m,
  };
}

// Finished uploads not yet saved to the campaign, remembered per campaign (with the format they
// were uploaded for) so a reload, or a closed tab, does not lose them. Every access is guarded:
// storage can be blocked. An older entry is a bare array of ids, with no format.
interface UnsavedEntry {
  format: CampaignFormat | null;
  ids: string[];
}
function readUnsaved(key: string): UnsavedEntry {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    const strings = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []);
    if (Array.isArray(v)) return { format: null, ids: strings(v) };
    if (v && typeof v === "object") {
      const o = v as { format?: unknown; ids?: unknown };
      const format = (BOOKABLE_FORMATS as readonly string[]).includes(o.format as string) ? (o.format as CampaignFormat) : null;
      return { format, ids: strings(o.ids) };
    }
  } catch {
    /* unreadable: treat as empty */
  }
  return { format: null, ids: [] };
}
function writeUnsaved(key: string, ids: string[], format: CampaignFormat) {
  try {
    if (ids.length) localStorage.setItem(key, JSON.stringify({ format, ids }));
    else localStorage.removeItem(key);
  } catch {
    /* storage blocked */
  }
}

interface Uploading {
  key: string;
  name: string;
  progress: number;
  error: string | null;
  /** A retry cannot help (wrong type, too large, refused by the server): Dismiss only. */
  fatal: boolean;
  file: File;
  resumeId: string | null;
  /** Waiting for a free upload slot. */
  queued: boolean;
  ctrl: AbortController | null;
}

type FieldErrors = { hashtags?: string; userTags?: string; collabs?: string; audioTrack?: string };

const handleMsg = (h: string) => `"@${h}" isn't an Instagram username (letters, numbers, . and _)`;

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
        <span className="absolute top-2 left-2 rounded-full bg-black/80 text-danger border border-danger/60 text-[11px] font-semibold px-2.5 py-1">We couldn&apos;t prepare this file</span>
      )}
    </div>
  );
}

/** One upload in progress, queued or failed. Failed rows announce themselves (role=alert). */
function UploadRow({ u, onRetry, onDiscard }: { u: Uploading; onRetry: () => void; onDiscard: () => void }) {
  const pct = Math.round(u.progress * 100);
  return (
    <div className="rounded-xl border-2 border-ink/10 p-3 aspect-[4/5] flex flex-col justify-end min-w-0">
      <div className="text-[12px] font-semibold text-ink truncate" title={u.name}>{u.name}</div>
      {u.error ? (
        <>
          <div className="text-[12px] text-danger mt-1" role="alert">{u.error}</div>
          <div className="flex gap-2 mt-2">
            {!u.fatal && <Button size="sm" variant="default" type="button" onClick={onRetry}>Retry</Button>}
            <Button size="sm" variant="ghost" type="button" onClick={onDiscard}>Dismiss</Button>
          </div>
        </>
      ) : u.queued ? (
        <>
          <div className="text-[11.5px] text-ink-3 mt-1">Queued</div>
          <div className="mt-2">
            <Button size="sm" variant="ghost" type="button" aria-label={`Cancel upload of ${u.name}`} onClick={onDiscard}>Cancel</Button>
          </div>
        </>
      ) : (
        <>
          <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden" role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-indigo transition-all motion-reduce:transition-none" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-[11.5px] text-ink-3 mt-1 tabular-nums">{u.progress >= 1 ? "Checking file…" : `Uploading ${pct}%`}</div>
          <div className="mt-2">
            <Button size="sm" variant="ghost" type="button" aria-label={`Cancel upload of ${u.name}`} onClick={onDiscard}>Cancel</Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Under a saved file whose preview could not be prepared: a re-save re-queues it. Never the raw error. */
function RenderFailedActions({ busy, onRetry, onReplace }: { busy: boolean; onRetry: () => void; onReplace: () => void }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      <Button size="sm" variant="default" type="button" disabled={busy} onClick={onRetry}>Try again</Button>
      <Button size="sm" variant="ghost" type="button" onClick={onReplace}>Upload a different file</Button>
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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [userOpen, setUserOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const savedMediaIds = new Set(campaign.media.map((m) => m.id));
  const savedThumbId = campaign.thumbnail?.id ?? null;
  const unsavedKey = `campaign-unsaved-media:${campaign.id}`;

  // Mirrors for callbacks that outlive a render (upload completions, unload handlers).
  const formatRef = useRef(format);
  formatRef.current = format;
  const mediaRef = useRef(media);
  mediaRef.current = media;
  const thumbStateRef = useRef(thumb);
  thumbStateRef.current = thumb;
  const savedIdsRef = useRef(savedMediaIds);
  savedIdsRef.current = savedMediaIds;
  const savedThumbRef = useRef(savedThumbId);
  savedThumbRef.current = savedThumbId;
  /** Unsaved edits since the last save (drives the leave warning). */
  const dirtyRef = useRef(false);
  const uploadingRef = useRef(false);
  uploadingRef.current = uploads.length > 0 || !!thumbUpload;
  /** Server upload ids of uploads that have not completed, by row key (cleaned up on cancel/leave). */
  const idsRef = useRef(new Map<string, string>());
  const ctrlsRef = useRef(new Map<string, AbortController>());
  /** Ids of files THIS step uploaded or restored — the only ones discardUnsaved may delete. A stale
   *  `campaign` prop (a refetch still on its way) must never make a saved file deletable. */
  const ownIdsRef = useRef(new Set<string>());
  /** Cancelled uploads whose DELETE has not reached the server yet: they still hold a server slot. */
  const [freeing, setFreeing] = useState(0);
  const freeSlot = (id: string) => {
    setFreeing((n) => n + 1);
    deleteCampaignUpload(id).finally(() => setFreeing((n) => Math.max(0, n - 1)));
  };
  const touch = () => {
    dirtyRef.current = true;
  };

  // A refetch (render polling, saving one account's text) must not wipe edits the client has
  // not saved yet: take the server's render state for files we already show, keep the rest.
  useEffect(() => {
    setMedia((cur) => cur.map((m) => campaign.media.find((x) => x.id === m.id) ?? m));
    setThumb((cur) => (cur && campaign.thumbnail && campaign.thumbnail.id === cur.id ? campaign.thumbnail : cur));
  }, [campaign.media, campaign.thumbnail]);

  // Bring back uploads that finished but were never saved (a reload, a closed tab).
  useEffect(() => {
    const stored = readUnsaved(unsavedKey);
    const ids = stored.ids.filter((id) => !savedIdsRef.current.has(id));
    if (!ids.length) return;
    // They come back under the format they were uploaded for (unless the format is frozen).
    const restoreFormat = !termsLocked && stored.format ? stored.format : formatRef.current;
    let live = true;
    Promise.all(
      ids.map((id) =>
        apiFetch<CampaignMedia>(`/client/campaign-uploads/${id}`)
          .then((r) => ({ id, row: r.data as CampaignMedia | null, gone: r.data?.uploadStatus !== "complete" }))
          .catch((e) => ({ id, row: null, gone: e instanceof ApiError && e.status === 404 })),
      ),
    ).then((res) => {
      if (!live) return;
      const gone = new Set(res.filter((r) => r.gone).map((r) => r.id));
      if (gone.size) {
        const now = readUnsaved(unsavedKey);
        writeUnsaved(unsavedKey, now.ids.filter((id) => !gone.has(id)), now.format ?? restoreFormat);
      }
      const back = res.filter((r) => r.row && !r.gone).map((r) => asMedia(r.row!));
      if (!back.length) return;
      for (const b of back) ownIdsRef.current.add(b.id);
      dirtyRef.current = true;
      if (restoreFormat !== formatRef.current) {
        formatRef.current = restoreFormat; // completions before the next render read the restored format
        setFormat(restoreFormat);
      }
      setMedia((cur) => {
        const fresh = back.filter((b) => !cur.some((c) => c.id === b.id));
        if (!fresh.length) return cur;
        return restoreFormat === "carousel" ? [...cur, ...fresh].slice(0, CAMPAIGN_LIMITS.carouselMax) : [fresh[fresh.length - 1]];
      });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload or tab close with unsaved work: let the browser ask first.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current || uploadingRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Leaving with uploads still running: discard them on the server so they don't hold one of the
  // client's upload slots. Best-effort — a keepalive DELETE needs a CORS preflight, which some
  // browsers drop; the server also stops counting a stale upload on its own.
  useEffect(() => {
    const discardAll = (keepalive: boolean) => {
      for (const id of idsRef.current.values()) deleteCampaignUpload(id, { keepalive });
      idsRef.current.clear();
    };
    const onPageHide = (e: PageTransitionEvent) => {
      if (!e.persisted) discardAll(true); // kept in the back-forward cache: the page may come back
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      for (const c of ctrlsRef.current.values()) c.abort();
      ctrlsRef.current.clear();
      discardAll(false);
    };
  }, []);

  const maxFiles = format === "carousel" ? CAMPAIGN_LIMITS.carouselMax : 1;
  const tagCount = countHashtags(caption, splitTags(hashtags));
  const mentionCount = countMentions(caption);
  const superLines = superText.split("\n").length;

  const forget = (id: string) => {
    const now = readUnsaved(unsavedKey);
    writeUnsaved(unsavedKey, now.ids.filter((x) => x !== id), now.format ?? formatRef.current);
  };
  /** Drop a finished upload the campaign never saved (frees the client's storage at once). */
  const discardUnsaved = (id: string) => {
    if (savedIdsRef.current.has(id) || savedThumbRef.current === id) return; // never delete a saved file
    if (!ownIdsRef.current.has(id)) return; // not ours (or saved since): only forget it from the form
    ownIdsRef.current.delete(id);
    deleteCampaignUpload(id);
    forget(id);
  };

  const startUpload = (u: Uploading) => {
    const ctrl = new AbortController();
    ctrlsRef.current.set(u.key, ctrl);
    setUploads((l) => l.map((x) => (x.key === u.key ? { ...x, queued: false, ctrl, error: null, fatal: false } : x)));
    // The same file can be cancelled and picked again under the same key while this run's init is
    // still pending: a settling run only ever clears its OWN entries, never the new run's.
    let myId: string | null = u.resumeId;
    const release = () => {
      if (ctrlsRef.current.get(u.key) === ctrl) ctrlsRef.current.delete(u.key);
      if (myId && idsRef.current.get(u.key) === myId) idsRef.current.delete(u.key);
    };
    uploadChunked(u.file, {
      resumeId: u.resumeId,
      signal: ctrl.signal,
      onId: (id) => {
        if (ctrl.signal.aborted) return void freeSlot(id); // cancelled before the id arrived
        myId = id;
        idsRef.current.set(u.key, id);
        setUploads((l) => l.map((x) => (x.key === u.key ? { ...x, resumeId: id } : x)));
      },
      onProgress: (p) => {
        if (!ctrl.signal.aborted) setUploads((l) => l.map((x) => (x.key === u.key ? { ...x, progress: p } : x)));
      },
    })
      .then((done) => {
        if (ctrl.signal.aborted) return void freeSlot(done.id); // cancelled while it finished
        release();
        const m = asMedia(done);
        ownIdsRef.current.add(m.id);
        writeUnsaved(unsavedKey, [...readUnsaved(unsavedKey).ids.filter((x) => x !== m.id), m.id], formatRef.current);
        dirtyRef.current = true;
        // A replacement swaps the single file; an unsaved file it replaces is discarded.
        if (formatRef.current !== "carousel") for (const old of mediaRef.current) if (old.id !== m.id) discardUnsaved(old.id);
        setUploads((l) => l.filter((x) => x.key !== u.key));
        setMedia((cur) => (formatRef.current === "carousel" ? [...cur, m] : [m]));
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return; // the client cancelled it: nothing to report
        // The server id stays known: a retryable row resumes it, and Dismiss deletes it.
        if (ctrlsRef.current.get(u.key) === ctrl) ctrlsRef.current.delete(u.key);
        setUploads((l) => l.map((x) => (x.key === u.key ? { ...x, error: errMsg(e), fatal: isFatal(e) } : x)));
      });
  };

  // Start queued uploads while fewer than UPLOAD_CONCURRENCY are actually running — and never past
  // the server's cap, which counts every upload row it still holds: a running one, a failed one
  // that can be retried (its row is still "uploading"), the thumbnail, and a cancel on its way.
  // A failed-but-resumable row uses a server slot only, not a network one, so it can't stall the queue.
  useEffect(() => {
    const holdsSlot = (u: Uploading) => !u.queued && (!u.error || (!u.fatal && !!(idsRef.current.get(u.key) ?? u.resumeId)));
    const running = uploads.filter((u) => !u.queued && !u.error).length;
    const mine = uploads.filter(holdsSlot).length;
    const thumbHolds = thumbUpload && (!thumbUpload.error || (!thumbUpload.fatal && !!thumbUpload.resumeId)) ? 1 : 0;
    const room = Math.max(0, Math.min(UPLOAD_CONCURRENCY - running, SERVER_UPLOAD_SLOTS - mine - thumbHolds - freeing));
    const next = uploads.filter((u) => u.queued && !u.error).slice(0, room);
    for (const u of next) startUpload(u);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploads, thumbUpload, freeing]);

  /** Cancel an upload in progress or queued, or dismiss a failed one. */
  const discardUpload = (u: Uploading) => {
    ctrlsRef.current.get(u.key)?.abort();
    ctrlsRef.current.delete(u.key);
    const id = idsRef.current.get(u.key) ?? u.resumeId;
    if (id) freeSlot(id);
    idsRef.current.delete(u.key);
    setUploads((l) => l.filter((x) => x.key !== u.key));
  };

  const pick = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // A replacement is already uploading: ignore a second pick until it ends.
    if (format !== "carousel" && uploads.some((u) => !u.error)) return;
    setError(null);
    // One slot: a new pick replaces earlier failed attempts at it.
    const kept = format === "carousel" ? uploads : [];
    if (format !== "carousel") for (const u of uploads) discardUpload(u);
    const live = kept.filter((u) => !u.fatal).length;
    const room = format === "carousel" ? Math.max(0, maxFiles - media.length - live) : 1;
    const all = [...files];
    const list = all.slice(0, room);
    if (format === "carousel" && all.length > list.length) {
      setError(`A carousel takes up to ${CAMPAIGN_LIMITS.carouselMax} files — ${all.length - list.length} not added.`);
    }
    const rows: Uploading[] = [];
    for (const f of list) {
      const key = `${f.name}-${f.size}-${f.lastModified}`;
      if (kept.some((u) => u.key === key) || rows.some((r) => r.key === key)) continue; // already in the list
      const row: Uploading = { key, name: f.name, progress: 0, file: f, resumeId: null, error: null, fatal: false, queued: true, ctrl: null };
      const mime = mimeOf(f);
      if (!mime) {
        rows.push({ ...row, error: WRONG_TYPE, fatal: true, queued: false });
        continue;
      }
      const isVideo = mime.startsWith("video/");
      if (format === "reel" && !isVideo) {
        rows.push({ ...row, error: "A reel needs a video (MP4 or MOV).", fatal: true, queued: false });
        continue;
      }
      const max = isVideo ? CAMPAIGN_LIMITS.videoMaxBytes : CAMPAIGN_LIMITS.imageMaxBytes;
      if (f.size > max) {
        rows.push({ ...row, error: `Too large — ${isVideo ? "videos" : "images"} can be up to ${Math.round(max / 1048576)} MB`, fatal: true, queued: false });
        continue;
      }
      rows.push({ ...row, file: withMime(f, mime) });
    }
    if (rows.length) setUploads((l) => [...l, ...rows]); // the queue effect starts them
  };

  const startThumbUpload = (u: Uploading) => {
    const ctrl = new AbortController();
    ctrlsRef.current.set(u.key, ctrl);
    setThumbUpload({ ...u, error: null, fatal: false, queued: false, ctrl });
    let myId: string | null = u.resumeId; // see startUpload: clear only this run's entries
    const release = () => {
      if (ctrlsRef.current.get(u.key) === ctrl) ctrlsRef.current.delete(u.key);
      if (myId && idsRef.current.get(u.key) === myId) idsRef.current.delete(u.key);
    };
    uploadChunked(u.file, {
      resumeId: u.resumeId,
      signal: ctrl.signal,
      onId: (id) => {
        if (ctrl.signal.aborted) return void freeSlot(id);
        myId = id;
        idsRef.current.set(u.key, id);
        setThumbUpload((x) => (x && x.key === u.key ? { ...x, resumeId: id } : x));
      },
      onProgress: (p) => {
        if (!ctrl.signal.aborted) setThumbUpload((x) => (x && x.key === u.key ? { ...x, progress: p } : x));
      },
    })
      .then((done) => {
        if (ctrl.signal.aborted) return void freeSlot(done.id);
        release();
        ownIdsRef.current.add(done.id);
        dirtyRef.current = true;
        const old = thumbStateRef.current;
        if (old && old.id !== done.id) discardUnsaved(old.id);
        setThumbUpload(null);
        setThumb(asMedia({ ...done, role: "thumbnail" }));
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        if (ctrlsRef.current.get(u.key) === ctrl) ctrlsRef.current.delete(u.key);
        setThumbUpload((x) => (x && x.key === u.key ? { ...x, error: errMsg(e), fatal: isFatal(e) } : x));
      });
  };
  const discardThumbUpload = () => {
    if (!thumbUpload) return;
    ctrlsRef.current.get(thumbUpload.key)?.abort();
    ctrlsRef.current.delete(thumbUpload.key);
    const id = idsRef.current.get(thumbUpload.key) ?? thumbUpload.resumeId;
    if (id) freeSlot(id);
    idsRef.current.delete(thumbUpload.key);
    setThumbUpload(null);
  };
  const pickThumb = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    if (thumbUpload) discardThumbUpload();
    const key = `thumb-${f.name}-${f.size}-${f.lastModified}`;
    const row: Uploading = { key, name: f.name, progress: 0, file: f, resumeId: null, error: null, fatal: false, queued: false, ctrl: null };
    const mime = mimeOf(f);
    if (mime !== "image/jpeg" && mime !== "image/png") {
      setThumbUpload({ ...row, error: "Wrong type — the thumbnail must be a JPG or PNG image", fatal: true });
      return;
    }
    if (f.size > CAMPAIGN_LIMITS.imageMaxBytes) {
      setThumbUpload({ ...row, error: `Too large — images can be up to ${Math.round(CAMPAIGN_LIMITS.imageMaxBytes / 1048576)} MB`, fatal: true });
      return;
    }
    startThumbUpload({ ...row, file: withMime(f, mime) });
  };
  // A thumbnail is a cover for a video: it only applies to a single-video reel or post.
  const thumbApplies = format !== "carousel" && media.some((m) => m.kind === "video");

  const move = (i: number, d: -1 | 1) => {
    touch();
    setMedia((m) => {
      const j = i + d;
      if (j < 0 || j >= m.length) return m;
      const c = m.slice();
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  };

  const removeMedia = (m: CampaignMedia) => {
    touch();
    discardUnsaved(m.id);
    setMedia((x) => x.filter((y) => y.id !== m.id));
  };

  const save = async () => {
    setError(null);
    if (media.length === 0) return setError("Upload your video or image first.");
    if (format === "carousel" && media.length < CAMPAIGN_LIMITS.carouselMin) return setError("A carousel needs at least 2 files.");
    if (format === "reel" && media.some((m) => m.kind !== "video")) return setError("A reel needs a video (MP4 or MOV).");
    if (uploads.some((u) => !u.error) || (thumbApplies && thumbUpload && !thumbUpload.error)) return setError("Wait for the uploads to finish.");
    const withAudio = format === "reel" && audio;

    // Mirror the server's checks so a typo is caught here, next to its field.
    const tags = splitTags(hashtags);
    const ut = splitTags(userTags);
    const co = splitTags(collabs);
    const fe: FieldErrors = {};
    const badTag = tags.find((t) => !HASHTAG_RE.test(t));
    if (badTag) fe.hashtags = `"#${badTag}" isn't a valid hashtag — use letters, numbers and _ only`;
    const badUser = ut.find((h) => !HANDLE_RE.test(h));
    if (badUser) fe.userTags = handleMsg(badUser);
    else if (ut.length > CAMPAIGN_LIMITS.userTagsMax) fe.userTags = `Tag up to ${CAMPAIGN_LIMITS.userTagsMax} accounts`;
    const badCollab = co.find((h) => !HANDLE_RE.test(h));
    if (badCollab) fe.collabs = handleMsg(badCollab);
    else if (co.length > CAMPAIGN_LIMITS.collaboratorsMax) fe.collabs = `Add up to ${CAMPAIGN_LIMITS.collaboratorsMax} collaborators`;
    if (withAudio && audioTrack.trim().length < 2) fe.audioTrack = "Tell us which song to use, or untick 'Use a song in this reel'.";
    setFieldErrors(fe);
    const firstBad = fe.audioTrack ? "c-audio" : fe.hashtags ? "c-tags" : fe.userTags ? "c-users" : fe.collabs ? "c-collab" : null;
    if (firstBad) {
      // Each message is on its field (role=alert there); a second alert banner would read it twice.
      setError(null);
      // After the re-render (More options opens itself while it holds an error).
      requestAnimationFrame(() => document.getElementById(firstBad)?.focus());
      return;
    }

    setBusy(true);
    try {
      const c = await mutateJson<Campaign>(`/client/campaigns/${campaign.id}/creative`, "PUT", {
        format,
        mediaIds: media.map((m) => m.id),
        caption,
        hashtags: tags,
        userTags: ut,
        collaborators: co,
        superText: superText.trim() || null,
        superTextStyle: superText.trim() ? style : null,
        audioIntegration: withAudio,
        audioTrack: withAudio ? audioTrack.trim() : null,
        thumbnailMediaId: thumbApplies && thumb ? thumb.id : null,
      });
      writeUnsaved(unsavedKey, [], format);
      ownIdsRef.current.clear(); // everything shown is now the campaign's own, saved file
      dirtyRef.current = false;
      onSaved(c);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const aboutToPay = campaign.paymentMode !== "offline" && ["draft", "awaiting_payment"].includes(campaign.status);

  // "More options": closed on a fresh draft, open (and not closable) while it holds anything.
  const forced =
    !!hashtags.trim() ||
    !!userTags.trim() ||
    !!collabs.trim() ||
    (thumbApplies && (!!thumb || !!thumbUpload)) ||
    !!fieldErrors.hashtags ||
    !!fieldErrors.userTags ||
    !!fieldErrors.collabs;
  const open = forced || userOpen;

  // Will saving prepare the preview again? (A caption/hashtag/tag/song-only save keeps finished renders.)
  const rendered = campaign.media.some((m) => m.renderStatus === "done");
  const nextThumbId = thumbApplies && thumb ? thumb.id : null;
  const renderInputsChanged =
    format !== campaign.format ||
    superText.trim() !== (campaign.superText ?? "") ||
    (!!superText.trim() && style !== (campaign.superTextStyle ?? "bottom")) ||
    media.some((m) => !savedMediaIds.has(m.id)) ||
    (nextThumbId !== null && nextThumbId !== savedThumbId);

  const replaceFailed = (m: CampaignMedia) => {
    if (format === "carousel") removeMedia(m);
    fileRef.current?.click();
  };

  const replacing = format !== "carousel" && uploads.some((u) => !u.error);

  return (
    <div className="grid grid-cols-1 gap-4">
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
                  touch();
                  // A single-file format keeps the first file; unsaved files it drops are discarded
                  // (so a later restore cannot bring back a file the client removed).
                  if (f !== "carousel") {
                    for (const x of mediaRef.current.slice(1)) discardUnsaved(x.id);
                    // The carousel's queue must not keep uploading: each completion would replace
                    // the kept file. Keep one upload only when no file is kept yet — the furthest
                    // along, and for a reel only a video.
                    const fits = (u: Uploading) => !u.error && (f !== "reel" || u.file.type.startsWith("video/"));
                    const keep = mediaRef.current.length
                      ? null
                      : [...uploads].filter(fits).sort((a, b) => Number(a.queued) - Number(b.queued) || b.progress - a.progress)[0] ?? null;
                    for (const u of uploads) if (u !== keep) discardUpload(u);
                  }
                  formatRef.current = f;
                  setFormat(f);
                  if (f !== "carousel") setMedia((m) => m.slice(0, 1));
                  const now = readUnsaved(unsavedKey);
                  writeUnsaved(unsavedKey, now.ids, f);
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
      </Card>

      <Card
        title="Your video or image"
        sub={
          format === "carousel"
            ? `Upload ${CAMPAIGN_LIMITS.carouselMin}–${CAMPAIGN_LIMITS.carouselMax} images or videos, in the order they should appear.`
            : format === "reel"
              ? "Upload one video. MP4 or MOV."
              : "Upload one file. JPG, PNG, MP4 or MOV."
        }
        right={
          media.length + uploads.filter((u) => !u.fatal).length < maxFiles || format !== "carousel" ? (
            <Button size="sm" variant="default" type="button" disabled={replacing} icon={<Icon.Upload size={14} />} onClick={() => fileRef.current?.click()}>
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
            {media.map((m, i) => {
              const saved = savedMediaIds.has(m.id);
              return (
                <div key={m.id} className="min-w-0">
                  <MediaPreview media={m} renderPending={saved && (m.renderStatus === "queued" || m.renderStatus === "rendering")} />
                  <div className="mt-1.5 flex items-center gap-1 text-[12px] text-ink-2">
                    <span className="truncate flex-1" title={m.originalName}>{format === "carousel" ? `${i + 1}. ` : ""}{m.originalName}</span>
                    {format === "carousel" && (
                      <>
                        <button type="button" aria-label="Move earlier" className="p-1 hover:text-ink disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)}><Icon.ChevLeft size={14} /></button>
                        <button type="button" aria-label="Move later" className="p-1 hover:text-ink disabled:opacity-30" disabled={i === media.length - 1} onClick={() => move(i, 1)}><Icon.ChevRight size={14} /></button>
                      </>
                    )}
                    <button type="button" aria-label={`Remove ${m.originalName}`} className="p-1 hover:text-danger" onClick={() => removeMedia(m)}><Icon.Close size={14} /></button>
                  </div>
                  {!saved && <div className="text-[11.5px] text-attention">Not saved yet — save this step to keep it</div>}
                  {saved && m.renderStatus === "failed" && <RenderFailedActions busy={busy} onRetry={save} onReplace={() => replaceFailed(m)} />}
                </div>
              );
            })}
            {uploads.map((u) => (
              <UploadRow key={u.key} u={u} onRetry={() => setUploads((l) => l.map((x) => (x.key === u.key ? { ...x, error: null, fatal: false, queued: true } : x)))} onDiscard={() => discardUpload(u)} />
            ))}
          </div>
        )}
      </Card>

      {format === "reel" && (
        <Card title="Add a song (optional)" sub="Reels only. We set the song you choose as the reel's audio. Each account charges extra for this.">
          <label className="flex items-center gap-2.5 text-[13.5px] font-semibold text-ink cursor-pointer">
            <input
              type="checkbox"
              checked={audio}
              disabled={termsLocked}
              onChange={(e) => {
                touch();
                setAudio(e.target.checked);
                setFieldErrors((f) => ({ ...f, audioTrack: undefined }));
              }}
              className="h-4 w-4 accent-[#403cfa]"
            />
            Use a song in this reel
          </label>
          {audio && (
            <div className="mt-3">
              <Field label="Song" htmlFor="c-audio" hint="Song name and artist, or a link to it on Instagram, Spotify or YouTube" error={fieldErrors.audioTrack ?? null}>
                <input
                  id="c-audio"
                  className={inputCls}
                  value={audioTrack}
                  maxLength={300}
                  onChange={(e) => {
                    touch();
                    setAudioTrack(e.target.value);
                    setFieldErrors((f) => ({ ...f, audioTrack: undefined }));
                  }}
                  placeholder="Song name – artist, or a link"
                />
              </Field>
              <p className="text-[12px] text-ink-3 mt-2">Accounts that don&apos;t offer songs are left out of the list.</p>
            </div>
          )}
        </Card>
      )}

      <Card title="Printed text" sub="Text we print on top of your image or video, exactly as you type it. Leave empty for none. You can give any single account its own text (or none) at the review step.">
        <div className="grid grid-cols-1 gap-3">
          <Field label="Printed text" htmlFor="c-super" hint={`${superText.length}/${CAMPAIGN_LIMITS.superTextMax} · up to 3 lines`} error={superText.length > CAMPAIGN_LIMITS.superTextMax || superLines > 3 ? "Keep it to 120 characters and 3 lines" : null}>
            <textarea
              id="c-super"
              className={textareaCls}
              rows={3}
              value={superText}
              onChange={(e) => {
                touch();
                setSuperText(e.target.value);
              }}
              placeholder={"FLAT 50% OFF\nToday only"}
            />
          </Field>
          {superText.trim() && (
            <fieldset>
              <legend className="block text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-1.5">Position</legend>
              <div className="flex flex-wrap gap-2">
                {(["top", "center", "bottom"] as const).map((s) => (
                  <label key={s} className={`flex items-center gap-2 h-9 px-3 rounded-xl border-2 cursor-pointer text-[13px] font-semibold ${style === s ? "border-indigo" : "border-ink/15"}`}>
                    <input
                      type="radio"
                      name="superstyle"
                      value={s}
                      checked={style === s}
                      onChange={() => {
                        touch();
                        setStyle(s);
                      }}
                      className="accent-[#403cfa]"
                    />
                    {s[0].toUpperCase() + s.slice(1)}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </div>
        <p className="text-[12px] text-ink-3 mt-2">
          After you save, we prepare a preview with the text in place — check it before you {aboutToPay ? "pay" : "send the campaign for review"}.
        </p>
      </Card>

      <Card title="Caption" sub={format === "story" ? "Stories don't show captions or tags on Instagram — they are used on Facebook only." : undefined}>
        <Field
          label="Caption"
          htmlFor="c-caption"
          hint={`${caption.length}/${CAMPAIGN_LIMITS.captionMax} characters · ${tagCount}/${CAMPAIGN_LIMITS.hashtagsMax} hashtags · ${mentionCount}/${CAMPAIGN_LIMITS.mentionsMax} mentions · Hashtags can go straight in the caption`}
          error={caption.length > CAMPAIGN_LIMITS.captionMax || tagCount > CAMPAIGN_LIMITS.hashtagsMax || mentionCount > CAMPAIGN_LIMITS.mentionsMax ? "Instagram allows 2,200 characters, 30 hashtags and 20 @mentions" : null}
        >
          <textarea
            id="c-caption"
            className={textareaCls}
            rows={5}
            value={caption}
            onChange={(e) => {
              touch();
              setCaption(e.target.value);
            }}
            placeholder="Write the caption that goes with the post…"
          />
        </Field>
      </Card>

      <Card
        title="More options (optional)"
        sub={`Hashtags · tagged accounts · collaborators${thumbApplies ? " · cover image" : ""}`}
        right={
          forced ? undefined : (
            <Button size="sm" variant="ghost" type="button" aria-label={open ? "Hide more options" : "Show more options"} aria-expanded={open} aria-controls="creative-more" onClick={() => setUserOpen((o) => !o)}>
              {open ? "Hide" : "Show"}
            </Button>
          )
        }
      >
        <div id="creative-more" hidden={!open}>
          <div className="grid grid-cols-1 gap-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Hashtags" htmlFor="c-tags" hint="Separate with spaces" error={fieldErrors.hashtags ?? null}>
                <input
                  id="c-tags"
                  className={inputCls}
                  value={hashtags}
                  onChange={(e) => {
                    touch();
                    setHashtags(e.target.value);
                    setFieldErrors((f) => ({ ...f, hashtags: undefined }));
                  }}
                  placeholder="#diwali #sale"
                />
              </Field>
              <Field label="Tag accounts" htmlFor="c-users" hint="Instagram usernames" error={fieldErrors.userTags ?? null}>
                <input
                  id="c-users"
                  className={inputCls}
                  value={userTags}
                  onChange={(e) => {
                    touch();
                    setUserTags(e.target.value);
                    setFieldErrors((f) => ({ ...f, userTags: undefined }));
                  }}
                  placeholder="@yourbrand"
                />
              </Field>
              <Field label="Collaborators" htmlFor="c-collab" hint="Up to 3 · they accept on Instagram" error={fieldErrors.collabs ?? null}>
                <input
                  id="c-collab"
                  className={inputCls}
                  value={collabs}
                  onChange={(e) => {
                    touch();
                    setCollabs(e.target.value);
                    setFieldErrors((f) => ({ ...f, collabs: undefined }));
                  }}
                  placeholder="@yourbrand"
                />
              </Field>
            </div>

            {thumbApplies && (
              <div>
                <div className="flex items-start gap-3 mb-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[13px] font-bold text-ink">Thumbnail</h3>
                    <p className="text-[12.5px] text-ink-3 mt-0.5">Optional. Your own cover image for the video (JPG or PNG). Leave it out and the platform picks a frame.</p>
                  </div>
                  {!thumbUpload && (
                    <Button size="sm" variant="default" type="button" icon={<Icon.Upload size={14} />} onClick={() => thumbRef.current?.click()}>
                      {thumb ? "Replace" : "Upload"}
                    </Button>
                  )}
                </div>
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
                        <MediaPreview media={thumb} renderPending={savedThumbId === thumb.id && (thumb.renderStatus === "queued" || thumb.renderStatus === "rendering")} />
                        <div className="mt-1.5 flex items-center gap-1 text-[12px] text-ink-2">
                          <span className="truncate flex-1" title={thumb.originalName}>{thumb.originalName}</span>
                          <button
                            type="button"
                            aria-label="Remove thumbnail"
                            className="p-1 hover:text-danger"
                            onClick={() => {
                              touch();
                              discardUnsaved(thumb.id);
                              setThumb(null);
                            }}
                          >
                            <Icon.Close size={14} />
                          </button>
                        </div>
                        {savedThumbId !== thumb.id && <div className="text-[11.5px] text-attention">Not saved yet — save this step to keep it</div>}
                        {savedThumbId === thumb.id && thumb.renderStatus === "failed" && (
                          <RenderFailedActions busy={busy} onRetry={save} onReplace={() => thumbRef.current?.click()} />
                        )}
                      </div>
                    )}
                    {thumbUpload && <UploadRow u={thumbUpload} onRetry={() => startThumbUpload(thumbUpload)} onDiscard={discardThumbUpload} />}
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
                    <span className="text-[12px]">Vertical works best for reels · the printed text is added to it too</span>
                  </button>
                )}
                <p className="text-[12px] text-ink-3 mt-3">Instagram takes the thumbnail automatically. On Facebook our team sets it when posting.</p>
              </div>
            )}
          </div>
        </div>
      </Card>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {/* A quiet pointer that disappears with the last field error (the fields carry the alerts). */}
      {Object.values(fieldErrors).some(Boolean) && <p className="text-[12.5px] text-danger font-medium">Fix the highlighted fields.</p>}
      {rendered && renderInputsChanged && (
        <p className="text-[12.5px] text-ink-3">Saving prepares your preview again — a minute or two for videos.</p>
      )}
      <div className="flex justify-end">
        <Button variant="ink" type="button" onClick={save} disabled={busy} aria-live="polite" iconRight={<Icon.ArrowRight size={15} />}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
    </div>
  );
}
