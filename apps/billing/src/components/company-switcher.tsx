"use client";
import { COMPANY_KEYS, SALES_COMPANIES, useCompany } from "@/lib/company";

// Which company the portal bills as. Two choices, both always visible: billing under the wrong
// company is expensive to undo (a tax invoice can only be cancelled), so this is never hidden in a menu.
export function CompanySwitcher() {
  const { company, setCompany } = useCompany();
  return (
    <div role="radiogroup" aria-label="Billing company" className="flex border-2 border-border text-[12px] uppercase tracking-[0.08em]">
      {COMPANY_KEYS.map((k) => {
        const on = k === company;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={on}
            title={SALES_COMPANIES[k].name}
            onClick={() => setCompany(k)}
            className={`px-2.5 py-1.5 whitespace-nowrap ${on ? "bg-indigo text-white font-bold" : "text-ink-3 hover:text-white"}`}
          >
            {SALES_COMPANIES[k].short}
          </button>
        );
      })}
    </div>
  );
}
