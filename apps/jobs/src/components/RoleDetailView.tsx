import type { ReactNode } from "react";
import { getDeptColor } from "@/lib/dept-colors";

// Presentational detail view for a single role — the rich layout previously shown
// only in the homepage side-panel. Now the canonical look for the standalone
// /[slug] page too. Deliberately has NO "use client" and NO hooks, so it renders
// on the server (SEO/crawler HTML) and inside client components alike.

const TYPE_DISPLAY: Record<string, string> = {
  FULL_TIME: "Full-time", PART_TIME: "Part-time", CONTRACT: "Contract",
  INTERNSHIP: "Internship", FREELANCE: "Freelance",
};

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function timeAgo(dateStr?: string): string {
  if (!dateStr) return "Recently posted";
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days <= 0) return "Posted today";
  if (days === 1) return "Posted yesterday";
  if (days < 7) return `Posted ${days}d ago`;
  if (days < 30) return `Posted ${Math.round(days / 7)}w ago`;
  return `Posted ${Math.round(days / 30)}mo ago`;
}

function parseLines(text?: string): string[] {
  if (!text) return [];
  return text
    .split(/\n+/)
    .map((s) => s.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);
}

export interface RoleDetailJob {
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
  _count?: { applications: number };
}

// Split into header + body because the source design puts the header (dept · №, title,
// meta chips) at FULL page width, above the two-column grid, and only the description +
// lists inside the grid's left column. Neither part sits in a card — they render straight
// onto the page background, so the fixed backdrop (bubbles / gradient wash) shows through.

/** Full-width header block: dept · № counter, title, meta chips. */
export function RoleDetailHeader({
  job,
  num,
  total,
}: {
  job: RoleDetailJob;
  num?: number;
  total?: number;
}) {
  const color = getDeptColor(job.department);
  return (
    <div className="ds-rd-head">
      <div className="ds-rd-dept" style={{ color }}>
        {job.department || "Open Role"}
        {num && total ? ` · № ${pad2(num)} / ${pad2(total)}` : null}
      </div>

      {/* h1 — this is the page's primary heading on the standalone route */}
      <h1 className="ds-rd-title">{job.title}</h1>

      <div className="ds-rd-meta">
        <span className="chip strong">{TYPE_DISPLAY[job.type] || job.type}</span>
        {job.location && <span className="chip">{job.location}</span>}
        {job.experience && <span className="chip">{job.experience}</span>}
        <span className="chip plain">{timeAgo(job.createdAt)}</span>
        {job._count?.applications ? (
          <span className="chip plain">{job._count.applications} applied</span>
        ) : null}
      </div>
    </div>
  );
}

/** Description + duties/requirements/benefits lists — the grid's left column. */
export function RoleDetailBody({
  job,
  isApplied = false,
  actions,
}: {
  job: RoleDetailJob;
  isApplied?: boolean;
  /** Action buttons (Apply / Share …) rendered in the footer action row. */
  actions?: ReactNode;
}) {
  const color = getDeptColor(job.department);
  const doingLines = parseLines(job.responsibilities);
  const lookingLines = parseLines(job.requirements);
  const benefitLines = parseLines(job.benefits);

  return (
    <div className="ds-rd-copy">
      {isApplied && (
        <div className="ds-rd-applied-banner">
          <span className="ck">✓</span>
          <span>Application submitted — we&apos;ll be in touch.</span>
        </div>
      )}

      <p className="ds-rd-summary">{job.description}</p>

      {doingLines.length > 0 && (
        <div className="ds-rd-block" style={{ "--dept": color } as React.CSSProperties}>
          <h5>What you&apos;ll do</h5>
          <ul>
            {doingLines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {lookingLines.length > 0 && (
        <div className="ds-rd-block" style={{ "--dept": color } as React.CSSProperties}>
          <h5>What we&apos;re looking for</h5>
          <ul>
            {lookingLines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {benefitLines.length > 0 && (
        <div className="ds-rd-block" style={{ "--dept": color } as React.CSSProperties}>
          <h5>Benefits</h5>
          <ul>
            {benefitLines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {actions && <div className="ds-rd-actions">{actions}</div>}
    </div>
  );
}

/** Header + body together — used by the server-rendered SEO fallback. */
export default function RoleDetailView({
  job,
  num,
  total,
  isApplied = false,
  actions,
}: {
  job: RoleDetailJob;
  /** Optional "№ 01 / 03" position counter. Rendered only when both are provided. */
  num?: number;
  total?: number;
  isApplied?: boolean;
  actions?: ReactNode;
}) {
  return (
    <>
      <RoleDetailHeader job={job} num={num} total={total} />
      <RoleDetailBody job={job} isApplied={isApplied} actions={actions} />
    </>
  );
}
