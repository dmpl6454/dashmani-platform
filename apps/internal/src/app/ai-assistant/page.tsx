"use client";

import { useState, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import DOMPurify from "dompurify";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import {
  Sparkles, Briefcase, FileText, ScrollText, Receipt, MessageSquare,
  Loader2, Copy, Check, ExternalLink, Send,
} from "lucide-react";

// Pill-shaped dark field (the mockup's form controls). Placeholder doubles as the label, as before.
const inputClass =
  "w-full h-[50px] px-5 rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[14px] placeholder:text-ds-t3 outline-none focus:border-[rgba(233,189,98,.6)] [color-scheme:dark] transition-colors";
const textareaClass =
  "w-full min-h-[78px] px-5 py-4 rounded-[20px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[14px] placeholder:text-ds-t3 outline-none focus:border-[rgba(233,189,98,.6)] resize-none";
const GRID = "grid gap-x-5 gap-y-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))]";

type Tab = "vacancy" | "offer" | "appointment" | "contract" | "salary" | "assist";

const tabs: { id: Tab; label: string; icon: any; desc: string }[] = [
  { id: "vacancy", label: "Job Vacancy", icon: Briefcase, desc: "AI-generate job descriptions" },
  { id: "offer", label: "Offer Letter", icon: FileText, desc: "Generate offer letters" },
  { id: "appointment", label: "Appointment Letter", icon: ScrollText, desc: "Generate appointment letters" },
  { id: "contract", label: "Employment Contract", icon: ScrollText, desc: "Generate contracts" },
  { id: "salary", label: "Salary Slip", icon: Receipt, desc: "Generate & send salary slips" },
  { id: "assist", label: "AI Chat", icon: MessageSquare, desc: "Ask anything HR-related" },
];

// ===== Shared dark UI pieces =====
function SectionHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div>
      <h2 className="text-[19px] font-semibold tracking-[-.01em] text-ds-text">{title}</h2>
      <p className="mt-[5px] text-[13px] text-ds-t2 [text-wrap:pretty]">{sub}</p>
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-[11px] font-semibold tracking-[.12em] uppercase text-ds-gold">
      {children}
      <span className="flex-1 h-px bg-[color:var(--hx-1A2C38)]" />
    </div>
  );
}

function GenerateButton({ loading, onClick, label }: { loading: boolean; onClick: () => void; label: string }) {
  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="inline-flex items-center gap-2 h-11 px-[22px] rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13.5px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60"
      >
        {loading ? <><Loader2 size={16} className="animate-spin" />Generating...</> : <><Sparkles size={16} />{label}</>}
      </button>
    </div>
  );
}

function Notice({ tone, children }: { tone: "error" | "ok"; children: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`px-3 py-2.5 rounded-[8px] text-[12.5px] border ${
        tone === "error"
          ? "bg-[rgba(229,72,77,.08)] border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)]"
          : "bg-[rgba(0,215,160,.08)] border-[rgba(0,215,160,.3)] text-ds-teal"
      }`}
    >
      {children}
    </div>
  );
}

const GHOST_BTN = "inline-flex items-center gap-[7px] h-10 px-[15px] rounded-full border text-[12.5px] font-semibold whitespace-nowrap";

/** Result block for the four document generators: heading, Send / Open & Print, notice and the real AI preview. */
function DocResult({ heading, html, title, sentAt, saving, onSend, openHtml, notice, error }: {
  heading: string; html: string; title: string; sentAt: string | null; saving: boolean;
  onSend: () => void; openHtml: (html: string, title: string) => void; notice: React.ReactNode; error?: string | null;
}) {
  return (
    <div className="flex flex-col gap-3.5 pt-[22px] border-t border-[color:var(--hx-1A2C38)]">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[15px] font-semibold text-ds-text">{heading}</span>
        <div className="flex gap-2 flex-wrap">
          {sentAt ? (
            <span className={`${GHOST_BTN} border-[rgba(0,215,160,.4)] bg-[rgba(0,215,160,.1)] text-ds-teal`}>
              <Check size={14} />Sent to employee at {sentAt}
            </span>
          ) : (
            <button type="button" onClick={onSend} disabled={saving} className={`${GHOST_BTN} border-0 bg-[color:var(--hx-00B386)] text-white hover:bg-[color:var(--hx-00C996)] disabled:opacity-50`}>
              {saving ? <><Loader2 size={14} className="animate-spin" />Sending...</> : <><Send size={14} />Send to Employee</>}
            </button>
          )}
          <button type="button" onClick={() => openHtml(html, title)} className={`${GHOST_BTN} border-[rgba(233,189,98,.45)] text-ds-gold hover:bg-[rgba(233,189,98,.1)]`}>
            <ExternalLink size={14} />Open &amp; Print
          </button>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!sentAt && (
        <div className="px-3.5 py-2.5 rounded-[10px] bg-[rgba(233,189,98,.07)] border border-[rgba(233,189,98,.28)] text-ds-gold text-[12.5px] leading-[1.5]">
          {notice}
        </div>
      )}
      {/* The generated document is real print-ready HTML (sanitised), shown on its own paper. */}
      <div className="h-[420px] rounded-[12px] border border-[color:var(--hx-1A2C38)] bg-ds-inset p-3 sm:p-6">
        <div className="h-full max-w-[720px] mx-auto rounded-[6px] overflow-hidden bg-white shadow-[0_10px_30px_rgba(0,0,0,.4)]">
          <iframe srcDoc={DOMPurify.sanitize(html)} className="w-full h-full" title={`${title} preview`} sandbox="allow-same-origin" />
        </div>
      </div>
    </div>
  );
}

