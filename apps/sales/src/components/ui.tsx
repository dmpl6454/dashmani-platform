"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from "lucide-react";

type Tone = "info" | "success" | "warn" | "danger";

const TONES: Record<Tone, { box: string; icon: ReactNode }> = {
  info: { box: "border-indigo/60 bg-indigo-soft/40 text-ink-2", icon: <Info size={18} className="text-indigo-light" aria-hidden /> },
  success: { box: "border-success/40 bg-success-bg text-ink-2", icon: <CheckCircle2 size={18} className="text-success" aria-hidden /> },
  warn: { box: "border-attention/40 bg-attention-bg text-ink-2", icon: <TriangleAlert size={18} className="text-attention" aria-hidden /> },
  danger: { box: "border-danger/40 bg-danger-bg text-ink-2", icon: <AlertCircle size={18} className="text-danger" aria-hidden /> },
};

/** A bordered message strip. Use role="alert" only for something that just went wrong. */
export function Banner({ tone = "info", title, children, action, role }: {
  tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode; role?: "alert" | "status";
}) {
  const t = TONES[tone];
  return (
    <div role={role} className={`border-2 px-4 py-3 flex gap-3 items-start ${t.box}`}>
      <span className="mt-0.5 shrink-0">{t.icon}</span>
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        {title && <p className="font-bold text-white">{title}</p>}
        {children && <div className={title ? "mt-1" : ""}>{children}</div>}
        {action && <div className="mt-3 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
}

export function PageHead({ kicker, title, children }: { kicker: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-8">
      <p className="kicker">{kicker}</p>
      <h1 className="mt-2 text-[clamp(30px,5vw,48px)] font-extrabold tracking-[-0.04em] leading-[1.02]">{title}</h1>
      {children && <div className="mt-3 text-ink-3 text-[15px] leading-relaxed max-w-2xl">{children}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-ink-3 text-sm py-10" role="status">
      <span className="spinner" aria-hidden /> {label}
    </div>
  );
}

/** A modal dialog: Escape and the backdrop close it; focus moves into it when it opens. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // Through a ref, so a parent re-render (a new onClose arrow) doesn't re-run the focus effect.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, []);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/75" onClick={onClose}>
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md bg-surface border-2 border-white/30 p-6 sm:p-7 flex flex-col gap-4 outline-none fade-up max-h-[90vh] overflow-y-auto"
      >
        <button type="button" onClick={onClose} aria-label="Close" className="absolute top-3 right-3 p-1.5 text-ink-3 hover:text-white">
          <X size={16} />
        </button>
        <h2 id="modal-title" className="text-2xl font-extrabold tracking-[-0.03em] pr-8">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} role="alert" className="inline-flex items-center gap-1.5 text-xs text-danger">
      <AlertCircle size={13} aria-hidden /> {children}
    </span>
  );
}
