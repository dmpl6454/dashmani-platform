import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import { prisma } from "@dashmani/db";
import {
  CAMPAIGN_LIMITS,
  CAMPAIGN_UPLOAD_CHUNK_BYTES,
  CAMPAIGN_UPLOAD_MIME,
  type CampaignUploadInitInput,
} from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { campaignConfig, mediaSubdirs } from "./config";

// Chunked, resumable uploads of campaign creatives to the server's disk.
//
// init → PUT chunk n (any order, re-sendable) → GET status (resume) → complete
//
// ⚠️ Safety rules:
//  • The declared MIME type only decides the size limit. On complete the real type is sniffed
//    from the file's magic bytes and ffprobe'd; anything that isn't a JPEG/PNG/MP4/MOV is
//    rejected and deleted.
//  • File names on disk come from a 256-bit random key, never from the client.
//  • Nothing is written under /uploads (public). See config.ts.
//  • Disk guard: refuse new uploads (507) when free space is low, so a burst of 500 MB videos
//    can never fill the disk the database lives on.

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export function kindOfMime(mime: string): "image" | "video" | null {
  const m = mime.toLowerCase();
  if ((CAMPAIGN_UPLOAD_MIME.image as readonly string[]).includes(m)) return "image";
  if ((CAMPAIGN_UPLOAD_MIME.video as readonly string[]).includes(m)) return "video";
  return null;
}

/** Max video length (seconds) for a format, or null for no extra limit (images). */
export function durationLimitSec(format: string, kind: string): number | null {
  if (kind !== "video") return null;
  if (format === "reel") return CAMPAIGN_LIMITS.reelMaxSec;
  if (format === "story") return CAMPAIGN_LIMITS.storyMaxSec;
  if (format === "carousel") return CAMPAIGN_LIMITS.carouselVideoMaxSec;
  return CAMPAIGN_LIMITS.postVideoMaxSec;
}

export async function ensureMediaDirs() {
  for (const d of [mediaSubdirs.tmp(), mediaSubdirs.orig(), mediaSubdirs.render()]) {
    await fsp.mkdir(d, { recursive: true, mode: 0o700 });
  }
}

export const chunkPath = (key: string, n: number) => path.join(mediaSubdirs.tmp(), `${key}.${n}.part`);
export const origPath = (m: { storageKey: string; ext: string }) => path.join(mediaSubdirs.orig(), `${m.storageKey}.${m.ext}`);
export const renderPath = (m: { renderKey: string | null; kind: string }) =>
  m.renderKey ? path.join(mediaSubdirs.render(), `${m.renderKey}.${m.kind === "video" ? "mp4" : "jpg"}`) : null;

/** Pure: may an upload of `size` bytes start, given the free space? */
export function diskAllows(freeBytes: number, size: number, minFreeBytes: number): boolean {
  // 2.2×: the chunks and the assembled file coexist briefly, plus a render of similar size.
  return freeBytes - size * 2.2 >= minFreeBytes;
}

async function freeBytes(): Promise<number> {
  await ensureMediaDirs();
  const s = await fsp.statfs(mediaSubdirs.tmp());
  return Number(s.bavail) * Number(s.bsize);
}

function expectedChunkBytes(size: number, chunkSize: number, totalChunks: number, n: number) {
  return n < totalChunks - 1 ? chunkSize : size - chunkSize * (totalChunks - 1);
}

const uploadSelect = {
  id: true,
  kind: true,
  originalName: true,
  bytes: true,
  uploadStatus: true,
  rejectReason: true,
  chunkSize: true,
  totalChunks: true,
  mime: true,
  durationMs: true,
  width: true,
  height: true,
} as const;

function shapeUpload(m: any, receivedChunks?: number[]) {
  return { ...m, bytes: Number(m.bytes), ...(receivedChunks ? { receivedChunks } : {}) };
}

export async function initUpload(clientId: string, input: CampaignUploadInitInput) {
  const kind = kindOfMime(input.mime);
  if (!kind) throw new AppError(400, "UNSUPPORTED_TYPE", "Upload a JPG or PNG image, or an MP4 or MOV video.");
  const max = kind === "video" ? CAMPAIGN_LIMITS.videoMaxBytes : CAMPAIGN_LIMITS.imageMaxBytes;
  if (input.size > max) {
    throw new AppError(413, "TOO_LARGE", `${kind === "video" ? "Videos" : "Images"} can be at most ${Math.round(max / 1024 / 1024)} MB.`);
  }

  const [active, inFlight] = await Promise.all([
    prisma.campaignMedia.aggregate({
      where: { clientId, purgedAt: null, uploadStatus: { in: ["uploading", "complete"] } },
      _sum: { bytes: true },
    }),
    prisma.campaignMedia.count({ where: { clientId, uploadStatus: "uploading", purgedAt: null } }),
  ]);
  if (inFlight >= campaignConfig.maxUploadsInFlight()) {
    throw new AppError(429, "TOO_MANY_UPLOADS", "Finish your current uploads before starting another.");
  }
  if (Number(active._sum.bytes ?? 0) + input.size > campaignConfig.clientQuotaBytes()) {
    throw new AppError(413, "QUOTA", "You've reached your storage limit. Remove unused files or finish a campaign first.");
  }
  if (!diskAllows(await freeBytes(), input.size, campaignConfig.minFreeBytes())) {
    throw new AppError(507, "STORAGE_FULL", "Uploads are paused for a moment. Please try again later.");
  }

  const totalChunks = Math.max(1, Math.ceil(input.size / CAMPAIGN_UPLOAD_CHUNK_BYTES));
  const m = await prisma.campaignMedia.create({
    data: {
      clientId,
      kind,
      originalName: input.filename,
      bytes: BigInt(input.size),
      storageKey: crypto.randomBytes(32).toString("base64url"),
      ext: MIME_EXT[input.mime.toLowerCase()],
      chunkSize: CAMPAIGN_UPLOAD_CHUNK_BYTES,
      totalChunks,
    },
    select: uploadSelect,
  });
  return shapeUpload(m, []);
}

