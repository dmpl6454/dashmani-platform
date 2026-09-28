"use client";
/**
 * Renders children into document.body (port of apps/internal ModalPortal). Every
 * pipeline overlay — sheets, the drag overlay, the mention popover, toasts — goes
 * through a portal so no ancestor's overflow or transform can clip or trap it.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export function ModalPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  if (!mounted) return null;
  return createPortal(children, document.body);
}
