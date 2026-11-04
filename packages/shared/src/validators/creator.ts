import { z } from "zod";
import { safeString, normalizedEmail, isHttpUrl, HTTP_URL_MESSAGE } from "../utils/sanitize";

// Creator portal (creators.digitalsukoon.com). Used by the API (input validation) and the
// creators app (form validation) — import by module path, not the @dashmani/shared barrel.

export const CREATOR_STATUSES = ["draft", "in_review", "approved", "rejected", "suspended", "closed"] as const;
export type CreatorStatus = (typeof CREATOR_STATUSES)[number];

export const CREATOR_STATUS_LABELS: Record<CreatorStatus, string> = {
  draft: "Setting up",
  in_review: "In review",
  approved: "Approved",
  rejected: "Not approved",
  suspended: "Suspended",
  closed: "Closed",
};

export const CREATOR_ASSET_KINDS = ["facebook_page", "instagram_account"] as const;
export type CreatorAssetKind = (typeof CREATOR_ASSET_KINDS)[number];

const password = z.string().min(8, "Use at least 8 characters").max(200, "That password is too long");
const name = safeString.pipe(z.string().min(2, "Your name must be at least 2 characters").max(120, "Keep your name under 120 characters"));
const email = z.string().max(254, "Email is too long").pipe(normalizedEmail);
/** ISO 3166-1 alpha-2, upper-case. Empty → undefined. */
const country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Pick your country")
  .optional()
  .or(z.literal("").transform(() => undefined));

export const creatorSignupSchema = z.object({
  name,
  email,
  password,
  country,
  acceptTerms: z.literal(true, { errorMap: () => ({ message: "Please accept the creator terms" }) }),
  confirmAdult: z.literal(true, { errorMap: () => ({ message: "You must be 18 or older" }) }),
});

export const creatorLoginSchema = z.object({
  email: normalizedEmail,
  password: z.string().min(1, "Password is required").max(200),
});

export const creatorRefreshSchema = z.object({ refreshToken: z.string().min(20).max(4096) });

export const creatorForgotSchema = z.object({ email: z.string().max(254).pipe(normalizedEmail) });

export const creatorResetSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: password,
});

export const creatorVerifyEmailSchema = z.object({ token: z.string().min(20).max(200) });

/**
 * "Continue with Google". The first call carries only `credential`; for a new email the API
 * answers { needsProfile } and the second call adds the terms + 18+ confirmations (and country).
 */
export const creatorGoogleSchema = z.object({
  credential: z.string().min(20).max(4096),
  country,
  acceptTerms: z.literal(true).optional(),
  confirmAdult: z.literal(true).optional(),
});

export const creatorProfileSchema = z.object({
  name: name.optional(),
  country,
  phone: safeString.pipe(z.string().max(32)).optional().or(z.literal("").transform(() => undefined)),
});

export const creatorChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: password,
});

/** Staff review note: required for reject / suspend, optional for approve. */
export const creatorReviewSchema = z.object({
  note: safeString.pipe(z.string().max(2000)).optional(),
});
export const creatorReviewNoteRequiredSchema = z.object({
  note: safeString.pipe(z.string().min(3, "Add a short note for the creator").max(2000)),
});

export const creatorAssetToggleSchema = z.object({ enabled: z.boolean() });

// ── Marketplace (Phase B/C): staff prices, the creator's decision on each booked post ────────

/** Formats a creator page can be priced for (clients book reel, post and carousel only). */
export const CREATOR_PRICED_FORMATS = ["reel", "post", "carousel"] as const;
export type CreatorPricedFormat = (typeof CREATOR_PRICED_FORMATS)[number];

const paise = z.number().int().min(100, "Minimum ₹1").max(100_000_000);

/**
 * Staff set, per creator page and format, what the CLIENT pays (brand price, optional
 * entertainment price and reel song add-on) and what WE pay the creator (settled by hand).
 * pricePaise null = stop offering that format on that page (the card is deleted).
 */
export const creatorPricingSchema = z.object({
  cards: z
    .array(
      z.object({
        assetId: z.string().uuid(),
        format: z.enum(CREATOR_PRICED_FORMATS),
        pricePaise: paise.nullable(),
        entertainmentPricePaise: paise.nullable().optional(),
        audioAddonPaise: paise.nullable().optional(),
        creatorPayoutPaise: paise.nullable().optional(),
        active: z.boolean().optional().default(true),
        category: safeString.pipe(z.string().max(60)).optional().nullable(),
      }),
    )
    .min(1)
    .max(60),
});
export type CreatorPricingInput = z.infer<typeof creatorPricingSchema>;

export const creatorOfferDeclineSchema = z.object({
  reason: safeString.pipe(z.string().min(3, "Tell us briefly why").max(500)),
});

export const creatorOfferPostedSchema = z.object({
  url: z.string().trim().url("Paste the full link to the post").max(500).refine(isHttpUrl, HTTP_URL_MESSAGE),
});

/** Item statuses as the creator sees them. */
export const CREATOR_OFFER_STATUS_LABELS: Record<string, string> = {
  awaiting_creator: "Waiting for you",
  queued: "Accepted — scheduled",
  manual_pending: "Accepted — post it yourself",
  published: "Live",
  posted_manual: "Live",
  creator_declined: "Declined",
  failed: "Not posted",
  refunded: "Cancelled",
};
