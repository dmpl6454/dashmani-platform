import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { prisma } from "@dashmani/db";
import { campaignConfig, mediaSubdirs } from "./config";
import { ensureMediaDirs, origPath, renderPath } from "./media.service";

// Burns the client's overlay ("super text") into their media and normalises it for the format
// (9:16 for reels and stories, ≤1080 px wide for posts). One file at a time, at low priority,
// so the 1-vCPU box keeps serving the portals.
//
// Two kinds of job share the worker: the DEFAULT render of each file (the booking's overlay,
// tracked on campaign_media.render_*) and PER-ACCOUNT VARIANTS (campaign_media_renders — one
// per file × distinct overlay an account customised). The default is rendered first.
//
// ⚠️ Text safety: the client's text is written to a FILE and passed to drawtext with
// `textfile=` and `expansion=none`. It is never placed inside the filter string, so no
// quote, colon, backslash or %{…} in it can change the ffmpeg command. File paths that ARE in
// the filter string are checked against a strict character set instead of being escaped.

const SAFE_PATH = /^[A-Za-z0-9/_.\-]+$/;

export interface RenderJob {
  kind: "video" | "image";
  format: string;
  input: string;
  output: string;
  /** One text file per overlay line (each line is centred on its own). */
  textFiles: string[];
  style: string | null;
  fontFile: string | null;
}

