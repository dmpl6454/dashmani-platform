"use client";
import { useState } from "react";
import { apiFetch, API_BASE } from "@/lib/api";
import useSWR from "swr";
import { GraduationCap, ExternalLink, FileText, X } from "lucide-react";
import { formatStatus } from "@dashmani/shared";
import { usePageTitle } from "@/lib/hooks/use-page-title";

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

const STATUSES = ["RECEIVED", "REVIEWING", "SHORTLISTED", "INTERVIEW", "OFFERED", "ACCEPTED", "REJECTED"];

const statusColors: Record<string, string> = {
  RECEIVED: "bg-gray-100 text-gray-700",
  REVIEWING: "bg-blue-50 text-blue-700",
  SHORTLISTED: "bg-purple-50 text-purple-700",
  INTERVIEW: "bg-yellow-50 text-yellow-700",
  OFFERED: "bg-green-50 text-green-700",
  ACCEPTED: "bg-green-100 text-green-800",
  REJECTED: "bg-red-50 text-red-700",
};

export default function InternshipsPage() {
  usePageTitle("Internships");
  const [filter, setFilter] = useState("");
  const { data, mutate } = useSWR(`/admin/internships${filter ? `?status=${filter}` : ""}`, (url: string) => apiFetch<any>(url));
  const apps = data?.data || [];
  const [selected, setSelected] = useState<any>(null);
  const [notes, setNotes] = useState("");
  const [updating, setUpdating] = useState(false);

  async function updateStatus(id: string, status: string) {
    setUpdating(true);
    try {
      await apiFetch(`/admin/internships/${id}/status`, { method: "POST", body: JSON.stringify({ status, reviewNotes: notes }) });
      mutate();
      setSelected(null);
      setNotes("");
    } catch (e: any) { alert(e.message); }
    setUpdating(false);
  }

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Internship Applications</h1>
          <p className="text-sm text-[#7A7A7A] mt-1">Manage 6-month internship applications</p>
        </div>
        <div className="flex items-center gap-2 bg-[#FFF3C4] px-4 py-2 rounded-full">
          <GraduationCap className="h-4 w-4 text-[#B8960C]" />
          <span className="text-sm font-semibold text-[#1A1A1A]">{apps.length} Applications</span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setFilter("")} className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${!filter ? "bg-[#1A1A1A] text-white" : "bg-white text-[#7A7A7A] border border-[#E8E0D0] hover:bg-[#FFF8E1]"}`}>All</button>
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setFilter(s)} className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${filter === s ? "bg-[#1A1A1A] text-white" : "bg-white text-[#7A7A7A] border border-[#E8E0D0] hover:bg-[#FFF8E1]"}`}>{s}</button>
        ))}
      </div>

      {/* Detail Modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-2xl shadow-xl border border-[#E8E0D0] w-full max-w-lg max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Sticky header */}
            <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-[#E8E0D0] shrink-0">
              <h2 className="text-lg font-semibold text-[#1A1A1A]">{selected.name}</h2>
              <button onClick={() => setSelected(null)} className="text-[#7A7A7A] hover:text-[#1A1A1A]"><X className="h-5 w-5" /></button>
            </div>
            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <div className="space-y-2 text-sm">
                <p><span className="text-[#7A7A7A]">Email:</span> <a href={`mailto:${selected.email}`} className="text-blue-600">{selected.email}</a></p>
                {selected.phone && <p><span className="text-[#7A7A7A]">Phone:</span> {selected.phone}</p>}
                {selected.college && <p><span className="text-[#7A7A7A]">College:</span> {selected.college}</p>}
                {selected.course && <p><span className="text-[#7A7A7A]">Course:</span> {selected.course}</p>}
                <p><span className="text-[#7A7A7A]">Duration:</span> {selected.duration}</p>
                {selected.department && <p><span className="text-[#7A7A7A]">Department:</span> {selected.department}</p>}
                {selected.startDate && <p><span className="text-[#7A7A7A]">Start Date:</span> {new Date(selected.startDate).toLocaleDateString("en-IN")}</p>}
                {selected.skills && <p><span className="text-[#7A7A7A]">Skills:</span> {selected.skills}</p>}
                {selected.coverLetter && <div className="mt-2"><p className="text-[#7A7A7A] mb-1">Cover Letter:</p><p className="bg-[#FEFCF7] rounded-lg p-3 text-xs border border-[#E8E0D0]">{selected.coverLetter}</p></div>}
                <div className="flex gap-3 mt-2">
                  {selected.linkedin && <a href={selected.linkedin} target="_blank" className="text-blue-600 text-xs flex items-center gap-1"><ExternalLink size={12} /> LinkedIn</a>}
                  {selected.portfolio && <a href={selected.portfolio} target="_blank" className="text-blue-600 text-xs flex items-center gap-1"><ExternalLink size={12} /> Portfolio</a>}
                  {selected.resumeUrl && <a href={selected.resumeUrl.startsWith("http") ? selected.resumeUrl : `${API_BASE}${selected.resumeUrl}`} target="_blank" className="text-blue-600 text-xs flex items-center gap-1"><FileText size={12} /> Resume</a>}
                </div>
                <textarea placeholder="Review notes..." value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${inputClass} mt-3`} />
              </div>
            </div>
            {/* Sticky footer — status pills always visible */}
            <div className="px-6 py-3 border-t border-[#E8E0D0] bg-[#FEFCF7] shrink-0 rounded-b-2xl">
              <div className="flex flex-wrap gap-2">
                {STATUSES.filter((s) => s !== selected.status).map((s) => (
                  <button key={s} onClick={() => updateStatus(selected.id, s)} disabled={updating} className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${statusColors[s]} hover:opacity-80 disabled:opacity-50`}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0EAD8]">
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Applicant</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">College / Course</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Duration</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Status</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Applied</th>
              </tr>
            </thead>
            <tbody>
              {apps.length === 0 ? (
                <tr><td colSpan={5} className="p-8 text-center text-[#7A7A7A]"><GraduationCap className="h-8 w-8 mx-auto mb-2 opacity-30" />No applications found</td></tr>
              ) : apps.map((app: any) => (
                <tr key={app.id} onClick={() => { setSelected(app); setNotes(app.reviewNotes || ""); }} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] cursor-pointer">
                  <td className="p-4">
                    <p className="font-semibold text-[#1A1A1A]">{app.name}</p>
                    <p className="text-xs text-[#7A7A7A]">{app.email}</p>
                  </td>
                  <td className="p-4 text-[#7A7A7A]">{app.college || "—"}{app.course ? ` · ${app.course}` : ""}</td>
                  <td className="p-4 text-[#7A7A7A]">{app.duration}</td>
                  <td className="p-4"><span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusColors[app.status] || "bg-gray-100"}`}>{formatStatus(app.status)}</span></td>
                  <td className="p-4 text-[#7A7A7A] text-xs">{new Date(app.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
