import * as React from "react";
import { cn } from "../lib/utils";

interface StatCardProps {
  title: string;
  value: string | number;
  change?: { value: number; label: string };
  icon?: React.ReactNode;
  className?: string;
}

export function StatCard({ title, value, change, icon, className }: StatCardProps) {
  return (
    <div className={cn("bg-surface border border-border rounded-lg p-6 shadow-card", className)}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-ink-3 font-medium">{title}</p>
          <p className="text-3xl font-light mt-1 font-serif text-ink">{value}</p>
          {change && (
            <p className={cn("text-xs mt-1 font-medium", change.value >= 0 ? "text-success" : "text-danger")}>
              {change.value >= 0 ? "+" : ""}{change.value}% {change.label}
            </p>
          )}
        </div>
        {icon && <div className="text-ink-4">{icon}</div>}
      </div>
    </div>
  );
}
