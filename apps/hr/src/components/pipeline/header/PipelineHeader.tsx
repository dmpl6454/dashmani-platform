"use client";
/**
 * The pipeline's own 56 px header (spec §9.2): title, page actions and the bell. No
 * Topstrip and no backdrop-blur, so fixed children (sheets, popovers) are never trapped
 * in a filter containing block.
 */
import { NotificationBell } from "@/components/notification-bell";

export function PipelineHeader({
  title,
  sub,
  left,
  actions,
  status,
}: {
  title: string;
  sub?: React.ReactNode;
  left?: React.ReactNode;
  actions?: React.ReactNode;
  status?: React.ReactNode;
}) {
  return (
    <header
      className="sticky top-0 shrink-0 bg-bg"
      style={{ zIndex: 20, borderBottom: "2px solid rgba(26,26,26,0.07)" }}
    >
      <div className="h-14 px-3 sm:px-5 flex items-center gap-2 min-w-0">
        {left}
        <div className="min-w-0 flex-1 flex items-center gap-2.5">
          <h1 className="min-w-0 truncate text-[16px] font-bold text-ink">{title}</h1>
          {sub && <span className="hidden md:inline min-w-0 truncate text-[12px] text-ink-3 font-medium">{sub}</span>}
          {status && <span className="hidden sm:flex min-w-0">{status}</span>}
        </div>
        {actions && <div className="flex items-center gap-1.5">{actions}</div>}
        <NotificationBell />
      </div>
      {status && <div className="sm:hidden px-3 pb-2 -mt-1 flex min-w-0">{status}</div>}
    </header>
  );
}
