"use client";
import type { ReactNode } from "react";
import type { ReconTodo } from "@/lib/sales-types";
import { fmtInr } from "@/lib/format";

/** "What to do next": one numbered row per todo, its amount, and one action (the first a filled button). */
export function TodoCard({ todo, empty, actionFor }: { todo: ReconTodo[]; empty: string; actionFor?: (t: ReconTodo, first: boolean) => ReactNode }) {
  return (
    <section className="card p-4 grid grid-cols-1 gap-2 mb-5" aria-label="What to do next">
      <h2 className="font-bold">What to do next</h2>
      {todo.length === 0 ? <p className="text-sm text-success">{empty}</p> : todo.map((t, i) => (
        <div key={`${t.code}-${i}`} className="flex flex-wrap items-start gap-3 min-w-0">
          <span className="w-6 h-6 shrink-0 grid place-items-center rounded-full bg-indigo text-white text-xs font-bold" aria-hidden>{i + 1}</span>
          <div className="min-w-0 flex-1 basis-48">
            <p className="text-sm">{t.sentence}</p>
            {t.paise != null && <p className="text-xs text-ink-3 sm:hidden font-mono">{fmtInr(t.paise)}</p>}
          </div>
          {t.paise != null && <span className="hidden sm:block text-sm font-mono">{fmtInr(t.paise)}</span>}
          {actionFor?.(t, i === 0)}
        </div>
      ))}
    </section>
  );
}
