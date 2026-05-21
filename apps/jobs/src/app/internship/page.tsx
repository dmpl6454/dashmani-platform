"use client";

import { useState, useRef } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

const DEPARTMENTS = [
  "Design", "Social Media", "Content / Copywriting",
  "Video / Motion", "Engineering", "Strategy", "Other",
];

export default function InternshipPage() {
  const [form, setForm] = useState({
    name: "", email: "", phone: "", college: "", course: "",
    startDate: "", duration: "6 months", department: "",
    skills: "", portfolio: "", linkedin: "", coverLetter: "",
  });
  const [resume, setResume] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [refCode, setRefCode] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function set(k: string, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => { if (v) fd.append(k, v); });
      if (resume) fd.append("resume", resume);

      const res = await fetch(`${API_URL}/internship/apply`, { method: "POST", body: fd });
      const data = await res.json();
      if (!data.success) throw new Error(data.error?.message || "Submission failed");

      const ref = "DS-INT-" + Math.random().toString(36).slice(2, 8).toUpperCase();
      setRefCode(ref);
      setSubmitted(true);
    } catch (e: any) {
      setError(e.message);
    }
    setSubmitting(false);
  }

  if (submitted) {
    return (
      <div className="ds-intern-view">
        <div className="ds-apply-card">
          <div className="ds-form-success">
            <div className="check" aria-hidden="true">✓</div>
            <h3>Thanks, {form.name.trim().split(/\s+/)[0] || "there"}.</h3>
            <p>
              Your internship application is in. We&apos;ll review it and get back within five working days.
              Keep an eye on your inbox.
            </p>
            {refCode && <p style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 12, color: "var(--muted)", marginTop: 12 }}>
              Ref · {refCode}
            </p>}
            <a className="back-link" href="/">Back to open roles →</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-intern-view">
      {/* Hero */}
      <header className="ds-intern-hero">
        <span className="ds-program-pill">Internship Program</span>
        <h2>6-Month Internship</h2>
        <p>
          Join Digital Sukoon as an intern and gain hands-on experience in digital marketing,
          content creation, and social media management. Mentored by senior craft — paid stipend — convert to full-time.
        </p>
      </header>

      {/* Benefit cards */}
      <div className="ds-benefit-cards">
        <article className="ds-benefit">
          <span className="ds-benefit-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M3 8.5 12 4l9 4.5L12 13 3 8.5Z" />
              <path d="M7 10.5V15c0 1.5 2.2 3 5 3s5-1.5 5-3v-4.5" />
            </svg>
          </span>
          <h4>Learn &amp; Grow</h4>
          <p>Work alongside senior craft on real client projects from day one.</p>
        </article>
        <article className="ds-benefit">
          <span className="ds-benefit-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M5 4h11l3 3v13H5V4Z" />
              <path d="M16 4v3h3" />
              <path d="M8 11h8M8 14h6" />
            </svg>
          </span>
          <h4>Certificate</h4>
          <p>Completion certificate and a personal letter of recommendation.</p>
        </article>
        <article className="ds-benefit">
          <span className="ds-benefit-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M4 7h16v10H4Z" />
              <circle cx="12" cy="12" r="2.5" />
              <path d="M7 7v10M17 7v10" />
            </svg>
          </span>
          <h4>Stipend</h4>
          <p>Performance-based stipend with a clear path to full-time conversion.</p>
        </article>
      </div>

      {/* Apply form */}
      <section className="ds-apply-card">
        <form onSubmit={handleSubmit} noValidate>
          <div className="ds-apply-form-head">
            <h3>Apply Now</h3>
            <span className="required-note">Fields marked <em>*</em> are required</span>
          </div>

          {error && (
            <div style={{
              padding: "12px 16px", borderRadius: 12, marginBottom: 20,
              background: "rgba(196,69,44,0.08)", border: "1px solid rgba(196,69,44,0.2)",
              color: "#C4452C", fontSize: 14,
            }}>
              {error}
            </div>
          )}

          <div className="ds-form-grid">
            <label className="ds-field">
              <span className="label">Full Name <em>*</em></span>
              <input type="text" required value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Your full name" />
            </label>
            <label className="ds-field">
              <span className="label">Email <em>*</em></span>
              <input type="email" required value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="you@example.com" />
            </label>

            <label className="ds-field">
              <span className="label">Phone</span>
              <input type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+91 — —————————" />
            </label>
            <label className="ds-field">
              <span className="label">College / University</span>
              <input type="text" value={form.college} onChange={(e) => set("college", e.target.value)} placeholder="Where you study" />
            </label>

            <label className="ds-field">
              <span className="label">Course / Degree</span>
              <input type="text" value={form.course} onChange={(e) => set("course", e.target.value)} placeholder="e.g., B.Tech, BBA, MBA" />
            </label>
            <label className="ds-field">
              <span className="label">Preferred Department <em>*</em></span>
              <select required value={form.department} onChange={(e) => set("department", e.target.value)}>
                <option value="">Select Department</option>
                {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>

            <label className="ds-field">
              <span className="label">Preferred Start Date</span>
              <input type="date" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} />
            </label>
            <label className="ds-field">
              <span className="label">Duration</span>
              <select value={form.duration} onChange={(e) => set("duration", e.target.value)}>
                <option value="3 months">3 Months</option>
                <option value="6 months">6 Months</option>
                <option value="9 months">9 Months</option>
              </select>
            </label>

            <label className="ds-field full">
              <span className="label">Skills</span>
              <input type="text" value={form.skills} onChange={(e) => set("skills", e.target.value)} placeholder="e.g., Canva, Photoshop, Content Writing, Video Editing" />
            </label>

            <label className="ds-field">
              <span className="label">LinkedIn Profile</span>
              <input type="url" value={form.linkedin} onChange={(e) => set("linkedin", e.target.value)} placeholder="https://linkedin.com/in/…" />
            </label>
            <label className="ds-field">
              <span className="label">Portfolio / Website</span>
              <input type="url" value={form.portfolio} onChange={(e) => set("portfolio", e.target.value)} placeholder="https://…" />
            </label>

            <label className="ds-field full">
              <span className="label">Cover Letter</span>
              <textarea
                value={form.coverLetter}
                onChange={(e) => set("coverLetter", e.target.value)}
                rows={5}
                placeholder="Tell us why you want to intern at Digital Sukoon and what you hope to learn…"
              />
            </label>

            <div className="ds-field full">
              <span className="label">Resume (PDF)</span>
              <div className="ds-file-row">
                <button type="button" className="ds-file-btn" onClick={() => fileRef.current?.click()}>
                  Choose File
                </button>
                <span className={`ds-file-name ${resume ? "has-file" : ""}`}>
                  {resume ? resume.name : "No file chosen"}
                </span>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pdf"
                  hidden
                  onChange={(e) => setResume(e.target.files?.[0] || null)}
                />
              </div>
            </div>
          </div>

          <button type="submit" className="ds-intern-submit" disabled={submitting}>
            <span>{submitting ? "Submitting…" : "Submit Internship Application"}</span>
            {!submitting && <span>→</span>}
          </button>
        </form>
      </section>
    </div>
  );
}
