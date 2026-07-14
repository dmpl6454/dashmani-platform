// Pure, dependency-free slug helpers shared by server (route/metadata/sitemap) and
// client (ShareButton) code. Kept out of lib/jobs.ts so importing it into a client
// component doesn't drag in the server-only fetch helpers.

// Canonical public origin. Shared links, OG/canonical tags, and the sitemap all use
// this so a shared URL is ALWAYS the public production address — never a localhost or
// preview origin the sharer happens to be on. Overridable via env for other envs.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://jobs.digitalsukoon.com";

/**
 * Turn a job title into a clean, URL-safe slug.
 *   "Revenue Head"        -> "revenue-head"
 *   "Sr. Frontend Eng."   -> "sr-frontend-eng"
 *   "Social / Media"      -> "social-media"
 * Spaces and separators collapse to single hyphens; punctuation is dropped.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "") // strip anything that isn't a letter, digit, space, or hyphen
    .replace(/[\s_]+/g, "-") // whitespace / underscores -> hyphen
    .replace(/-+/g, "-") // collapse repeated hyphens
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
}

/** The canonical slug for a job — derived from its title. */
export function jobSlug(job: { title: string }): string {
  return slugify(job.title);
}

/** True if a route param is a raw job UUID (so we can resolve it directly). */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
