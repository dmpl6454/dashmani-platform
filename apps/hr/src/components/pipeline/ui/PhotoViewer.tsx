"use client";
/**
 * Full-screen photo viewer (2026-11-23): a photo opens on the same page, like WhatsApp, not in a
 * new tab. Dark backdrop, the photo fitted to the screen, the name, Download and Close.
 * Closes with Esc, the ✕ button, or a click on the backdrop. Focus moves to Close on open and
 * back to what opened it on close; the page behind does not scroll while it is open.
 *
 * `url` is a short-lived signed link (15 min); Download asks the API for a fresh one.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";

const Z_VIEWER = 70; // above sheets (50), toasts (57) and drag (60)

export function PhotoViewer({
  url,
  name,
  onDownload,
  onClose,
}: {
  url: string;
  name: string;
  onDownload: () => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // The chat re-renders on every poll; a ref keeps the open/close effect from re-running.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      className="fixed inset-0 flex flex-col"
      style={{ zIndex: Z_VIEWER, background: "rgba(0, 0, 0, 0.96)" }}
      onClick={onClose}
    >
      <div className="shrink-0 flex items-center gap-2 px-3 py-2" style={{ paddingTop: "max(8px, env(safe-area-inset-top))" }} onClick={(e) => e.stopPropagation()}>
        <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-white" title={name}>
          {name}
        </p>
        <button type="button" onClick={onDownload} aria-label="Download" className="h-11 w-11 grid place-items-center text-white/80 hover:text-white">
          <Download size={20} />
        </button>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="h-11 w-11 grid place-items-center text-white/80 hover:text-white">
          <X size={22} />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center p-3" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a signed R2 link, not a static asset */}
        <img src={url} alt={name} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
      </div>
    </div>,
    document.body,
  );
}
