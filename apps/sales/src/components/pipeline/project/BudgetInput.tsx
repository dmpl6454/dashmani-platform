"use client";
/**
 * A rupee budget field (New project sheet, project page): digits only, shown back in Indian
 * grouping ("₹5,00,000") under the box so a missed zero is easy to spot. Empty = no budget.
 */
import { useId } from "react";
import { pipelineValidators } from "@dashmani/shared";
import { fmtInr } from "@/lib/format";

/** "5,00,000" / "500000" → 500000; "" → null; anything else → an error sentence. */
export function parseBudget(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const s = raw.replace(/[₹,\s]/g, "");
  if (s === "") return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false, error: "Enter the budget in whole rupees, e.g. 500000." };
  const n = Number(s);
  if (n > pipelineValidators.PIPELINE_BUDGET_MAX) return { ok: false, error: "That budget is too large." };
  return { ok: true, value: n };
}

export function BudgetInput({
  value,
  onChange,
  disabled,
  autoFocus,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  error?: string;
}) {
  const id = useId();
  const parsed = parseBudget(value);
  const shown = error ?? (parsed.ok ? null : parsed.error);
  return (
    <div>
      <label htmlFor={id} className="block text-[12.5px] font-semibold text-ink-2 mb-1.5">
        Budget <span className="text-ink-4 font-medium">(optional, ₹)</span>
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-ink-3" aria-hidden>
          ₹
        </span>
        <input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value.replace(/[^\d,]/g, ""))}
          aria-invalid={!!shown}
          aria-describedby={`${id}-hint`}
          placeholder="e.g. 500000"
          className="w-full h-11 pl-7 pr-3 rounded-xl border border-border bg-surface text-[16px] text-ink tabular-nums placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-indigo"
        />
      </div>
      <p id={`${id}-hint`} className={`mt-1 text-[12px] ${shown ? "text-danger" : "text-ink-4"}`}>
        {shown ?? (parsed.ok && parsed.value != null ? fmtInr(parsed.value * 100, { whole: true }) : "Only the person who creates the project can change it later.")}
      </p>
    </div>
  );
}