async function ownedUpload(clientId: string, id: string) {
  const m = await prisma.campaignMedia.findFirst({ where: { id, clientId, purgedAt: null } });
  if (!m) throw new AppError(404, "NOT_FOUND", "Upload not found");
  return m;
}

async function receivedChunks(m: { storageKey: string; totalChunks: number; chunkSize: number; bytes: bigint }) {
  const got: number[] = [];
  for (let n = 0; n < m.totalChunks; n++) {
    try {
      const st = await fsp.stat(chunkPath(m.storageKey, n));
      if (st.size === expectedChunkBytes(Number(m.bytes), m.chunkSize, m.totalChunks, n)) got.push(n);
    } catch {
      /* missing */
    }
  }
  return got;
}

export async function uploadStatus(clientId: string, id: string) {
  const m = await ownedUpload(clientId, id);
  const got = m.uploadStatus === "uploading" ? await receivedChunks(m) : [];
  const picked = Object.fromEntries(Object.keys(uploadSelect).map((k) => [k, (m as any)[k]]));
  return shapeUpload(picked, got);
}

/**
 * Stream one chunk to disk. Re-sending a chunk overwrites it (that is how a client retries).
 * The body is counted while it streams: more bytes than this chunk should hold → 413 and the
 * partial file is discarded; fewer → 400.
 */
