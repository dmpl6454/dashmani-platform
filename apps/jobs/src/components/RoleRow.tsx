"use client";

import Link from "next/link";
import { jobSlug } from "@/lib/slug";
import { getDeptColor } from "@/lib/dept-colors";
import ShareButton from "@/components/ShareButton";

interface ApiJob {
  id: string;
  title: string;
  department?: string;
  location?: string;
  type: string;
  createdAt?: string;
}

const TYPE_DISPLAY: Record<string, string> = {
  FULL_TIME: "Full-time",
  PART_TIME: "Part-time",
  CONTRACT: "Contract",
  INTERNSHIP: "Internship",
  FREELANCE: "Freelance",
};

// Derives a short one-line blurb from the job's long description — the real API has no
// dedicated blurb field, and none is being added just for this list view.
function blurbFrom(description: string, max = 110): string {
  const flat = description.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : max)}…`;
}

export default function RoleRow({
  job,
  isApplied,
  onOpen,
}: {
  job: ApiJob & { description: string };
  isApplied: boolean;
  onOpen: () => void;
}) {
  const color = getDeptColor(job.department);
  const slug = jobSlug(job);

  return (
    <li
      className={`ds-role ${isApplied ? "applied" : ""}`}
      style={{ "--dept": color } as React.CSSProperties}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      role="link"
      aria-label={`${job.title}${job.department ? `, ${job.department}` : ""}${job.location ? `, ${job.location}` : ""}${isApplied ? ", already applied" : ""}`}
    >
      <div className="dept-tag">
        <span className="dept-swatch" aria-hidden="true" />
        {job.department || "General"}
      </div>

      <div className="info">
        <span className="title-wrap">
          <span className="title">{job.title}</span>
          <span className="title-underline" aria-hidden="true" />
        </span>
        {job.type === "INTERNSHIP" && <span className="tag">Internship</span>}
        <div className="blurb">{blurbFrom(job.description)}</div>
      </div>

      {job.location && <div className="location">{job.location}</div>}

      <span className="type-pill">{isApplied ? "Applied" : TYPE_DISPLAY[job.type] || job.type}</span>

      <span className="ds-role-actions">
        <ShareButton slug={slug} jobTitle={job.title} variant="icon" className="go" />
        <Link
          href={`/${slug}?apply=true`}
          className="ds-role-apply"
          aria-label={`Apply for the ${job.title} role`}
          onClick={(e) => e.stopPropagation()}
        >
          →
        </Link>
      </span>
    </li>
  );
}
