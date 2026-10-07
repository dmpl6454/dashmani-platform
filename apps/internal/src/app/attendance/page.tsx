"use client";
import { useState, useMemo, useEffect } from "react";
import useSWR from "swr";
import { useAttendance } from "@/lib/hooks/use-attendance";
import { useEmployees } from "@/lib/hooks/use-employees";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ModalPortal } from "@/components/modal-portal";
import { ChevronLeft, ChevronRight, Plus, X, Pencil } from "lucide-react";
import { usePageTitle } from "@/lib/hooks/use-page-title";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Mockup palette.
const STATUS: Record<string, { label: string; color: string }> = {
  PRESENT:  { label: "Present",  color: "#00D7A0" },
  LATE:     { label: "Late",     color: "#E9BD62" },
  ABSENT:   { label: "Absent",   color: "#FB7185" },
  HALF_DAY: { label: "Half Day", color: "#6EB2FF" },
  LEAVE:    { label: "Leave",    color: "#9B7EDE" },
};
const STATUS_OPTIONS = ["PRESENT", "LATE", "ABSENT", "HALF_DAY", "LEAVE"];
const HUES = ["#238BFF", "#E9BD62", "#9B7EDE", "#00D7A0", "#FB7185", "#6EB2FF"];
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
};
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const initials = (name: string) =>
  (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const pad = (n: number) => String(n).padStart(2, "0");
// Local calendar day (IST for users in India) — never toISOString, which is UTC.
const localISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtClock = (v?: string | null) =>
  v ? new Date(v).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase() : "—";

const LABEL = "flex flex-col gap-[7px] text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase";
const FIELD =
  "h-10 px-3 rounded-[8px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] tracking-normal normal-case font-normal outline-none focus:border-ds-gold placeholder:text-ds-t4 [color-scheme:dark] min-w-0 w-full";
const GRID =
  "grid gap-x-5 items-center [grid-template-columns:minmax(0,13fr)_minmax(0,23fr)_minmax(0,12fr)_minmax(0,12fr)_minmax(0,13fr)_minmax(0,10fr)_minmax(0,12fr)_minmax(0,5fr)]";

type ManualEntry = { userId: string; date: string; checkIn: string; checkOut: string; status: string; note: string };
const EMPTY_ENTRY: ManualEntry = { userId: "", date: "", checkIn: "", checkOut: "", status: "PRESENT", note: "" };

/** Today's check-in card. Same endpoints as the old AttendanceClock; today's own record fills in the times. */
function ClockCard({ onChange }: { onChange: () => void }) {
  const { user } = useAuth();
  const [now, setNow] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Fallback if today's record can't be read back (mirrors the old local-only behaviour).
  const [local, setLocal] = useState<{ checkIn?: string; checkOut?: string }>({});

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const today = localISO(new Date());
  // Same endpoint the table uses, scoped to me + today. No request until the user is known.
  const { data: mineData, mutate: mutateMine } = useSWR(
    user?.id ? `/attendance?employeeId=${user.id}&startDate=${today}&endDate=${today}` : null,
    (url: string) => apiFetch(url),
    { revalidateOnFocus: false },
  );
  const mine = user?.id ? ((mineData as any)?.data || []).find((r: any) => (r.date || "").slice(0, 10) === today) : null;
  const checkIn: string | undefined = mine?.checkIn || local.checkIn;
  const checkOut: string | undefined = mine?.checkOut || local.checkOut;

  const state = !checkIn ? { label: "Not checked in", color: "#738395" } : !checkOut ? { label: "Checked in", color: "#00D7A0" } : { label: "Day complete", color: "#6EB2FF" };
  let worked = "—";
  if (checkIn && now) {
    const end = checkOut ? new Date(checkOut).getTime() : now.getTime();
    const m = Math.max(0, Math.floor((end - new Date(checkIn).getTime()) / 60000));
    worked = `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
  }

  async function punch() {
    setLoading(true);
    setError("");
    try {
      if (!checkIn) {
        const res: any = await apiFetch("/attendance/check-in", { method: "POST" });
        setLocal({ checkIn: res?.data?.checkIn });
      } else {
        const res: any = await apiFetch("/attendance/check-out", { method: "POST" });
        setLocal((l) => ({ ...l, checkIn: l.checkIn ?? checkIn, checkOut: res?.data?.checkOut }));
      }
      mutateMine();
      onChange();
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const done = !!checkOut;
  return (
    <div className="relative p-6 rounded-[16px] bg-ds-card border border-[#2A4658] overflow-hidden">
      <span aria-hidden="true" className="absolute left-6 right-6 top-0 h-px bg-[linear-gradient(90deg,transparent,#E9BD62,transparent)] opacity-70" />
      <div className="flex items-center justify-between gap-2.5">
        <span className="text-[10px] font-semibold tracking-[.18em] uppercase text-ds-t3">
          {now ? `${DOW[now.getDay()]}, ${now.getDate()} ${MONTH_NAMES[now.getMonth()]}` : "Today"}
        </span>
        <span
          className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full border text-[11px] font-semibold whitespace-nowrap"
          style={{ background: rgba(state.color, 0.1), borderColor: rgba(state.color, 0.3), color: state.color }}
        >
          <i className="h-[5px] w-[5px] rounded-full" style={{ background: state.color }} />
          {state.label}
        </span>
      </div>
      <div className="mt-3.5 text-[44px] font-bold tracking-[-.04em] leading-none text-ds-text tabular-nums" suppressHydrationWarning>
        {now ? now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).toUpperCase() : "—"}
      </div>
      <div className="flex gap-6 mt-4 text-[12px] text-ds-t3 flex-wrap">
        <span>In <b className="text-ds-t5 font-semibold ml-1">{fmtClock(checkIn)}</b></span>
        <span>Out <b className="text-ds-t5 font-semibold ml-1">{fmtClock(checkOut)}</b></span>
        <span>Worked <b className="text-ds-t5 font-semibold ml-1">{worked}</b></span>
      </div>
      {error && (
        <div className="mt-3 px-3 py-2 rounded-[6px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[#FB7185] text-[12px]">{error}</div>
      )}
      <button
        type="button"
        onClick={punch}
        disabled={loading || done}
        className={`mt-5 w-full inline-flex items-center justify-center h-11 rounded-full border text-[13px] font-bold transition-colors disabled:opacity-50 ${
          !checkIn ? "bg-ds-gold border-ds-gold text-[#060D14] hover:bg-[#F4D58C]" : "bg-transparent border-[#2A4658] text-ds-text hover:border-ds-gold"
        }`}
      >
        {loading ? "Please wait…" : !checkIn ? "Check In" : !checkOut ? "Check Out" : "Checked out"}
      </button>
    </div>
  );
}

export default function AttendancePage() {
  usePageTitle("Attendance");
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [employeeFilter, setEmployeeFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");

  const [showModal, setShowModal] = useState(false);
  const [editRecord, setEditRecord] = useState<any | null>(null);
  const [manualForm, setManualForm] = useState<ManualEntry>(EMPTY_ENTRY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const startDate = useMemo(() => `${viewYear}-${pad(viewMonth + 1)}-01`, [viewYear, viewMonth]);
  const endDate = useMemo(() => {
    const lastDay = new Date(viewYear, viewMonth + 1, 0).getDate();
    return `${viewYear}-${pad(viewMonth + 1)}-${pad(lastDay)}`;
  }, [viewYear, viewMonth]);

  const { data, isLoading, error: loadError, mutate } = useAttendance({ startDate, endDate, employeeId: employeeFilter || undefined });
  const records: any[] = (data as any)?.data || [];
  const shown = useMemo(() => (statusFilter ? records.filter((r) => r.status === statusFilter) : records), [records, statusFilter]);

  // limit:500 so the attendance employee-filter dropdown lists all active employees (API caps at 50 otherwise).
  const { data: employeesData } = useEmployees({ status: "ACTIVE", limit: 500 });
  const employees: any[] = (employeesData as any)?.data || [];

  const count = (s: string) => records.filter((r) => r.status === s).length;
  const total = records.length;
  const stats = [
    { label: "Present", value: count("PRESENT"), color: "#00D7A0" },
    { label: "Late", value: count("LATE"), color: "#E9BD62" },
    { label: "Absent", value: count("ABSENT"), color: "#FB7185" },
    { label: "On Leave", value: count("LEAVE") + count("HALF_DAY"), color: "#9B7EDE", note: "leave + half day" },
  ];

  useEffect(() => {
    if (!showModal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !saving) setShowModal(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showModal, saving]);

  function prevMonth() {
    if (viewMonth === 0) { setViewYear((y) => y - 1); setViewMonth(11); }
    else setViewMonth((m) => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear((y) => y + 1); setViewMonth(0); }
    else setViewMonth((m) => m + 1);
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

  const editName = editRecord ? editRecord.employee?.name || employees.find((x) => x.id === editRecord.employeeId)?.name || "" : "";

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex-[1_1_320px] min-w-0">
          <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Attendance</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">Daily check-ins, overrides and manual records</p>
        </div>
        <button
          type="button"
          onClick={openAdd}
          className="inline-flex items-center gap-[7px] h-10 px-5 rounded-full bg-ds-gold text-[#060D14] text-[13px] font-bold whitespace-nowrap hover:bg-[#F4D58C]"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.4} /> Add Record
        </button>
      </section>

      {/* Clock + month stats */}
      <section className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))]">
        <ClockCard onChange={() => mutate()} />
        <div className="grid grid-cols-2 gap-px rounded-[16px] overflow-hidden bg-ds-line border border-ds-line">
          {stats.map((s) => (
            <div key={s.label} className="px-[22px] py-5 bg-ds-card min-w-0">
              <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[.16em] uppercase text-ds-t3">
                <i className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                {s.label}
              </div>
              <div className="mt-2.5 text-[32px] font-bold tracking-[-.04em] leading-none text-ds-text tabular-nums">
                {isLoading && !data ? "—" : String(s.value).padStart(2, "0")}
              </div>
              <div className="mt-1.5 text-[11px] text-ds-t3">
                {isLoading && !data ? " " : total ? `${Math.round((s.value / total) * 100)}% of records` : "no records this month"}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Controls */}
      <section className="flex items-center gap-2.5 flex-wrap mt-[22px]">
        <div className="flex items-center gap-1 h-[42px] px-1.5 rounded-full bg-ds-inset border border-ds-line2">
          <button type="button" onClick={prevMonth} aria-label="Previous month" className="h-8 w-8 rounded-full grid place-items-center text-ds-t2 hover:bg-[#132430] hover:text-ds-text">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[140px] text-center text-[13.5px] font-semibold text-ds-text whitespace-nowrap">
            {MONTH_NAMES[viewMonth]} {viewYear}
          </span>
          <button type="button" onClick={nextMonth} aria-label="Next month" className="h-8 w-8 rounded-full grid place-items-center text-ds-t2 hover:bg-[#132430] hover:text-ds-text">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <select
          value={employeeFilter}
          onChange={(e) => setEmployeeFilter(e.target.value)}
          aria-label="Employee"
          className="h-[42px] min-w-[200px] max-w-full px-4 rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] outline-none cursor-pointer [color-scheme:dark] focus:border-ds-gold"
        >
          <option value="" className="bg-ds-card">All Employees</option>
          {employees.map((emp: any) => (
            <option key={emp.id} value={emp.id} className="bg-ds-card">{emp.name}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Status"
          className="h-[42px] px-4 rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] outline-none cursor-pointer [color-scheme:dark] focus:border-ds-gold"
        >
          <option value="" className="bg-ds-card">All Statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s} className="bg-ds-card">{STATUS[s].label}</option>)}
        </select>
        {!isLoading && (
          <span className="ml-auto text-[12px] text-ds-t3 whitespace-nowrap">
            {shown.length} record{shown.length !== 1 ? "s" : ""}
          </span>
        )}
      </section>

      {/* Table */}
      <section className="mt-[18px] rounded-[16px] border border-[#2A4658] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)]">
        <div className="overflow-x-auto">
          <div className="min-w-[1000px]">
            <div className={`${GRID} h-[50px] px-6 bg-ds-inset border-b border-ds-line2 text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3 whitespace-nowrap`}>
              <span>Date</span><span>Employee</span><span>Check In</span><span>Check Out</span>
              <span className="text-center">Status</span><span>Overtime</span><span>Note</span><span className="text-center">Action</span>
            </div>
            {isLoading && !data ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className={`${GRID} h-[70px] px-6 border-b border-[#132430]`}>
                  <div className="h-3.5 w-16 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full bg-ds-hover motion-safe:animate-pulse" />
                    <div className="h-3.5 w-28 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                  </div>
                </div>
              ))
            ) : loadError ? (
              <div className="py-14 px-5 text-center text-ds-t3 text-[13px]">Attendance couldn&apos;t be loaded just now. Refresh to try again.</div>
            ) : shown.length === 0 ? (
              <div className="py-14 px-5 text-center text-ds-t3 text-[13px]">
                {records.length && statusFilter
                  ? `No ${STATUS[statusFilter]?.label.toLowerCase()} records for ${MONTH_NAMES[viewMonth]} ${viewYear}`
                  : `No records for ${MONTH_NAMES[viewMonth]} ${viewYear}`}
              </div>
            ) : (
              shown.map((r: any) => {
                const cfg = STATUS[r.status] || { label: r.status, color: "#738395" };
                const name = r.employee?.name || employees.find((x) => x.id === r.employeeId)?.name || "—";
                const hue = HUES[hash(name) % HUES.length];
                const key = (r.date || "").slice(0, 10);
                const dt = key ? new Date(`${key}T00:00:00`) : null;
                const ot = r.overtimeHours > 0 ? `${r.overtimeHours.toFixed(1)}h` : null;
                return (
                  <div key={r.id} className={`${GRID} h-[70px] px-6 border-b border-[#132430] last:border-b-0 text-[13px] hover:bg-[#0A1620] transition-colors tabular-nums`}>
                    <span className="flex flex-col gap-0.5 min-w-0 leading-[1.25]">
                      <span className="font-medium text-ds-t5 whitespace-nowrap">{dt ? `${dt.getDate()} ${MONTH_SHORT[dt.getMonth()]}` : "—"}</span>
                      <span className="text-[11.5px] text-ds-t3">{dt ? DOW[dt.getDay()].slice(0, 3) : ""}</span>
                    </span>
                    <span className="flex items-center gap-3 min-w-0">
                      <span
                        aria-hidden="true"
                        className="h-9 w-9 rounded-full border grid place-items-center text-[11px] font-bold shrink-0"
                        style={{ background: rgba(hue, 0.12), borderColor: rgba(hue, 0.3), color: hue }}
                      >
                        {initials(name)}
                      </span>
                      <span className="text-[14px] font-semibold text-ds-text truncate" title={name}>{name}</span>
                    </span>
                    <span className="text-ds-t5 whitespace-nowrap">{fmtClock(r.checkIn)}</span>
                    <span className="text-ds-t5 whitespace-nowrap">{fmtClock(r.checkOut)}</span>
                    <span className="flex justify-center">
                      <span
                        className="inline-flex items-center h-[30px] px-3.5 rounded-full border text-[12px] font-semibold whitespace-nowrap"
                        style={{ background: rgba(cfg.color, 0.1), borderColor: rgba(cfg.color, 0.3), color: cfg.color }}
                      >
                        {cfg.label}
                      </span>
                    </span>
                    <span className={`whitespace-nowrap ${ot ? "text-ds-t5 font-semibold" : "text-[#4A6275]"}`}>{ot ?? "—"}</span>
                    <span className={`text-[12.5px] truncate ${r.note ? "text-[#8B9AAB]" : "text-[#4A6275]"}`} title={r.note || undefined}>{r.note || "—"}</span>
                    <span className="flex justify-center">
                      <button
                        type="button"
                        onClick={() => openEdit(r)}
                        title="Override record"
                        aria-label={`Override record for ${name}`}
                        className="h-9 w-9 rounded-full border border-ds-line2 text-ds-t3 grid place-items-center shrink-0 hover:text-ds-gold hover:border-[rgba(233,189,98,.5)]"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>

      {/* Manual entry / override modal */}
      {showModal && (
        <ModalPortal>
          <div className="ds-root contents">
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(2,6,10,.7)]" onClick={() => !saving && setShowModal(false)}>
              <form
                onSubmit={handleSave}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={editRecord ? "Override Record" : "Add Manual Record"}
                className="relative w-full max-w-[440px] max-h-[calc(100vh-32px)] overflow-y-auto bg-ds-card border border-ds-line2 rounded-[16px] p-6 shadow-[0_20px_50px_rgba(0,0,0,.6)] flex flex-col gap-4"
              >
                <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,#E9BD62_30%,#E9BD62_70%,transparent)]" />
                <div className="flex items-center justify-between">
                  <span className="text-[16px] font-semibold text-ds-text">{editRecord ? "Override Record" : "Add Manual Record"}</span>
                  <button type="button" onClick={() => setShowModal(false)} disabled={saving} aria-label="Close" className="text-ds-t3 hover:text-ds-text">
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {editRecord ? (
                  <div className="text-[12.5px] text-ds-t2 -mt-1">{editName}</div>
                ) : (
                  <label className={LABEL}>
                    <span>Employee<span className="text-ds-gold ml-[3px]">*</span></span>
                    <select required className={`${FIELD} cursor-pointer`} value={manualForm.userId} onChange={(e) => setManualForm({ ...manualForm, userId: e.target.value })}>
                      <option value="" className="bg-ds-card">Select employee...</option>
                      {employees.map((emp: any) => (
                        <option key={emp.id} value={emp.id} className="bg-ds-card">{emp.name}</option>
                      ))}
                    </select>
                  </label>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <label className={LABEL}>
                    <span>Date<span className="text-ds-gold ml-[3px]">*</span></span>
                    <input type="date" required className={FIELD} value={manualForm.date} onChange={(e) => setManualForm({ ...manualForm, date: e.target.value })} />
                  </label>
                  <label className={LABEL}>
                    <span>Status<span className="text-ds-gold ml-[3px]">*</span></span>
                    <select required className={`${FIELD} cursor-pointer`} value={manualForm.status} onChange={(e) => setManualForm({ ...manualForm, status: e.target.value })}>
                      {STATUS_OPTIONS.map((s) => <option key={s} value={s} className="bg-ds-card">{STATUS[s].label}</option>)}
                    </select>
                  </label>
                  <label className={LABEL}>
                    <span>Check In</span>
                    <input type="time" className={FIELD} value={manualForm.checkIn} onChange={(e) => setManualForm({ ...manualForm, checkIn: e.target.value })} />
                  </label>
                  <label className={LABEL}>
                    <span>Check Out</span>
                    <input type="time" className={FIELD} value={manualForm.checkOut} onChange={(e) => setManualForm({ ...manualForm, checkOut: e.target.value })} />
                  </label>
                </div>

                <label className={LABEL}>
                  <span>Note</span>
                  <input className={FIELD} placeholder="Reason for manual entry..." value={manualForm.note} onChange={(e) => setManualForm({ ...manualForm, note: e.target.value })} />
                </label>

                {error && (
                  <div className="px-3 py-2.5 rounded-[6px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[#FB7185] text-[12px]">{error}</div>
                )}

                <div className="flex gap-2 mt-1">
                  <button type="submit" disabled={saving} className="h-10 px-5 rounded-full bg-ds-gold text-[#060D14] text-[13px] font-bold hover:bg-[#F4D58C] disabled:opacity-60">
                    {saving ? "Saving..." : "Save Record"}
                  </button>
                  <button type="button" onClick={() => setShowModal(false)} disabled={saving} className="h-10 px-[18px] rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold hover:text-ds-text disabled:opacity-50">
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
}
