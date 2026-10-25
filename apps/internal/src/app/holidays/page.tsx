"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { ChevronLeft, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { ModalPortal } from "@/components/modal-portal";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WDL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TYPEC: Record<string, [string, string]> = {
  PUBLIC: ["Public", "var(--hx-00D7A0)"],
  RESTRICTED: ["Restricted", "var(--hx-E9BD62)"],
  COMPANY: ["Company", "var(--hx-6EB2FF)"],
};
const TYPE_KEYS = ["PUBLIC", "RESTRICTED", "COMPANY"];
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
// Local date parts, never toISOString (IST rule).
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const CAL_ICON = "M3 4h18v18H3zM16 2v4M8 2v4M3 10h18";
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
const YEAR_BTN =
  "h-[38px] w-[38px] rounded-full border border-ds-line2 bg-ds-inset text-ds-t2 grid place-items-center shrink-0 hover:text-ds-text hover:border-[rgba(233,189,98,.5)] transition-colors";

const emptyForm = { name: "", date: "", type: "PUBLIC" as "PUBLIC" | "RESTRICTED" | "COMPANY", description: "" };

export default function HolidaysPage() {
  usePageTitle("Holiday Calendar");
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const { data, isLoading, error, mutate } = useSWR(
    `/admin/holidays?year=${year}`,
    (url: string) => apiFetch<any>(url)
  );
  const holidays: any[] = data?.data || [];
  const loaded = !!data;

  useEffect(() => {
    if (!modalOpen && !deleteTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (deleteTarget && !deleting) setDeleteTarget(null);
      else if (modalOpen && !adding) setModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen, deleteTarget, adding, deleting]);

  function updateForm(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setAddError("");
  }

  function openModal() {
    setForm(emptyForm);
    setAddError("");
    setModalOpen(true);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (adding) return;
    setAdding(true);
    setAddError("");
    try {
      await apiFetch("/admin/holidays", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setModalOpen(false);
      mutate();
    } catch (e: any) {
      setAddError(e.message || "Failed to add holiday");
    } finally {
      setAdding(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await apiFetch(`/admin/holidays/${deleteTarget.id}`, { method: "DELETE" });
      mutate();
      setDeleteTarget(null);
    } catch (e: any) {
      setDeleteError(e.message || "Failed to delete holiday");
    } finally {
      setDeleting(false);
    }
  }

  // ── Derived view data (real API rows only) ──
  const today = midnight(new Date());
  const todayKey = dayKey(today);
  const rows = holidays
    .map((h) => {
      const d = h.date ? new Date(h.date) : null;
      const valid = !!d && !isNaN(d.getTime());
      return { h, d: valid ? (d as Date) : null, key: valid ? dayKey(d as Date) : "" };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // "Next holiday" is only knowable for the current year (we only fetch one year at a time).
  const next = year === currentYear ? rows.find((r) => r.d && r.key >= todayKey) ?? null : null;
  const daysToGo = next?.d ? Math.round((midnight(next.d).getTime() - today.getTime()) / 864e5) : 0;

  const counts = TYPE_KEYS.map((k) => [k, rows.filter((r) => (r.h.type || "PUBLIC") === k).length] as const);
  const summary = loaded
    ? `${rows.length} holiday${rows.length === 1 ? "" : "s"} in ${year}` +
      (counts.some(([, n]) => n) ? " · " + counts.filter(([, n]) => n).map(([k, n]) => `${n} ${TYPEC[k][0].toLowerCase()}`).join(", ") : "")
    : error
      ? "Holidays couldn't be loaded"
      : "Loading holidays…";

  const groups: { mi: number; list: typeof rows }[] = [];
  const undated: typeof rows = [];
  rows.forEach((r) => {
    if (!r.d) { undated.push(r); return; }
    const mi = r.d.getMonth();
    let g = groups.find((q) => q.mi === mi);
    if (!g) { g = { mi, list: [] }; groups.push(g); }
    g.list.push(r);
  });

  const renderRow = (r: (typeof rows)[number], i: number) => {
    const isNext = !!next && r.h.id === next.h.id;
    const [tl, tc] = TYPEC[r.h.type] || TYPEC.PUBLIC;
    return (
      <div
        key={r.h.id}
        className={`grid [grid-template-columns:56px_minmax(0,1fr)_auto] items-center gap-3.5 sm:gap-[18px] px-4 sm:px-5 py-4 border-t ${i ? "border-[color:var(--hx-132430)]" : "border-transparent"} hover:bg-[color:var(--hx-0A1620)] transition-colors`}
      >
        <span
          className="h-[60px] w-14 rounded-[12px] border flex flex-col items-center justify-center leading-none"
          style={{ background: isNext ? "var(--hx-E9BD62)" : "var(--hx-0B1720)", borderColor: isNext ? "var(--hx-E9BD62)" : "var(--hx-223543)" }}
        >
          <span className="text-[24px] font-extrabold tracking-[-.03em] tabular-nums" style={{ color: isNext ? "var(--hx-060D14)" : "var(--hx-F4F6F8)" }}>
            {r.d ? r.d.getDate() : "—"}
          </span>
          <span className="mt-[5px] text-[10px] font-bold tracking-[.14em]" style={{ color: isNext ? "rgba(6,13,20,.7)" : "var(--hx-738395)" }}>
            {r.d ? WD[r.d.getDay()].toUpperCase() : ""}
          </span>
        </span>
        <div className="min-w-0 flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="text-[16px] font-bold tracking-[-.01em] text-ds-text [overflow-wrap:anywhere]">{r.h.name || "—"}</span>
            <span
              className="inline-flex items-center gap-1.5 h-[22px] px-2.5 rounded-full border text-[11px] font-semibold whitespace-nowrap"
              style={{ background: rgba(tc, 0.1), borderColor: rgba(tc, 0.3), color: tc }}
            >
              <i className="h-[5px] w-[5px] rounded-full" style={{ background: tc }} />
              {tl}
            </span>
            {isNext && (
              <span className="inline-flex items-center h-[22px] px-2.5 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[10.5px] font-extrabold tracking-[.08em] whitespace-nowrap shrink-0">
                NEXT UP
              </span>
            )}
          </div>
          {r.h.description && <span className="text-[13px] leading-[1.5] text-ds-t2 [text-wrap:pretty] [overflow-wrap:anywhere]">{r.h.description}</span>}
        </div>
        <button
          type="button"
          onClick={() => { setDeleteError(""); setDeleteTarget(r.h); }}
          title="Delete holiday"
          aria-label={`Delete ${r.h.name || "holiday"}`}
          className="h-9 w-9 rounded-full border border-[color:var(--hx-1F3442)] text-ds-t3 grid place-items-center shrink-0 hover:text-[color:var(--hx-FB7185)] hover:border-[rgba(229,72,77,.5)] hover:bg-[rgba(229,72,77,.08)] transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  };

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex-[1_1_300px] min-w-0">
          <div className="text-[11px] font-bold tracking-[.2em] uppercase text-ds-gold">Time off</div>
          <h1 className="mt-1.5 text-[32px] sm:text-[38px] font-extrabold tracking-[-.035em] text-ds-text leading-tight whitespace-nowrap">Holiday Calendar</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">{summary}</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setYear((y) => y - 1)} aria-label="Previous year" className={YEAR_BTN}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[84px] text-center text-[26px] font-extrabold tracking-[-.03em] text-ds-gold tabular-nums">{year}</span>
            <button type="button" onClick={() => setYear((y) => y + 1)} aria-label="Next year" className={YEAR_BTN}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={openModal}
            className="inline-flex items-center gap-2 h-11 px-5 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13.5px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] transition-colors"
          >
            <Plus className="h-[15px] w-[15px]" strokeWidth={2.4} /> Add Holiday
          </button>
        </div>
      </section>

      {/* Next holiday hero */}
      {next && next.d && (
        <section className="relative grid [grid-template-columns:auto_minmax(0,1fr)] sm:[grid-template-columns:auto_minmax(0,1fr)_auto] items-center gap-5 sm:gap-7 mb-[18px] px-5 sm:px-8 py-6 sm:py-7 rounded-[20px] border border-[rgba(233,189,98,.45)] bg-[radial-gradient(120%_140%_at_0%_0%,rgba(233,189,98,.16),rgba(233,189,98,.03)_55%,var(--hx-08131C)_100%)] shadow-[0_18px_40px_rgba(0,0,0,.4)] overflow-hidden">
          <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)]" />
          <span className="w-[76px] h-[84px] sm:w-[92px] sm:h-[100px] rounded-[16px] bg-ds-gold text-[color:var(--hx-060D14)] flex flex-col items-center justify-center leading-none shadow-[0_10px_24px_rgba(233,189,98,.25)]">
            <span className="text-[12px] font-extrabold tracking-[.18em]">{MONTHS[next.d.getMonth()].toUpperCase()}</span>
            <span className="text-[34px] sm:text-[42px] font-extrabold tracking-[-.04em] mt-1.5 tabular-nums">{next.d.getDate()}</span>
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-bold tracking-[.2em] uppercase text-ds-gold">Next holiday</div>
            <div className="mt-2 text-[22px] sm:text-[30px] font-extrabold tracking-[-.03em] leading-[1.1] text-ds-text [text-wrap:balance] [overflow-wrap:anywhere]">{next.h.name || "—"}</div>
            <div className="mt-2 flex items-center gap-2.5 flex-wrap text-[13px] text-ds-t2">
              <span>{WDL[next.d.getDay()]}</span>
              <span className="h-[3px] w-[3px] rounded-full bg-[color:var(--hx-4A6275)]" />
              <span className="font-semibold" style={{ color: (TYPEC[next.h.type] || TYPEC.PUBLIC)[1] }}>{(TYPEC[next.h.type] || TYPEC.PUBLIC)[0]}</span>
            </div>
          </div>
          <div className="col-span-2 sm:col-span-1 flex sm:block items-baseline gap-3 sm:text-right pt-4 sm:pt-0 sm:pl-7 border-t sm:border-t-0 sm:border-l border-[rgba(233,189,98,.25)]">
            <div className="text-[44px] sm:text-[56px] font-extrabold tracking-[-.05em] leading-[.9] text-ds-gold tabular-nums">{daysToGo === 0 ? "Today" : daysToGo}</div>
            {daysToGo !== 0 && (
              <div className="sm:mt-2 text-[11px] font-bold tracking-[.18em] uppercase text-ds-t2">{daysToGo === 1 ? "day" : "days"} to go</div>
            )}
          </div>
        </section>
      )}

      {/* Legend */}
      {loaded && (
        <section className="flex items-center gap-2.5 flex-wrap mb-[18px]">
          {TYPE_KEYS.map((k) => {
            const [label, c] = TYPEC[k];
            const n = counts.find(([kk]) => kk === k)?.[1] ?? 0;
            return (
              <span key={k} className="inline-flex items-center gap-2 h-[34px] px-3.5 rounded-full bg-ds-card border border-[color:var(--hx-1F3442)] text-[12.5px] font-semibold text-ds-t5">
                <i className="h-2 w-2 rounded-full" style={{ background: c }} />
                {label}
                <span className="text-ds-t3 tabular-nums">{n}</span>
              </span>
            );
          })}
        </section>
      )}

      {/* Months */}
      <section className="flex flex-col gap-3.5">
        {isLoading && !data ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-[120px] rounded-[18px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
          ))
        ) : error && !data ? (
          <div className="rounded-[18px] border border-[color:var(--hx-2A4658)] bg-ds-card py-14 px-5 text-center text-ds-t3 text-[13px]">
            Holidays couldn&apos;t be loaded just now. Refresh to try again.
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-[18px] border border-[color:var(--hx-2A4658)] bg-ds-card py-16 px-5 flex flex-col items-center gap-3 text-ds-t3 text-[13.5px]">
            <Icon d={CAL_ICON} className="h-8 w-8" sw={1.5} />
            No holidays for {year}
          </div>
        ) : (
          <>
            {groups.map((g) => {
              const hasNext = !!next && g.list.some((r) => r.h.id === next.h.id);
              const past = g.list.every((r) => r.key < todayKey);
              return (
                <div
                  key={g.mi}
                  className="grid grid-cols-1 sm:[grid-template-columns:160px_minmax(0,1fr)] rounded-[18px] border bg-ds-card overflow-hidden shadow-[0_10px_28px_rgba(0,0,0,.28)]"
                  style={{ borderColor: hasNext ? "rgba(233,189,98,.45)" : "var(--hx-1F3442)", opacity: past ? 0.6 : 1 }}
                >
                  <div
                    className="px-5 py-4 sm:py-[22px] border-b sm:border-b-0 sm:border-r border-[color:var(--hx-1A2C38)] flex sm:flex-col items-baseline sm:items-start justify-between sm:justify-start gap-1.5"
                    style={{ background: hasNext ? "rgba(233,189,98,.08)" : "var(--hx-0B1720)" }}
                  >
                    <span className="text-[22px] font-extrabold tracking-[-.03em] [overflow-wrap:anywhere]" style={{ color: hasNext ? "var(--hx-E9BD62)" : "var(--hx-F4F6F8)" }}>
                      {MONTHS_FULL[g.mi]}
                    </span>
                    <span className="text-[11px] font-semibold tracking-[.14em] uppercase text-ds-t3 whitespace-nowrap">
                      {g.list.length} {g.list.length === 1 ? "holiday" : "holidays"}
                    </span>
                  </div>
                  <div className="flex flex-col min-w-0">{g.list.map(renderRow)}</div>
                </div>
              );
            })}
            {undated.length > 0 && (
              <div className="grid grid-cols-1 sm:[grid-template-columns:160px_minmax(0,1fr)] rounded-[18px] border border-[color:var(--hx-1F3442)] bg-ds-card overflow-hidden">
                <div className="px-5 py-4 sm:py-[22px] bg-ds-inset border-b sm:border-b-0 sm:border-r border-[color:var(--hx-1A2C38)]">
                  <span className="text-[22px] font-extrabold tracking-[-.03em] text-ds-text">No date</span>
                </div>
                <div className="flex flex-col min-w-0">{undated.map(renderRow)}</div>
              </div>
            )}
          </>
        )}
      </section>

      {/* Add Holiday Modal */}
      {modalOpen && (
        <ModalPortal>
          <div className="ds-root contents">
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(2,6,10,.72)]" onClick={() => !adding && setModalOpen(false)}>
              <form
                onSubmit={handleAdd}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Add Holiday"
                className="relative w-full max-w-[500px] max-h-full overflow-y-auto bg-ds-card border border-ds-line2 rounded-[18px] shadow-[0_24px_60px_rgba(0,0,0,.6)]"
              >
                <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)]" />
                <div className="flex items-center justify-between px-6 py-[18px] border-b border-[color:var(--hx-1A2C38)]">
                  <span className="flex items-center gap-2.5 text-[16px] font-semibold text-ds-text">
                    <span className="text-ds-gold flex"><Icon d={CAL_ICON} className="h-[17px] w-[17px]" /></span>
                    Add Holiday
                  </span>
                  <button
                    type="button"
                    onClick={() => setModalOpen(false)}
                    disabled={adding}
                    aria-label="Close"
                    className="h-[30px] w-[30px] rounded-[8px] grid place-items-center text-ds-t3 hover:bg-[color:var(--hx-132430)] hover:text-ds-text transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="px-6 py-[22px] flex flex-col gap-4">
                  <label className={LABEL}>
                    <span>Holiday Name<span className="text-ds-gold ml-[3px]">*</span></span>
                    <input
                      type="text"
                      placeholder="e.g., Republic Day"
                      value={form.name}
                      onChange={(e) => updateForm("name", e.target.value)}
                      required
                      autoFocus
                      className={FIELD}
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-3.5">
                    <label className={LABEL}>
                      <span>Date<span className="text-ds-gold ml-[3px]">*</span></span>
                      <input type="date" value={form.date} onChange={(e) => updateForm("date", e.target.value)} required className={FIELD} />
                    </label>
                    <label className={LABEL}>
                      <span>Type</span>
                      <select value={form.type} onChange={(e) => updateForm("type", e.target.value)} className={`${FIELD} cursor-pointer`}>
                        <option value="PUBLIC" className="bg-ds-card">Public</option>
                        <option value="RESTRICTED" className="bg-ds-card">Restricted</option>
                        <option value="COMPANY" className="bg-ds-card">Company</option>
                      </select>
                    </label>
                  </div>
                  <label className={LABEL}>
                    <span>Description</span>
                    <input
                      type="text"
                      placeholder="Optional description"
                      value={form.description}
                      onChange={(e) => updateForm("description", e.target.value)}
                      className={FIELD}
                    />
                  </label>
                  {addError && (
                    <div role="alert" className="px-3 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12.5px]">
                      {addError}
                    </div>
                  )}
                  <div className="flex justify-end gap-2.5 pt-1">
                    <button
                      type="button"
                      onClick={() => setModalOpen(false)}
                      disabled={adding}
                      className="h-[42px] px-5 rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold hover:text-ds-text hover:border-[color:var(--hx-2A4658)] disabled:opacity-50 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={adding}
                      aria-live="polite"
                      className="inline-flex items-center gap-2 h-[42px] px-5 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13.5px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60 transition-colors"
                    >
                      <Plus className="h-3.5 w-3.5" strokeWidth={2.4} />
                      {adding ? "Adding..." : "Add Holiday"}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <ModalPortal>
          <div className="ds-root contents">
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(2,6,10,.72)]" onClick={() => !deleting && setDeleteTarget(null)}>
              <div
                onClick={(e) => e.stopPropagation()}
                role="alertdialog"
                aria-modal="true"
                aria-label="Delete holiday?"
                className="w-full max-w-[380px] bg-ds-card border border-ds-line2 rounded-[16px] p-6 shadow-[0_20px_50px_rgba(0,0,0,.6)]"
              >
                <div className="h-10 w-10 rounded-[11px] grid place-items-center bg-[rgba(229,72,77,.12)] text-[color:var(--hx-FB7185)]">
                  <Trash2 className="h-[17px] w-[17px]" />
                </div>
                <div className="mt-3.5 text-[15px] font-semibold text-ds-text">Delete holiday?</div>
                <div className="mt-1.5 text-[12.5px] leading-[1.5] text-ds-t2">
                  <b className="text-ds-text font-semibold">{deleteTarget.name || "This holiday"}</b> will be removed. This cannot be undone.
                </div>
                {deleteError && (
                  <div role="alert" className="mt-3.5 px-3 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12px]">
                    {deleteError}
                  </div>
                )}
                <div className="flex justify-end gap-2 mt-[22px]">
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(null)}
                    disabled={deleting}
                    className="h-[38px] px-4 rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold hover:text-ds-text disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={confirmDelete}
                    disabled={deleting}
                    className="h-[38px] px-[18px] rounded-full bg-[color:var(--hx-E5484D)] text-white text-[13px] font-bold disabled:opacity-60"
                  >
                    {deleting ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
}
