"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { CalendarDays, Plus, Trash2, ChevronLeft, ChevronRight } from "lucide-react";

const inputClass =
  "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

const typeBadge: Record<string, string> = {
  PUBLIC: "bg-[rgba(107,203,119,0.12)] text-[#2E7D32]",
  RESTRICTED: "bg-[rgba(245,213,71,0.18)] text-[#B8960C]",
  COMPANY: "bg-[rgba(100,149,237,0.12)] text-[#3B6DC6]",
};

export default function HolidaysPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [form, setForm] = useState({
    name: "",
    date: "",
    type: "PUBLIC" as "PUBLIC" | "RESTRICTED" | "COMPANY",
    description: "",
  });
  const [adding, setAdding] = useState(false);

  const { data, isLoading, mutate } = useSWR(
    `/admin/holidays?year=${year}`,
    (url: string) => apiFetch<any>(url)
  );
  const holidays = data?.data || [];

  function updateForm(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      await apiFetch("/admin/holidays", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setForm({ name: "", date: "", type: "PUBLIC", description: "" });
      mutate();
    } catch (e: any) {
      alert(e.message || "Failed to add holiday");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this holiday?")) return;
    try {
      await apiFetch(`/admin/holidays/${id}`, { method: "DELETE" });
      mutate();
    } catch (e: any) {
      alert(e.message || "Failed to delete holiday");
    }
  }

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Holiday Calendar</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setYear((y) => y - 1)}
            className="w-9 h-9 flex items-center justify-center rounded-full border border-[#E8E0D0] hover:bg-[rgba(245,213,71,0.1)] transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-lg font-semibold text-[#1A1A1A] min-w-[60px] text-center">{year}</span>
          <button
            onClick={() => setYear((y) => y + 1)}
            className="w-9 h-9 flex items-center justify-center rounded-full border border-[#E8E0D0] hover:bg-[rgba(245,213,71,0.1)] transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Add Holiday Form */}
      <form
        onSubmit={handleAdd}
        className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5"
      >
        <p className="font-medium text-[#1A1A1A] mb-4 flex items-center gap-2">
          <Plus size={16} /> Add Holiday
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Holiday Name</label>
            <input
              type="text"
              placeholder="e.g., Republic Day"
              value={form.name}
              onChange={(e) => updateForm("name", e.target.value)}
              required
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Date</label>
            <input
              type="date"
              value={form.date}
              onChange={(e) => updateForm("date", e.target.value)}
              required
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Type</label>
            <select
              value={form.type}
              onChange={(e) => updateForm("type", e.target.value)}
              className={inputClass}
            >
              <option value="PUBLIC">Public</option>
              <option value="RESTRICTED">Restricted</option>
              <option value="COMPANY">Company</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Description</label>
            <input
              type="text"
              placeholder="Optional description"
              value={form.description}
              onChange={(e) => updateForm("description", e.target.value)}
              className={inputClass}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            disabled={adding}
            className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] transition-all disabled:opacity-50 flex items-center gap-2"
          >
            <Plus size={16} />
            {adding ? "Adding..." : "Add Holiday"}
          </button>
        </div>
      </form>

      {/* Holidays List */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0EAD8]">
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Date</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Name</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Type</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Description</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-[#7A7A7A]">Loading...</td>
                </tr>
              ) : holidays.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-[#7A7A7A]">
                    <CalendarDays size={24} className="mx-auto mb-2 opacity-30" />
                    No holidays for {year}
                  </td>
                </tr>
              ) : (
                holidays.map((h: any) => (
                  <tr key={h.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                    <td className="p-4 text-[#1A1A1A] font-medium">
                      {h.date ? new Date(h.date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : "—"}
                    </td>
                    <td className="p-4 text-[#1A1A1A]">{h.name || "—"}</td>
                    <td className="p-4">
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${typeBadge[h.type] || typeBadge.PUBLIC}`}>
                        {h.type}
                      </span>
                    </td>
                    <td className="p-4 text-[#7A7A7A] max-w-[250px] truncate">{h.description || "—"}</td>
                    <td className="p-4">
                      <button
                        onClick={() => handleDelete(h.id)}
                        className="flex items-center gap-1 rounded-full bg-[rgba(231,76,60,0.08)] text-[#E74C3C] px-3 py-1.5 text-xs font-medium hover:bg-[rgba(231,76,60,0.18)] transition-colors"
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
