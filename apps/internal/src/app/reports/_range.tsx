"use client";
import { X } from "lucide-react";

export interface RangePreset {
  label: string;
  days: number; // number of days the window spans, inclusive of today
}

// Shared across all three Reports pages so the time-period pills stay consistent.
export const RANGE_PRESETS: RangePreset[] = [
  { label: "24h", days: 1 },
  { label: "48h", days: 2 },
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "Year", days: 365 },
];

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayISO(): string {
  return toISODate(new Date());
}

// Start date (YYYY-MM-DD) for a preset spanning `days` days ending today, inclusive.
export function presetStart(days: number, end: Date = new Date()): string {
  return toISODate(new Date(end.getTime() - (days - 1) * 86400000));
}

// Which preset (if any) the current [startDate, endDate] exactly matches.
export function activePresetLabel(startDate: string, endDate: string): string | null {
  const t = todayISO();
  if (endDate !== t) return null;
  const match = RANGE_PRESETS.find((p) => presetStart(p.days) === startDate);
  return match?.label ?? null;
}

interface RangePillsProps {
  startDate: string;
  endDate: string;
  onChange: (startDate: string, endDate: string) => void;
  /** Default preset label to reset to (defaults to "30d"). */
  defaultLabel?: string;
}

/**
 * Time-period pills + From/To custom date inputs.
 * "Everything follows the pill" — the parent owns startDate/endDate and feeds
 * every card/chart on the page from that single range.
 */
export function RangePills({ startDate, endDate, onChange, defaultLabel = "30d" }: RangePillsProps) {
  const active = activePresetLabel(startDate, endDate);
  const isCustom = active === null;
  const defPreset = RANGE_PRESETS.find((p) => p.label === defaultLabel) ?? RANGE_PRESETS[4];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {RANGE_PRESETS.map((p) => {
          const isActive = active === p.label;
          return (
            <button
              key={p.label}
              onClick={() => onChange(presetStart(p.days), todayISO())}
              className={`h-8 px-3.5 rounded-full text-xs font-semibold transition-all border ${
                isActive
                  ? "bg-[#1A1A1A] text-white border-[#1A1A1A] shadow-sm"
                  : "bg-white text-[#7A7A7A] border-[#E8E0D0] hover:border-[#1A1A1A]/30 hover:text-[#1A1A1A]"
              }`}
            >
              {p.label}
            </button>
          );
        })}

        <span className="mx-1 h-5 w-px bg-[#E8E0D0]" />

        <div className="flex items-center gap-1.5">
          <label className="text-[10px] font-medium text-[#B0B0B0] uppercase tracking-wide">From</label>
          <input
            type="date"
            value={startDate}
            max={endDate}
            onChange={(e) => onChange(e.target.value, endDate)}
            className="h-8 rounded-lg border border-[#E8E0D0] bg-[#FEFCF8] text-xs px-2 focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] font-medium text-[#B0B0B0] uppercase tracking-wide">To</label>
          <input
            type="date"
            value={endDate}
            min={startDate}
            max={todayISO()}
            onChange={(e) => onChange(startDate, e.target.value)}
            className="h-8 rounded-lg border border-[#E8E0D0] bg-[#FEFCF8] text-xs px-2 focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]"
          />
        </div>

        {isCustom && (
          <button
            onClick={() => onChange(presetStart(defPreset.days), todayISO())}
            className="h-8 flex items-center gap-1 rounded-lg border border-[#E8E0D0] bg-white px-2.5 text-[11px] text-[#7A7A7A] hover:text-[#E74C3C] hover:border-red-200 transition-colors"
            title={`Reset to last ${defaultLabel}`}
          >
            <X className="h-3 w-3" /> Reset
          </button>
        )}
      </div>
    </div>
  );
}

// Human label for the currently selected window, e.g. "Last 7 days" or "12 May – 20 May".
export function rangeLabel(startDate: string, endDate: string): string {
  const active = activePresetLabel(startDate, endDate);
  if (active) {
    if (active === "24h") return "Today";
    if (active === "48h") return "Last 48 hours";
    if (active === "Year") return "Last year";
    return `Last ${active.replace("d", " days")}`;
  }
  const fmt = (s: string) =>
    new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}
