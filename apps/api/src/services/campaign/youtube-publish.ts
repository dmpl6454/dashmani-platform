import fsp from "fs/promises";
import { prisma } from "@dashmani/db";
import { todayIST } from "@dashmani/shared";
import { campaignConfig } from "./config";
import { renderPath } from "./media.service";
import { forgetAccessToken, getAccessToken, YoutubeReauthError } from "./youtube.service";

// Phase 3 — one step of a YouTube upload (resumable protocol), called by publish.service.
//
// ⚠️ NEVER POST TWICE. The resumable session URL is saved as the item's containerId
// ("yt:<url>") BEFORE a single byte is sent, and every later step asks that session how far it
// got (PUT, Content-Range bytes */size) instead of starting again. Only a session YouTube says
// is gone (404/410) is replaced; a video is created only when its last byte arrives, so a dead
// session never left a video behind.
//
// Each step sends at most one CHUNK (32 MiB) so it ends well inside publish.service's 10-minute
// lock; the worker comes back for the next chunk two seconds later.

export const YT_CHUNK_BYTES = 32 * 1024 * 1024; // a multiple of 256 KiB, as the protocol requires
const INIT_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const THUMB_URL = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const CHUNK_TIMEOUT_MS = 5 * 60_000;
const PREFIX = "yt:";

export type YtOutcome =
  | { kind: "published"; remotePostId: string; permalink: string; note?: string }
  | { kind: "wait"; delayMs: number; containerId: string | null }
  | { kind: "retry"; error: string; containerId: string | null; delayMs?: number }
  | { kind: "manual"; reason: string; remotePostId?: string; permalink?: string };

export interface YtJob {
  itemId: string;
  connectionId: string;
  format: string; // reel (Short) | post (video)
  containerId: string | null;
  title: string;
  description: string;
  /** The rendered video on disk, and an optional rendered thumbnail (posts only). */
  file: { path: string; size: number };
  thumbnail: { path: string } | null;
}

// ── Metadata ────────────────────────────────────────────────────────────────────

const clean = (s: string) => s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();

