import { z } from "zod";

/**
 * Removes every `<...>` span, producing output BYTE-IDENTICAL to
 * `s.replace(/<[^>]*>/g, "")` — in linear time.
 *
 * ⚠️ Why not the regex (P11). On input containing a `<` with no later `>`, V8's
 * backtracking engine rescans the rest of the string from EVERY `<`, which is O(n²) and
 * fully synchronous on the API's single main thread: measured 1.9 s for 40 KB of "<" and
 * 5.3 s for 80 KB, while the API's express.json() accepts 10 MB bodies and every caller
 * applies its `.max()` only AFTER this transform — the 2026-09-08 main-thread-hang class.
 * This scan visits each character at most twice.
 *
 * Semantics reproduced exactly:
 * - a span runs from a `<` to the FIRST `>` after it (`[^>]*` may contain further `<`);
 * - a `<` with no `>` after it is kept verbatim, and so is everything after it — if no
 *   `>` follows the first unmatched `<`, none follows any later `<` either;
 * - a `>` outside a span is kept.
 * Locked by a property test against the old regex (apps/api/tests/pipeline/safe-string.test.ts).
 */
export function stripTagsLinear(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      out += s.slice(i);
      break;
    }
    const gt = s.indexOf(">", lt + 1);
    if (gt === -1) {
      out += s.slice(i); // regex: an unmatched "<" is kept verbatim
      break;
    }
    out += s.slice(i, lt);
    i = gt + 1;
  }
  return out;
}

/** Strips HTML/script tags and trims whitespace from string fields */
export const safeString = z.string().transform((s) => stripTagsLinear(s).trim());

/** safeString with a minimum length requirement */
export const safeStringMin = (min: number) =>
  z.string().transform((s) => stripTagsLinear(s).trim()).refine((s) => s.length >= min);

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

/** Strips query string (UTM params, igsh, etc.) from a social account handle */
export function sanitizeAccountHandle(raw: string): string {
  // Strip query string, trim, then remove any leading "@" — a social handle never
  // legitimately starts with "@", and a stray leading "@" (pasted from a profile
  // mention) otherwise renders as "@@handle" wherever the UI prepends its own "@".
  return raw.split("?")[0].trim().replace(/^@+/, "");
}
