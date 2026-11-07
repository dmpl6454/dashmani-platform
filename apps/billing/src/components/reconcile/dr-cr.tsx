"use client";
// Dr / Cr: a two-button toggle (phones have no minus key) and a signed amount with its side.
import { drCrText } from "@/lib/reconcile";

export function DrCrToggle({ value, onChange }: { value: "Dr" | "Cr"; onChange: (v: "Dr" | "Cr") => void }) {
  return (
    <div className="inline-flex border-2 border-border" role="radiogroup" aria-label="Dr or Cr">
      {(["Dr", "Cr"] as const).map((s) => (
        <button key={s} type="button" role="radio" aria-checked={value === s} onClick={() => onChange(s)}
          className={`px-3 py-1.5 text-sm ${value === s ? "bg-indigo text-white" : "text-ink-3 hover:text-white"}`}>
          {s === "Dr" ? "Dr (they owe us)" : "Cr (advance)"}
        </button>
      ))}
    </div>
  );
}

export function DrCr({ paise, long = true, className = "" }: { paise: number; long?: boolean; className?: string }) {
  return <span className={`font-mono tabular-nums ${className}`}>{drCrText(paise, long)}</span>;
}
