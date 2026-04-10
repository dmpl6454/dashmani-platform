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
    <div className={cn("bg-white rounded-lg p-6 shadow-card", className)}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-[#7A7A7A] font-medium">{title}</p>
          <p className="text-3xl font-light mt-1 font-serif text-[#1A1A1A]">{value}</p>
          {change && (
            <p className={cn("text-xs mt-1 font-medium", change.value >= 0 ? "text-green-600" : "text-red-600")}>
              {change.value >= 0 ? "+" : ""}{change.value}% {change.label}
            </p>
          )}
        </div>
        {icon && <div className="text-[#B0B0B0]">{icon}</div>}
      </div>
    </div>
  );
}
