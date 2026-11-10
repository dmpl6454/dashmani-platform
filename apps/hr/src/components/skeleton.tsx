"use client";

/**
 * Placeholder rows shown while a list is loading. Without them a page that is still
 * fetching shows its empty state ("No expense claims yet"), which is a false claim:
 * only a LOADED response may say a list is empty (CLAUDE.md rule).
 */
export function SkeletonRows({ rows = 3, card = false }: { rows?: number; card?: boolean }) {
  const list = (
    <ul aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="px-5 py-4 flex items-center gap-3" style={i ? { borderTop: "2px solid rgba(26,26,26,0.05)" } : undefined}>
          <span className="h-9 w-9 rounded-full bg-ink/[0.06] motion-safe:animate-pulse shrink-0" />
          <span className="flex-1 min-w-0 space-y-2">
            <span className="block h-3 w-2/5 rounded bg-ink/[0.06] motion-safe:animate-pulse" />
            <span className="block h-3 w-3/5 rounded bg-ink/[0.05] motion-safe:animate-pulse" />
          </span>
          <span className="h-5 w-16 rounded-full bg-ink/[0.06] motion-safe:animate-pulse shrink-0" />
        </li>
      ))}
    </ul>
  );
  return (
    <div role="status" aria-live="polite" className={card ? "v3-card overflow-hidden" : undefined}>
      <span className="sr-only">Loading…</span>
      {list}
    </div>
  );
}
