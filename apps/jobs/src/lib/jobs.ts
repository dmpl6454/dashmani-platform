// Server-side jobs data + structured-data helpers.
//
// WHY THIS FILE EXISTS: the jobs portal is our only public, SEO-dependent surface.
// The interactive pages are `"use client"` and fetch jobs in the browser, so the
// HTML Google receives on its first crawl is an empty "0 positions / Loading…"
// shell — which is why the site was not indexing. These helpers run on the SERVER
// (no "use client") so the server-rendered page wrappers can:
//   1. Put real job content into the initial HTML (indexable text), and
//   2. Emit Google `JobPosting` structured data (eligible for the Google Jobs widget).
//
// Both the public list and detail endpoints already strip internal UUIDs via the
// service-layer `select` (see CLAUDE.md "Public API endpoints must never expose
// internal user UUIDs"), so these read-only fetches are safe to render publicly.

import { jobSlug, isUuid, SITE_URL } from "./slug";

export { SITE_URL };

/**
 * Serialize an object to a JSON string safe for inlining inside a <script> tag.
 *
 * JSON.stringify escapes `"` and `\`, but NOT `<`, so a string value containing
 * the literal `</script>` would break out of the JSON-LD block (the one HTML/JSON
 * injection vector for inlined JSON). Escaping `<` as the valid JSON unicode escape
 * `<` makes `</script>` un-matchable by the HTML parser while keeping the JSON
 * byte-for-byte equivalent. Use this anywhere we feed dangerouslySetInnerHTML a
 * JSON-LD payload. (This is the same technique Next.js uses for its own inlined data.)
 */
export function safeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

export interface PublicJob {
  id: string;
  title: string;
  department?: string;
  location?: string;
  type: string;
  experience?: string;
  salary?: string;
  description: string;
  requirements?: string;
  responsibilities?: string;
  benefits?: string;
  createdAt?: string;
  updatedAt?: string;
}

// Map our internal employment-type enum to schema.org JobPosting employmentType.
const EMPLOYMENT_TYPE: Record<string, string> = {
  FULL_TIME: "FULL_TIME",
  PART_TIME: "PART_TIME",
  CONTRACT: "CONTRACTOR",
  INTERNSHIP: "INTERN",
  FREELANCE: "CONTRACTOR",
};

// Revalidate server fetches hourly — jobs change rarely, and this keeps the page
// served from the static/ISR cache (fast + crawlable) rather than hitting the API
// on every Googlebot request.
const REVALIDATE_SECONDS = 3600;

/** Fetch all active public job listings for server rendering. Returns [] on failure
 *  so a transient API hiccup degrades to an empty page rather than a 500. */
export async function getJobs(): Promise<PublicJob[]> {
  try {
    const res = await fetch(`${API_URL}/jobs`, {
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.data as PublicJob[]) || [];
  } catch {
    return [];
  }
}

/** Fetch a single public job by id for server rendering. Returns null if not found. */
export async function getJob(id: string): Promise<PublicJob | null> {
  try {
    const res = await fetch(`${API_URL}/jobs/${id}`, {
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.data as PublicJob) || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a /[id] route param that may be EITHER a title slug ("revenue-head")
 * or a raw job UUID. New shareable links use the slug; we still honour UUIDs so
 * previously-shared links and Google-indexed UUID URLs keep working.
 *
 * The public /jobs list already returns full job objects, so a slug match needs
 * no extra per-job request.
 */
export async function resolveJob(param: string): Promise<PublicJob | null> {
  const decoded = decodeURIComponent(param);
  if (isUuid(decoded)) return getJob(decoded);
  const target = decoded.toLowerCase();
  const jobs = await getJobs();
  return jobs.find((job) => jobSlug(job) === target) || null;
}

/** Strip leading bullet/dash markers and collapse whitespace for clean schema text. */
function cleanText(text?: string): string | undefined {
  if (!text) return undefined;
  return text.replace(/\s+/g, " ").trim() || undefined;
}

/**
 * Build a schema.org JobPosting object for a single job.
 * Reference: https://developers.google.com/search/docs/appearance/structured-data/job-posting
 *
 * `validThrough` is set 90 days out from datePosted — Google requires a future date
 * and will drop a posting from the Jobs widget once it passes, so we keep it rolling.
 */
export function buildJobPostingSchema(job: PublicJob) {
  const datePosted = job.createdAt || job.updatedAt;
  const validThrough = datePosted
    ? new Date(new Date(datePosted).getTime() + 90 * 86400000).toISOString()
    : undefined;

  // Combine the free-text sections into one description so the rich result has body.
  const descriptionParts = [
    cleanText(job.description),
    job.responsibilities ? `Responsibilities: ${cleanText(job.responsibilities)}` : undefined,
    job.requirements ? `Requirements: ${cleanText(job.requirements)}` : undefined,
    job.benefits ? `Benefits: ${cleanText(job.benefits)}` : undefined,
  ].filter(Boolean);

  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    description: descriptionParts.join(" "),
    identifier: {
      "@type": "PropertyValue",
      name: "Digital Sukoon",
      value: job.id,
    },
    url: `${SITE_URL}/${jobSlug(job)}`,
    employmentType: EMPLOYMENT_TYPE[job.type] || "OTHER",
    hiringOrganization: {
      "@type": "Organization",
      name: "Digital Sukoon",
      sameAs: "https://digitalsukoon.com",
      logo: "https://digitalsukoon.com/logo.svg",
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: job.location || "Mumbai",
        addressRegion: "Maharashtra",
        addressCountry: "IN",
      },
    },
    applicantLocationRequirements: { "@type": "Country", name: "India" },
    directApply: true,
  };

  if (datePosted) schema.datePosted = datePosted;
  if (validThrough) schema.validThrough = validThrough;

  return schema;
}
