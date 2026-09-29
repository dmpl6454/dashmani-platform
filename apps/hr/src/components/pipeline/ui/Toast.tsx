"use client";
/**
 * Toasts (portalled, z-57, aria-live polite). A toast may carry actions ("View",
 * "Undo") and may be persistent — the move toast stays until dismissed or acted on.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { ModalPortal } from "@/components/modal-portal";
import { Z } from "../constants";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  text: string;
  actions?: ToastAction[];
  /** ms; 0 = persistent. Default 5000. */
  duration?: number;
  tone?: "neutral" | "error";
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  show(t: ToastInput): number;
  dismiss(id: number): void;
}

const ToastCtx = createContext<ToastApi>({ show: () => 0, dismiss: () => {} });

export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (t: ToastInput) => {
      const id = next.current++;
      setItems((xs) => [...xs.slice(-2), { ...t, id }]);
      const d = t.duration ?? 5000;
      if (d > 0) setTimeout(() => dismiss(id), d);
      return id;
    },
    [dismiss],
  );
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <ModalPortal>
        <div
          aria-live="polite"
          role="status"
          className="fixed left-0 right-0 bottom-0 flex flex-col items-center gap-2 px-4 pointer-events-none"
          style={{ zIndex: Z.toast, paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}
        >
          {items.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto w-full max-w-md flex items-center gap-2 rounded-xl px-4 py-2 shadow-pop text-[13.5px] ${
                t.tone === "error" ? "bg-danger text-white" : "bg-ink text-white"
              }`}
            >
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t.text}</span>
              {t.actions?.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => {
                    dismiss(t.id);
                    a.onClick();
                  }}
                  className="h-11 px-3 rounded-lg font-bold text-action hover:bg-white/10"
                >
                  {a.label}
                </button>
              ))}
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="h-11 w-11 -mr-2 grid place-items-center rounded-lg hover:bg-white/10">
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      </ModalPortal>
    </ToastCtx.Provider>
  );
}
