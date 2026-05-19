import { z } from "zod";
import { normalizedEmail } from "../utils/sanitize";

export const loginSchema = z.object({
  email: normalizedEmail,
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});
