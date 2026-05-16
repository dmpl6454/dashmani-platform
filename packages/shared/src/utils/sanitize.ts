import { z } from "zod";

/** Strips HTML/script tags and trims whitespace from string fields */
export const safeString = z.string().transform((s) => s.replace(/<[^>]*>/g, "").trim());

/** safeString with a minimum length requirement */
export const safeStringMin = (min: number) =>
  z.string().transform((s) => s.replace(/<[^>]*>/g, "").trim()).refine((s) => s.length >= min);
