"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { apiFetch, apiUpload } from "@/lib/api";
import Link from "next/link";
import {
  ArrowLeft, MapPin, Briefcase, Clock, IndianRupee, CheckCircle, Send, Loader2,
} from "lucide-react";

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#5B4BF5]/30 focus:border-[#5B4BF5]/50 transition-colors";

const typeLabels: Record<string, string> = {
  FULL_TIME: "Full Time", PART_TIME: "Part Time", CONTRACT: "Contract",
  INTERNSHIP: "Internship", FREELANCE: "Freelance",
};

interface Job {
  id: string; title: string; department?: string; location?: string;
  type: string; experience?: string; salary?: string; description: string;
  requirements?: string; responsibilities?: string; benefits?: string;
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

  // Auto-scroll to form when coming from "Apply Now" button
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
      const formData = new FormData();
      formData.append("applicantName", form.applicantName);
      formData.append("applicantEmail", form.applicantEmail);
      if (form.applicantPhone) formData.append("applicantPhone", form.applicantPhone);
      if (form.coverLetter) formData.append("coverLetter", form.coverLetter);
      if (form.experience) formData.append("experience", form.experience);
      if (form.currentCompany) formData.append("currentCompany", form.currentCompany);
      if (form.linkedinUrl) formData.append("linkedinUrl", form.linkedinUrl);
      if (form.portfolioUrl) formData.append("portfolioUrl", form.portfolioUrl);
      if (fileRef.current?.files?.[0]) formData.append("resume", fileRef.current.files[0]);

      await apiUpload(`/jobs/${id}/apply`, formData);
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message || "Failed to submit application");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="flex justify-center py-20"><div className="h-8 w-8 border-2 border-[#F5D547] border-t-transparent rounded-full animate-spin" /></div>;
  if (!job) return <div className="text-center py-20 text-[#7A7A7A]">Job not found</div>;

  return (
    <div className="space-y-8">
      <Link href="/" className="inline-flex items-center gap-2 text-sm text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to all positions
      </Link>

      {/* Job Header */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5 sm:p-8">
        <h1 className="text-3xl font-serif font-light text-[#1A1A1A] mb-3">{job.title}</h1>
        <div className="flex flex-wrap gap-4 text-sm text-[#7A7A7A] mb-6">
          {job.department && <span className="flex items-center gap-1.5"><Briefcase className="h-4 w-4" /> {job.department}</span>}
          {job.location && <span className="flex items-center gap-1.5"><MapPin className="h-4 w-4" /> {job.location}</span>}
          <span className="flex items-center gap-1.5"><Clock className="h-4 w-4" /> {typeLabels[job.type] || job.type}</span>
          {job.salary && <span className="flex items-center gap-1.5"><IndianRupee className="h-4 w-4" /> {job.salary}</span>}
        </div>
        {job.experience && <p className="text-sm text-[#7A7A7A] mb-4">Experience Required: <strong>{job.experience}</strong></p>}

        {!submitted && (
          <button
            onClick={() => {
              setShowForm(true);
              setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
            }}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-gradient-to-r from-[#3023D0] to-[#5B4BF5] text-white py-3.5 px-8 rounded-full font-semibold shadow-[0_4px_16px_rgba(91,75,245,0.3)] hover:shadow-[0_6px_24px_rgba(91,75,245,0.4)] hover:-translate-y-0.5 transition-all text-base"
          >
            <Send className="h-4 w-4" />
            Apply Now
          </button>
        )}
      </div>

      {/* Job Description Sections */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-8 space-y-6">
        <Section title="About the Role" content={job.description} />
        {job.responsibilities && <Section title="Key Responsibilities" content={job.responsibilities} />}
        {job.requirements && <Section title="Requirements" content={job.requirements} />}
        {job.benefits && <Section title="Benefits" content={job.benefits} />}
      </div>

      {/* Application Form */}
      {showForm && !submitted && (
        <div ref={formRef} id="apply" className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5 sm:p-8">
          <h2 className="text-2xl font-serif font-light text-[#1A1A1A] mb-6">Apply for {job.title}</h2>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Full Name *</label>
                <input type="text" required value={form.applicantName} onChange={(e) => setForm({ ...form, applicantName: e.target.value })} placeholder="Your full name" className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Email *</label>
                <input type="email" required value={form.applicantEmail} onChange={(e) => setForm({ ...form, applicantEmail: e.target.value })} placeholder="your@email.com" className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Phone</label>
                <input type="tel" value={form.applicantPhone} onChange={(e) => setForm({ ...form, applicantPhone: e.target.value })} placeholder="+91..." className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Current Company</label>
                <input type="text" value={form.currentCompany} onChange={(e) => setForm({ ...form, currentCompany: e.target.value })} placeholder="Where do you work now?" className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Experience</label>
                <input type="text" value={form.experience} onChange={(e) => setForm({ ...form, experience: e.target.value })} placeholder="e.g., 2 years" className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">LinkedIn URL</label>
                <input type="url" value={form.linkedinUrl} onChange={(e) => setForm({ ...form, linkedinUrl: e.target.value })} placeholder="https://linkedin.com/in/..." className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Portfolio URL</label>
                <input type="url" value={form.portfolioUrl} onChange={(e) => setForm({ ...form, portfolioUrl: e.target.value })} placeholder="https://..." className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Resume</label>
                <div className="relative">
                  <input ref={fileRef} type="file" accept=".pdf,.doc,.docx" className={inputClass} />
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Cover Letter</label>
              <textarea value={form.coverLetter} onChange={(e) => setForm({ ...form, coverLetter: e.target.value })} rows={5} placeholder="Tell us why you'd be great for this role..." className={inputClass + " resize-none"} />
            </div>

            {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg p-3">{error}</p>}

            <button type="submit" disabled={submitting} className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#1A1A1A] text-white py-3.5 px-8 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all text-base">
              {submitting ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Submitting...</>
              ) : (
                <><Send className="h-4 w-4" /> Submit Application</>
              )}
            </button>
          </form>
        </div>
      )}

      {/* Success */}
      {submitted && (
        <div className="bg-green-50 border border-green-200 rounded-2xl p-8 text-center">
          <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-green-800 mb-2">Application Submitted!</h3>
          <p className="text-sm text-green-700">Thank you for applying. We will review your application and get back to you soon.</p>
        </div>
      )}
    </div>
  );
}

function Section({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <h3 className="text-lg font-semibold text-[#1A1A1A] mb-3">{title}</h3>
      <div className="prose prose-sm text-[#555] max-w-none whitespace-pre-line">{content}</div>
    </div>
  );
}
