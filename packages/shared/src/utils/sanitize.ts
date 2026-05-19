import { z } from "zod";

/** Strips HTML/script tags and trims whitespace from string fields */
export const safeString = z.string().transform((s) => s.replace(/<[^>]*>/g, "").trim());

/** safeString with a minimum length requirement */
export const safeStringMin = (min: number) =>
  z.string().transform((s) => s.replace(/<[^>]*>/g, "").trim()).refine((s) => s.length >= min);

/**
 * Email validator that ALSO trims + lowercases. Use this for every email
 * field that will be persisted or used as a lookup key — emails are
 * case-insensitive in practice but Postgres unique constraints are not.
 * Storing only-normalized values prevents the "registered but can't sign in"
 * lockout when a user types a different case than they registered with.
 */
export const normalizedEmail = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().email("Invalid email"));
