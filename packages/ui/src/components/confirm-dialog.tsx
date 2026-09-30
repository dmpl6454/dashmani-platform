"use client";

import { cn } from "../lib/utils";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-surface rounded-2xl shadow-pop border border-border p-6 w-full max-w-sm space-y-4">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <p className="text-sm text-ink-3">{description}</p>
        <div className="flex justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-full border border-border text-sm font-medium text-ink hover:bg-muted transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              "px-4 py-2 rounded-full text-sm font-medium transition-colors",
              destructive
                ? "bg-danger text-[#2A0A0F] hover:brightness-110"
                : "bg-action text-[#06121B] hover:bg-action-deep",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
