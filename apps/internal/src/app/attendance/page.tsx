"use client";
import { useState, useMemo } from "react";
import useSWR from "swr";
import { useAttendance } from "@/lib/hooks/use-attendance";
import { useEmployees } from "@/lib/hooks/use-employees";
import { AttendanceClock } from "@/components/attendance-clock";
import { apiFetch } from "@/lib/api";
import { ChevronLeft, ChevronRight, Plus, X, Check, Pencil } from "lucide-react";
import { formatStatus, formatDate } from "@dashmani/shared";
import { usePageTitle } from "@/lib/hooks/use-page-title";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const STATUS_OPTIONS = ["PRESENT", "LATE", "ABSENT", "HALF_DAY", "LEAVE"];

const statusBadge: Record<string, string> = {
  PRESENT: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  LATE: "bg-[#FFF3C4] text-[#1A1A1A]",
  ABSENT: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
  HALF_DAY: "bg-[rgba(245,166,35,0.12)] text-[#F5A623]",
  LEAVE: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
};

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-3 py-2 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

type ManualEntry = {
  userId: string;
  date: string;
  checkIn: string;
  checkOut: string;
  status: string;
  note: string;
};

const EMPTY_ENTRY: ManualEntry = { userId: "", date: "", checkIn: "", checkOut: "", status: "PRESENT", note: "" };

