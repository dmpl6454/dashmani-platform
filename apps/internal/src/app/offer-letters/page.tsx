"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { FileText, Plus, ChevronUp, Eye } from "lucide-react";

const inputClass =
  "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

export default function OfferLettersPage() {
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    employeeId: "",
    offerDate: "",
    joiningDate: "",
    designation: "",
    department: "",
    salary: "",
    probationMonths: "3",
    location: "",
  });

  const { data: lettersData, mutate } = useSWR(
    "/admin/offer-letters",
    (url: string) => apiFetch<any>(url)
  );
  const letters = lettersData?.data || [];

  // ?limit=500 so the "Select employee" dropdown lists all employees (API caps at 50 otherwise).
  const { data: employeesData } = useSWR(
    "/employees?limit=500",
    (url: string) => apiFetch<any>(url)
  );
  const employees = employeesData?.data || [];

  function updateForm(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await apiFetch("/admin/offer-letters", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          salary: Number(form.salary),
          probationMonths: Number(form.probationMonths),
        }),
      });
      setForm({
        employeeId: "",
        offerDate: "",
        joiningDate: "",
        designation: "",
        department: "",
        salary: "",
        probationMonths: "3",
        location: "",
      });
      setShowForm(false);
      mutate();
    } catch (e: any) {
      setFormError(e.message || "Failed to generate offer letter");
    } finally {
      setSubmitting(false);
    }
  }

  function viewHtml(id: string) {
    const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
    window.open(`${API_URL}/admin/offer-letters/${id}/html?token=${token}`, "_blank");
  }

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Offer Letters</h1>
        <button
          onClick={() => setShowForm((p) => !p)}
          className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] transition-all flex items-center gap-2"
        >
          {showForm ? <ChevronUp size={16} /> : <Plus size={16} />}
          {showForm ? "Close Form" : "Generate Offer Letter"}
        </button>
      </div>

      {/* Inline Form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5 crx-animate-slide"
        >
          <p className="font-medium text-[#1A1A1A] mb-4">New Offer Letter</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Employee</label>
              <select
                value={form.employeeId}
                onChange={(e) => updateForm("employeeId", e.target.value)}
                required
                className={inputClass}
              >
                <option value="">Select employee...</option>
                {employees.map((emp: any) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name || `${emp.firstName || ""} ${emp.lastName || ""}`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Offer Date</label>
              <input
                type="date"
                value={form.offerDate}
                onChange={(e) => updateForm("offerDate", e.target.value)}
                required
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Joining Date</label>
              <input
                type="date"
                value={form.joiningDate}
                onChange={(e) => updateForm("joiningDate", e.target.value)}
                required
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Designation</label>
              <input
                type="text"
                placeholder="e.g., Software Engineer"
                value={form.designation}
                onChange={(e) => updateForm("designation", e.target.value)}
                required
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Department</label>
              <input
                type="text"
                placeholder="e.g., Engineering"
                value={form.department}
                onChange={(e) => updateForm("department", e.target.value)}
                required
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Salary (Monthly)</label>
              <input
                type="number"
                placeholder="e.g., 50000"
                value={form.salary}
                onChange={(e) => updateForm("salary", e.target.value)}
                required
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Probation (Months)</label>
              <input
                type="number"
                min="0"
                max="12"
                value={form.probationMonths}
                onChange={(e) => updateForm("probationMonths", e.target.value)}
                required
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Location</label>
              <input
                type="text"
                placeholder="e.g., New Delhi"
                value={form.location}
                onChange={(e) => updateForm("location", e.target.value)}
                required
                className={inputClass}
              />
            </div>
          </div>
          {formError && (
            <p className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{formError}</p>
          )}
          <div className="mt-5 flex justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] transition-all disabled:opacity-50"
            >
              {submitting ? "Generating..." : "Generate Offer Letter"}
            </button>
          </div>
        </form>
      )}

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0EAD8]">
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Employee</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Designation</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Salary</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Offer Date</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Joining Date</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {letters.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-[#7A7A7A]">
                    <FileText size={24} className="mx-auto mb-2 opacity-30" />
                    No offer letters generated yet
                  </td>
                </tr>
              ) : (
                letters.map((letter: any) => (
                  <tr key={letter.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                    <td className="p-4 text-[#1A1A1A] font-medium">{letter.employeeName || letter.employee?.name || "—"}</td>
                    <td className="p-4 text-[#1A1A1A]">{letter.designation || "—"}</td>
                    <td className="p-4 text-[#1A1A1A] font-semibold">
                      {letter.salary != null ? `₹${Number(letter.salary).toLocaleString()}` : "—"}
                    </td>
                    <td className="p-4 text-[#7A7A7A]">
                      {letter.offerDate ? new Date(letter.offerDate).toLocaleDateString() : "—"}
                    </td>
                    <td className="p-4 text-[#7A7A7A]">
                      {letter.joiningDate ? new Date(letter.joiningDate).toLocaleDateString() : "—"}
                    </td>
                    <td className="p-4">
                      <button
                        onClick={() => viewHtml(letter.id)}
                        className="flex items-center gap-1.5 rounded-full bg-[rgba(245,213,71,0.15)] text-[#1A1A1A] px-3 py-1.5 text-xs font-medium hover:bg-[rgba(245,213,71,0.3)] transition-colors"
                      >
                        <Eye size={13} /> View
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