export async function putChunk(clientId: string, id: string, n: number, body: Readable) {
  const m = await ownedUpload(clientId, id);
  if (m.uploadStatus !== "uploading") throw new AppError(409, "UPLOAD_CLOSED", "This upload is already finished.");
  if (!Number.isInteger(n) || n < 0 || n >= m.totalChunks) throw new AppError(400, "BAD_CHUNK", "Invalid chunk number");
  const expected = expectedChunkBytes(Number(m.bytes), m.chunkSize, m.totalChunks, n);

  await ensureMediaDirs();
  const final = chunkPath(m.storageKey, n);
  const tmp = `${final}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > expected) return cb(new AppError(413, "CHUNK_TOO_LARGE", "Chunk is larger than expected"));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(body, counter, fs.createWriteStream(tmp, { mode: 0o600 }));
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    if (err instanceof AppError) throw err;
    throw new AppError(400, "CHUNK_INTERRUPTED", "The chunk upload was interrupted. Retry it.");
  }
  if (seen !== expected) {
    await fsp.rm(tmp, { force: true });
    throw new AppError(400, "CHUNK_SIZE", `Chunk ${n} should be ${expected} bytes, got ${seen}.`);
  }
  await fsp.rename(tmp, final);
  return { chunk: n, bytes: seen };
}

// ── Completion: assemble, sniff, probe ──────────────────────────────────────────

/** Real type from the file's first bytes. Only the four formats we accept are recognised. */
export function sniffMime(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 12 && head.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = head.subarray(8, 12).toString("latin1");
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  return null;
}

export interface ProbeResult {
  hasVideo: boolean;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/** Pure parse of `ffprobe -print_format json -show_streams -show_format` output. */
export function parseProbe(json: string): ProbeResult {
  const data = JSON.parse(json);
  const streams: any[] = Array.isArray(data?.streams) ? data.streams : [];
  const v = streams.find((s) => s.codec_type === "video");
  let width = v?.width ? Number(v.width) : null;
  let height = v?.height ? Number(v.height) : null;
  // Phone videos are often stored landscape with a 90° rotation flag.
  const rot = Number(v?.tags?.rotate ?? v?.side_data_list?.find((d: any) => d.rotation != null)?.rotation ?? 0);
  if (width && height && Math.abs(rot) % 180 === 90) [width, height] = [height, width];
  const dur = Number(data?.format?.duration ?? v?.duration);
  return { hasVideo: Boolean(v), width, height, durationMs: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : null };
}

export function ffprobe(file: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(parseProbe(stdout));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

/** Overridable in tests (no ffprobe on a CI runner is fine). */
export const mediaTools = { probe: ffprobe };

async function reject(id: string, file: string | null, reason: string): Promise<never> {
  if (file) await fsp.rm(file, { force: true });
  await prisma.campaignMedia.update({ where: { id }, data: { uploadStatus: "rejected", rejectReason: reason.slice(0, 300) } });
  throw new AppError(400, "FILE_REJECTED", reason);
}

export async function completeUpload(clientId: string, id: string) {
  const m = await ownedUpload(clientId, id);
  if (m.uploadStatus === "complete") return uploadStatus(clientId, id);
  if (m.uploadStatus !== "uploading") throw new AppError(409, "UPLOAD_CLOSED", "This upload was rejected. Upload the file again.");

  // Claim: a double-clicked "complete" must not assemble twice.
  const claim = await prisma.campaignMedia.updateMany({
    where: { id, uploadStatus: "uploading", renderStatus: "none" },
    data: { renderStatus: "assembling" },
  });
  if (claim.count !== 1) throw new AppError(409, "UPLOAD_BUSY", "This upload is already being finished.");

  const release = () => prisma.campaignMedia.update({ where: { id }, data: { renderStatus: "none" } });
  const got = await receivedChunks(m);
  if (got.length !== m.totalChunks) {
    await release();
    const missing = [...Array(m.totalChunks).keys()].filter((n) => !got.includes(n));
    throw new AppError(400, "CHUNKS_MISSING", "Some parts of the file are missing.", missing.slice(0, 50).map((n) => ({ field: `chunk.${n}`, message: "missing" })));
  }

  const dest = origPath(m);
  const tmp = `${dest}.assembling`;
  try {
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    for (let n = 0; n < m.totalChunks; n++) {
      await pipeline(fs.createReadStream(chunkPath(m.storageKey, n)), out, { end: false });
    }
    await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    await release();
    throw err;
  }
  for (let n = 0; n < m.totalChunks; n++) await fsp.rm(chunkPath(m.storageKey, n), { force: true });
  await prisma.campaignMedia.update({ where: { id }, data: { renderStatus: "none" } });

  const fh = await fsp.open(dest, "r");
  const head = Buffer.alloc(16);
  await fh.read(head, 0, 16, 0);
  await fh.close();
  const real = sniffMime(head);
  const realKind = real ? kindOfMime(real) : null;
  if (!real || realKind !== m.kind) return reject(id, dest, "This file isn't a supported image or video (JPG, PNG, MP4 or MOV).");

  let probe: ProbeResult;
  try {
    probe = await mediaTools.probe(dest);
  } catch {
    return reject(id, dest, "We couldn't read this file. Export it again and re-upload.");
  }
  if (!probe.width || !probe.height) return reject(id, dest, "We couldn't read the dimensions of this file.");
  if (Math.min(probe.width, probe.height) < 320) return reject(id, dest, "The file is too small — use at least 320 px on the short side.");
  if (m.kind === "video") {
    if (!probe.hasVideo || !probe.durationMs) return reject(id, dest, "This video has no playable picture.");
    if (probe.durationMs > CAMPAIGN_LIMITS.postVideoMaxSec * 1000) {
      return reject(id, dest, `Videos can be at most ${CAMPAIGN_LIMITS.postVideoMaxSec / 60} minutes.`);
    }
  }

  await prisma.campaignMedia.update({
    where: { id },
    data: {
      uploadStatus: "complete",
      mime: real,
      ext: MIME_EXT[real],
      width: probe.width,
      height: probe.height,
      durationMs: m.kind === "video" ? probe.durationMs : null,
    },
  });
  if (MIME_EXT[real] !== m.ext) await fsp.rename(dest, origPath({ storageKey: m.storageKey, ext: MIME_EXT[real] }));
  return uploadStatus(clientId, id);
}

/** Delete an upload that isn't part of a paid campaign. */
export async function deleteUpload(clientId: string, id: string) {
  const m = await ownedUpload(clientId, id);
  if (m.bookingId) {
    const b = await prisma.campaignBooking.findUnique({ where: { id: m.bookingId }, select: { status: true } });
    if (b && !["draft", "awaiting_payment", "changes_requested", "cancelled", "expired"].includes(b.status)) {
      throw new AppError(409, "MEDIA_IN_USE", "This file belongs to a booked campaign and can't be removed.");
    }
  }
  await purgeMediaFiles(m);
  await prisma.campaignMedia.update({ where: { id }, data: { purgedAt: new Date(), bookingId: null } });
  return { deleted: true };
}

/** Remove every file a media row owns (chunks, original, render). Idempotent. */
export async function purgeMediaFiles(m: { storageKey: string; ext: string; totalChunks: number; renderKey: string | null; kind: string }) {
  for (let n = 0; n < m.totalChunks; n++) await fsp.rm(chunkPath(m.storageKey, n), { force: true });
  await fsp.rm(origPath(m), { force: true });
  await fsp.rm(`${origPath(m)}.assembling`, { force: true });
  const r = renderPath(m);
  if (r) await fsp.rm(r, { force: true });
}

/** Resolve a media row to the file to show: the render when ready, else the original. */
export function previewFile(m: { storageKey: string; ext: string; renderKey: string | null; renderStatus: string; kind: string }) {
  const r = m.renderStatus === "done" ? renderPath(m) : null;
  return r ?? origPath(m);
}
