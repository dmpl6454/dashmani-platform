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

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

type Tab = "vacancy" | "offer" | "appointment" | "contract" | "salary" | "assist";

const tabs: { id: Tab; label: string; icon: any; desc: string }[] = [
  { id: "vacancy", label: "Job Vacancy", icon: Briefcase, desc: "AI-generate job descriptions" },
  { id: "offer", label: "Offer Letter", icon: FileText, desc: "Generate offer letters" },
  { id: "appointment", label: "Appointment Letter", icon: ScrollText, desc: "Generate appointment letters" },
  { id: "contract", label: "Employment Contract", icon: ScrollText, desc: "Generate contracts" },
  { id: "salary", label: "Salary Slip", icon: Receipt, desc: "Generate & send salary slips" },
  { id: "assist", label: "AI Chat", icon: MessageSquare, desc: "Ask anything HR-related" },
];

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
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-[#F5D547] to-[#E8B830] flex items-center justify-center">
          <Sparkles size={20} className="text-[#1A1A1A]" />
        </div>
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">AI Assistant</h1>
          <p className="text-sm text-[#7A7A7A]">Powered by Claude AI — Generate documents, job postings, and more</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 flex-wrap">
        {tabs.map((tab) => (
          <button key={tab.id} onClick={() => { setActiveTab(tab.id); setResult(null); }}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${activeTab === tab.id ? "bg-[#1A1A1A] text-white shadow-lg" : "bg-white text-[#7A7A7A] border border-[#E8E0D0] hover:border-[#F5D547]"}`}>
            <tab.icon size={16} />{tab.label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6">
        {activeTab === "vacancy" && <VacancyGenerator loading={loading} setLoading={setLoading} result={result} setResult={setResult} copyText={copyText} copied={copied} />}
        {activeTab === "offer" && <OfferLetterGenerator employees={employees} loading={loading} setLoading={setLoading} result={result} setResult={setResult} openHtml={openHtmlWindow} />}
        {activeTab === "appointment" && <AppointmentGenerator employees={employees} loading={loading} setLoading={setLoading} result={result} setResult={setResult} openHtml={openHtmlWindow} />}
        {activeTab === "contract" && <ContractGenerator employees={employees} loading={loading} setLoading={setLoading} result={result} setResult={setResult} openHtml={openHtmlWindow} />}
        {activeTab === "salary" && <SalarySlipGenerator employees={employees} loading={loading} setLoading={setLoading} result={result} setResult={setResult} openHtml={openHtmlWindow} />}
        {activeTab === "assist" && <AIChat loading={loading} setLoading={setLoading} employees={employees} />}
      </div>
    </div>
  );
}

// ===== Vacancy Generator =====
function VacancyGenerator({ loading, setLoading, result, setResult, copyText, copied }: any) {
  const [form, setForm] = useState({ title: "", department: "", type: "FULL_TIME", experience: "", salary: "", location: "", notes: "" });

  async function generate() {
    if (!form.title) return alert("Job title is required");
    setLoading(true);
    setResult(null);
    try {
      const res = await apiFetch<any>("/admin/ai/generate-job", { method: "POST", body: JSON.stringify(form) });
      setResult(res.data);
    } catch (e: any) { alert(e.message); }
    finally { setLoading(false); }
  }

  async function postJob() {
    if (!result) return;
    try {
      await apiFetch("/admin/jobs", { method: "POST", body: JSON.stringify({
        title: form.title, department: form.department, location: form.location,
        type: form.type, experience: form.experience, salary: form.salary,
        description: result.description, requirements: result.requirements,
        responsibilities: result.responsibilities, benefits: result.benefits, status: "ACTIVE",
      })});
      alert("Job posted successfully!");
    } catch (e: any) { alert(e.message); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-[#1A1A1A] mb-1">Generate Job Vacancy</h2>
        <p className="text-sm text-[#7A7A7A]">AI will create a complete job description with requirements, responsibilities, and benefits</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <input type="text" placeholder="Job Title *" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputClass} />
        <input type="text" placeholder="Department" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className={inputClass} />
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className={inputClass}>
          <option value="FULL_TIME">Full Time</option>
          <option value="PART_TIME">Part Time</option>
          <option value="CONTRACT">Contract</option>
          <option value="INTERNSHIP">Internship</option>
          <option value="FREELANCE">Freelance</option>
        </select>
        <input type="text" placeholder="Experience (e.g., 2-4 years)" value={form.experience} onChange={(e) => setForm({ ...form, experience: e.target.value })} className={inputClass} />
        <input type="text" placeholder="Salary (e.g., 3-5 LPA)" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} className={inputClass} />
        <input type="text" placeholder="Location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={inputClass} />
      </div>
      <textarea placeholder="Additional notes or specific requirements..." value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className={inputClass + " resize-none"} />
      <button onClick={generate} disabled={loading} className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 flex items-center gap-2">
        {loading ? <><Loader2 size={16} className="animate-spin" />Generating...</> : <><Sparkles size={16} />Generate with AI</>}
      </button>

      {result && (
        <div className="space-y-4 border-t border-[#F0EAD8] pt-5">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-[#1A1A1A]">Generated Job Description</h3>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => copyText(`${result.description}\n\nRequirements:\n${result.requirements}\n\nResponsibilities:\n${result.responsibilities}\n\nBenefits:\n${result.benefits}`)}
                className="flex items-center gap-1 text-xs text-[#7A7A7A] hover:text-[#1A1A1A] border border-[#E8E0D0] rounded-full px-3 py-1.5">
                {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "Copied" : "Copy All"}
              </button>
              <button onClick={postJob} className="flex items-center gap-1 text-xs font-medium bg-green-50 text-green-700 rounded-full px-4 py-1.5 hover:bg-green-100">
                <Briefcase size={12} />Post Job Now
              </button>
            </div>
          </div>
          {[
            { label: "Description", value: result.description },
            { label: "Requirements", value: result.requirements },
            { label: "Responsibilities", value: result.responsibilities },
            { label: "Benefits", value: result.benefits },
          ].map((section) => (
            <div key={section.label}>
              <p className="text-xs font-medium text-[#7A7A7A] mb-1">{section.label}</p>
              <div className="bg-[#FEFCF7] rounded-xl p-4 text-sm text-[#555] whitespace-pre-line">{section.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== Employee Select Component =====
function EmployeeSelect({ employees, value, onChange }: { employees: any[]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
      <option value="">Select Employee *</option>
      {employees.map((emp: any) => (
        <option key={emp.id} value={emp.id}>{emp.name} — {emp.profile?.designation || "No designation"}</option>
      ))}
    </select>
  );
}

// ===== Offer Letter Generator =====
function OfferLetterGenerator({ employees, loading, setLoading, result, setResult, openHtml }: any) {
  const [form, setForm] = useState({ employeeId: "", designation: "", department: "", salary: "", joiningDate: "", probationMonths: "3", location: "", specialTerms: "" });
  const [saving, setSaving] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);

  async function generate() {
    if (!form.employeeId || !form.designation || !form.salary || !form.joiningDate) return alert("Fill required fields");
    setLoading(true);
    setResult(null);
    setSentAt(null);
    try {
      const res = await apiFetch<any>("/admin/ai/generate-offer-letter", {
        method: "POST", body: JSON.stringify({ ...form, salary: parseFloat(form.salary), probationMonths: parseInt(form.probationMonths) }),
      });
      setResult(res.data);
    } catch (e: any) { alert(e.message); }
    finally { setLoading(false); }
  }

  async function sendToEmployee() {
    if (!form.employeeId || !form.designation || !form.salary || !form.joiningDate) return;
    setSaving(true);
    try {
      await apiFetch<any>("/admin/offer-letters", {
        method: "POST",
        body: JSON.stringify({
          employeeId: form.employeeId,
          offerDate: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })(),
          joiningDate: form.joiningDate,
          designation: form.designation,
          department: form.department || undefined,
          salary: parseFloat(form.salary),
          probationMonths: parseInt(form.probationMonths),
          location: form.location || undefined,
        }),
      });
      setSentAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }));
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-[#1A1A1A] mb-1">Generate Offer Letter</h2>
        <p className="text-sm text-[#7A7A7A]">AI will create a professional offer letter ready for printing</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <EmployeeSelect employees={employees} value={form.employeeId} onChange={(v) => { setForm({ ...form, employeeId: v }); setSentAt(null); }} />
        <input type="text" placeholder="Designation *" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} className={inputClass} />
        <input type="text" placeholder="Department" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className={inputClass} />
        <input type="number" placeholder="Monthly CTC (INR) *" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} className={inputClass} />
        <input type="date" placeholder="Joining Date *" value={form.joiningDate} onChange={(e) => setForm({ ...form, joiningDate: e.target.value })} className={inputClass} />
        <input type="number" placeholder="Probation (months)" value={form.probationMonths} onChange={(e) => setForm({ ...form, probationMonths: e.target.value })} className={inputClass} />
        <input type="text" placeholder="Location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={inputClass} />
      </div>
      <textarea placeholder="Special terms or conditions..." value={form.specialTerms} onChange={(e) => setForm({ ...form, specialTerms: e.target.value })} rows={2} className={inputClass + " resize-none"} />
      <button onClick={generate} disabled={loading} className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 flex items-center gap-2">
        {loading ? <><Loader2 size={16} className="animate-spin" />Generating...</> : <><Sparkles size={16} />Generate Offer Letter</>}
      </button>
      {result?.html && (
        <div className="border-t border-[#F0EAD8] pt-5">
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <p className="font-semibold text-[#1A1A1A]">Offer Letter for {result.employeeName}</p>
            <div className="flex items-center gap-2">
              {sentAt ? (
                <span className="flex items-center gap-1.5 bg-green-50 border border-green-200 text-green-700 rounded-full px-4 py-1.5 text-sm font-medium">
                  <Check size={14} />Sent to employee at {sentAt}
                </span>
              ) : (
                <button onClick={sendToEmployee} disabled={saving}
                  className="flex items-center gap-1.5 bg-green-600 text-white rounded-full px-4 py-2 text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                  {saving ? <><Loader2 size={14} className="animate-spin" />Sending...</> : <><Send size={14} />Send to Employee</>}
                </button>
              )}
              <button onClick={() => openHtml(result.html, `Offer Letter - ${result.employeeName}`)}
                className="flex items-center gap-1 bg-[#1A1A1A] text-white rounded-full px-4 py-2 text-sm font-medium hover:bg-[#2B2B2B]">
                <ExternalLink size={14} />Open & Print
              </button>
            </div>
          </div>
          {!sentAt && (
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              Preview only — click <strong>Send to Employee</strong> to save this offer letter so they can view it in the HR portal.
            </p>
          )}
          <div className="border border-[#E8E0D0] rounded-xl overflow-hidden h-[400px]">
            <iframe srcDoc={DOMPurify.sanitize(result.html)} className="w-full h-full" title="Offer Letter Preview" sandbox="allow-same-origin" />
          </div>
        </div>
      )}
    </div>
  );
}

// ===== Appointment Letter Generator =====
function AppointmentGenerator({ employees, loading, setLoading, result, setResult, openHtml }: any) {
  const [form, setForm] = useState({ employeeId: "", designation: "", department: "", salary: "", joiningDate: "", probationMonths: "3", noticePeriod: "30", location: "", specialClauses: "" });
  const [saving, setSaving] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);

  async function generate() {
    if (!form.employeeId || !form.designation || !form.salary || !form.joiningDate) return alert("Fill required fields");
    setLoading(true);
    setResult(null);
    setSentAt(null);
    try {
      const res = await apiFetch<any>("/admin/ai/generate-appointment-letter", {
        method: "POST", body: JSON.stringify({ ...form, salary: parseFloat(form.salary), probationMonths: parseInt(form.probationMonths), noticePeriod: parseInt(form.noticePeriod) }),
      });
      setResult(res.data);
    } catch (e: any) { alert(e.message); }
    finally { setLoading(false); }
  }

  async function sendToEmployee() {
    if (!form.employeeId || !form.designation || !form.salary || !form.joiningDate) return;
    setSaving(true);
    try {
      await apiFetch<any>("/admin/offer-letters", {
        method: "POST",
        body: JSON.stringify({
          employeeId: form.employeeId,
          letterType: "APPOINTMENT",
          offerDate: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })(),
          joiningDate: form.joiningDate,
          designation: form.designation,
          department: form.department || undefined,
          salary: parseFloat(form.salary),
          probationMonths: parseInt(form.probationMonths),
          noticePeriod: parseInt(form.noticePeriod),
          location: form.location || undefined,
        }),
      });
      setSentAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }));
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-[#1A1A1A] mb-1">Generate Appointment Letter</h2>
        <p className="text-sm text-[#7A7A7A]">AI will create a comprehensive appointment letter with all legal clauses</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <EmployeeSelect employees={employees} value={form.employeeId} onChange={(v) => { setForm({ ...form, employeeId: v }); setSentAt(null); }} />
        <input type="text" placeholder="Designation *" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} className={inputClass} />
        <input type="text" placeholder="Department" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className={inputClass} />
        <input type="number" placeholder="Monthly CTC (INR) *" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} className={inputClass} />
        <input type="date" placeholder="Joining Date *" value={form.joiningDate} onChange={(e) => setForm({ ...form, joiningDate: e.target.value })} className={inputClass} />
        <input type="number" placeholder="Probation (months)" value={form.probationMonths} onChange={(e) => setForm({ ...form, probationMonths: e.target.value })} className={inputClass} />
        <input type="number" placeholder="Notice Period (days)" value={form.noticePeriod} onChange={(e) => setForm({ ...form, noticePeriod: e.target.value })} className={inputClass} />
        <input type="text" placeholder="Location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={inputClass} />
      </div>
      <textarea placeholder="Special clauses or conditions..." value={form.specialClauses} onChange={(e) => setForm({ ...form, specialClauses: e.target.value })} rows={2} className={inputClass + " resize-none"} />
      <button onClick={generate} disabled={loading} className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 flex items-center gap-2">
        {loading ? <><Loader2 size={16} className="animate-spin" />Generating...</> : <><Sparkles size={16} />Generate Appointment Letter</>}
      </button>
      {result?.html && (
        <div className="border-t border-[#F0EAD8] pt-5">
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <p className="font-semibold text-[#1A1A1A]">Appointment Letter for {result.employeeName}</p>
            <div className="flex items-center gap-2">
              {sentAt ? (
                <span className="flex items-center gap-1.5 bg-green-50 border border-green-200 text-green-700 rounded-full px-4 py-1.5 text-sm font-medium">
                  <Check size={14} />Sent to employee at {sentAt}
                </span>
              ) : (
                <button onClick={sendToEmployee} disabled={saving}
                  className="flex items-center gap-1.5 bg-green-600 text-white rounded-full px-4 py-2 text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                  {saving ? <><Loader2 size={14} className="animate-spin" />Sending...</> : <><Send size={14} />Send to Employee</>}
                </button>
              )}
              <button onClick={() => openHtml(result.html, `Appointment Letter - ${result.employeeName}`)}
                className="flex items-center gap-1 bg-[#1A1A1A] text-white rounded-full px-4 py-2 text-sm font-medium hover:bg-[#2B2B2B]">
                <ExternalLink size={14} />Open & Print
              </button>
            </div>
          </div>
          {!sentAt && (
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              Preview only — click <strong>Send to Employee</strong> to save this appointment letter so they can view it in the HR portal.
            </p>
          )}
          <div className="border border-[#E8E0D0] rounded-xl overflow-hidden h-[400px]">
            <iframe srcDoc={DOMPurify.sanitize(result.html)} className="w-full h-full" title="Appointment Letter Preview" sandbox="allow-same-origin" />
          </div>
        </div>
      )}
    </div>
  );
}

// ===== Contract Generator =====
function ContractGenerator({ employees, loading, setLoading, result, setResult, openHtml }: any) {
  const [form, setForm] = useState({ employeeId: "", designation: "", department: "", salary: "", contractDate: "", probationMonths: "3", noticePeriod: "30", specialClauses: "" });
  const [saving, setSaving] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);

  async function generate() {
    if (!form.employeeId || !form.designation || !form.salary || !form.contractDate) return alert("Fill required fields");
    setLoading(true);
    setResult(null);
    setSentAt(null);
    try {
      const res = await apiFetch<any>("/admin/ai/generate-contract", {
        method: "POST", body: JSON.stringify({ ...form, salary: parseFloat(form.salary), probationMonths: parseInt(form.probationMonths), noticePeriod: parseInt(form.noticePeriod) }),
      });
      setResult(res.data);
    } catch (e: any) { alert(e.message); }
    finally { setLoading(false); }
  }

  async function sendToEmployee() {
    if (!form.employeeId || !form.designation || !form.salary || !form.contractDate) return;
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
      setSentAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }));
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-[#1A1A1A] mb-1">Generate Employment Contract</h2>
        <p className="text-sm text-[#7A7A7A]">AI will create a legally sound employment contract with all standard clauses</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <EmployeeSelect employees={employees} value={form.employeeId} onChange={(v) => { setForm({ ...form, employeeId: v }); setSentAt(null); }} />
        <input type="text" placeholder="Designation *" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} className={inputClass} />
        <input type="text" placeholder="Department" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className={inputClass} />
        <input type="number" placeholder="Monthly CTC (INR) *" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} className={inputClass} />
        <input type="date" placeholder="Contract Date *" value={form.contractDate} onChange={(e) => setForm({ ...form, contractDate: e.target.value })} className={inputClass} />
        <input type="number" placeholder="Probation (months)" value={form.probationMonths} onChange={(e) => setForm({ ...form, probationMonths: e.target.value })} className={inputClass} />
        <input type="number" placeholder="Notice Period (days)" value={form.noticePeriod} onChange={(e) => setForm({ ...form, noticePeriod: e.target.value })} className={inputClass} />
      </div>
      <textarea placeholder="Special clauses..." value={form.specialClauses} onChange={(e) => setForm({ ...form, specialClauses: e.target.value })} rows={2} className={inputClass + " resize-none"} />
      <button onClick={generate} disabled={loading} className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 flex items-center gap-2">
        {loading ? <><Loader2 size={16} className="animate-spin" />Generating...</> : <><Sparkles size={16} />Generate Contract</>}
      </button>
      {result?.html && (
        <div className="border-t border-[#F0EAD8] pt-5">
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <p className="font-semibold text-[#1A1A1A]">Employment Contract for {result.employeeName}</p>
            <div className="flex items-center gap-2">
              {sentAt ? (
                <span className="flex items-center gap-1.5 bg-green-50 border border-green-200 text-green-700 rounded-full px-4 py-1.5 text-sm font-medium">
                  <Check size={14} />Sent to employee at {sentAt}
                </span>
              ) : (
                <button onClick={sendToEmployee} disabled={saving}
                  className="flex items-center gap-1.5 bg-green-600 text-white rounded-full px-4 py-2 text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                  {saving ? <><Loader2 size={14} className="animate-spin" />Sending...</> : <><Send size={14} />Send to Employee</>}
                </button>
              )}
              <button onClick={() => openHtml(result.html, `Contract - ${result.employeeName}`)}
                className="flex items-center gap-1 bg-[#1A1A1A] text-white rounded-full px-4 py-2 text-sm font-medium hover:bg-[#2B2B2B]">
                <ExternalLink size={14} />Open & Print
              </button>
            </div>
          </div>
          {!sentAt && (
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              Preview only — click <strong>Send to Employee</strong> to save this contract so they can review and sign it in the HR portal.
            </p>
          )}
          <div className="border border-[#E8E0D0] rounded-xl overflow-hidden h-[400px]">
            <iframe srcDoc={DOMPurify.sanitize(result.html)} className="w-full h-full" title="Contract Preview" sandbox="allow-same-origin" />
          </div>
        </div>
      )}
    </div>
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

  async function generate() {
    if (!form.employeeId || !form.basicSalary) return alert("Select employee and fill basic salary");
    setLoading(true);
    setResult(null);
    setSentAt(null);
    try {
      const res = await apiFetch<any>("/admin/ai/salary-slip/preview", {
        method: "POST",
        body: JSON.stringify({
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
        }),
      });
      setResult(res.data);
    } catch (e: any) { alert(e.message); }
    finally { setLoading(false); }
  }

  async function sendToEmployee() {
    if (!form.employeeId || !form.basicSalary) return;
    setSaving(true);
    try {
      await apiFetch<any>("/admin/salary-slips/generate", {
        method: "POST",
        body: JSON.stringify({
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
        }),
      });
      setSentAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }));
    } catch (e: any) {
      if (e.message?.includes("Unique constraint") || e.message?.includes("already exists")) {
        alert("A salary slip for this employee and month already exists. Edit it from the /salary-slips page instead.");
      } else {
        alert(e.message);
      }
    }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-[#1A1A1A] mb-1">Generate Salary Slip</h2>
        <p className="text-sm text-[#7A7A7A]">AI-styled salary slip — preview, then send to the employee. They'll see it in the HR portal under 'Salary Slips'.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <EmployeeSelect employees={employees} value={form.employeeId} onChange={handleEmployeeChange} />
        <div>
          <select value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })} className={inputClass}>
            {["January","February","March","April","May","June","July","August","September","October","November","December"].map((m, i) => (
              <option key={i} value={i + 1}>{m}</option>
            ))}
          </select>
        </div>
        <div>
          <select value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} className={inputClass}>
            {[2024, 2025, 2026, 2027].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold text-[#7A7A7A] uppercase tracking-wide mb-2">Earnings</p>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            { key: "basicSalary", label: "Basic Salary *" },
            { key: "hra", label: "HRA" },
            { key: "conveyance", label: "Conveyance" },
            { key: "medicalAllowance", label: "Medical Allowance" },
            { key: "specialAllowance", label: "Special Allowance" },
            { key: "otherEarnings", label: "Other Earnings" },
          ].map(({ key, label }) => (
            <input key={key} type="number" step="0.01" placeholder={label}
              value={form[key as keyof typeof form]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              className={inputClass} />
          ))}
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold text-[#7A7A7A] uppercase tracking-wide mb-2">Deductions</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { key: "pf", label: "PF" },
            { key: "esi", label: "ESI" },
            { key: "tax", label: "Income Tax (TDS)" },
            { key: "otherDeductions", label: "Other Deductions" },
          ].map(({ key, label }) => (
            <input key={key} type="number" step="0.01" placeholder={label}
              value={form[key as keyof typeof form]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              className={inputClass} />
          ))}
        </div>
      </div>
      <textarea placeholder="Remarks (optional)" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} rows={2} className={inputClass + " resize-none"} />
      <button onClick={generate} disabled={loading} className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 flex items-center gap-2">
        {loading ? <><Loader2 size={16} className="animate-spin" />Generating...</> : <><Sparkles size={16} />Generate Salary Slip</>}
      </button>
      {result?.html && (
        <div className="border-t border-[#F0EAD8] pt-5">
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <p className="font-semibold text-[#1A1A1A]">Salary Slip for {result.employeeName}</p>
            <div className="flex items-center gap-2">
              {sentAt ? (
                <span className="flex items-center gap-1.5 bg-green-50 border border-green-200 text-green-700 rounded-full px-4 py-1.5 text-sm font-medium">
                  <Check size={14} />Sent to employee at {sentAt}
                </span>
              ) : (
                <button onClick={sendToEmployee} disabled={saving}
                  className="flex items-center gap-1.5 bg-green-600 text-white rounded-full px-4 py-2 text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                  {saving ? <><Loader2 size={14} className="animate-spin" />Sending...</> : <><Send size={14} />Send to Employee</>}
                </button>
              )}
              <button onClick={() => openHtml(result.html, `Salary Slip - ${result.employeeName}`)}
                className="flex items-center gap-1 bg-[#1A1A1A] text-white rounded-full px-4 py-2 text-sm font-medium hover:bg-[#2B2B2B]">
                <ExternalLink size={14} />Open & Print
              </button>
            </div>
          </div>
          {!sentAt && (
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              Preview only — click <strong>Send to Employee</strong> to save this salary slip. It will appear in /salary-slips for approval and in the employee's HR portal.
            </p>
          )}
          <div className="border border-[#E8E0D0] rounded-xl overflow-hidden h-[400px]">
            <iframe srcDoc={DOMPurify.sanitize(result.html)} className="w-full h-full" title="Salary Slip Preview" sandbox="allow-same-origin" />
          </div>
        </div>
      )}
    </div>
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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
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

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-[#1A1A1A] mb-1">AI Chat Assistant</h2>
        <p className="text-sm text-[#7A7A7A]">Ask anything — HR policies, email drafts, performance feedback, warning letters, etc.</p>
      </div>
      <div className="space-y-1">
        <EmployeeSelect employees={employees} value={employeeId} onChange={(v) => { setEmployeeId(v); if (v) setEmployeeError(""); }} />
        {employeeError && <p role="alert" className="text-xs text-red-500 font-semibold">{employeeError}</p>}
      </div>
      <div className="border border-[#E8E0D0] rounded-xl h-[350px] overflow-y-auto p-4 bg-[#FEFCF7] space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-[#B0B0B0] py-10">
            <Sparkles size={24} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm">Ask me anything HR-related</p>
            <div className="flex flex-wrap gap-2 justify-center mt-4">
              {["Draft a warning letter", "Write a promotion announcement email", "Suggest interview questions for a designer", "Draft work-from-home policy"].map((s) => (
                <button key={s} onClick={() => setInput(s)} className="text-xs bg-white border border-[#E8E0D0] rounded-full px-3 py-1.5 text-[#7A7A7A] hover:border-[#F5D547]">{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`${msg.role === "user" ? "text-right" : ""}`}>
            <div className={`inline-block max-w-[80%] rounded-xl px-4 py-2.5 text-sm ${msg.role === "user" ? "bg-[#1A1A1A] text-white" : "bg-white border border-[#E8E0D0] text-[#555]"}`}>
              <div className="whitespace-pre-wrap">{msg.content}</div>
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-[#7A7A7A] text-sm"><Loader2 size={14} className="animate-spin" />Thinking...</div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className="flex gap-3">
        <input type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !loading && send()}
          placeholder="Type your question..." className={inputClass} />
        <button onClick={send} disabled={loading || !input.trim()} className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 whitespace-nowrap">
          Send
        </button>
      </div>
    </div>
  );
}