/** Title: the caption's first line without hashtags, ≤100 chars; else the booking's name. */
export function youtubeTitle(caption: string, fallback: string): string {
  const first = (caption ?? "").split("\n").map((l) => clean(l.replace(/#[\p{L}\p{N}_]+/gu, ""))).find(Boolean) ?? "";
  const t = first || clean(fallback) || "Video";
  return t.length > 100 ? `${t.slice(0, 99).trimEnd()}…` : t;
}

/** Description: the full posted caption; a Short carries #Shorts. ≤5000 chars, no angle brackets. */
export function youtubeDescription(text: string, format: string): string {
  let d = (text ?? "").replace(/[<>]/g, "");
  if (format === "reel" && !/#shorts\b/i.test(d)) d = d ? `${d}\n\n#Shorts` : "#Shorts";
  return d.slice(0, 5000);
}

export function youtubePermalink(videoId: string, format: string): string {
  return format === "reel" ? `https://www.youtube.com/shorts/${videoId}` : `https://youtu.be/${videoId}`;
}

// ── Daily cap ───────────────────────────────────────────────────────────────────

/** Uploads begun today (IST): finished ones plus sessions in flight, other than this item's. */
export async function uploadsToday(exceptItemId: string): Promise<number> {
  // The real instant IST midnight began (postedAt is a timestamp). istMidnight() is for DATE
  // columns — it returns UTC midnight and would miss uploads made 00:00–05:30 IST.
  const since = new Date(`${todayIST()}T00:00:00+05:30`);
  const [done, inFlight] = await Promise.all([
    prisma.campaignBookingItem.count({ where: { platform: "youtube", remotePostId: { not: null }, postedAt: { gte: since }, id: { not: exceptItemId } } }),
    prisma.campaignBookingItem.count({ where: { platform: "youtube", status: "queued", containerId: { startsWith: PREFIX }, id: { not: exceptItemId } } }),
  ]);
  return done + inFlight;
}

// ── Google calls ────────────────────────────────────────────────────────────────

interface GoogleError {
  status: number;
  reason: string | null;
  message: string;
}

async function googleError(res: Response): Promise<GoogleError> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
  return { status: res.status, reason: body.error?.errors?.[0]?.reason ?? null, message: (body.error?.message ?? `HTTP ${res.status}`).slice(0, 300) };
}

function mapError(e: GoogleError, what: string, containerId: string | null): YtOutcome {
  if (e.status === 403 && (e.reason === "quotaExceeded" || e.reason === "rateLimitExceeded" || e.reason === "userRateLimitExceeded")) {
    return { kind: "retry", error: `YouTube quota/rate limit (${what})`, containerId, delayMs: 60 * 60_000 };
  }
  if (e.status === 403 || e.status === 400) {
    return { kind: "manual", reason: `YouTube refused the upload (${what}): ${e.message} — post it by hand.` };
  }
  return { kind: "retry", error: `${what}: ${e.message}`, containerId };
}

interface Video {
  id?: string;
  status?: { privacyStatus?: string; uploadStatus?: string; rejectionReason?: string };
}

/** Run `call` with a fresh access token; on a 401 drop the cached token and try once more. */
async function withToken(connectionId: string, call: (token: string) => Promise<Response>): Promise<Response> {
  let res = await call(await getAccessToken(connectionId));
  if (res.status === 401) {
    forgetAccessToken(connectionId);
    res = await call(await getAccessToken(connectionId));
  }
  return res;
}

async function readChunk(path: string, start: number, length: number): Promise<Buffer> {
  const fh = await fsp.open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function finished(job: YtJob, video: Video, connectionId: string): Promise<YtOutcome> {
  if (!video.id) return { kind: "manual", reason: "YouTube finished the upload but returned no video id — check YouTube Studio and paste the link." };
  const permalink = youtubePermalink(video.id, job.format);
  if (video.status?.uploadStatus === "rejected" || video.status?.uploadStatus === "failed") {
    return { kind: "manual", reason: `YouTube rejected the video (${video.status.rejectionReason ?? video.status.uploadStatus}) — ${permalink}`, remotePostId: video.id };
  }
  const wanted = campaignConfig.youtubePrivacy();
  if (video.status?.privacyStatus && video.status.privacyStatus !== wanted) {
    return {
      kind: "manual",
      reason: `YouTube kept the video ${video.status.privacyStatus} — the Google project needs YouTube's API audit. Make it ${wanted} in YouTube Studio, then paste the link: ${permalink}`,
      remotePostId: video.id,
      permalink,
    };
  }
  let note: string | undefined;
  if (job.thumbnail && job.format === "post") {
    // Best effort: a channel needs phone verification for custom thumbnails. Never fails the post.
    try {
      const img = await fsp.readFile(job.thumbnail.path);
      const r = await withToken(connectionId, (token) =>
        fetch(`${THUMB_URL}?videoId=${encodeURIComponent(video.id!)}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "image/jpeg", "content-length": String(img.length) },
          body: img,
          signal: AbortSignal.timeout(60_000),
        }),
      );
      if (!r.ok) note = `The client's thumbnail could not be set on YouTube (${(await googleError(r)).message}) — set it in YouTube Studio.`;
    } catch (err) {
      note = `The client's thumbnail could not be set on YouTube (${err instanceof Error ? err.message : String(err)}) — set it in YouTube Studio.`;
    }
  }
  return { kind: "published", remotePostId: video.id, permalink, note };
}

// ── One step ────────────────────────────────────────────────────────────────────

export async function ytStep(job: YtJob): Promise<YtOutcome> {
  try {
    if (!job.containerId?.startsWith(PREFIX)) {
      if ((await uploadsToday(job.itemId)) >= campaignConfig.youtubeDailyUploads()) {
        return { kind: "wait", delayMs: 60 * 60_000, containerId: null };
      }
      const meta = {
        snippet: { title: job.title, description: job.description, categoryId: "24" },
        status: { privacyStatus: campaignConfig.youtubePrivacy(), selfDeclaredMadeForKids: false },
      };
      const res = await withToken(job.connectionId, (token) =>
        fetch(INIT_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=UTF-8",
            "x-upload-content-length": String(job.file.size),
            "x-upload-content-type": "video/mp4",
          },
          body: JSON.stringify(meta),
          signal: AbortSignal.timeout(30_000),
        }),
      );
      const location = res.headers.get("location");
      // No session = nothing uploaded; an unanswered init is safe to repeat.
      if (!res.ok || !location) return res.ok ? { kind: "retry", error: "YouTube opened no upload session", containerId: null } : mapError(await googleError(res), "start upload", null);
      return { kind: "wait", delayMs: 1_000, containerId: `${PREFIX}${location}` };
    }

    const session = job.containerId.slice(PREFIX.length);
    // Where is the session? 200/201 = finished (an earlier last chunk's answer was lost).
    const probe = await withToken(job.connectionId, (token) =>
      fetch(session, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-range": `bytes */${job.file.size}`, "content-length": "0" },
        signal: AbortSignal.timeout(30_000),
      }),
    );
    if (probe.status === 200 || probe.status === 201) return finished(job, (await probe.json().catch(() => ({}))) as Video, job.connectionId);
    if (probe.status === 404 || probe.status === 410) {
      // The session expired (they last about a week) or was cancelled. No video exists from it.
      return { kind: "retry", error: "The YouTube upload session expired — starting a new one.", containerId: null, delayMs: 5_000 };
    }
    if (probe.status !== 308) return mapError(await googleError(probe), "upload status", job.containerId);

    const range = probe.headers.get("range"); // "bytes=0-1234567" — absent when nothing arrived
    const offset = range ? Number(range.split("-")[1]) + 1 : 0;
    if (!Number.isFinite(offset) || offset < 0 || offset > job.file.size) {
      return { kind: "retry", error: `YouTube reported an unexpected upload offset (${range})`, containerId: job.containerId };
    }
    const length = Math.min(YT_CHUNK_BYTES, job.file.size - offset);
    const chunk = await readChunk(job.file.path, offset, length);
    const end = offset + chunk.length - 1;
    const put = await withToken(job.connectionId, (token) =>
      fetch(session, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "video/mp4",
          "content-length": String(chunk.length),
          "content-range": `bytes ${offset}-${end}/${job.file.size}`,
        },
        body: chunk,
        signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
      }),
    );
    if (put.status === 200 || put.status === 201) return finished(job, (await put.json().catch(() => ({}))) as Video, job.connectionId);
    if (put.status === 308) return { kind: "wait", delayMs: 2_000, containerId: job.containerId };
    if (put.status === 404 || put.status === 410) return { kind: "retry", error: "The YouTube upload session expired — starting a new one.", containerId: null, delayMs: 5_000 };
    // 5xx: the session survives; the next step asks it for the offset and resumes.
    return mapError(await googleError(put), "upload chunk", job.containerId);
  } catch (err) {
    if (err instanceof YoutubeReauthError) {
      return { kind: "manual", reason: `${err.message} (Campaigns → YouTube). Then use "Publish now" or post it by hand.` };
    }
    // Network error / timeout: the session (if any) survives; the next step resumes from its offset.
    return { kind: "retry", error: err instanceof Error ? err.message : String(err), containerId: job.containerId };
  }
}

/** The rendered file an item uploads: its own render variant when it has one, else the default render. */
export async function renderedFile(f: { mediaId: string; renderId: string | null; kind: string }): Promise<{ path: string; size: number } | null> {
  let key: string | null = null;
  if (f.renderId) {
    key = (await prisma.campaignMediaRender.findUnique({ where: { id: f.renderId }, select: { renderKey: true } }))?.renderKey ?? null;
  } else {
    key = (await prisma.campaignMedia.findUnique({ where: { id: f.mediaId }, select: { renderKey: true } }))?.renderKey ?? null;
  }
  const p = renderPath({ renderKey: key, kind: f.kind });
  if (!p) return null;
  try {
    const st = await fsp.stat(p);
    return st.size > 0 ? { path: p, size: st.size } : null;
  } catch {
    return null;
  }
}
