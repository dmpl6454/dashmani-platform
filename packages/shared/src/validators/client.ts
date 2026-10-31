import { z } from "zod";
import { safeString, normalizedEmail, isHttpUrl, HTTP_URL_MESSAGE } from "../utils/sanitize";

export const clientLoginSchema = z.object({
  email: normalizedEmail,
  password: z.string().min(1, "Password is required"),
});

export const createClientSchema = z.object({
  companyName: safeString.pipe(z.string().min(2, "Company name must be at least 2 characters").max(200)),
  contactName: safeString.pipe(z.string().min(2, "Contact name must be at least 2 characters").max(200)),
  email: normalizedEmail,
  password: z.string().min(8, "Password must be at least 8 characters"),
  phone: z.string().max(20).optional(),
});

export const updateClientSchema = z.object({
  companyName: safeString.pipe(z.string().min(2).max(200)).optional(),
  contactName: safeString.pipe(z.string().min(2).max(200)).optional(),
  phone: z.string().max(20).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "ONBOARDING"]).optional(),
});

export const createProjectSchema = z.object({
  name: safeString.pipe(z.string().min(2, "Project name must be at least 2 characters").max(200)),
  description: safeString.pipe(z.string().max(2000)).optional(),
  clientId: z.string().uuid("Invalid client ID"),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  accountIds: z.array(z.string().uuid()).optional(),
});

export const updateProjectSchema = z.object({
  name: safeString.pipe(z.string().min(2).max(200)).optional(),
  description: safeString.pipe(z.string().max(2000)).nullable().optional(),
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]).optional(),
  startDate: z.string().date().nullable().optional(),
  endDate: z.string().date().nullable().optional(),
});

export const createApprovalSchema = z.object({
  title: z.string().min(2, "Title is required").max(200),
  description: z.string().max(2000).optional(),
  fileUrl: z.string().url().refine(isHttpUrl, HTTP_URL_MESSAGE).optional(),
});

export const respondApprovalSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "REVISION_REQUESTED"]),
  clientNote: z.string().max(2000).optional(),
});

export const addProjectAccountSchema = z.object({
  accountId: z.string().uuid("Invalid account ID"),
});

export const addProjectTaskSchema = z.object({
  taskId: z.string().uuid("Invalid task ID"),
});

export const clientRegisterSchema = z.object({
  token:    z.string().uuid("Invalid invite token"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  contactName: z.string().min(2).max(200).optional(),
});

/**
 * Public self-signup from the website's "Start a campaign" button (owner decision 2026-10-10).
 * Free-text fields go through safeString; the email is normalised so the account can never
 * be locked out by casing (see CLAUDE.md "Email-case lockouts").
 */
export const clientSignupSchema = z.object({
  companyName: safeString.pipe(z.string().min(2, "Company or brand name must be at least 2 characters").max(200)),
  contactName: safeString.pipe(z.string().min(2, "Your name must be at least 2 characters").max(200)),
  email: z.string().max(254, "Email is too long").pipe(normalizedEmail),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  phone: safeString.pipe(z.string().max(20)).optional().or(z.literal("").transform(() => undefined)),
});

/**
 * "Sign in with Google" (client portal). `credential` is the Google Identity Services ID token;
 * the API verifies it with Google before trusting a byte of it. `companyName` is sent only on
 * the second round-trip of a FIRST sign-in, when the portal has asked the new client to name
 * their company (the token carries a person's name and email, not a business).
 */
export const clientGoogleSchema = z.object({
  credential: z.string().min(20).max(4096),
  companyName: safeString.pipe(z.string().min(2, "Company or brand name must be at least 2 characters").max(200)).optional(),
});

export const createInviteSchema = z.object({
  email: normalizedEmail,
});

export const createBriefSchema = z.object({
  projectId:    z.string().uuid("Invalid project ID"),
  title:        z.string().min(2, "Title must be at least 2 characters").max(200),
  description:  z.string().min(2, "Description must be at least 2 characters").max(4000),
  referenceUrl: z.string().url("Invalid URL").refine(isHttpUrl, HTTP_URL_MESSAGE).optional().or(z.literal("").transform(() => undefined)),
});

/**
 * Team logins: a further person who signs in to the client portal as the same company. Added by
 * the company's owner (client portal → Team) or by sales staff (sales portal → client).
 */
export const clientTeamInviteSchema = z.object({
  email: z.string().max(254, "Email is too long").pipe(normalizedEmail),
  name: safeString.pipe(z.string().min(2, "Name must be at least 2 characters").max(200)),
});

/** Accepting a team invite: the emailed one-time token, a password, and optionally a corrected name. */
export const clientJoinSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, "Invalid invite link"),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  name: safeString.pipe(z.string().min(2, "Name must be at least 2 characters").max(200)).optional(),
});

/** A team login's own email choices (the owner always receives both). */
export const clientTeamEmailChoicesSchema = z
  .object({ emailCampaigns: z.boolean().optional(), emailInvoices: z.boolean().optional() })
  .refine((v) => v.emailCampaigns !== undefined || v.emailInvoices !== undefined, { message: "Nothing to change" });
