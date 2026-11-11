// Where creators write to us. One constant for the footer, the offer page and the dialogs.
export const SUPPORT_EMAIL = "creators@digitalsukoon.com";

/** mailto: link with a subject and body. Email links may do nothing in some browsers, so the
 *  address is always shown as text beside the link too. */
export function supportMailto(subject: string, body = ""): string {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}${body ? `&body=${encodeURIComponent(body)}` : ""}`;
}
