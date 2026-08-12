"use client";

import { Eye, Heart, MessageCircle, Info } from "lucide-react";
import { isPlatformInsightSupported } from "@dashmani/shared";

function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
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

  // Views only show for platforms that expose them (YouTube). Instagram/Facebook
  // don't return a reliable view count, so we show likes + comments — no fake "—".
  const hasViews = metric.views != null;

  return (
    <span
      title={updatedAt ? `Last updated ${updatedAt}` : `${platform} insights`}
      className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-rose-700 bg-rose-50 rounded-full px-2 py-0.5 select-none"
    >
      {hasViews && (
        <>
          <Eye className="h-2.5 w-2.5 flex-shrink-0" />
          {fmtCompact(metric.views)}
          <span className="text-rose-400">·</span>
        </>
      )}
      <Heart className="h-2.5 w-2.5 flex-shrink-0" />
      {fmtCompact(metric.likes)}
      <span className="text-rose-400">·</span>
      <MessageCircle className="h-2.5 w-2.5 flex-shrink-0" />
      {fmtCompact(metric.comments)}
    </span>
  );
}
