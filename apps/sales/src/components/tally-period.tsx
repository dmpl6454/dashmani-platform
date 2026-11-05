"use client";
import { todayIST } from "@/lib/format";

// The period chooser of the Tally page (spec-tally §5.2): Last month · This month · This quarter ·
// This FY · Custom. Quarters are financial-year quarters (Apr–Jun …). On or before the 15th (IST)
// the default is last month, otherwise this month.

export type TallyPreset = "last_month" | "this_month" | "this_quarter" | "this_fy" | "custom";
export interface TallyPeriodValue { preset: TallyPreset; from: string; to: string }

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
const span = (y: number, m1: number, y2: number, m2: number) => ({ from: `${y}-${pad(m1)}-01`, to: `${y2}-${pad(m2)}-${pad(lastDay(y2, m2))}` });

export function presetRange(p: Exclude<TallyPreset, "custom">, today = todayIST()): { from: string; to: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  if (p === "this_month") return span(y, m, y, m);
  if (p === "last_month") return m === 1 ? span(y - 1, 12, y - 1, 12) : span(y, m - 1, y, m - 1);
  const fyStart = m >= 4 ? y : y - 1;
  if (p === "this_fy") return span(fyStart, 4, fyStart + 1, 3);
  const qStart = m >= 4 ? Math.floor((m - 4) / 3) * 3 + 4 : 1;
  return span(y, qStart, y, qStart + 2);
}

export function defaultPeriod(today = todayIST()): TallyPeriodValue {
  const preset: TallyPreset = Number(today.slice(8, 10)) <= 15 ? "last_month" : "this_month";
  return { preset, ...presetRange(preset, today) };
}

const LABELS: Array<[TallyPreset, string]> = [["last_month", "Last month"], ["this_month", "This month"], ["this_quarter", "This quarter"], ["this_fy", "This FY"], ["custom", "Custom"]];

export function TallyPeriod({ value, onChange }: { value: TallyPeriodValue; onChange: (v: TallyPeriodValue) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 min-w-0">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Period">
        {LABELS.map(([k, label]) => (
          <button key={k} type="button" aria-pressed={value.preset === k}
            onClick={() => onChange(k === "custom" ? { ...value, preset: "custom" } : { preset: k, ...presetRange(k) })}
            className={`px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] border-2 ${value.preset === k ? "bg-indigo border-indigo text-white font-bold" : "border-border text-ink-3 hover:text-white"}`}>
            {label}
          </button>
        ))}
      </div>
      {value.preset === "custom" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block min-w-0"><span className="block text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-1">From</span>
            <input type="date" className="input w-full" value={value.from} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} /></label>
          <label className="block min-w-0"><span className="block text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-1">To</span>
            <input type="date" className="input w-full" value={value.to} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} /></label>
        </div>
      )}
    </div>
  );
}
