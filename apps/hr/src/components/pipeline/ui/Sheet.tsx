"use client";
/**
 * Portalled sheet / dialog (spec §9.2, §9.10): a bottom sheet on phones, a centred
 * dialog from sm up. Sized by the visualViewport contract so the iOS keyboard never
 * covers its footer. Traps focus while open and restores it on close; Esc closes.
 */
import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { ModalPortal } from "@/components/modal-portal";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
  z = 50,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  z?: number;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const first = panel.current?.querySelector<HTMLElement>("[data-autofocus]") ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const els = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      restoreTo.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <ModalPortal>
      <div className="pl-vv flex items-end sm:items-center justify-center" style={{ zIndex: z }}>
        <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={`relative w-full ${wide ? "sm:max-w-2xl" : "sm:max-w-md"} max-h-full sm:max-h-[90%] flex flex-col bg-surface rounded-t-2xl sm:rounded-2xl shadow-pop overflow-hidden`}
        >
          <div className="flex items-center gap-2 px-4 h-14 shrink-0 border-b border-rule">
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-[15px] font-bold text-ink">
              {title}
            </h2>
            <button type="button" onClick={onClose} aria-label="Close" className="h-11 w-11 -mr-2 grid place-items-center rounded-xl text-ink-3 hover:bg-muted">
              <X size={18} />
            </button>
          </div>
          <div className="pl-scroll flex-1 px-4 py-4">{children}</div>
          {footer && <div className="shrink-0 px-4 py-3 border-t border-rule bg-surface">{footer}</div>}
        </div>
      </div>
    </ModalPortal>
  );
}
