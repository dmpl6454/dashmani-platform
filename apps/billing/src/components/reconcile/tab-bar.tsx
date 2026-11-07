"use client";
// The /reconcile tab pills (the invoice-list pill markup), wrapping on phones.
export function TabBar<T extends string>({ tabs, current, onPick }: { tabs: Array<{ key: T; label: string }>; current: T; onPick: (t: T) => void }) {
  return (
    <div className="flex flex-wrap gap-2 mb-5" role="tablist" aria-label="Reconcile">
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={t.key === current} onClick={() => onPick(t.key)}
          className={`px-3 py-1.5 text-sm border-2 ${t.key === current ? "bg-indigo border-indigo text-white" : "border-border text-ink-3 hover:text-white"}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Small filter pills with counts. */
export function FilterPills<T extends string>({ items, current, onPick, label }: { items: Array<{ key: T; label: string; count?: number }>; current: T; onPick: (t: T) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-2 mb-3" role="radiogroup" aria-label={label}>
      {items.map((t) => (
        <button key={t.key} type="button" role="radio" aria-checked={t.key === current} onClick={() => onPick(t.key)}
          className={`px-2.5 py-1 text-xs border ${t.key === current ? "bg-indigo border-indigo text-white" : "border-border text-ink-3 hover:text-white"}`}>
          {t.label}{t.count !== undefined ? ` (${t.count})` : ""}
        </button>
      ))}
    </div>
  );
}
