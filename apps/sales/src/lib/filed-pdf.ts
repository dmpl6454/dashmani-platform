"use client";
import { apiFetchBlob, downloadBlob } from "./api";
import { errorSentence } from "./messages";

/** How long a viewed PDF's object URL lives — long enough for the tab to load it, then the bytes are freed. */
const VIEW_URL_TTL_MS = 60_000;

/**
 * "View" a signed PDF of the filed accounts. The tab opens BEFORE the await, so a popup blocker
 * still treats it as the click's own window; the bytes come through the authenticated fetch.
 * A blocked popup DOWNLOADS the file instead — never navigates this page away (that would throw
 * away any figures typed but not saved).
 */
export async function viewFiledPdf(fileId: string, fileName: string, onError: (msg: string) => void) {
  const tab = window.open("", "_blank");
  try {
    const { blob } = await apiFetchBlob(`/sales/accounts/filed/files/${fileId}?inline=1`);
    const pdf = new Blob([blob], { type: "application/pdf" });
    if (!tab || tab.closed) { downloadBlob(pdf, fileName); return; }
    const url = URL.createObjectURL(pdf);
    tab.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), VIEW_URL_TTL_MS);
  } catch (err) {
    tab?.close();
    onError(errorSentence(err));
  }
}

/** Download a signed PDF under the name the server gives it. */
export async function downloadFiledPdf(fileId: string, fallback: string, onError: (msg: string) => void) {
  try {
    const { blob, filename } = await apiFetchBlob(`/sales/accounts/filed/files/${fileId}`);
    downloadBlob(blob, filename ?? fallback);
  } catch (err) {
    onError(errorSentence(err));
  }
}
