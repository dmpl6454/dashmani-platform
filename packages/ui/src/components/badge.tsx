import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "bg-muted text-ink-2 border border-border",
        success: "bg-success-bg text-success border border-success/30",
        warning: "bg-attention-bg text-attention border border-attention/30",
        danger: "bg-danger-bg text-danger border border-danger/30",
        secondary: "bg-muted text-ink-3 border border-border",
        dark: "bg-[#1D2C3A] text-ink border border-border",
        yellow: "bg-action/15 text-action border border-action/30",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
