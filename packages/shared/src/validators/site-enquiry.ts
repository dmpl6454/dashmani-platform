import { z } from "zod";
import { safeString, normalizedEmail } from "../utils/sanitize";

// Campaign enquiry from the public marketing site (digitalsukoon.com, apps/web → CH 06 Contact).
// The option lists are the site's exact labels; the API rejects anything else.

export const SITE_ENQUIRY_INTENTS = [
  "Film / OTT",
  "Brand campaign",
  "Product launch",
  "Celebrity",
  "Music",
  "Event",
  "Other",
] as const;

export const SITE_ENQUIRY_BUDGETS = ["Under ₹10L", "₹10L – ₹50L", "₹50L – ₹2Cr", "₹2Cr+"] as const;

export const siteEnquirySchema = z.object({
  intent: z.enum(SITE_ENQUIRY_INTENTS),
  campaignName: safeString.pipe(z.string().max(200)).optional(),
  company: safeString.pipe(z.string().max(200)).optional(),
  budget: z.enum(SITE_ENQUIRY_BUDGETS).optional(),
  launchDate: z.union([z.string().date("Invalid date"), z.literal("")]).optional(),
  email: z.string({ required_error: "Email is required" }).trim().min(1, "Email is required").pipe(normalizedEmail),
  // Honeypot: a field hidden from people. Bots that fill it are answered "ok" and dropped.
  website: z.string().max(500).optional(),
});

export type SiteEnquiryInput = z.infer<typeof siteEnquirySchema>;
