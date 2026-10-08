import { z } from "zod";
import { safeString } from "../utils/sanitize";
import { todayIST } from "../utils/date";

// Self-serve campaign booking (client portal "Start a campaign"). Shared by the API (input
// validation) and the client / internal portals (forms). Import this module BY PATH from the
// frontends ("@dashmani/shared/src/validators/campaign") — never through the barrel.

// ── Vocabularies ────────────────────────────────────────────────────────────────

export const CAMPAIGN_PLATFORMS = ["instagram", "facebook", "youtube"] as const;
export type CampaignPlatform = (typeof CAMPAIGN_PLATFORMS)[number];

/** reel = IG Reel / FB Reel / YouTube Short; post = feed photo or video (YouTube: long video). */
export const CAMPAIGN_FORMATS = ["reel", "story", "post", "carousel"] as const;
export type CampaignFormat = (typeof CAMPAIGN_FORMATS)[number];

/** Which formats each platform can carry. YouTube has no stories or carousels. */
export const PLATFORM_FORMATS: Record<CampaignPlatform, readonly CampaignFormat[]> = {
  instagram: ["reel", "story", "post", "carousel"],
  facebook: ["reel", "story", "post", "carousel"],
  youtube: ["reel", "post"],
};

export const FORMAT_LABELS: Record<CampaignFormat, string> = {
  reel: "Reel",
  story: "Story",
  post: "Post",
  carousel: "Carousel",
};

