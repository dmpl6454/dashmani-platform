import { z } from "zod";
import { safeString, normalizedEmail } from "../utils/sanitize";

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