export default function AIAssistantPage() {
  usePageTitle("AI Assistant");
  const [activeTab, setActiveTab] = useState<Tab>("vacancy");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  // ?limit=500 so the document-generator employee pickers list all employees (API caps at 50 otherwise).
  const { data: employeesData } = useSWR("/employees?limit=500", (url: string) => apiFetch<any>(url));
  const employees = employeesData?.data || [];

  function copyText(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function openHtmlWindow(html: string, title: string) {
    const sanitized = DOMPurify.sanitize(html);
    const blob = new Blob([sanitized], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    if (w) { w.document.title = title; }
  }

  return (
    <div className="pb-8">
      <section className="flex items-center gap-3.5 pt-[30px] pb-[22px]">
        <span className="h-[46px] w-[46px] rounded-[13px] bg-[rgba(233,189,98,.12)] border border-[rgba(233,189,98,.4)] text-ds-gold grid place-items-center shrink-0">
          <Sparkles size={20} />
        </span>
        <div className="min-w-0">
          <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">AI Assistant</h1>
          <p className="mt-1 text-[13.5px] text-ds-t2">Powered by Claude AI — Generate documents, job postings, and more</p>
        </div>
      </section>

      {/* Tabs */}
      <section className="flex flex-wrap gap-2.5" role="tablist" aria-label="Generator">
        {tabs.map((tab) => {
          const on = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={on}
              title={tab.desc}
              onClick={() => { setActiveTab(tab.id); setResult(null); }}
              className={`inline-flex items-center gap-[9px] h-12 px-5 rounded-full border text-[14px] font-semibold whitespace-nowrap transition-colors ${
                on
                  ? "border-ds-gold bg-ds-gold text-[color:var(--hx-060D14)]"
                  : "border-ds-line2 bg-ds-inset text-ds-t2 hover:border-[rgba(233,189,98,.55)] hover:text-ds-text"
              }`}
            >
              <tab.icon size={16} />{tab.label}
            </button>
          );
        })}
      </section>

      <section className="relative mt-4 rounded-[18px] border border-[color:var(--hx-2A4658)] bg-ds-card p-5 sm:p-7 shadow-[0_12px_32px_rgba(0,0,0,.35)] flex flex-col gap-[22px] overflow-hidden">
        <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)] opacity-70" />
        {activeTab === "vacancy" && <VacancyGenerator loading={loading} setLoading={setLoading} result={result} setResult={setResult} copyText={copyText} copied={copied} />}
        {activeTab === "offer" && <OfferLetterGenerator employees={employees} loading={loading} setLoading={setLoading} result={result} setResult={setResult} openHtml={openHtmlWindow} />}
        {activeTab === "appointment" && <AppointmentGenerator employees={employees} loading={loading} setLoading={setLoading} result={result} setResult={setResult} openHtml={openHtmlWindow} />}
        {activeTab === "contract" && <ContractGenerator employees={employees} loading={loading} setLoading={setLoading} result={result} setResult={setResult} openHtml={openHtmlWindow} />}
        {activeTab === "salary" && <SalarySlipGenerator employees={employees} loading={loading} setLoading={setLoading} result={result} setResult={setResult} openHtml={openHtmlWindow} />}
        {activeTab === "assist" && <AIChat loading={loading} setLoading={setLoading} employees={employees} />}
      </section>
    </div>
  );
}

