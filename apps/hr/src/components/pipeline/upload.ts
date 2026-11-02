/**
 * Uploading a version's file straight to Cloudflare R2 (2026-11-02).
 *
 * The API hands out a signed PUT URL (plApi.startUpload); the file goes from the browser to
 * R2 without passing through our server. XMLHttpRequest, not fetch: fetch has no upload
 * progress. The bucket's CORS rule must allow PUT with a Content-Type header from this origin.
 */
import { pipelineWork as W } from "@dashmani/shared";

const BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  zip: "application/zip",
};

/** The file's type: what the browser says, else from its extension (Windows often says nothing for .mov). */
export function fileTypeOf(file: File): string {
  const t = (file.type || "").toLowerCase();
  if (t) return t;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? "";
}

/** Null when the file can be uploaded for this kind, else the reason in plain words. */
export function checkFile(kind: string, file: File): string | null {
  const rule = W.uploadRuleFor(kind);
  if (!rule) return "A caption is text — paste or write it instead.";
  if (!rule.types.includes(fileTypeOf(file))) return "This type of file can't be uploaded here.";
  if (file.size <= 0) return "This file is empty.";
  if (file.size > rule.maxBytes) return `The file is too big (the most is ${W.formatBytes(rule.maxBytes)}).`;
  return null;
}

/** Accept list for the file picker. */
export function acceptFor(kind: string): string {
  return (W.uploadRuleFor(kind)?.types ?? []).join(",");
}

/** A failure to show as-is (upload interrupted, pop-up blocked). */
export class UploadError extends Error {}
export class UploadAborted extends UploadError {}

/** PUTs the file to R2. Resolves when stored; rejects on failure or abort. */
export function putToR2(
  ticket: W.PipelineUploadTicket,
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(ticket.method, ticket.url);
    for (const [k, v] of Object.entries(ticket.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new UploadError(`The upload failed (storage answered ${xhr.status}) — try again.`)));
    xhr.onerror = () => reject(new UploadError("The upload was interrupted — check your connection and try again."));
    xhr.onabort = () => reject(new UploadAborted("Upload cancelled."));
    if (signal.aborted) return xhr.abort();
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/**
 * Opens a version's file in a new tab. The tab is opened synchronously (inside the click) and
 * pointed at the signed URL once it arrives — opening it after the await would be blocked as a
 * pop-up.
 */
export async function openVersionFile(getUrl: () => Promise<{ url: string }>, download: boolean): Promise<void> {
  if (download) {
    const { url } = await getUrl();
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const tab = window.open("", "_blank");
  try {
    const { url } = await getUrl();
    if (!tab) throw new UploadError("Your browser blocked the new tab — allow pop-ups for this site, or use Download.");
    tab.opener = null;
    tab.location.href = url;
  } catch (e) {
    tab?.close();
    throw e;
  }
}
