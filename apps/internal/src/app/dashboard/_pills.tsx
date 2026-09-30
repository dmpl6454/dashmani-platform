// apps/internal/src/app/dashboard/_pills.tsx
// Shared, stateless pill button used by every dashboard glance card so all pill
// groups look identical. Pure presentational — no state, no data, no side effects.
// The `_` prefix keeps Next.js from routing this file (same convention as reports/_range.tsx).
"use client";
import type { ReactNode } from "react";

// Accent lets each card tint its active pill to match the card's icon color
// (Dashboard.dc.html): action (sky) for links, terra (purple) for growth/movers,
// sage (green) for performers. `indigo` is kept as an alias of the sky accent.
type Accent = "action" | "terra" | "indigo" | "sage";

// Active = accent-tinted fill + accent border + accent text (mockup's tinted pill),
// which reads correctly in both light and dark themes.
const ACTIVE: Record<Accent, string> = {
  action: "bg-action/15 text-action border-action/50",
  terra: "bg-terra/15 text-terra border-terra/50",
  indigo: "bg-action/15 text-action border-action/50",
  sage: "bg-sage/15 text-sage border-sage/50",
};
const HOVER: Record<Accent, string> = {
  action: "hover:border-action/40 hover:text-ink",
  terra: "hover:border-terra/40 hover:text-ink",
  indigo: "hover:border-action/40 hover:text-ink",
  sage: "hover:border-sage/40 hover:text-ink",
};

export function Pill({
  active,
  accent = "action",
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
      className={`h-7 px-3 rounded-xl text-xs font-semibold transition-all border whitespace-nowrap ${
        active ? ACTIVE[accent] : `bg-muted text-ink-4 border-border ${HOVER[accent]}`
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