// ===== Vacancy Generator =====
function VacancyGenerator({ loading, setLoading, result, setResult, copyText, copied }: any) {
  const [form, setForm] = useState({ title: "", department: "", type: "FULL_TIME", experience: "", salary: "", location: "", notes: "" });
  const [error, setError] = useState("");
  const [posted, setPosted] = useState(false);
  const [posting, setPosting] = useState(false);

  async function generate() {
    if (!form.title) return setError("Job title is required");
    setError("");
    setPosted(false);
    setLoading(true);
    setResult(null);
    try {
      const res = await apiFetch<any>("/admin/ai/generate-job", { method: "POST", body: JSON.stringify(form) });
      setResult(res.data);
    } catch (e: any) { setError(e.message || "Generation failed"); }
    finally { setLoading(false); }
  }

  async function postJob() {
    if (!result || posting) return;
    setError("");
    setPosting(true);
    try {
      await apiFetch("/admin/jobs", { method: "POST", body: JSON.stringify({
        title: form.title, department: form.department, location: form.location,
        type: form.type, experience: form.experience, salary: form.salary,
        description: result.description, requirements: result.requirements,
        responsibilities: result.responsibilities, benefits: result.benefits, status: "ACTIVE",
      })});
      setPosted(true);
    } catch (e: any) { setError(e.message || "Failed to post the job"); }
    finally { setPosting(false); }
  }

  return (
    <>
      <SectionHead title="Generate Job Vacancy" sub="AI will create a complete job description with requirements, responsibilities, and benefits" />
      <div className="flex flex-col gap-[22px]">
        <div className={GRID}>
          <input type="text" placeholder="Job Title *" title="Job Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputClass} />
          <input type="text" placeholder="Department" title="Department" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className={inputClass} />
          <select value={form.type} title="Type" onChange={(e) => setForm({ ...form, type: e.target.value })} className={`${inputClass} cursor-pointer`}>
            <option value="FULL_TIME" className="bg-ds-card">Full Time</option>
            <option value="PART_TIME" className="bg-ds-card">Part Time</option>
            <option value="CONTRACT" className="bg-ds-card">Contract</option>
            <option value="INTERNSHIP" className="bg-ds-card">Internship</option>
            <option value="FREELANCE" className="bg-ds-card">Freelance</option>
          </select>
          <input type="text" placeholder="Experience (e.g., 2-4 years)" title="Experience" value={form.experience} onChange={(e) => setForm({ ...form, experience: e.target.value })} className={inputClass} />
          <input type="text" placeholder="Salary (e.g., 3-5 LPA)" title="Salary" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} className={inputClass} />
          <input type="text" placeholder="Location" title="Location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={inputClass} />
        </div>
        <textarea placeholder="Additional notes or specific requirements..." value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className={textareaClass} />
        {error && !result?.html && <Notice tone="error">{error}</Notice>}
        <GenerateButton loading={loading} onClick={generate} label="Generate with AI" />
      </div>

      {result && (
        <div className="flex flex-col gap-4 pt-[22px] border-t border-[color:var(--hx-1A2C38)]">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-[15px] font-semibold text-ds-text">Generated Job Description</span>
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => copyText(`${result.description}\n\nRequirements:\n${result.requirements}\n\nResponsibilities:\n${result.responsibilities}\n\nBenefits:\n${result.benefits}`)}
                className={`${GHOST_BTN} h-[38px] border-ds-line2 text-ds-t2 hover:text-ds-text hover:border-[color:var(--hx-2A4658)]`}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy All"}
              </button>
              <button
                type="button"
                onClick={postJob}
                disabled={posting}
                className={`${GHOST_BTN} h-[38px] border-[rgba(0,215,160,.4)] bg-[rgba(0,215,160,.1)] text-ds-teal hover:bg-[rgba(0,215,160,.18)] disabled:opacity-70`}
              >
                {posting ? <><Loader2 size={13} className="animate-spin" />Posting...</> : <><Briefcase size={13} />Post Job Now</>}
              </button>
            </div>
          </div>
          {posted && <Notice tone="ok">Job posted successfully.</Notice>}
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))]">
            {[
              { label: "Description", value: result.description },
              { label: "Requirements", value: result.requirements },
              { label: "Responsibilities", value: result.responsibilities },
              { label: "Benefits", value: result.benefits },
            ].map((section) => (
              <div key={section.label} className="px-[18px] py-4 rounded-[12px] bg-ds-inset border border-[color:var(--hx-1A2C38)]">
                <div className="text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3">{section.label}</div>
                <p className="mt-2 text-[13px] leading-[1.65] text-ds-t5 whitespace-pre-line break-words">{section.value}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ===== Employee Select Component =====
function EmployeeSelect({ employees, value, onChange }: { employees: any[]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} title="Employee" onChange={(e) => onChange(e.target.value)} className={`${inputClass} cursor-pointer`}>
      <option value="" className="bg-ds-card">Select Employee *</option>
      {employees.map((emp: any) => (
        <option key={emp.id} value={emp.id} className="bg-ds-card">{emp.name} — {emp.profile?.designation || "No designation"}</option>
      ))}
    </select>
  );
}

const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const sentTime = () => new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

// ===== Offer Letter Generator =====
function OfferLetterGenerator({ employees, loading, setLoading, result, setResult, openHtml }: any) {
  const [form, setForm] = useState({ employeeId: "", designation: "", department: "", salary: "", joiningDate: "", probationMonths: "3", location: "", specialTerms: "" });
  const [saving, setSaving] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function generate() {
    if (!form.employeeId || !form.designation || !form.salary || !form.joiningDate) return setError("Fill required fields");
    setError("");
    setLoading(true);
    setResult(null);
    setSentAt(null);
    try {
      const res = await apiFetch<any>("/admin/ai/generate-offer-letter", {
        method: "POST", body: JSON.stringify({ ...form, salary: parseFloat(form.salary), probationMonths: parseInt(form.probationMonths) }),
      });
      setResult(res.data);
    } catch (e: any) { setError(e.message || "Generation failed"); }
    finally { setLoading(false); }
  }

  async function sendToEmployee() {
    if (!form.employeeId || !form.designation || !form.salary || !form.joiningDate) return;
    setError("");
    setSaving(true);
    try {
      await apiFetch<any>("/admin/offer-letters", {
        method: "POST",
        body: JSON.stringify({
          employeeId: form.employeeId,
          offerDate: todayKey(),
          joiningDate: form.joiningDate,
          designation: form.designation,
          department: form.department || undefined,
          salary: parseFloat(form.salary),
          probationMonths: parseInt(form.probationMonths),
          location: form.location || undefined,
        }),
      });
      setSentAt(sentTime());
    } catch (e: any) { setError(e.message || "Failed to send"); }
    finally { setSaving(false); }
  }

  return (
    <>
      <SectionHead title="Generate Offer Letter" sub="AI will create a professional offer letter ready for printing" />
      <div className="flex flex-col gap-[22px]">
        <div className={GRID}>
          <EmployeeSelect employees={employees} value={form.employeeId} onChange={(v) => { setForm({ ...form, employeeId: v }); setSentAt(null); }} />
          <input type="text" placeholder="Designation *" title="Designation" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} className={inputClass} />
          <input type="text" placeholder="Department" title="Department" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className={inputClass} />
          <input type="number" placeholder="Monthly CTC (INR) *" title="Monthly CTC (INR)" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} className={inputClass} />
          <input type="date" placeholder="Joining Date *" title="Joining Date" value={form.joiningDate} onChange={(e) => setForm({ ...form, joiningDate: e.target.value })} className={inputClass} />
          <input type="number" placeholder="Probation (months)" title="Probation (months)" value={form.probationMonths} onChange={(e) => setForm({ ...form, probationMonths: e.target.value })} className={inputClass} />
          <input type="text" placeholder="Location" title="Location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={inputClass} />
        </div>
        <textarea placeholder="Special terms or conditions..." value={form.specialTerms} onChange={(e) => setForm({ ...form, specialTerms: e.target.value })} rows={2} className={textareaClass} />
        {error && !result?.html && <Notice tone="error">{error}</Notice>}
        <GenerateButton loading={loading} onClick={generate} label="Generate Offer Letter" />
      </div>
      {result?.html && (
        <DocResult
          heading={`Offer Letter for ${result.employeeName}`}
          html={result.html}
          title={`Offer Letter - ${result.employeeName}`}
          sentAt={sentAt}
          saving={saving}
          onSend={sendToEmployee}
          error={error}
          openHtml={openHtml}
          notice={<>Preview only — click <strong>Send to Employee</strong> to save this offer letter so they can view it in the HR portal.</>}
        />
      )}
    </>
  );
}

