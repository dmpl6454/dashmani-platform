"use client";
import { apiFetchBlob, downloadBlob } from "./api";
import { errorSentence } from "./messages";

/**
 * "View" a signed PDF of the filed accounts. The tab opens BEFORE the await, so a popup blocker
 * still treats it as the click's own window; the bytes come through the authenticated fetch.
 */
export async function viewFiledPdf(fileId: string, onError: (msg: string) => void) {
  const tab = window.open("", "_blank");
  try {
    const { blob } = await apiFetchBlob(`/sales/accounts/filed/files/${fileId}?inline=1`);
    const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
    if (tab) tab.location.href = url;
    else window.location.href = url;
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
