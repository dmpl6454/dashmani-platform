"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { apiFetch, apiUpload } from "@/lib/api";

const TYPE_DISPLAY: Record<string, string> = {
  FULL_TIME: "Full-time", PART_TIME: "Part-time", CONTRACT: "Contract",
  INTERNSHIP: "Internship", FREELANCE: "Freelance",
};

const DEPT_COLORS: Record<string, string> = {
  design: "#2027E6", social: "#C9882A", content: "#2F7F5A",
  video: "#6D4DC9", engineering: "#1F8FA8", web: "#1F8FA8",
  strategy: "#B05429", production: "#B43E70", marketing: "#B05429",
};

function getDeptColor(dept?: string) {
  if (!dept) return "#2027E6";
  const lower = dept.toLowerCase();
  const key = Object.keys(DEPT_COLORS).find((k) => lower.includes(k));
  return key ? DEPT_COLORS[key] : "#2027E6";
}

interface Job {
  id: string; title: string; department?: string; location?: string;
  type: string; experience?: string; salary?: string; description: string;
  requirements?: string; responsibilities?: string; benefits?: string; createdAt?: string;
}

export default function JobDetailPage() {
  const { id } = useParams();
  const searchParams = useSearchParams();
  const applyDirect = searchParams.get("apply") === "true";

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(applyDirect);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
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
      if (fileRef.current?.files?.[0]) fd.append("resume", fileRef.current.files[0]);
      await apiUpload(`/jobs/${id}/apply`, fd);
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message || "Failed to submit application");
    }
    setSubmitting(false);
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
        <a href="/" className="ds-btn ghost" style={{ marginTop: 16, display: "inline-flex" }}>← Back to all roles</a>
      </div>
    );
  }

  const color = getDeptColor(job.department);

  function sec(title: string, text?: string) {
    if (!text) return null;
    return (
      <div style={{ marginBottom: 28 }}>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
    );
  }

  return (
    <div className="ds-detail-page">
      <a href="/" className="ds-back-link">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M10 3 5 8l5 5" />
        </svg>
        Back to all positions
      </a>

      {/* Header card */}
      <div className="ds-jd-header" style={{ borderTop: `4px solid ${color}` }}>
        {job.department && (
          <div className="ds-jd-dept" style={{ color }}>
            {job.department}
          </div>
        )}
        <h1 className="ds-jd-title">{job.title}</h1>

        {/* Meta chips */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 24 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 12px", borderRadius: 999, background: "rgba(11,15,58,0.05)", fontSize: 12.5, fontWeight: 500, color: "var(--ink)" }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.2 1.4"/></svg>
            {TYPE_DISPLAY[job.type] || job.type}
          </span>
          {job.location && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 12px", borderRadius: 999, background: "rgba(11,15,58,0.05)", fontSize: 12.5, fontWeight: 500, color: "var(--ink)" }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 14s-5-4.4-5-8.2A5 5 0 0 1 13 5.8C13 9.6 8 14 8 14Z"/><circle cx="8" cy="6" r="1.8"/></svg>
              {job.location}
            </span>
          )}
          {job.experience && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 12px", borderRadius: 999, background: "rgba(11,15,58,0.05)", fontSize: 12.5, fontWeight: 500, color: "var(--ink)" }}>
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
        {sec("About the Role", job.description)}
        {sec("Key Responsibilities", job.responsibilities)}
        {sec("Requirements", job.requirements)}
        {sec("Benefits", job.benefits)}
      </div>

      {/* Application form */}
      {showForm && !submitted && (
        <div ref={formRef} className="ds-jd-form-card">
          <h2>Apply for {job.title}</h2>
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
                <span className="ds-file-name">{fileRef.current?.files?.[0]?.name || "No file chosen"}</span>
                <input ref={fileRef} type="file" accept=".pdf,.doc,.docx" hidden onChange={() => {}} />
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
            <div style={{ padding: "12px 16px", borderRadius: 12, marginBottom: 16, background: "rgba(196,69,44,0.08)", border: "1px solid rgba(196,69,44,0.2)", color: "#C4452C", fontSize: 14 }}>
              {error}
            </div>
          )}

          <button
            type="button"
            className="ds-intern-submit"
            disabled={submitting}
            onClick={handleSubmit as any}
          >
            {submitting ? "Submitting…" : "Submit Application"}
            {!submitting && <span>→</span>}
          </button>
        </div>
      )}

      {submitted && (
        <div className="ds-jd-form-card">
          <div className="ds-success-banner">
            <div className="check" aria-hidden="true">✓</div>
            <h3>Application Submitted!</h3>
            <p>Thank you for applying. We&apos;ll review your application and get back to you within five working days.</p>
          </div>
        </div>
      )}
    </div>
  );
}