export default function AttendancePage() {
  usePageTitle("Attendance");
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [employeeFilter, setEmployeeFilter] = useState<string>("");

  const [showModal, setShowModal] = useState(false);
  const [editRecord, setEditRecord] = useState<any | null>(null);
  const [manualForm, setManualForm] = useState<ManualEntry>(EMPTY_ENTRY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const startDate = useMemo(() => `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-01`, [viewYear, viewMonth]);
  const endDate = useMemo(() => {
    const lastDay = new Date(viewYear, viewMonth + 1, 0).getDate();
    return `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }, [viewYear, viewMonth]);

  const { data, isLoading, mutate } = useAttendance({ startDate, endDate, employeeId: employeeFilter || undefined });
  const records = (data as any)?.data || [];

  const { data: employeesData } = useEmployees({ status: "ACTIVE" });
  const employees: any[] = (employeesData as any)?.data || [];

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  }

  function openAdd() {
    setEditRecord(null);
    setManualForm(EMPTY_ENTRY);
    setError("");
    setShowModal(true);
  }

  function openEdit(record: any) {
    setEditRecord(record);
    setManualForm({
      userId: record.employeeId || "",
      date: record.date ? record.date.split("T")[0] : "",
      checkIn: record.checkIn ? new Date(record.checkIn).toTimeString().slice(0, 5) : "",
      checkOut: record.checkOut ? new Date(record.checkOut).toTimeString().slice(0, 5) : "",
      status: record.status || "PRESENT",
      note: record.note || "",
    });
    setError("");
    setShowModal(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const dateStr = manualForm.date;
      const toDateTime = (timeStr: string) => {
        if (!timeStr) return undefined;
        return `${dateStr}T${timeStr}:00`;
      };
      if (editRecord) {
        await apiFetch<any>(`/attendance/${editRecord.id}/override`, {
          method: "PUT",
          body: JSON.stringify({
            status: manualForm.status,
            checkIn: toDateTime(manualForm.checkIn),
            checkOut: toDateTime(manualForm.checkOut),
            note: manualForm.note || undefined,
          }),
        });
      } else {
        await apiFetch<any>("/attendance/manual", {
          method: "POST",
          body: JSON.stringify({
            userId: manualForm.userId,
            date: dateStr,
            status: manualForm.status,
            checkIn: toDateTime(manualForm.checkIn),
            checkOut: toDateTime(manualForm.checkOut),
            note: manualForm.note || undefined,
          }),
        });
      }
      mutate();
      setShowModal(false);
    } catch (err: any) {
      setError(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Attendance</h1>
        <button onClick={openAdd} className="flex items-center gap-2 bg-[#1A1A1A] text-white rounded-full px-5 py-2.5 text-sm font-semibold hover:bg-[#2B2B2B] transition-all shadow-md">
          <Plus className="h-4 w-4" /> Add Record
        </button>
      </div>

      <div className="max-w-sm crx-animate-slide crx-delay-1">
        <AttendanceClock />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-center crx-animate-slide crx-delay-2">
        {/* Month picker */}
        <div className="flex items-center gap-2 bg-white/70 border border-[#E8E0D0] rounded-xl px-4 py-2.5 shadow-sm">
          <button onClick={prevMonth} className="text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm font-medium text-[#1A1A1A] min-w-[130px] text-center">
            {MONTH_NAMES[viewMonth]} {viewYear}
          </span>
          <button onClick={nextMonth} className="text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {/* Employee filter */}
        <select
          value={employeeFilter}
          onChange={(e) => setEmployeeFilter(e.target.value)}
          className="bg-white/70 border border-[#E8E0D0] rounded-xl px-4 py-2.5 text-sm text-[#1A1A1A] outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] shadow-sm min-w-[200px]"
        >
          <option value="">All Employees</option>
          {employees.map((emp: any) => (
            <option key={emp.id} value={emp.id}>{emp.name}</option>
          ))}
        </select>

        {records.length > 0 && (
          <span className="text-xs text-[#7A7A7A]">{records.length} record{records.length !== 1 ? "s" : ""}</span>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0EAD8]">
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Date</th>
                {!employeeFilter && <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Employee</th>}
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Check In</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Check Out</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Status</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Overtime</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Note</th>
                <th className="p-4" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={8} className="p-4 text-center text-[#7A7A7A]">Loading...</td></tr>
              ) : records.length === 0 ? (
                <tr><td colSpan={8} className="p-4 text-center text-[#7A7A7A]">No records for {MONTH_NAMES[viewMonth]} {viewYear}</td></tr>
              ) : (
                records.map((r: any) => (
                  <tr key={r.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors group">
                    <td className="p-4 text-[#1A1A1A]">{formatDate(r.date)}</td>
                    {!employeeFilter && <td className="p-4 text-[#1A1A1A]">{r.employee?.name || "—"}</td>}
                    <td className="p-4 text-[#1A1A1A]">{r.checkIn ? new Date(r.checkIn).toLocaleTimeString() : "—"}</td>
                    <td className="p-4 text-[#1A1A1A]">{r.checkOut ? new Date(r.checkOut).toLocaleTimeString() : "—"}</td>
                    <td className="p-4">
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadge[r.status] || "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>
                        {formatStatus(r.status)}
                      </span>
                    </td>
                    <td className="p-4 text-[#1A1A1A]">{r.overtimeHours > 0 ? `${r.overtimeHours.toFixed(1)}h` : "—"}</td>
                    <td className="p-4 text-[#7A7A7A] text-xs max-w-[140px] truncate">{r.note || "—"}</td>
                    <td className="p-4">
                      <button onClick={() => openEdit(r)} className="opacity-0 group-hover:opacity-100 text-[#B0B0B0] hover:text-[#F5D547] transition-all">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Manual entry / override modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl border border-[#E8E0D0] p-6 w-full max-w-md z-10">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-[#1A1A1A]">{editRecord ? "Override Record" : "Add Manual Record"}</h2>
              <button onClick={() => setShowModal(false)} className="text-[#B0B0B0] hover:text-[#1A1A1A]"><X className="h-5 w-5" /></button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              {!editRecord && (
                <div>
                  <label className="block text-xs text-[#7A7A7A] mb-1 font-medium">Employee *</label>
                  <select required className={inputClass} value={manualForm.userId} onChange={(e) => setManualForm({ ...manualForm, userId: e.target.value })}>
                    <option value="">Select employee...</option>
                    {employees.map((emp: any) => (
                      <option key={emp.id} value={emp.id}>{emp.name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs text-[#7A7A7A] mb-1 font-medium">Date *</label>
                <input type="date" required className={inputClass} value={manualForm.date} onChange={(e) => setManualForm({ ...manualForm, date: e.target.value })} />
              </div>

              <div>
                <label className="block text-xs text-[#7A7A7A] mb-1 font-medium">Status *</label>
                <select required className={inputClass} value={manualForm.status} onChange={(e) => setManualForm({ ...manualForm, status: e.target.value })}>
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#7A7A7A] mb-1 font-medium">Check In</label>
                  <input type="time" className={inputClass} value={manualForm.checkIn} onChange={(e) => setManualForm({ ...manualForm, checkIn: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs text-[#7A7A7A] mb-1 font-medium">Check Out</label>
                  <input type="time" className={inputClass} value={manualForm.checkOut} onChange={(e) => setManualForm({ ...manualForm, checkOut: e.target.value })} />
                </div>
              </div>

              <div>
                <label className="block text-xs text-[#7A7A7A] mb-1 font-medium">Note</label>
                <input className={inputClass} placeholder="Reason for manual entry..." value={manualForm.note} onChange={(e) => setManualForm({ ...manualForm, note: e.target.value })} />
              </div>

              {error && <div className="text-sm text-[#E74C3C] bg-red-50/60 border border-red-100 rounded-lg px-3 py-2">{error}</div>}

              <div className="flex gap-3 pt-1">
                <button type="submit" disabled={saving} className="flex items-center gap-2 bg-[#1A1A1A] text-white py-2.5 px-5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all">
                  <Check className="h-3.5 w-3.5" /> {saving ? "Saving..." : "Save Record"}
                </button>
                <button type="button" onClick={() => setShowModal(false)} className="border border-[#F0EAD8] text-[#7A7A7A] py-2.5 px-5 rounded-full text-sm hover:border-[#E8D8B4] transition-all">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
