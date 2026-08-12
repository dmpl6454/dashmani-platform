"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiFetch, apiUpload } from "@/lib/api";
import { jobSlug } from "@/lib/slug";
import ShareButton from "@/components/ShareButton";
import { RoleDetailHeader, RoleDetailBody } from "@/components/RoleDetailView";

interface Job {
  id: string; title: string; department?: string; location?: string;
  type: string; experience?: string; salary?: string; description: string;
  requirements?: string; responsibilities?: string; benefits?: string; createdAt?: string;
}

// `initialJob` is fetched on the server (see page.tsx) and seeded into state so the
// first render — the one Googlebot indexes — already contains the full role content
// instead of a "Loading…" spinner. The client still revalidates in the background.
// `num`/`total` drive the "№ 01 / 03" position counter (computed on the server).
export default function JobDetailPage({
  initialJob = null,
  num,
  total,
}: {
  initialJob?: Job | null;
  num?: number;
  total?: number;
}) {
  // The route param is now the title slug (e.g. "revenue-head"), so it can't be used
  // for API calls. All /jobs/:id requests use the real UUID from the server-resolved
  // initialJob instead.
  const jobId = initialJob?.id;
  const searchParams = useSearchParams();
  const applyDirect = searchParams.get("apply") === "true";

  const [job, setJob] = useState<Job | null>(initialJob);
  // If the server already provided the job, we're not in a loading state on mount.
  const [loading, setLoading] = useState(initialJob === null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // Track selected file in state so the UI re-renders when the user picks one.
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  // The design's apply card asks for fewer fields than the API's JobApplication
  // model has room for (experience/currentCompany exist as optional columns for
  // HR's own use, e.g. manual notes) — the public form only collects what the
  // design shows. LinkedIn and portfolio are one combined field here, matching
  // the design's single "LinkedIn / portfolio" input; its value is sent as
  // linkedinUrl, the field the design's input maps to most directly.
  const [form, setForm] = useState({
    applicantName: "", applicantEmail: "", applicantPhone: "",
    linkedinUrl: "", coverLetter: "",
  });

  useEffect(() => {
    if (!jobId) {
      setLoading(false);
      return;
    }
    apiFetch<any>(`/jobs/${jobId}`)
      .then((res) => setJob(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [jobId]);

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
      if (form.linkedinUrl) fd.append("linkedinUrl", form.linkedinUrl);
      if (resumeFile) fd.append("resume", resumeFile);
      await apiUpload(`/jobs/${jobId}/apply`, fd);
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
        <Link href="/#index" className="ds-btn ghost" style={{ marginTop: 16, display: "inline-flex" }}>
          ← Back to all roles
        </Link>
      </div>
    );
  }

  return (
    <div className="ds-detail-page">
      {/* #index, not "/" — returns the visitor to the roles list they came from rather
          than dropping them at the top of the hero. */}
      <Link href="/#index" className="ds-back-link">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M10 3 5 8l5 5" />
        </svg>
        Back to all positions
      </Link>

      {/* Header spans the full page width, above the two-column grid — per the source. */}
      <RoleDetailHeader job={job} num={num} total={total} />

      {/* Description on the left, apply form beside it (sticky) on the right — matches
          the source design's side-by-side layout. Collapses to stacked below the
          grid's 340px column minimum (mobile/narrow viewports). */}
      <div className="ds-jd-layout">
        <div>
          <RoleDetailBody
            job={job}
            isApplied={submitted}
            actions={
              <>
                {!submitted && (
                  <button
                    className="ds-btn primary"
                    type="button"
                    onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                    style={{ flex: 1, justifyContent: "space-between", padding: "14px 18px 14px 22px" }}
                  >
                    Apply for this role
                    <span className="arrow">→</span>
                  </button>
                )}
                {/* Sharing stays available even after applying — a visitor may still
                    want to pass the role to someone else. */}
                <ShareButton slug={jobSlug(job)} jobTitle={job.title} variant="labeled" />
              </>
            }
          />
        </div>

        <div ref={formRef} className="ds-jd-aside">
          {submitted ? (
            <div className="ds-jd-form-card">
              <div className="ds-jd-illustration" aria-hidden="true">
                <img src="/illustrations/resume.svg" alt="" />
              </div>
              <div className="ds-success-banner">
                <img
                  src="/illustrations/action-successful.svg"
                  alt=""
                  aria-hidden="true"
                  style={{ display: "block", width: 150, height: "auto", margin: "0 auto 18px" }}
                />
                <h3>Application Submitted!</h3>
                <p>Thank you for applying. We&apos;ll review your application and get back to you within five working days.</p>
                <p style={{ marginTop: 10, fontSize: 14, opacity: 0.8 }}>
                  Have a question?{" "}
                  <a href="mailto:careers@digitalsukoon.com" style={{ fontWeight: 600, textDecoration: "underline" }}>
                    Email careers@digitalsukoon.com
                  </a>
                </p>
                <div
                  style={{
                    display: "flex", alignItems: "center", gap: 14, textAlign: "left",
                    marginTop: 28, paddingTop: 22, borderTop: "1.5px solid var(--line-soft)",
                  }}
                >
                  <img
                    src="/illustrations/interview.svg"
                    alt=""
                    aria-hidden="true"
                    style={{ display: "block", width: 88, height: "auto", flex: "none" }}
                  />
                  <div style={{ fontSize: 14, lineHeight: 1.5, opacity: 0.7 }}>
                    Next step, if it&apos;s a fit: a 30-minute intro call with the team lead.
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Application form — wrapped in <form> so required/type="email" validation is active */
            <div className="ds-jd-form-card">
              <div className="ds-jd-illustration" aria-hidden="true">
                <img src="/illustrations/resume.svg" alt="" />
              </div>
              <div className="ds-jd-eyebrow">Apply for this role</div>
                <form onSubmit={handleSubmit} noValidate={false}>
                  <div className="ds-jd-fields">
                    <label className="ds-field">
                      <span className="label">Full name</span>
                      <input type="text" required value={form.applicantName} onChange={(e) => setForm({ ...form, applicantName: e.target.value })} placeholder="Jane Doe" />
                    </label>
                    <label className="ds-field">
                      <span className="label">Email</span>
                      <input type="email" required value={form.applicantEmail} onChange={(e) => setForm({ ...form, applicantEmail: e.target.value })} placeholder="jane@email.com" />
                    </label>
                    <label className="ds-field">
                      <span className="label">Phone</span>
                      <input type="tel" value={form.applicantPhone} onChange={(e) => setForm({ ...form, applicantPhone: e.target.value })} placeholder="+91 98765 43210" />
                    </label>
                    <label className="ds-field">
                      <span className="label">LinkedIn / portfolio</span>
                      <input type="url" value={form.linkedinUrl} onChange={(e) => setForm({ ...form, linkedinUrl: e.target.value })} placeholder="https://" />
                    </label>
                    <label className="ds-field">
                      <span className="label">Resume</span>
                      <div
                        className={`ds-jd-resume-drop ${dragActive ? "drag-active" : ""}`}
                        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                        onDragLeave={() => setDragActive(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragActive(false);
                          const f = e.dataTransfer.files?.[0];
                          if (f) setResumeFile(f);
                        }}
                      >
                        <input
                          ref={fileRef}
                          type="file"
                          accept=".pdf,.doc,.docx"
                          onChange={(e) => setResumeFile(e.target.files?.[0] ?? null)}
                        />
                        <span className="name">
                          {resumeFile?.name ?? "Drop or choose a file — PDF or Word, up to 10MB"}
                        </span>
                        {resumeFile && (
                          <button
                            type="button"
                            className="remove"
                            aria-label="Remove resume"
                            onClick={() => { setResumeFile(null); if (fileRef.current) fileRef.current.value = ""; }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </label>
                    <label className="ds-field">
                      <span className="label">Cover note (optional)</span>
                      <textarea
                        value={form.coverLetter}
                        onChange={(e) => setForm({ ...form, coverLetter: e.target.value })}
                        rows={3}
                        placeholder="Anything you'd like us to know"
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
                    {submitting ? "Submitting…" : "Submit application"}
                  </button>
                </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