// ===== Appointment Letter Generator =====
function AppointmentGenerator({ employees, loading, setLoading, result, setResult, openHtml }: any) {
  const [form, setForm] = useState({ employeeId: "", designation: "", department: "", salary: "", joiningDate: "", probationMonths: "3", noticePeriod: "30", location: "", specialClauses: "" });
  const [saving, setSaving] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function generate() {
    if (!form.employeeId || !form.designation || !form.salary || !form.joiningDate) return setError("Fill required fields");
    setError("");
    setLoading(true);
    setResult(null);
    setSentAt(null);
    try {
      const res = await apiFetch<any>("/admin/ai/generate-appointment-letter", {
        method: "POST", body: JSON.stringify({ ...form, salary: parseFloat(form.salary), probationMonths: parseInt(form.probationMonths), noticePeriod: parseInt(form.noticePeriod) }),
      });
      setResult(res.data);
    } catch (e: any) { setError(e.message || "Generation failed"); }
    finally { setLoading(false); }
  }

  async function sendToEmployee() {
    if (!form.employeeId || !form.designation || !form.salary || !form.joiningDate) return;
    setError("");
    setSaving(true);
    try {
      await apiFetch<any>("/admin/offer-letters", {
        method: "POST",
        body: JSON.stringify({
          employeeId: form.employeeId,
          letterType: "APPOINTMENT",
          offerDate: todayKey(),
          joiningDate: form.joiningDate,
          designation: form.designation,
          department: form.department || undefined,
          salary: parseFloat(form.salary),
          probationMonths: parseInt(form.probationMonths),
          noticePeriod: parseInt(form.noticePeriod),
          location: form.location || undefined,
        }),
      });
      setSentAt(sentTime());
    } catch (e: any) { setError(e.message || "Failed to send"); }
    finally { setSaving(false); }
  }

  return (
    <>
      <SectionHead title="Generate Appointment Letter" sub="AI will create a comprehensive appointment letter with all legal clauses" />
      <div className="flex flex-col gap-[22px]">
        <div className={GRID}>
          <EmployeeSelect employees={employees} value={form.employeeId} onChange={(v) => { setForm({ ...form, employeeId: v }); setSentAt(null); }} />
          <input type="text" placeholder="Designation *" title="Designation" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} className={inputClass} />
          <input type="text" placeholder="Department" title="Department" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className={inputClass} />
          <input type="number" placeholder="Monthly CTC (INR) *" title="Monthly CTC (INR)" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} className={inputClass} />
          <input type="date" placeholder="Joining Date *" title="Joining Date" value={form.joiningDate} onChange={(e) => setForm({ ...form, joiningDate: e.target.value })} className={inputClass} />
          <input type="number" placeholder="Probation (months)" title="Probation (months)" value={form.probationMonths} onChange={(e) => setForm({ ...form, probationMonths: e.target.value })} className={inputClass} />
          <input type="number" placeholder="Notice Period (days)" title="Notice Period (days)" value={form.noticePeriod} onChange={(e) => setForm({ ...form, noticePeriod: e.target.value })} className={inputClass} />
          <input type="text" placeholder="Location" title="Location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={inputClass} />
        </div>
        <textarea placeholder="Special clauses or conditions..." value={form.specialClauses} onChange={(e) => setForm({ ...form, specialClauses: e.target.value })} rows={2} className={textareaClass} />
        {error && !result?.html && <Notice tone="error">{error}</Notice>}
        <GenerateButton loading={loading} onClick={generate} label="Generate Appointment Letter" />
      </div>
      {result?.html && (
        <DocResult
          heading={`Appointment Letter for ${result.employeeName}`}
          html={result.html}
          title={`Appointment Letter - ${result.employeeName}`}
          sentAt={sentAt}
          saving={saving}
          onSend={sendToEmployee}
          error={error}
          openHtml={openHtml}
          notice={<>Preview only — click <strong>Send to Employee</strong> to save this appointment letter so they can view it in the HR portal.</>}
        />
      )}
    </>
  );
}