export const BOOKING_STATUSES = [
  "draft",
  "awaiting_payment",
  "paid_pending_review",
  "changes_requested",
  "approved",
  "publishing",
  "completed",
  "partially_published",
  "rejected",
  "refunded",
  "cancelled",
  "expired",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Client-editable states: content, accounts and media can change only here. */
export const EDITABLE_BOOKING_STATUSES: readonly BookingStatus[] = ["draft", "awaiting_payment", "changes_requested"];

export const ITEM_STATUSES = [
  "pending", // booked, not yet approved
  "manual_pending", // approved — staff post it by hand (Phase 1, YouTube)
  "posted_manual", // staff posted it and recorded the link
  "queued", // approved — Meta auto-publish (Phase 2)
  "published", // auto-published by the API
  "failed",
  "refunded",
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
/** An item that is live on the platform with a link. */
export const LIVE_ITEM_STATUSES: readonly ItemStatus[] = ["posted_manual", "published"];
/** An item that will not change again (live, failed or refunded). */
export const SETTLED_ITEM_STATUSES: readonly ItemStatus[] = ["posted_manual", "published", "failed", "refunded"];

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  draft: "Draft",
  awaiting_payment: "Awaiting payment",
  paid_pending_review: "Paid — in review",
  changes_requested: "Changes requested",
  approved: "Approved — scheduling",
  publishing: "Going live",
  completed: "Live",
  partially_published: "Partly live",
  rejected: "Rejected",
  refunded: "Refunded",
  cancelled: "Cancelled",
  expired: "Expired",
};

/** Overlay-text styles. A preset KEY is stored; the renderer maps it to fixed font / box params. */
export const SUPER_TEXT_STYLES = ["top", "center", "bottom"] as const;
export type SuperTextStyle = (typeof SUPER_TEXT_STYLES)[number];

// ── Limits (Instagram's are the strictest, so they apply to every platform) ─────

export const CAMPAIGN_LIMITS = {
  captionMax: 2200,
  hashtagsMax: 30,
  mentionsMax: 20,
  collaboratorsMax: 3,
  userTagsMax: 20,
  carouselMin: 2,
  carouselMax: 10,
  superTextMax: 120,
  superTextLinesMax: 3,
  launchWindowMaxDays: 60,
  itemsMax: 50,
  videoMaxBytes: 500 * 1024 * 1024,
  imageMaxBytes: 20 * 1024 * 1024,
  /** Seconds. */
  reelMaxSec: 90,
  storyMaxSec: 60,
  postVideoMaxSec: 600,
  carouselVideoMaxSec: 60,
} as const;

export const CAMPAIGN_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export const CAMPAIGN_UPLOAD_MIME = {
  image: ["image/jpeg", "image/png"],
  video: ["video/mp4", "video/quicktime"],
} as const;

// ── Helpers ─────────────────────────────────────────────────────────────────────

const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Hashtags written inside the caption plus the separate list, de-duplicated case-insensitively. */
export function countHashtags(caption: string, extra: readonly string[] = []): number {
  const set = new Set<string>();
  for (const m of caption.matchAll(/#([\p{L}\p{N}_]+)/gu)) set.add(m[1].toLowerCase());
  for (const h of extra) set.add(h.replace(/^#/, "").toLowerCase());
  return set.size;
}

export function countMentions(caption: string): number {
  return new Set([...caption.matchAll(/@([A-Za-z0-9._]{1,30})/g)].map((m) => m[1].toLowerCase())).size;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Rupees display for paise. 150000 → "₹1,500". */
export function formatPaise(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { maximumFractionDigits: rupees % 1 === 0 ? 0 : 2 })}`;
}

const handle = z
  .string()
  .trim()
  .transform((s) => s.replace(/^@/, ""))
  .pipe(z.string().regex(HANDLE_RE, "Use an Instagram username (letters, numbers, . and _)"));

// ── Schemas ─────────────────────────────────────────────────────────────────────

export const campaignInfoSchema = z
  .object({
    name: safeString.pipe(z.string().min(2, "Give the campaign a name").max(200)),
    brand: safeString.pipe(z.string().min(2, "Enter the brand").max(200)),
    objective: safeString.pipe(z.string().max(2000)).optional().nullable(),
    launchFrom: z.string().regex(YMD_RE, "Pick a start date"),
    launchTo: z.string().regex(YMD_RE, "Pick an end date"),
  })
  .superRefine((v, ctx) => {
    if (v.launchFrom < todayIST()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["launchFrom"], message: "The start date can't be in the past" });
    }
    if (v.launchTo < v.launchFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["launchTo"], message: "The end date must be on or after the start" });
    } else if (daysBetween(v.launchFrom, v.launchTo) > CAMPAIGN_LIMITS.launchWindowMaxDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["launchTo"],
        message: `The launch window can be at most ${CAMPAIGN_LIMITS.launchWindowMaxDays} days`,
      });
    }
  });
export type CampaignInfoInput = z.infer<typeof campaignInfoSchema>;

export const campaignCreativeSchema = z
  .object({
    format: z.enum(CAMPAIGN_FORMATS),
    mediaIds: z.array(z.string().uuid()).min(1, "Upload your creative").max(CAMPAIGN_LIMITS.carouselMax),
    caption: safeString.pipe(z.string().max(CAMPAIGN_LIMITS.captionMax)).optional().default(""),
    hashtags: z
      .array(
        z
          .string()
          .trim()
          .transform((s) => s.replace(/^#/, ""))
          .pipe(z.string().regex(/^[\p{L}\p{N}_]{1,100}$/u, "Hashtags use letters, numbers and _")),
      )
      .max(CAMPAIGN_LIMITS.hashtagsMax)
      .optional()
      .default([]),
    userTags: z.array(handle).max(CAMPAIGN_LIMITS.userTagsMax).optional().default([]),
    collaborators: z.array(handle).max(CAMPAIGN_LIMITS.collaboratorsMax).optional().default([]),
    superText: safeString
      .transform((s) => s.normalize("NFC"))
      .pipe(z.string().max(CAMPAIGN_LIMITS.superTextMax))
      .optional()
      .nullable(),
    superTextStyle: z.enum(SUPER_TEXT_STYLES).optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.format === "carousel") {
      if (v.mediaIds.length < CAMPAIGN_LIMITS.carouselMin) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mediaIds"], message: "A carousel needs at least 2 images or videos" });
      }
    } else if (v.mediaIds.length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mediaIds"], message: "Upload exactly one file for this format" });
    }
    if (countHashtags(v.caption ?? "", v.hashtags) > CAMPAIGN_LIMITS.hashtagsMax) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["hashtags"], message: "Instagram allows at most 30 hashtags" });
    }
    if (countMentions(v.caption ?? "") > CAMPAIGN_LIMITS.mentionsMax) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["caption"], message: "Instagram allows at most 20 @mentions" });
    }
    if (v.superText) {
      if (v.superText.split("\n").length > CAMPAIGN_LIMITS.superTextLinesMax) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["superText"], message: "Keep the overlay text to 3 lines" });
      }
      // The renderer receives the text through a file, but control characters still break the
      // layout, so reject them here (newlines are allowed).
      if (/[\u0000-\u0009\u000B-\u001F\u007F]/.test(v.superText)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["superText"], message: "The overlay text contains unsupported characters" });
      }
    }
  });
export type CampaignCreativeInput = z.infer<typeof campaignCreativeSchema>;

export const campaignItemsSchema = z.object({
  rateCardIds: z.array(z.string().uuid()).min(1, "Pick at least one account").max(CAMPAIGN_LIMITS.itemsMax),
});
export type CampaignItemsInput = z.infer<typeof campaignItemsSchema>;

export const campaignUploadInitSchema = z.object({
  filename: safeString.pipe(z.string().min(1).max(255)),
  size: z.number().int().positive(),
  mime: z.string().max(100),
});
export type CampaignUploadInitInput = z.infer<typeof campaignUploadInitSchema>;

export const campaignReviewNoteSchema = z.object({
  note: safeString.pipe(z.string().min(3, "Add a short note for the client").max(2000)),
});

export const campaignMarkPostedSchema = z.object({
  url: z.string().trim().url("Paste the full link to the post").max(500),
});

export const campaignRateCardUpsertSchema = z.object({
  cards: z
    .array(
      z.object({
        targetType: z.enum(["meta_asset", "social_account"]),
        targetId: z.string().uuid(),
        format: z.enum(CAMPAIGN_FORMATS),
        /** null deletes the card (stops offering that format on that account). */
        pricePaise: z.number().int().min(100, "Minimum ₹1").max(100_000_000).nullable(),
        active: z.boolean().optional().default(true),
        category: safeString.pipe(z.string().max(60)).optional().nullable(),
      }),
    )
    .min(1)
    .max(500),
});
export type CampaignRateCardUpsertInput = z.infer<typeof campaignRateCardUpsertSchema>;

/** Which hosts a manually recorded post link may point to, per platform. */
export const PLATFORM_POST_HOSTS: Record<CampaignPlatform, readonly string[]> = {
  instagram: ["instagram.com"],
  facebook: ["facebook.com", "fb.watch"],
  youtube: ["youtube.com", "youtu.be"],
};

export function isPlatformPostUrl(platform: CampaignPlatform, url: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return PLATFORM_POST_HOSTS[platform].some((h) => host === h || host.endsWith(`.${h}`));
}
