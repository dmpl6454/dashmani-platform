"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { apiFetch, apiUpload } from "@/lib/api";
import { getDeptColor } from "@/lib/dept-colors";

const TYPE_DISPLAY: Record<string, string> = {
  FULL_TIME: "Full-time", PART_TIME: "Part-time", CONTRACT: "Contract",
  INTERNSHIP: "Internship", FREELANCE: "Freelance",
};

interface Job {
  id: string; title: string; department?: string; location?: string;
  type: string; experience?: string; salary?: string; description: string;
  requirements?: string; responsibilities?: string; benefits?: string; createdAt?: string;
}

// Proper named component so React DevTools shows a sensible label.
function Section({ title, text }: { title: string; text?: string }) {
  if (!text) return null;
  return (
    <div style={{ marginBottom: 28 }}>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

// `initialJob` is fetched on the server (see page.tsx) and seeded into state so the
// first render — the one Googlebot indexes — already contains the full role content
// instead of a "Loading…" spinner. The client still revalidates in the background.
export default function JobDetailPage({ initialJob = null }: { initialJob?: Job | null }) {
  const { id } = useParams();
  const searchParams = useSearchParams();
  const applyDirect = searchParams.get("apply") === "true";

  const [job, setJob] = useState<Job | null>(initialJob);
  // If the server already provided the job, we're not in a loading state on mount.
  const [loading, setLoading] = useState(initialJob === null);
  const [showForm, setShowForm] = useState(applyDirect);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // Track selected file in state so the UI re-renders when the user picks one.
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const [form, setForm] = useState({
    applicantName: "", applicantEmail: "", applicantPhone: "",
    coverLetter: "", experience: "", currentCompany: "",
    linkedinUrl: "", portfolioUrl: "",
  });

  useEffect(() => {
    apiFetch<any>(`/jobs/${id}`)
      .then((res) => setJob(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  // Auto-scroll to form when coming from "Apply Now" deep-link.
  useEffect(() => {
    if (applyDirect && !loading && job && formRef.current) {
      setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
    }
  }, [applyDirect, loading, job]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("applicantName", form.applicantName);
      fd.append("applicantEmail", form.applicantEmail);
      if (form.applicantPhone) fd.append("applicantPhone", form.applicantPhone);
      if (form.coverLetter) fd.append("coverLetter", form.coverLetter);
      if (form.experience) fd.append("experience", form.experience);
      if (form.currentCompany) fd.append("currentCompany", form.currentCompany);
      if (form.linkedinUrl) fd.append("linkedinUrl", form.linkedinUrl);
      if (form.portfolioUrl) fd.append("portfolioUrl", form.portfolioUrl);
      if (resumeFile) fd.append("resume", resumeFile);
      await apiUpload(`/jobs/${id}/apply`, fd);
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message || "Failed to submit application");
    } finally {
      // Always re-enable the button — even if the catch block itself throws.
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="ds-detail-page">
        <div style={{ display: "flex", alignItems: "center", gap: 12, color: "var(--muted)", fontSize: 14 }}>
          <div style={{ width: 18, height: 18, borderRadius: "50%", border: "2px solid var(--accent-tint)", borderTopColor: "var(--accent)", animation: "spin .8s linear infinite" }} />
          Loading…
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="ds-detail-page" style={{ textAlign: "center", paddingTop: 64 }}>
        <p style={{ color: "var(--muted)", fontSize: 15 }}>Job not found.</p>
        <Link href="/" className="ds-btn ghost" style={{ marginTop: 16, display: "inline-flex" }}>
          ← Back to all roles
        </Link>
      </div>
    );
  }

  const color = getDeptColor(job.department);

  return (
    <div className="ds-detail-page">
      <Link href="/" className="ds-back-link">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M10 3 5 8l5 5" />
        </svg>
        Back to all positions
      </Link>

      {/* Header card */}
      <div className="ds-jd-header" style={{ borderTop: `4px solid ${color}` }}>
        {job.department && (
          <div className="ds-jd-dept" style={{ color }}>
            {job.department}
          </div>
        )}
        <h1 className="ds-jd-title">{job.title}</h1>

        {/* Meta chips — extracted to a reusable class to avoid copy-pasting the same 11-property inline object */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 24 }}>
          <span className="ds-meta-chip">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.2 1.4"/></svg>
            {TYPE_DISPLAY[job.type] || job.type}
          </span>
          {job.location && (
            <span className="ds-meta-chip">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 14s-5-4.4-5-8.2A5 5 0 0 1 13 5.8C13 9.6 8 14 8 14Z"/><circle cx="8" cy="6" r="1.8"/></svg>
              {job.location}
            </span>
          )}
          {job.experience && (
            <span className="ds-meta-chip">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 13V8m5 5V4m5 9V9"/></svg>
              {job.experience}
            </span>
          )}
        </div>

        {!submitted && (
          <button
            onClick={() => {
              setShowForm(true);
              setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
            }}
            className="ds-btn primary"
            style={{ fontSize: 15, padding: "14px 28px" }}
          >
            Apply for this role
            <span className="arrow">→</span>
          </button>
        )}
      </div>

      {/* Description */}
      <div className="ds-jd-body">
        <Section title="About the Role" text={job.description} />
        <Section title="Key Responsibilities" text={job.responsibilities} />
        <Section title="Requirements" text={job.requirements} />
        <Section title="Benefits" text={job.benefits} />
      </div>

      {/* Application form — wrapped in <form> so required/type="email" validation is active */}
      {showForm && !submitted && (
        <div ref={formRef} className="ds-jd-form-card">
          <h2>Apply for {job.title}</h2>
          <form onSubmit={handleSubmit} noValidate={false}>
            <div className="ds-form-grid">
              <label className="ds-field">
                <span className="label">Full Name <em style={{ color: "var(--accent)", fontStyle: "normal" }}>*</em></span>
                <input type="text" required value={form.applicantName} onChange={(e) => setForm({ ...form, applicantName: e.target.value })} placeholder="Your full name" />
              </label>
              <label className="ds-field">
                <span className="label">Email <em style={{ color: "var(--accent)", fontStyle: "normal" }}>*</em></span>
                <input type="email" required value={form.applicantEmail} onChange={(e) => setForm({ ...form, applicantEmail: e.target.value })} placeholder="your@email.com" />
              </label>
              <label className="ds-field">
                <span className="label">Phone</span>
                <input type="tel" value={form.applicantPhone} onChange={(e) => setForm({ ...form, applicantPhone: e.target.value })} placeholder="+91…" />
              </label>
              <label className="ds-field">
                <span className="label">Current Company</span>
                <input type="text" value={form.currentCompany} onChange={(e) => setForm({ ...form, currentCompany: e.target.value })} placeholder="Where do you work now?" />
              </label>
              <label className="ds-field">
                <span className="label">Experience</span>
                <input type="text" value={form.experience} onChange={(e) => setForm({ ...form, experience: e.target.value })} placeholder="e.g., 2 years" />
              </label>
              <label className="ds-field">
                <span className="label">LinkedIn URL</span>
                <input type="url" value={form.linkedinUrl} onChange={(e) => setForm({ ...form, linkedinUrl: e.target.value })} placeholder="https://linkedin.com/in/..." />
              </label>
              <label className="ds-field">
                <span className="label">Portfolio URL</span>
                <input type="url" value={form.portfolioUrl} onChange={(e) => setForm({ ...form, portfolioUrl: e.target.value })} placeholder="https://…" />
              </label>
              <div className="ds-field">
                <span className="label">Resume (PDF)</span>
                <div className="ds-file-row">
                  <button type="button" className="ds-file-btn" onClick={() => fileRef.current?.click()}>Choose File</button>
                  {/* resumeFile state (not fileRef) drives the label so the UI updates on pick */}
                  <span className={`ds-file-name ${resumeFile ? "has-file" : ""}`}>
                    {resumeFile?.name ?? "No file chosen"}
                  </span>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf,.doc,.docx"
                    hidden
                    onChange={(e) => setResumeFile(e.target.files?.[0] ?? null)}
                  />
                </div>
              </div>
              <label className="ds-field full">
                <span className="label">Cover Letter</span>
                <textarea
                  value={form.coverLetter}
                  onChange={(e) => setForm({ ...form, coverLetter: e.target.value })}
                  rows={5}
                  placeholder="Tell us why you'd be great for this role…"
                />
              </label>
            </div>

            {error && (
              <div style={{ padding: "12px 16px", borderRadius: 12, marginBottom: 16, background: "rgba(196,69,44,0.08)", border: "1px solid rgba(196,69,44,0.2)", color: "var(--error)", fontSize: 14 }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              className="ds-intern-submit"
              disabled={submitting}
            >
              {submitting ? "Submitting…" : "Submit Application"}
              {!submitting && <span>→</span>}
            </button>
          </form>
        </div>
      )}

      {submitted && (
        <div className="ds-jd-form-card">
          <div className="ds-success-banner">
            <div className="check" aria-hidden="true">✓</div>
            <h3>Application Submitted!</h3>
            <p>Thank you for applying. We&apos;ll review your application and get back to you within five working days.</p>
            <p style={{ marginTop: 10, fontSize: 14, opacity: 0.8 }}>
              Have a question?{" "}
              <a href="mailto:careers@digitalsukoon.com" style={{ fontWeight: 600, textDecoration: "underline" }}>
                Email careers@digitalsukoon.com
              </a>
            </p>
          </div>
        </div>
      )}

      <div style={{ padding: "32px 0 8px", textAlign: "center" }}>
        <p style={{ fontSize: 14, color: "var(--muted, #666)", lineHeight: 1.6 }}>
          Questions about your application?{" "}
          <a href="mailto:careers@digitalsukoon.com" style={{ fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 2, color: "inherit" }}>
            Email careers@digitalsukoon.com
          </a>
        </p>
      </div>
    </div>
  );
}
