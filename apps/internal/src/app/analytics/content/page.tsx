"use client";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useContentAnalytics } from "@/lib/hooks/use-analytics";
import { formatStatus } from "@dashmani/shared";

const pct = (n: number, d: number) => `${d > 0 ? Math.min(100, Math.round((n / d) * 100)) : 0}%`;

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <span className="flex-1 min-w-0 h-2.5 rounded-[5px] bg-[color:var(--hx-132430)] overflow-hidden">
      <span className="block h-full rounded-[5px]" style={{ width: pct(value, max), background: color }} />
    </span>
  );
}

// Mockup palette.
const STATUS_COLORS: Record<string, string> = {
  DRAFT: "var(--hx-738395)",
  PENDING_APPROVAL: "var(--hx-E9BD62)",
  APPROVED: "var(--hx-9B7EDE)",
  SCHEDULED: "var(--hx-6EB2FF)",
  PUBLISHED: "var(--hx-00D7A0)",
  FAILED: "var(--hx-FB7185)",
  REJECTED: "var(--hx-FB7185)",
};

const PLATFORM_COLORS: Record<string, string> = {
  Instagram: "var(--hx-DD3FAF)",
  Twitter: "var(--hx-6EB2FF)",
  LinkedIn: "var(--hx-238BFF)",
  Facebook: "var(--hx-2F86F0)",
  YouTube: "var(--hx-E52D47)",
  TikTok: "var(--hx-00D7A0)",
  Snapchat: "var(--hx-E9BD62)",
};

function Header() {
  return (
    <>
      <section className="pt-[26px]">
        <Link href="/analytics" className="inline-flex items-center gap-1.5 text-[13px] text-ds-t2 hover:text-ds-text transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" /> Analytics
        </Link>
      </section>
      <section className="pt-3.5 pb-[22px]">
        <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Content Analytics</h1>
        <p className="mt-1.5 text-[13.5px] text-ds-t2">Content performance and pipeline status</p>
      </section>
    </>
  );
}

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col min-w-0 rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)] ${className}`}>
      <div className="flex items-center h-[60px] px-6 border-b border-ds-line">
        <span className="text-[15px] font-semibold tracking-[-.01em] text-ds-text">{title}</span>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

export default function ContentAnalyticsPage() {
  const { data, isLoading } = useContentAnalytics();
  const content = (data as any)?.data;

  if (isLoading) {
    return (
      <div className="pb-8" aria-hidden="true">
        <div className="pt-[26px] pb-[22px] space-y-3.5">
          <div className="h-3 w-16 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
          <div className="h-9 w-64 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-[128px] rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />)}
        </div>
        <div className="mt-4 h-64 rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
      </div>
    );
  }

  if ((content?.totalPosts ?? 0) === 0) {
    return (
      <div className="pb-8">
        <Header />
        <div className="py-14 px-5 rounded-[16px] border border-dashed border-ds-line2 text-center text-ds-t3 text-[13px]">
          No content posts yet.
        </div>
      </div>
    );
  }

  const statCards = [
    { title: "Total Posts", value: content?.totalPosts ?? 0, sub: "all time", color: "text-ds-text" },
    { title: "Published This Month", value: content?.publishedThisMonth ?? 0, sub: "current period", color: "text-ds-teal" },
    { title: "Scheduled Upcoming", value: content?.scheduledUpcoming ?? 0, sub: "in pipeline", color: "text-ds-text" },
    { title: "Platforms Active", value: (content?.byPlatform ?? []).length, sub: "channels used", color: "text-ds-text" },
  ];

  return (
    <div className="pb-8">
      <Header />

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((card) => (
          <div key={card.title} className="min-w-0 rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card px-5 py-5 shadow-[0_12px_32px_rgba(0,0,0,.35)]">
            <span className="block text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3 truncate">{card.title}</span>
            <p className={`mt-2.5 text-[34px] font-bold tracking-[-.04em] tabular-nums leading-[1.1] ${card.color}`}>{card.value}</p>
            <p className="mt-1 text-[12px] text-ds-t3">{card.sub}</p>
          </div>
        ))}
      </section>

      <section className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="By Status">
          <div className="flex flex-col gap-3.5">
            {(content?.byStatus ?? []).map((s: any) => (
              <div key={s.status} className="flex items-center gap-3.5">
                <span className="flex items-center gap-2 w-[124px] shrink-0 text-[12.5px] text-ds-t2 min-w-0">
                  <i className="h-[7px] w-[7px] rounded-[2px] shrink-0" style={{ background: STATUS_COLORS[s.status] || "var(--hx-738395)" }} />
                  <span className="truncate">{formatStatus(s.status)}</span>
                </span>
                <ProgressBar value={s.count} max={content?.totalPosts || 1} color={STATUS_COLORS[s.status] || "var(--hx-738395)"} />
                <span className="w-10 text-right text-[13px] font-semibold text-ds-text tabular-nums">{s.count}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="By Platform">
          <div className="flex flex-col gap-3.5">
            {(content?.byPlatform ?? []).map((p: any) => (
              <div key={p.platformName} className="flex items-center gap-3.5">
                <span className="flex items-center gap-2 w-[124px] shrink-0 text-[12.5px] text-ds-t2 min-w-0">
                  <i className="h-[7px] w-[7px] rounded-[2px] shrink-0" style={{ background: PLATFORM_COLORS[p.platformName] || "var(--hx-738395)" }} />
                  <span className="truncate">{p.platformName}</span>
                </span>
                <ProgressBar value={p.count} max={content?.totalPosts || 1} color={PLATFORM_COLORS[p.platformName] || "var(--hx-738395)"} />
                <span className="w-10 text-right text-[13px] font-semibold text-ds-text tabular-nums">{p.count}</span>
              </div>
            ))}
          </div>
        </Card>
      </section>
    </div>
  );
}