/** Word-wrap the overlay to at most `width` characters a line, keeping the client's breaks. */
export function wrapOverlay(text: string, width = 26): string {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if ((line + " " + word).length <= width) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * The identity of an overlay variant: same format, style and text → same render. The text is
 * compared after the trim the renderer applies, so "A " and "A" share one file.
 */
export function overlayKey(format: string, text: string | null, style: string | null): string {
  const t = (text ?? "").trim();
  return crypto.createHash("sha1").update(`${format}|${t ? style ?? "bottom" : ""}|${t}`).digest("hex");
}

/** Pure: the ffmpeg arguments for a job. Throws if a path is not filter-safe. */
export function buildFfmpegArgs(job: RenderJob): string[] {
  for (const p of [job.input, job.output, ...job.textFiles, job.fontFile]) {
    if (p && !SAFE_PATH.test(p)) throw new Error(`Unsafe path for ffmpeg filter: ${p}`);
  }
  const vertical = job.format === "reel" || job.format === "story";
  const W = 1080;
  const H = 1920;
  const filters: string[] = [];
  if (vertical) {
    filters.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`);
  } else {
    filters.push(`scale='min(${W},iw)':-2`);
  }
  filters.push("setsar=1");
  if (job.textFiles.length && job.fontFile) {
    const n = job.textFiles.length;
    const lineH = "(w*0.0754)"; // font size w*0.058 × 1.3
    const base =
      job.style === "top" ? "h*0.09" : job.style === "center" ? `(h-${n}*${lineH})/2` : `h*0.80-${n}*${lineH}`;
    job.textFiles.forEach((tf, i) => {
      filters.push(
        [
          `drawtext=fontfile=${job.fontFile}`,
          `textfile=${tf}`,
          "expansion=none",
          "fontcolor=white",
          "fontsize=w*0.058",
          "box=1",
          "boxcolor=black@0.55",
          "boxborderw=18",
          "x=(w-text_w)/2",
          `y=${base}+${i}*${lineH}`,
        ].join(":"),
      );
    });
  }
  const vf = filters.join(",");
  if (job.kind === "image") {
    return ["-hide_banner", "-loglevel", "error", "-y", "-threads", "1", "-i", job.input, "-vf", vf, "-frames:v", "1", "-q:v", "2", job.output];
  }
  return [
    "-hide_banner", "-loglevel", "error", "-y", "-threads", "1",
    "-i", job.input,
    "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "+faststart",
    job.output,
  ];
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // nice: background priority so login and report submission stay fast during a render.
    execFile("nice", ["-n", "15", "ffmpeg", ...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, _out, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().slice(-400)));
      resolve();
    });
  });
}

/** Overridable in tests. */
export const renderTools = { run: runFfmpeg };

function pickFont(): string | null {
  for (const f of campaignConfig.fontFiles()) if (fs.existsSync(f)) return f;
  return null;
}

/** The box is busy — leave the render for a later tick. */
export function boxTooBusy(): boolean {
  const load = os.loadavg()[0];
  const free = os.freemem();
  return load > Number(process.env.CAMPAIGN_RENDER_MAX_LOAD || 1.5) || free < 300 * 1024 * 1024;
}

/**
 * Render one file with one overlay into a fresh render key. Returns the key; the caller
 * records it. Temp text files are always removed.
 */
async function renderOne(media: { storageKey: string; ext: string; kind: string }, format: string, text: string | null, style: string | null) {
  await ensureMediaDirs();
  const renderKey = crypto.randomBytes(32).toString("base64url");
  const out = renderPath({ renderKey, kind: media.kind })!;
  const tmpOut = out.replace(/(\.\w+)$/, ".partial$1");
  const textFiles: string[] = [];
  try {
    const wrapped = text?.trim() ? wrapOverlay(text) : "";
    const font = wrapped ? pickFont() : null;
    if (wrapped && !font) throw new Error("No overlay font installed (apt install fonts-noto-core)");
    for (const [i, line] of (wrapped ? wrapped.split("\n") : []).entries()) {
      const tf = path.join(mediaSubdirs.tmp(), `${renderKey}.${i}.txt`);
      await fsp.writeFile(tf, line, { mode: 0o600 });
      textFiles.push(tf);
    }
    await renderTools.run(
      buildFfmpegArgs({
        kind: media.kind as "video" | "image",
        format,
        input: origPath(media),
        output: tmpOut,
        textFiles,
        style: wrapped ? style ?? "bottom" : null,
        fontFile: font,
      }),
      campaignConfig.renderTimeoutMs(),
    );
    await fsp.rename(tmpOut, out);
    return { renderKey, out };
  } catch (err) {
    await fsp.rm(tmpOut, { force: true });
    throw err;
  } finally {
    for (const tf of textFiles) await fsp.rm(tf, { force: true });
  }
}

let running = false;

/** Render at most one queued file (default render first, then per-account variants). Returns the media or render id rendered, or null. */
export async function renderNext(opts: { ignoreLoad?: boolean } = {}): Promise<string | null> {
  if (running || !campaignConfig.renderEnabled()) return null;
  if (!opts.ignoreLoad && boxTooBusy()) return null;
  running = true;
  try {
    return (await renderDefault()) ?? (await renderVariant());
  } finally {
    running = false;
  }
}

async function renderDefault(): Promise<string | null> {
  const now = new Date();
  const candidate = await prisma.campaignMedia.findFirst({
    where: {
      purgedAt: null,
      uploadStatus: "complete",
      bookingId: { not: null },
      OR: [{ renderStatus: "queued" }, { renderStatus: "rendering", renderLockedUntil: { lt: now } }],
    },
    orderBy: { updatedAt: "asc" },
  });
  if (!candidate) return null;
  const claim = await prisma.campaignMedia.updateMany({
    where: { id: candidate.id, renderStatus: candidate.renderStatus, updatedAt: candidate.updatedAt },
    data: { renderStatus: "rendering", renderLockedUntil: new Date(Date.now() + campaignConfig.renderTimeoutMs() + 5 * 60_000) },
  });
  if (claim.count !== 1) return null;

  const booking = await prisma.campaignBooking.findUnique({
    where: { id: candidate.bookingId! },
    select: { format: true, superText: true, superTextStyle: true },
  });
  try {
    const { renderKey, out } = await renderOne(candidate, booking?.format ?? "post", booking?.superText ?? null, booking?.superTextStyle ?? null);
    // Only accept the result if the creative wasn't changed while we rendered.
    const done = await prisma.campaignMedia.updateMany({
      where: { id: candidate.id, renderStatus: "rendering", bookingId: candidate.bookingId },
      data: { renderStatus: "done", renderKey, renderError: null, renderLockedUntil: null },
    });
    if (done.count !== 1) {
      await fsp.rm(out, { force: true });
      return null;
    }
    if (candidate.renderKey) await fsp.rm(renderPath(candidate)!, { force: true });
    return candidate.id;
  } catch (err) {
    console.error(`[campaign-render] ${candidate.id} failed:`, (err as Error).message);
    await prisma.campaignMedia.updateMany({
      where: { id: candidate.id, renderStatus: "rendering" },
      data: { renderStatus: "failed", renderError: (err as Error).message.slice(0, 500), renderLockedUntil: null },
    });
    return null;
  }
}

async function renderVariant(): Promise<string | null> {
  const now = new Date();
  const candidate = await prisma.campaignMediaRender.findFirst({
    where: {
      OR: [{ status: "queued" }, { status: "rendering", lockedUntil: { lt: now } }],
      media: { purgedAt: null, uploadStatus: "complete" },
    },
    orderBy: { updatedAt: "asc" },
    include: { media: true, booking: { select: { format: true } } },
  });
  if (!candidate) return null;
  const claim = await prisma.campaignMediaRender.updateMany({
    where: { id: candidate.id, status: candidate.status, updatedAt: candidate.updatedAt },
    data: { status: "rendering", lockedUntil: new Date(Date.now() + campaignConfig.renderTimeoutMs() + 5 * 60_000) },
  });
  if (claim.count !== 1) return null;
  try {
    const { renderKey, out } = await renderOne(candidate.media, candidate.booking.format ?? "post", candidate.overlayText, candidate.overlayStyle);
    const done = await prisma.campaignMediaRender.updateMany({
      where: { id: candidate.id, status: "rendering" },
      data: { status: "done", renderKey, error: null, lockedUntil: null },
    });
    if (done.count !== 1) {
      // The variant was dropped (creative edited) while we rendered.
      await fsp.rm(out, { force: true });
      return null;
    }
    if (candidate.renderKey) await fsp.rm(renderPath({ renderKey: candidate.renderKey, kind: candidate.media.kind })!, { force: true });
    return candidate.id;
  } catch (err) {
    console.error(`[campaign-render] variant ${candidate.id} failed:`, (err as Error).message);
    await prisma.campaignMediaRender.updateMany({
      where: { id: candidate.id, status: "rendering" },
      data: { status: "failed", error: (err as Error).message.slice(0, 500), lockedUntil: null },
    });
    return null;
  }
}