// ===== Contract Generator =====
function ContractGenerator({ employees, loading, setLoading, result, setResult, openHtml }: any) {
  const [form, setForm] = useState({ employeeId: "", designation: "", department: "", salary: "", contractDate: "", probationMonths: "3", noticePeriod: "30", specialClauses: "" });
  const [saving, setSaving] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function generate() {
    if (!form.employeeId || !form.designation || !form.salary || !form.contractDate) return setError("Fill required fields");
    setError("");
    setLoading(true);
    setResult(null);
    setSentAt(null);
    try {
      const res = await apiFetch<any>("/admin/ai/generate-contract", {
        method: "POST", body: JSON.stringify({ ...form, salary: parseFloat(form.salary), probationMonths: parseInt(form.probationMonths), noticePeriod: parseInt(form.noticePeriod) }),
      });
      setResult(res.data);
    } catch (e: any) { setError(e.message || "Generation failed"); }
    finally { setLoading(false); }
  }

  async function sendToEmployee() {
    if (!form.employeeId || !form.designation || !form.salary || !form.contractDate) return;
    setError("");
    setSaving(true);
    try {
      await apiFetch<any>("/admin/contracts", {
        method: "POST",
        body: JSON.stringify({
          employeeId: form.employeeId,
          contractDate: form.contractDate,
          designation: form.designation,
          department: form.department || undefined,
          salary: parseFloat(form.salary),
          probationMonths: parseInt(form.probationMonths),
          noticePeriod: parseInt(form.noticePeriod),
        }),
      });
      setSentAt(sentTime());
    } catch (e: any) { setError(e.message || "Failed to send"); }
    finally { setSaving(false); }
  }

  return (
    <>
      <SectionHead title="Generate Employment Contract" sub="AI will create a legally sound employment contract with all standard clauses" />
      <div className="flex flex-col gap-[22px]">
        <div className={GRID}>
          <EmployeeSelect employees={employees} value={form.employeeId} onChange={(v) => { setForm({ ...form, employeeId: v }); setSentAt(null); }} />
          <input type="text" placeholder="Designation *" title="Designation" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} className={inputClass} />
          <input type="text" placeholder="Department" title="Department" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className={inputClass} />
          <input type="number" placeholder="Monthly CTC (INR) *" title="Monthly CTC (INR)" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} className={inputClass} />
          <input type="date" placeholder="Contract Date *" title="Contract Date" value={form.contractDate} onChange={(e) => setForm({ ...form, contractDate: e.target.value })} className={inputClass} />
          <input type="number" placeholder="Probation (months)" title="Probation (months)" value={form.probationMonths} onChange={(e) => setForm({ ...form, probationMonths: e.target.value })} className={inputClass} />
          <input type="number" placeholder="Notice Period (days)" title="Notice Period (days)" value={form.noticePeriod} onChange={(e) => setForm({ ...form, noticePeriod: e.target.value })} className={inputClass} />
        </div>
        <textarea placeholder="Special clauses..." value={form.specialClauses} onChange={(e) => setForm({ ...form, specialClauses: e.target.value })} rows={2} className={textareaClass} />
        {error && !result?.html && <Notice tone="error">{error}</Notice>}
        <GenerateButton loading={loading} onClick={generate} label="Generate Contract" />
      </div>
      {result?.html && (
        <DocResult
          heading={`Employment Contract for ${result.employeeName}`}
          html={result.html}
          title={`Contract - ${result.employeeName}`}
          sentAt={sentAt}
          saving={saving}
          onSend={sendToEmployee}
          error={error}
          openHtml={openHtml}
          notice={<>Preview only — click <strong>Send to Employee</strong> to save this contract so they can review and sign it in the HR portal.</>}
        />
      )}
    </>
  );
}

