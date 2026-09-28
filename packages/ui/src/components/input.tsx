import * as React from "react";
import { cn } from "../lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, label, error, ...props }, ref) => {
    return (
      <div className="space-y-1.5">
        {label && <label className="text-sm font-medium text-ink">{label}</label>}
        <input
          type={type}
          className={cn(
            "flex h-11 w-full rounded-lg border border-border bg-muted px-4 py-2.5 text-sm text-ink placeholder:text-ink-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:border-action disabled:cursor-not-allowed disabled:opacity-50",
            error && "border-danger focus-visible:ring-danger/40",
            className
          )}
          ref={ref}
          {...props}
        />
        {error && <p className="text-xs text-red-500 mt-0.5">{error}</p>}
      </div>
    );
  }
);
Input.displayName = "Input";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, ...props }, ref) => {
    return (
      <div className="space-y-1.5">
        {label && <label className="text-sm font-medium text-ink">{label}</label>}
        <textarea
          className={cn(
            "flex min-h-[80px] w-full rounded-lg border border-border bg-muted px-4 py-2.5 text-sm text-ink placeholder:text-ink-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:border-action disabled:cursor-not-allowed disabled:opacity-50",
            error && "border-danger focus-visible:ring-danger/40",
            className
          )}
          ref={ref}
          {...props}
        />
        {error && <p className="text-xs text-red-500 mt-0.5">{error}</p>}
      </div>
    );
  }
);
Textarea.displayName = "Textarea";

export { Input, Textarea };
