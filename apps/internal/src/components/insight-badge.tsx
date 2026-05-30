"use client";

import { Eye, Heart, Info } from "lucide-react";
import { isPlatformInsightSupported } from "@dashmani/shared";

function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

interface InsightBadgeProps {
  platform: string;
  metric?: {
    views?: number | null;
    likes?: number | null;
    comments?: number | null;
    fetchedAt?: Date | string;
  } | null;
}

export function InsightBadge({ platform, metric }: InsightBadgeProps) {
  const supported = isPlatformInsightSupported(platform);

  if (!supported) {
    return (
      <span
        title={`Insights not yet supported for ${platform}`}
        className="inline-flex items-center gap-1 text-[10px] text-[#B0B0B0] cursor-help select-none"
      >
        <Info className="h-2.5 w-2.5 flex-shrink-0" />
        Insights soon
      </span>
    );
  }

  if (!metric) return null;

  const updatedAt = metric.fetchedAt
    ? new Date(metric.fetchedAt).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })
    : null;

  return (
    <span
      title={updatedAt ? `Last updated ${updatedAt}` : "YouTube insights"}
      className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-rose-700 bg-rose-50 rounded-full px-2 py-0.5 select-none"
    >
      <Eye className="h-2.5 w-2.5 flex-shrink-0" />
      {fmtCompact(metric.views)}
      <span className="text-rose-400">·</span>
      <Heart className="h-2.5 w-2.5 flex-shrink-0" />
      {fmtCompact(metric.likes)}
    </span>
  );
}
