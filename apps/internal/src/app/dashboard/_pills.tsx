// apps/internal/src/app/dashboard/_pills.tsx
// Shared, stateless pill button used by every dashboard glance card so all pill
// groups look identical. Pure presentational — no state, no data, no side effects.
// The `_` prefix keeps Next.js from routing this file (same convention as reports/_range.tsx).
"use client";
import type { ReactNode } from "react";

// Accent lets each card tint its active pill to match the card's icon color:
// terra for links, indigo for growth, sage for performers.
type Accent = "terra" | "indigo" | "sage";

const ACTIVE: Record<Accent, string> = {
  terra: "bg-terra text-white border-terra",
  indigo: "bg-indigo text-white border-indigo",
  sage: "bg-sage text-white border-sage",
};
const HOVER: Record<Accent, string> = {
  terra: "hover:border-terra/30 hover:text-terra",
  indigo: "hover:border-indigo/30 hover:text-indigo",
  sage: "hover:border-sage/30 hover:text-sage",
};

export function Pill({
  active,
  accent = "indigo",
  onClick,
  children,
}: {
  active: boolean;
  accent?: Accent;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`h-7 px-3 rounded-full text-xs font-semibold transition-all border-2 whitespace-nowrap ${
        active ? ACTIVE[accent] : `bg-surface text-ink-4 border-ink/12 ${HOVER[accent]}`
      }`}
    >
      {children}
    </button>
  );
}

// Wrapper that wraps pills on small screens instead of overflowing (390px-safe).
export function PillGroup({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
