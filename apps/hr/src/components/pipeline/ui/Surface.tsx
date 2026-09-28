"use client";
/**
 * A portalled full-screen surface sized by the visualViewport contract (spec §9.2): the
 * phone project page (z-45, above the HR mobile bar) and the phone ReplySheet (z-50).
 * Traps focus while mounted and restores it on unmount; Esc calls onEscape.
 */
import { useEffect, useRef } from "react";
import { ModalPortal } from "@/components/modal-portal";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Surface({
  z,
  label,
  onEscape,
  trap = true,
  children,
}: {
  z: number;
  label: string;
  onEscape?: () => void;
  trap?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const esc = useRef(onEscape);
  esc.current = onEscape;
  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (!ref.current) return;
      // Only the top-most surface/sheet handles keys: ignore when focus is elsewhere.
      if (!ref.current.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (e.key === "Escape" && esc.current) {
        esc.current();
        return;
      }
      if (!trap || e.key !== "Tab") return;
      const els = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (!els.length) return;
      if (e.shiftKey && document.activeElement === els[0]) {
        e.preventDefault();
        els[els.length - 1].focus();
      } else if (!e.shiftKey && document.activeElement === els[els.length - 1]) {
        e.preventDefault();
        els[0].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreTo?.focus?.();
    };
  }, [trap]);
  return (
    <ModalPortal>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} className="pl-vv flex flex-col bg-bg text-ink" style={{ zIndex: z }}>
        {children}
      </div>
    </ModalPortal>
  );
}
