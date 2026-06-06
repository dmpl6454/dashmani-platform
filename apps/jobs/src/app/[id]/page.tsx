// SERVER COMPONENT (no "use client") for the job-detail route.
//
// Responsibilities (all SEO-critical, none of which a client component can do):
//   1. generateMetadata  — a unique <title>, description, and canonical per role,
//      so each job competes in search on its own terms instead of inheriting the
//      generic site title.
//   2. generateStaticParams — pre-render every open role at build/ISR time so the
//      HTML exists and is crawlable without a client round-trip.
//   3. JobPosting JSON-LD — makes each role eligible for Google's Jobs rich result.
//   4. Seed <JobDetailClient initialJob> — the role's full text is in the first
//      HTML render (not a "Loading…" spinner), which is what Googlebot indexes.

import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getJob, getJobs, buildJobPostingSchema, safeJsonLd, SITE_URL } from "@/lib/jobs";
import JobDetailClient from "./JobDetailClient";

// Revalidate the static HTML hourly (matches lib/jobs fetch revalidate).
export const revalidate = 3600;
// Allow on-demand rendering of roles created after the last build (ISR fallback).
export const dynamicParams = true;

const TYPE_DISPLAY: Record<string, string> = {
  FULL_TIME: "Full-time", PART_TIME: "Part-time", CONTRACT: "Contract",
  INTERNSHIP: "Internship", FREELANCE: "Freelance",
};

interface PageProps {
  params: { id: string };
}

export async function generateStaticParams() {
  const jobs = await getJobs();
  return jobs.map((job) => ({ id: job.id }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const job = await getJob(params.id);
  if (!job) {
    return { title: "Job not found", robots: { index: false, follow: true } };
  }

  const typeLabel = TYPE_DISPLAY[job.type] || job.type;
  const where = job.location ? ` in ${job.location}` : "";
  const title = `${job.title} — ${typeLabel}${job.department ? ` (${job.department})` : ""}`;
  // First ~155 chars of the role description make the best meta description.
  const description =
    (job.description || `Apply for the ${job.title} role at Digital Sukoon${where}.`)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 155);
  const url = `${SITE_URL}/${job.id}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      url,
      title: `${job.title} | Digital Sukoon Careers`,
      description,
      siteName: "Digital Sukoon Careers",
    },
    twitter: {
      card: "summary_large_image",
      title: `${job.title} | Digital Sukoon Careers`,
      description,
    },
  };
}

export default async function JobDetailPageWrapper({ params }: PageProps) {
  const job = await getJob(params.id);

  // No such role → real 404 (correct SEO signal, and avoids a soft-404 the old
  // client-only "Job not found" text would have produced).
  if (!job) notFound();

  const schema = buildJobPostingSchema(job);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(schema) }}
      />
      {/* JobDetailClient calls useSearchParams() (for the ?apply=true deep-link),
          which requires a Suspense boundary when the page is statically prerendered.
          The fallback renders the role's static SEO content so the prerendered HTML
          (and thus Googlebot's view) still contains the full job text. */}
      <Suspense fallback={<JobDetailFallback job={job} />}>
        <JobDetailClient initialJob={job} />
      </Suspense>
    </>
  );
}

// Server-rendered static view of the role — shown during the CSR bailout and baked
// into the prerendered HTML so the page is never an empty shell for crawlers.
function JobDetailFallback({ job }: { job: NonNullable<Awaited<ReturnType<typeof getJob>>> }) {
  return (
    <div className="ds-detail-page">
      <div className="ds-jd-header">
        {job.department && <div className="ds-jd-dept">{job.department}</div>}
        <h1 className="ds-jd-title">{job.title}</h1>
      </div>
      <div className="ds-jd-body">
        {job.description && (
          <div style={{ marginBottom: 28 }}>
            <h3>About the Role</h3>
            <p>{job.description}</p>
          </div>
        )}
        {job.responsibilities && (
          <div style={{ marginBottom: 28 }}>
            <h3>Key Responsibilities</h3>
            <p>{job.responsibilities}</p>
          </div>
        )}
        {job.requirements && (
          <div style={{ marginBottom: 28 }}>
            <h3>Requirements</h3>
            <p>{job.requirements}</p>
          </div>
        )}
        {job.benefits && (
          <div style={{ marginBottom: 28 }}>
            <h3>Benefits</h3>
            <p>{job.benefits}</p>
          </div>
        )}
      </div>
    </div>
  );
}
