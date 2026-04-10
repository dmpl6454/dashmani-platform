"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { Clock, Plus, ChevronUp } from "lucide-react";

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

const statusColors: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: "bg-yellow-50", text: "text-yellow-700" },
  APPROVED: { bg: "bg-green-50", text: "text-green-700" },
  REJECTED: { bg: "bg-red-50", text: "text-red-700" },
};

export default function ExtraHoursPage() {
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ date: "", hours: "", description: "" });

  const { data, mutate } = useSWR("/hr/extra-hours", apiFetch);
  const hours = (data as any)?.data || [];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiFetch("/hr/extra-hours", {
        method: "POST",
        body: JSON.stringify({ date: form.date, hours: Number(form.hours), description: form.description }),
      });
      setForm({ date: "", hours: "", description: "" });
      setShowForm(false);
      mutate();
    } catch (e: any) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  const totalApproved = hours.filter((h: any) => h.status === "APPROVED").reduce((s: number, h: any) => s + h.hours, 0);

  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-light text-[#1A1A1A] font-serif">Extra Work Hours</h1>
          <p className="text-sm text-[#888] mt-1">Log overtime and extra work hours for approval</p>
        </div>
        <button onClick={() => setShowForm((p) => !p)} className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] transition-all flex items-center gap-2">
          {showForm ? <ChevronUp size={16} /> : <Plus size={16} />}
          {showForm ? "Close" : "Log Hours"}
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-[#E8E0D0] p-4">
          <p className="text-xs text-[#888]">Total Approved Hours</p>
          <p className="text-2xl font-semibold text-[#1A1A1A]">{totalApproved}h</p>
        </div>
        <div className="bg-white rounded-xl border border-[#E8E0D0] p-4">
          <p className="text-xs text-[#888]">Pending</p>
          <p className="text-2xl font-semibold text-yellow-600">{hours.filter((h: any) => h.status === "PENDING").length}</p>
        </div>
        <div className="bg-white rounded-xl border border-[#E8E0D0] p-4">
          <p className="text-xs text-[#888]">Total Entries</p>
          <p className="text-2xl font-semibold text-[#1A1A1A]">{hours.length}</p>
        </div>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Date</label>
              <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Hours</label>
              <input type="number" step="0.5" min="0.5" max="12" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} required placeholder="e.g., 2.5" className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Description</label>
              <input type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What did you work on?" className={inputClass} />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button type="submit" disabled={submitting} className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50">
              {submitting ? "Submitting..." : "Submit"}
            </button>
          </div>
        </form>
      )}

      {/* List */}
      <div className="space-y-3">
        {hours.length === 0 ? (
          <div className="bg-white rounded-2xl border border-[#E8E0D0] p-8 text-center text-[#888]">
            <Clock className="h-8 w-8 mx-auto mb-2 text-[#C4B89C]" />
            No extra hours logged yet
          </div>
        ) : hours.map((h: any) => {
          const sc = statusColors[h.status] || statusColors.PENDING;
          return (
            <div key={h.id} className="bg-white rounded-xl border border-[#E8E0D0] p-4 flex items-center justify-between">
              <div>
                <p className="font-semibold text-sm">{new Date(h.date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</p>
                <p className="text-xs text-[#888] mt-0.5">{h.description || "—"}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-lg font-semibold">{h.hours}h</span>
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${sc.bg} ${sc.text}`}>{h.status}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
