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
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-xl border border-[#E8E0D0] p-6 w-full max-w-sm space-y-4">
        <h2 className="text-base font-semibold text-[#1A1A1A]">{title}</h2>
        <p className="text-sm text-[#7A7A7A]">{description}</p>
        <div className="flex justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-full border border-[#E8E0D0] text-sm font-medium text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)] transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              "px-4 py-2 rounded-full text-sm font-medium text-white transition-colors",
              destructive
                ? "bg-[#E74C3C] hover:bg-[#c0392b]"
                : "bg-[#1A1A1A] hover:bg-[#2B2B2B]",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
