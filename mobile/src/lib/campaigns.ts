// Shared bits for the admin campaign screens (mirror apps/internal/src/app/campaigns/_ds.tsx).
// Colours are warm/neutral only — no purple (app design rule).

export const BOOKING_STATUS: Record<string, { label: string; color: string }> = {
  draft: { label: "Draft", color: "#8E8E93" },
  awaiting_payment: { label: "Awaiting payment", color: "#8E8E93" },
  paid_pending_review: { label: "Needs review", color: "#F9A64A" },
  changes_requested: { label: "Changes requested", color: "#FF9F0A" },
  approved: { label: "Approved — to post", color: "#0A84FF" },
  publishing: { label: "Posting", color: "#0A84FF" },
  completed: { label: "Delivered", color: "#30D158" },
  partially_published: { label: "Partly delivered", color: "#30D158" },
  rejected: { label: "Rejected", color: "#FF453A" },
  refunded: { label: "Refunded", color: "#8E8E93" },
  cancelled: { label: "Cancelled", color: "#636366" },
  expired: { label: "Expired", color: "#636366" },
};

export const ITEM_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: "Awaiting approval", color: "#8E8E93" },
  manual_pending: { label: "To post", color: "#F9A64A" },
  queued: { label: "Auto-publish", color: "#0A84FF" },
  posted_manual: { label: "Posted", color: "#30D158" },
  published: { label: "Published", color: "#30D158" },
  failed: { label: "Failed", color: "#FF453A" },
  refunded: { label: "Refunded", color: "#8E8E93" },
};

export const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube", snapchat: "Snapchat" };

/** Paise → "₹1,23,456" (whole rupees when there are no paise). */
export function rupees(paise: number | null | undefined): string {
  if (paise == null) return "—";
  const r = paise / 100;
  return "₹" + r.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 });
}

/** What a format is called on a platform (a Snapchat "reel" is a Spotlight, a YouTube one a Short). */
export function formatLabel(platform: string, format: string): string {
  if (format === "reel" && platform === "snapchat") return "Spotlight";
  if (format === "reel" && platform === "youtube") return "Short";
  if (format === "post" && platform === "youtube") return "Video";
  return format.charAt(0).toUpperCase() + format.slice(1);
}
