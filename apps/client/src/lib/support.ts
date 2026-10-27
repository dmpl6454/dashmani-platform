// Client support on WhatsApp (owner, 2026-10-27). One place for the number, so a change is one edit.
export const SUPPORT_WHATSAPP_NUMBER = "919930761000";
export const SUPPORT_WHATSAPP_DISPLAY = "+91 99307 61000";

/** wa.me link that opens WhatsApp (app or web) with a short message already typed. */
export function whatsappSupportUrl(context?: string): string {
  const text = context ? `Hi Digital Sukoon, I need help with ${context}.` : "Hi Digital Sukoon, I need help with my client portal.";
  return `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}
