"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { Tone } from "@/lib/offers";

// Small pieces the booking pages share: the status chip and the copy button.

const TONE_TEXT: Record<Tone, string> = {
  attention: "text-attention",
  info: "text-indigo-light",
  success: "text-success",
  muted: "text-ink-3",
};

/** A dot and a few uppercase words, in the same style as the payout status. The words carry the meaning; the colour only reinforces it. */
export function StatusChip({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className={`inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] font-bold ${TONE_TEXT[tone]}`}>
      <span className="w-2 h-2 rounded-full bg-current" aria-hidden /> {label}
    </span>
  );
}

/** execCommand fallback for a browser without the async clipboard (or one that refuses it outside a secure context). */
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // Off screen, at 16px so iOS does not zoom while it is selected.
    ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;font-size:16px";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Puts `text` on the clipboard. `what` names it for a screen reader ("caption"): the visible word is just "Copy", and
 * what happened is also said in a polite live region, because a button whose label changes is not announced on its own.
 */
export function CopyButton({ text, what }: { text: string; what: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = legacyCopy(text);
    setState(ok ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2500);
  }

  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={copy}>
        {state === "copied" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : "Copy"}
        <span className="sr-only"> {what}</span>
      </button>
      <span role="status" className="sr-only">
        {state === "copied" ? `Copied ${what}` : state === "failed" ? `Couldn't copy ${what}. Select the text and copy it yourself.` : ""}
      </span>
    </>
  );
}
