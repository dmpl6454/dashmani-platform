// Link Analytics request bodies (sales portal /links). Shared by the API and the portal.
import { z } from "zod";
import { safeString } from "../utils/sanitize";

/** The pasted text: up to ~2 MB (an uploaded TXT/CSV is read in the browser and sent as text). */
const linksText = z.string().max(2_200_000, "That file is too large — at most 2 MB of links at a time");
const mode = z.enum(["paste", "csv"]).optional();

export const linkBatchCreateSchema = z.object({
  name: safeString.pipe(z.string().min(1, "Give the batch a name").max(160)),
  notes: safeString.pipe(z.string().max(2000)).nullish(),
  keepDuplicates: z.boolean().optional(),
  text: linksText,
  mode,
});

export const linkBatchAddSchema = z.object({
  text: linksText,
  mode,
  keepDuplicates: z.boolean().optional(),
});

export const linkBatchUpdateSchema = z.object({
  name: safeString.pipe(z.string().min(1).max(160)).optional(),
  notes: safeString.pipe(z.string().max(2000)).nullish(),
  keepDuplicates: z.boolean().optional(),
});

export const linkBatchScheduleSchema = z.object({
  hours: z.union([z.literal(6), z.literal(12), z.literal(24)]).nullable(),
});

export const linkUsernameHintSchema = z.object({
  username: z.string().max(40).nullable(),
});
