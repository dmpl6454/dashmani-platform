"use client";
import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

const DEPARTMENTS = ["Social Media", "Content Writing", "Graphic Design", "Video Production", "Web Development", "Marketing", "Business Development", "HR & Operations", "Other"];

export default function InternshipPage() {
  const [form, setForm] = useState({
    name: "", email: "", phone: "", college: "", course: "",
    startDate: "", duration: "6 months", department: "",
    skills: "", portfolio: "", linkedin: "", coverLetter: "",
  });
  const [resume, setResume] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const normalized = { ...form, email: form.email.trim().toLowerCase() };
      const fd = new FormData();
      Object.entries(normalized).forEach(([k, v]) => { if (v) fd.append(k, v); });
      if (resume) fd.append("resume", resume);

      const res = await fetch(`${API_URL}/internship/apply`, { method: "POST", body: fd });
      const data = await res.json();
      if (!data.success) throw new Error(data.error?.message || "Submission failed");
      setSubmitted(true);
    } catch (e: any) {
      setError(e.message);
    }
    setSubmitting(false);
  }

  if (submitted) {
    return (
      <div className="max-w-2xl mx-auto text-center py-20">
        <div className="h-16 w-16 mx-auto mb-6 rounded-full bg-green-100 flex items-center justify-center">
          <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
        </div>
        <h1 className="text-3xl font-serif font-light text-[#1A1A1A] mb-3">Application Submitted!</h1>
        <p className="text-[#7A7A7A]">Thank you for applying for the internship at Digital Sukoon. We will review your application and get back to you shortly.</p>
        <a href="/" className="inline-block mt-6 text-sm font-medium text-blue-600 hover:text-blue-800">← Back to Careers</a>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Header */}
      <div className="text-center">
        <span className="inline-block bg-[#FFF3C4] text-[#B8960C] text-xs font-semibold px-3 py-1 rounded-full mb-3">INTERNSHIP PROGRAM</span>
        <h1 className="text-4xl font-serif font-light text-[#1A1A1A]">6-Month Internship</h1>
        <p className="text-[#7A7A7A] mt-2 max-w-lg mx-auto">Join Digital Sukoon as an intern and gain hands-on experience in digital marketing, content creation, and social media management.</p>
      </div>

      {/* Benefits */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { title: "Learn & Grow", desc: "Work with industry professionals on real client projects" },
          { title: "Certificate", desc: "Receive a completion certificate and letter of recommendation" },
          { title: "Stipend", desc: "Performance-based stipend and potential for full-time conversion" },
        ].map((b, i) => (
          <div key={i} className="bg-white rounded-xl border border-[#E8E0D0] p-4 text-center">
            <h3 className="font-semibold text-[#1A1A1A] text-sm mb-1">{b.title}</h3>
            <p className="text-xs text-[#7A7A7A]">{b.desc}</p>
          </div>
        ))}
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] border border-[#E8E0D0] p-6 md:p-8 space-y-5">
        <h2 className="text-xl font-semibold text-[#1A1A1A]">Apply Now</h2>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Full Name *</label>
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Email *</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Phone</label>
            <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">College / University</label>
            <input type="text" value={form.college} onChange={(e) => setForm({ ...form, college: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Course / Degree</label>
            <input type="text" placeholder="e.g., B.Tech, BBA, MBA" value={form.course} onChange={(e) => setForm({ ...form, course: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Preferred Department</label>
            <select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className={inputClass}>
              <option value="">Select Department</option>
              {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Preferred Start Date</label>
            <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Duration</label>
            <select value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} className={inputClass}>
              <option value="3 months">3 Months</option>
              <option value="6 months">6 Months</option>
              <option value="12 months">12 Months</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Skills</label>
          <input type="text" placeholder="e.g., Canva, Photoshop, Content Writing, Video Editing" value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} className={inputClass} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">LinkedIn Profile</label>
            <input type="url" placeholder="https://linkedin.com/in/..." value={form.linkedin} onChange={(e) => setForm({ ...form, linkedin: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Portfolio / Website</label>
            <input type="url" placeholder="https://..." value={form.portfolio} onChange={(e) => setForm({ ...form, portfolio: e.target.value })} className={inputClass} />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Cover Letter</label>
          <textarea placeholder="Tell us why you want to intern at Digital Sukoon and what you hope to learn..." value={form.coverLetter} onChange={(e) => setForm({ ...form, coverLetter: e.target.value })} rows={4} className={`${inputClass} resize-none`} />
        </div>

        <div>
          <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Resume (PDF)</label>
          <input type="file" accept=".pdf,.doc,.docx" onChange={(e) => setResume(e.target.files?.[0] || null)} className="text-sm text-[#7A7A7A]" />
        </div>

        <button type="submit" disabled={submitting} className="w-full bg-[#1A1A1A] text-white py-3 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all">
          {submitting ? "Submitting Application..." : "Submit Internship Application"}
        </button>
      </form>
    </div>
  );
}
