"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HUES = ["var(--hx-238BFF)", "var(--hx-E9BD62)", "var(--hx-9B7EDE)", "var(--hx-00D7A0)", "var(--hx-FB7185)", "var(--hx-6EB2FF)"];
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
};
const initials = (n: string) =>
  n.split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "—";
// Local date parts, never toISOString (IST rule).
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fdY = (v: string) => {
  const d = new Date(v);
  return isNaN(d.getTime()) ? "—" : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

const DOC_ICON = "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5";
function Icon({ d, className = "h-4 w-4", sw = 1.9 }: { d: string; className?: string; sw?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const LABEL = "flex flex-col gap-[7px] text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase min-w-0";
const FIELD =
  "h-[46px] w-full px-4 rounded-[12px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] tracking-normal normal-case font-normal outline-none focus:border-[rgba(233,189,98,.6)] placeholder:text-ds-t4 [color-scheme:dark] min-w-0";
const GRID =
  "grid gap-x-3 items-center [grid-template-columns:minmax(130px,30fr)_minmax(100px,22fr)_minmax(80px,14fr)_minmax(120px,20fr)_40px]";
const REQ = <span className="text-ds-gold ml-[3px]">*</span>;

const BLANK = {
  employeeId: "",
  offerDate: "",
  joiningDate: "",
  designation: "",
  department: "",
  salary: "",
  probationMonths: "3",
  location: "",
};

export default function OfferLettersPage() {
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState(BLANK);

  const { data: lettersData, error, isLoading, mutate } = useSWR(
    "/admin/offer-letters",
    (url: string) => apiFetch<any>(url)
  );
  const letters: any[] = lettersData?.data || [];
  const loaded = !!lettersData;

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
    if (submitting) return;
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
      setForm(BLANK);
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

  const todayKey = dayKey(new Date());
  const nameOf = (l: any) => l.employeeName || l.employee?.name || "";

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex-[1_1_320px] min-w-0">
          <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight whitespace-nowrap">Offer Letters</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">
            {loaded
              ? `${letters.length} offer ${letters.length === 1 ? "letter" : "letters"} generated`
              : error
                ? "Offer letters couldn't be loaded"
                : "Loading offer letters…"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setShowForm((p) => !p); setFormError(null); }}
          aria-expanded={showForm}
          className="inline-flex items-center gap-2 h-[46px] px-[22px] rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[14px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] transition-colors"
        >
          <Icon d={showForm ? "M18 15l-6-6-6 6" : "M12 5v14M5 12h14"} className="h-[15px] w-[15px]" sw={2.4} />
          {showForm ? "Close Form" : "Generate Offer Letter"}
        </button>
      </section>

      {/* Inline Form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="relative mb-4 rounded-[18px] border border-[color:var(--hx-2A4658)] bg-ds-card px-5 sm:px-[26px] py-6 shadow-[0_12px_32px_rgba(0,0,0,.35)] overflow-hidden"
        >
          <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px opacity-70 bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)]" />
          <div className="flex items-center gap-2.5 mb-5">
            <span className="h-[34px] w-[34px] rounded-[10px] bg-[rgba(233,189,98,.12)] text-ds-gold grid place-items-center shrink-0">
              <Icon d={DOC_ICON} className="h-[15px] w-[15px]" />
            </span>
            <span className="text-[16px] font-semibold text-ds-text">New Offer Letter</span>
          </div>
          <div className="grid gap-x-[18px] gap-y-4 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
            <label className={LABEL}>
              <span>Employee{REQ}</span>
              <select
                value={form.employeeId}
                onChange={(e) => updateForm("employeeId", e.target.value)}
                required
                className={`${FIELD} cursor-pointer`}
              >
                <option value="" className="bg-ds-card">Select employee...</option>
                {employees.map((emp: any) => (
                  <option key={emp.id} value={emp.id} className="bg-ds-card">
                    {emp.name || `${emp.firstName || ""} ${emp.lastName || ""}`}
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL}>
              <span>Offer Date{REQ}</span>
              <input type="date" value={form.offerDate} onChange={(e) => updateForm("offerDate", e.target.value)} required className={FIELD} />
            </label>
            <label className={LABEL}>
              <span>Joining Date{REQ}</span>
              <input type="date" value={form.joiningDate} onChange={(e) => updateForm("joiningDate", e.target.value)} required className={FIELD} />
            </label>
            <label className={LABEL}>
              <span>Designation{REQ}</span>
              <input type="text" placeholder="e.g., Software Engineer" value={form.designation} onChange={(e) => updateForm("designation", e.target.value)} required className={FIELD} />
            </label>
            <label className={LABEL}>
              <span>Department{REQ}</span>
              <input type="text" placeholder="e.g., Engineering" value={form.department} onChange={(e) => updateForm("department", e.target.value)} required className={FIELD} />
            </label>
            <label className={LABEL}>
              <span>Salary (Monthly){REQ}</span>
              <input type="number" placeholder="e.g., 50000" value={form.salary} onChange={(e) => updateForm("salary", e.target.value)} required className={FIELD} />
            </label>
            <label className={LABEL}>
              <span>Probation (Months){REQ}</span>
              <input type="number" min="0" max="12" value={form.probationMonths} onChange={(e) => updateForm("probationMonths", e.target.value)} required className={FIELD} />
            </label>
            <label className={LABEL}>
              <span>Location{REQ}</span>
              <input type="text" placeholder="e.g., New Delhi" value={form.location} onChange={(e) => updateForm("location", e.target.value)} required className={FIELD} />
            </label>
          </div>
          {formError && (
            <div role="alert" className="mt-4 px-3.5 py-2.5 rounded-[10px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12.5px]">
              {formError}
            </div>
          )}
          <div className="flex justify-end mt-5">
            <button
              type="submit"
              disabled={submitting}
              aria-live="polite"
              className="inline-flex items-center gap-2 h-11 px-[22px] rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[14px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60 transition-colors"
            >
              {submitting ? "Generating..." : "Generate Offer Letter"}
            </button>
          </div>
        </form>
      )}

      {/* Table */}
      <section className="rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)]">
        <div className="overflow-x-auto [color-scheme:dark]">
          <div className="min-w-[600px]">
            <div className={`${GRID} h-[52px] px-5 bg-ds-inset border-b border-ds-line2 text-[11px] font-semibold tracking-[.08em] uppercase text-ds-t3 whitespace-nowrap`}>
              <span>Employee</span><span>Designation</span><span>Salary</span><span>Joining</span><span />
            </div>
            {isLoading && !lettersData ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={`${GRID} h-[80px] px-5 border-b border-[color:var(--hx-132430)]`}>
                  <div className="flex items-center gap-3">
                    <div className="h-[38px] w-[38px] rounded-full bg-ds-hover motion-safe:animate-pulse" />
                    <div className="h-3.5 w-28 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                  </div>
                </div>
              ))
            ) : error && !lettersData ? (
              <div className="py-14 px-5 text-center text-ds-t3 text-[13px]">Offer letters couldn&apos;t be loaded just now. Refresh to try again.</div>
            ) : letters.length === 0 ? (
              <div className="py-14 px-5 flex flex-col items-center gap-2.5 text-ds-t3 text-[13px]">
                <Icon d={DOC_ICON} className="h-[30px] w-[30px]" sw={1.5} />
                No offer letters generated yet
              </div>
            ) : (
              letters.map((letter: any) => {
                const name = nameOf(letter);
                const hue = HUES[hash(name || letter.id || "") % HUES.length];
                const sub = [letter.department, letter.location].filter(Boolean).join(" · ");
                const joinD = letter.joiningDate ? new Date(letter.joiningDate) : null;
                const upcoming = !!joinD && !isNaN(joinD.getTime()) && dayKey(joinD) > todayKey;
                return (
                  <div
                    key={letter.id}
                    className={`${GRID} min-h-[80px] py-3 px-5 border-b border-[color:var(--hx-132430)] last:border-b-0 text-[13.5px] tabular-nums hover:bg-[color:var(--hx-0A1620)] transition-colors`}
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span
                        className="h-[38px] w-[38px] rounded-full grid place-items-center text-[12px] font-bold shrink-0"
                        style={{ background: rgba(hue, 0.16), color: hue }}
                      >
                        {name ? initials(name) : "—"}
                      </span>
                      <span className="flex flex-col gap-0.5 min-w-0 leading-[1.25]">
                        <span className="text-[14.5px] font-semibold text-ds-text leading-[1.3] [overflow-wrap:anywhere]">{name || "—"}</span>
                        {sub && <span className="text-[11.5px] text-ds-t3 truncate" title={sub}>{sub}</span>}
                      </span>
                    </span>
                    <span className="text-ds-t5 leading-[1.35] [overflow-wrap:anywhere] min-w-0">{letter.designation || "—"}</span>
                    <span className="font-bold text-ds-gold whitespace-nowrap">
                      {letter.salary != null ? `₹${Number(letter.salary).toLocaleString("en-IN")}` : "—"}
                    </span>
                    <span className="flex flex-col justify-center gap-1 min-w-0 leading-[1.25]">
                      <span className="flex items-center gap-1.5 text-ds-text font-medium whitespace-nowrap">
                        {letter.joiningDate ? fdY(letter.joiningDate) : "—"}
                        {upcoming && <span title="Upcoming" className="h-1.5 w-1.5 rounded-full bg-ds-teal shrink-0" />}
                      </span>
                      <span className="text-[11.5px] text-ds-t3 whitespace-nowrap">
                        Offered {letter.offerDate ? fdY(letter.offerDate) : "—"}
                      </span>
                    </span>
                    <span className="flex items-center justify-end">
                      <button
                        type="button"
                        onClick={() => viewHtml(letter.id)}
                        title="View offer letter"
                        aria-label={`View offer letter${name ? ` for ${name}` : ""}`}
                        className="h-[38px] w-[38px] rounded-full border border-[rgba(233,189,98,.4)] bg-[rgba(233,189,98,.08)] text-ds-gold grid place-items-center shrink-0 hover:bg-[rgba(233,189,98,.2)] transition-colors"
                      >
                        <Icon d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" className="h-[15px] w-[15px]" />
                      </button>
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
