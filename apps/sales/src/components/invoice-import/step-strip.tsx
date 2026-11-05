"use client";

const STEPS = ["Columns", "Check", "Import", "Report"] as const;

/** 1 Columns · 2 Check · 3 Import · 4 Report — derived from the import's status. */
export function StepStrip({ step }: { step: 1 | 2 | 3 | 4 }) {
  return (
    <ol className="flex flex-wrap gap-1 mb-4" aria-label="Import steps">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={step === i + 1 ? "step" : undefined}
          className={`px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] border-2 ${step === i + 1 ? "bg-indigo border-indigo text-white font-bold" : step > i + 1 ? "border-border text-ink-2" : "border-transparent text-ink-3"}`}>
          {i + 1} {s}
        </li>
      ))}
    </ol>
  );
}
