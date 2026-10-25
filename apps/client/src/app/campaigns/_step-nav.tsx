"use client";
import type { Ref } from "react";

// The four booking steps, shared by /campaigns/new (step 1) and /campaigns/[id] (steps 1–4).
// Module-scoped: the `_` prefix keeps Next from routing it.

export type Step = "info" | "creative" | "accounts" | "pay";

export const STEPS: { id: Step; label: string }[] = [
  { id: "info", label: "Details" },
  { id: "creative", label: "Content" },
  { id: "accounts", label: "Accounts" },
  { id: "pay", label: "Review & submit" },
];

/** Step 4 says "pay" only when the gateway will actually open (paymentMode "razorpay"). */
export function stepLabel(s: Step, offline?: boolean): string {
  if (s === "pay") return offline === false ? "Review & pay" : "Review & submit";
  return STEPS.find((x) => x.id === s)?.label ?? s;
}

/** Why a pill can't be opened yet (title + screen-reader text). */
function reason(reached: Record<Step, boolean>): string {
  if (!reached.creative) return "Save the details first";
  if (!reached.accounts) return "Upload your video or image first";
  return "Pick at least one account first";
}

/**
 * Step pills: four equal columns on a phone (numbers only, so nothing is clipped), a row of
 * labelled pills from `sm`. Unreached steps stay focusable (aria-disabled, with the reason) but
 * do nothing. Below the pills a visible "Step n of 4 · Label" heading, which the page focuses
 * after a step change so keyboard and screen-reader users land on the new step.
 */
export function StepNav({ current, reached, offline, onSelect, headingRef }: {
  current: Step;
  reached: Record<Step, boolean>;
  offline?: boolean;
  onSelect?: (s: Step) => void;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const idx = Math.max(0, STEPS.findIndex((s) => s.id === current));
  const why = reason(reached);
  return (
    <>
      <nav aria-label="Steps" className="mb-2 sm:mb-3 grid grid-cols-4 gap-1.5 sm:flex sm:overflow-x-auto sm:pb-1">
        {STEPS.map((s, i) => {
          const active = current === s.id;
          const ok = reached[s.id];
          const label = stepLabel(s.id, offline);
          return (
            <button
              key={s.id}
              type="button"
              aria-current={active ? "step" : undefined}
              aria-disabled={!ok}
              title={ok ? undefined : why}
              onClick={() => ok && onSelect?.(s.id)}
              className={`w-full sm:w-auto sm:shrink-0 h-9 px-2 sm:px-3.5 rounded-full text-[12.5px] font-semibold border-2 aria-disabled:opacity-40 aria-disabled:cursor-not-allowed ${active ? "bg-indigo text-white border-indigo" : "border-ink/15 text-ink-2"}`}
            >
              {i + 1}
              <span className="sr-only sm:not-sr-only">. {label}</span>
              {!ok && <span className="sr-only"> — {why}</span>}
            </button>
          );
        })}
      </nav>
      <h2 ref={headingRef} tabIndex={-1} className="mb-4 text-[12.5px] font-semibold text-ink-2 outline-none">
        Step {idx + 1} of 4 · {stepLabel(STEPS[idx].id, offline)}
      </h2>
    </>
  );
}