// ===== Salary Slip Generator =====
function SalarySlipGenerator({ employees, loading, setLoading, result, setResult, openHtml }: any) {
  const [form, setForm] = useState({
    employeeId: "",
    month: String(new Date().getMonth() + 1),
    year: String(new Date().getFullYear()),
    basicSalary: "",
    hra: "",
    conveyance: "",
    medicalAllowance: "",
    specialAllowance: "",
    otherEarnings: "0",
    pf: "",
    esi: "",
    tax: "0",
    otherDeductions: "0",
    remarks: "",
  });
  const [saving, setSaving] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [error, setError] = useState("");

  function handleEmployeeChange(id: string) {
    setForm((prev) => { const f = { ...prev, employeeId: id }; setSentAt(null);
      const emp = employees.find((e: any) => e.id === id);
      const salary = emp?.profile?.salary;
      if (salary) {
        const basic = Math.round(salary * 0.4 * 100) / 100;
        f.basicSalary = String(basic);
        f.hra = String(Math.round(salary * 0.2 * 100) / 100);
        f.conveyance = String(Math.round(salary * 0.05 * 100) / 100);
        f.medicalAllowance = String(Math.round(salary * 0.05 * 100) / 100);
        f.specialAllowance = String(Math.round(salary * 0.2 * 100) / 100);
        f.otherEarnings = String(Math.round(salary * 0.1 * 100) / 100);
        f.pf = String(Math.round(basic * 0.12 * 100) / 100);
        f.esi = String(Math.round(salary * 0.0075 * 100) / 100);
      }
      return f;
    });
  }

  const payload = () => ({
    employeeId: form.employeeId,
    month: parseInt(form.month),
    year: parseInt(form.year),
    basicSalary: parseFloat(form.basicSalary || "0"),
    hra: parseFloat(form.hra || "0"),
    conveyance: parseFloat(form.conveyance || "0"),
    medicalAllowance: parseFloat(form.medicalAllowance || "0"),
    specialAllowance: parseFloat(form.specialAllowance || "0"),
    otherEarnings: parseFloat(form.otherEarnings || "0"),
    pf: parseFloat(form.pf || "0"),
    esi: parseFloat(form.esi || "0"),
    tax: parseFloat(form.tax || "0"),
    otherDeductions: parseFloat(form.otherDeductions || "0"),
    remarks: form.remarks || undefined,
  });

  async function generate() {
    if (!form.employeeId || !form.basicSalary) return setError("Select employee and fill basic salary");
    setError("");
    setLoading(true);
    setResult(null);
    setSentAt(null);
    try {
      const res = await apiFetch<any>("/admin/ai/salary-slip/preview", { method: "POST", body: JSON.stringify(payload()) });
      setResult(res.data);
    } catch (e: any) { setError(e.message || "Generation failed"); }
    finally { setLoading(false); }
  }

  async function sendToEmployee() {
    if (!form.employeeId || !form.basicSalary) return;
    setError("");
    setSaving(true);
    try {
      await apiFetch<any>("/admin/salary-slips/generate", { method: "POST", body: JSON.stringify(payload()) });
      setSentAt(sentTime());
    } catch (e: any) {
      if (e.message?.includes("Unique constraint") || e.message?.includes("already exists")) {
        setError("A salary slip for this employee and month already exists. Edit it from the /salary-slips page instead.");
      } else {
        setError(e.message || "Failed to send");
      }
    }
    finally { setSaving(false); }
  }

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return (
    <>
      <SectionHead title="Generate Salary Slip" sub="AI-styled salary slip — preview, then send to the employee. They'll see it in the HR portal under 'Salary Slips'." />
      <div className="flex flex-col gap-[22px]">
        <div className={GRID}>
          <EmployeeSelect employees={employees} value={form.employeeId} onChange={handleEmployeeChange} />
          <select value={form.month} title="Month" onChange={(e) => setForm({ ...form, month: e.target.value })} className={`${inputClass} cursor-pointer`}>
            {MONTHS.map((m, i) => <option key={i} value={i + 1} className="bg-ds-card">{m}</option>)}
          </select>
          <select value={form.year} title="Year" onChange={(e) => setForm({ ...form, year: e.target.value })} className={`${inputClass} cursor-pointer`}>
            {[2024, 2025, 2026, 2027].map((y) => <option key={y} value={y} className="bg-ds-card">{y}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-3">
          <GroupLabel>Earnings</GroupLabel>
          <div className="grid gap-x-5 gap-y-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,200px),1fr))]">
            {[
              { key: "basicSalary", label: "Basic Salary *" },
              { key: "hra", label: "HRA" },
              { key: "conveyance", label: "Conveyance" },
              { key: "medicalAllowance", label: "Medical Allowance" },
              { key: "specialAllowance", label: "Special Allowance" },
              { key: "otherEarnings", label: "Other Earnings" },
            ].map(({ key, label }) => (
              <input key={key} type="number" step="0.01" placeholder={label} title={label.replace(" *", "")}
                value={form[key as keyof typeof form]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                className={inputClass} />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <GroupLabel>Deductions</GroupLabel>
          <div className="grid gap-x-5 gap-y-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,180px),1fr))]">
            {[
              { key: "pf", label: "PF" },
              { key: "esi", label: "ESI" },
              { key: "tax", label: "Income Tax (TDS)" },
              { key: "otherDeductions", label: "Other Deductions" },
            ].map(({ key, label }) => (
              <input key={key} type="number" step="0.01" placeholder={label} title={label}
                value={form[key as keyof typeof form]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                className={inputClass} />
            ))}
          </div>
        </div>
        <textarea placeholder="Remarks (optional)" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} rows={2} className={textareaClass} />
        {error && !result?.html && <Notice tone="error">{error}</Notice>}
        <GenerateButton loading={loading} onClick={generate} label="Generate Salary Slip" />
      </div>
      {result?.html && (
        <DocResult
          heading={`Salary Slip for ${result.employeeName}`}
          html={result.html}
          title={`Salary Slip - ${result.employeeName}`}
          sentAt={sentAt}
          saving={saving}
          onSend={sendToEmployee}
          error={error}
          openHtml={openHtml}
          notice={<>Preview only — click <strong>Send to Employee</strong> to save this salary slip. It will appear in /salary-slips for approval and in the employee&apos;s HR portal.</>}
        />
      )}
    </>
  );
}

// ===== AI Chat =====
function AIChat({ loading, setLoading, employees }: any) {
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [employeeError, setEmployeeError] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

  async function send() {
    if (!input.trim()) return;
    if (!employeeId) {
      setEmployeeError("Please select an employee");
      return;
    }
    setEmployeeError("");
    const userMsg = input;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);
    try {
      const res = await apiFetch<any>("/admin/ai/assist", {
        method: "POST", body: JSON.stringify({ task: userMsg, employeeId }),
      });
      setMessages((prev) => [...prev, { role: "assistant", content: res.data.response }]);
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${e.message}` }]);
    }
    finally { setLoading(false); }
  }

  const AiBadge = () => (
    <span className="h-7 w-7 rounded-[8px] bg-[rgba(233,189,98,.12)] text-ds-gold grid place-items-center shrink-0"><Sparkles size={14} /></span>
  );

  return (
    <>
      <SectionHead title="AI Chat Assistant" sub="Ask anything — HR policies, email drafts, performance feedback, warning letters, etc." />
      <div className="flex flex-col gap-3.5">
        <label className="flex flex-col gap-[7px] text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase max-w-[420px]">
          <span>Employee<span className="text-ds-gold ml-[3px]">*</span></span>
          <select
            value={employeeId}
            onChange={(e) => { setEmployeeId(e.target.value); if (e.target.value) setEmployeeError(""); }}
            className={`w-full h-11 px-3.5 rounded-[10px] border bg-ds-inset text-ds-text text-[16px] sm:text-[13.5px] normal-case tracking-normal font-normal outline-none [color-scheme:dark] cursor-pointer focus:border-ds-gold ${employeeError ? "border-[rgba(229,72,77,.6)]" : "border-ds-line2"}`}
          >
            <option value="" className="bg-ds-card">Select Employee *</option>
            {employees.map((emp: any) => (
              <option key={emp.id} value={emp.id} className="bg-ds-card">{emp.name} — {emp.profile?.designation || "No designation"}</option>
            ))}
          </select>
        </label>
        {employeeError && <p role="alert" className="-mt-1.5 text-[12px] font-semibold text-[color:var(--hx-FB7185)]">{employeeError}</p>}
        <div className="h-[380px] overflow-y-auto rounded-[14px] border border-[color:var(--hx-1A2C38)] bg-ds-inset p-[18px] flex flex-col gap-3">
          {messages.length === 0 && (
            <div className="m-auto flex flex-col items-center gap-3.5 text-center p-5">
              <span className="h-11 w-11 rounded-[12px] bg-[rgba(233,189,98,.1)] text-ds-gold grid place-items-center"><Sparkles size={20} /></span>
              <span className="text-[13.5px] text-ds-t2">Ask me anything HR-related</span>
              <div className="flex flex-wrap gap-2 justify-center max-w-[560px]">
                {["Draft a warning letter", "Write a promotion announcement email", "Suggest interview questions for a designer", "Draft work-from-home policy"].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setInput(s)}
                    className="h-[34px] px-3.5 rounded-full border border-ds-line2 bg-ds-card text-ds-t2 text-[12.5px] hover:text-ds-text hover:border-[rgba(233,189,98,.45)]"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((msg, i) => {
            const user = msg.role === "user";
            return (
              <div key={i} className={`flex gap-2.5 items-start ${user ? "justify-end" : "justify-start"}`}>
                {!user && <AiBadge />}
                <div
                  className={`max-w-[78%] px-[15px] py-[11px] rounded-[14px] border text-[13.5px] leading-[1.6] whitespace-pre-wrap break-words ${
                    user ? "bg-ds-gold border-ds-gold text-[color:var(--hx-060D14)]" : "bg-ds-card border-[color:var(--hx-1A2C38)] text-ds-t5"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            );
          })}
          {loading && (
            <div className="flex items-center gap-2.5 text-ds-t3 text-[13px]"><AiBadge />Thinking...</div>
          )}
          <div ref={messagesEndRef} />
        </div>
        <div className="flex gap-2.5">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && send()}
            placeholder="Type your question..."
            aria-label="Your question"
            className="flex-1 min-w-0 h-12 px-5 rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13.5px] placeholder:text-ds-t3 outline-none focus:border-[rgba(233,189,98,.6)]"
          />
          <button
            type="button"
            onClick={send}
            disabled={loading || !input.trim()}
            className="inline-flex items-center gap-2 h-12 px-[22px] rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13.5px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-50"
          >
            <Send size={15} />Send
          </button>
        </div>
      </div>
    </>
  );
}
