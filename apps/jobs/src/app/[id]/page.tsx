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
import { getJobs, resolveJob, buildJobPostingSchema, safeJsonLd, SITE_URL } from "@/lib/jobs";
import { jobSlug } from "@/lib/slug";
import JobDetailClient from "./JobDetailClient";
import RoleDetailView from "@/components/RoleDetailView";

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
  // Pre-render each role at its slug (e.g. "revenue-head"). UUID URLs still resolve
  // on demand via dynamicParams + resolveJob, so old links don't break.
  return jobs.map((job) => ({ id: jobSlug(job) }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const job = await resolveJob(params.id);
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
  const url = `${SITE_URL}/${jobSlug(job)}`;

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
  const job = await resolveJob(params.id);

  // No such role → real 404 (correct SEO signal, and avoids a soft-404 the old
  // client-only "Job not found" text would have produced).
  if (!job) notFound();

  const schema = buildJobPostingSchema(job);

  // "№ N / total" position, matching the counter the old side-panel showed.
  const allJobs = await getJobs();
  const idx = allJobs.findIndex((j) => j.id === job.id);
  const num = idx >= 0 ? idx + 1 : undefined;
  const total = allJobs.length || undefined;

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
      <Suspense fallback={<JobDetailFallback job={job} num={num} total={total} />}>
        <JobDetailClient initialJob={job} num={num} total={total} />
      </Suspense>
    </>
  );
}

// Server-rendered static view of the role — shown during the CSR bailout and baked
// into the prerendered HTML so the page is never an empty shell for crawlers. Uses
// the same RoleDetailView as the client so the crawler HTML matches the live design.
function JobDetailFallback({
  job,
  num,
  total,
}: {
  job: NonNullable<Awaited<ReturnType<typeof resolveJob>>>;
  num?: number;
  total?: number;
}) {
  return (
    <div className="ds-detail-page">
      <RoleDetailView job={job} num={num} total={total} />
    </div>
  );
}
