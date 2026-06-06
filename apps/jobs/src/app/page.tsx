// SERVER COMPONENT (no "use client").
//
// This wrapper is what makes the jobs portal indexable. It fetches the open roles
// on the server and passes them to the interactive <JobsClient> as `initialJobs`,
// which seeds SWR's cache so the very first HTML render — the one Googlebot sees —
// already contains every job title, department, and location as real text (instead
// of the old "0 positions / Loading…" empty shell that Google was indexing).
//
// It also emits an ItemList of JobPosting structured data so the listing page is
// eligible for Google's Jobs rich result. Per-job JobPosting schema lives on each
// detail page ([id]/page.tsx).

import { getJobs, buildJobPostingSchema, safeJsonLd, SITE_URL } from "@/lib/jobs";
import JobsClient from "./JobsClient";

// Revalidate the static HTML hourly (matches the API fetch revalidate in lib/jobs).
export const revalidate = 3600;

export default async function JobsHomePage() {
  const jobs = await getJobs();

  // ItemList wrapping each role's JobPosting — the canonical way to mark up a
  // listing page for Google Jobs.
  const itemListSchema = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: jobs.map((job, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${SITE_URL}/${job.id}`,
      item: buildJobPostingSchema(job),
    })),
  };

  return (
    <>
      {jobs.length > 0 && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListSchema) }}
        />
      )}
      <JobsClient initialJobs={jobs} />
    </>
  );
}
