import { z } from "zod";
import { normalizedEmail } from "../utils/sanitize";

export const loginSchema = z.object({
  email: normalizedEmail,
  password: z.string().min(8, "Password must be at least 8 characters"),
  /** "Keep me signed in" — stretches the refresh token from 7 to 30 days. */
  rememberMe: z.boolean().optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});
