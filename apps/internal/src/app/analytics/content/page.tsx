"use client";
import { useContentAnalytics } from "@/lib/hooks/use-analytics";
import { formatStatus } from "@dashmani/shared";

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="w-full bg-action-soft rounded-lg h-[24px]">
      <div className={`h-[24px] rounded-lg ${color}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-[#243645]",
  SCHEDULED: "bg-action",
  PUBLISHED: "bg-success",
  FAILED: "bg-danger",
};

const PLATFORM_COLORS: Record<string, string> = {
  Instagram: "bg-pink-500",
  Twitter: "bg-sky-500",
  LinkedIn: "bg-action",
  Facebook: "bg-action-soft",
  YouTube: "bg-danger",
  TikTok: "bg-[#1D2C3A]",
  Snapchat: "bg-yellow-400",
};

export default function ContentAnalyticsPage() {
  const { data, isLoading } = useContentAnalytics();
  const content = (data as any)?.data;

  if (isLoading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-action" /></div>;
  }

  if ((content?.totalPosts ?? 0) === 0) {
    return (
      <div className="space-y-6 crx-animate-fade">
        <div>
          <h1 className="font-serif text-4xl font-light text-ink">Content Analytics</h1>
          <p className="text-ink-3 mt-1">Content performance and pipeline status</p>
        </div>
        <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border p-8 text-center">
          <p className="text-ink-3">No content posts yet.</p>
        </div>
      </div>
    );
  }

  const statCards = [
    { title: "Total Posts", value: content?.totalPosts ?? 0, sub: "all time", color: "text-ink" },
    { title: "Published This Month", value: content?.publishedThisMonth ?? 0, sub: "current period", color: "text-success" },
    { title: "Scheduled Upcoming", value: content?.scheduledUpcoming ?? 0, sub: "in pipeline", color: "text-ink" },
    { title: "Platforms Active", value: (content?.byPlatform ?? []).length, sub: "channels used", color: "text-ink" },
  ];

  return (
    <div className="space-y-6 crx-animate-fade">
      <div>
        <h1 className="font-serif text-4xl font-light text-ink">Content Analytics</h1>
        <p className="text-ink-3 mt-1">Content performance and pipeline status</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((card, i) => (
          <div
            key={card.title}
            className={`bg-surface rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-${i + 1}`}
          >
            <span className="text-sm text-ink-3">{card.title}</span>
            <p className={`text-[40px] font-light font-num leading-tight mt-2 ${card.color}`}>{card.value}</p>
            <p className="text-xs text-ink-4 mt-1">{card.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-5">
          <div className="px-6 py-4 border-b border-border">
            <h3 className="font-serif text-ink font-medium">By Status</h3>
          </div>
          <div className="p-6">
            <div className="space-y-3">
              {(content?.byStatus ?? []).map((s: any) => (
                <div key={s.status} className="flex items-center gap-3">
                  <span className="text-sm w-24 shrink-0 text-ink-3">{formatStatus(s.status)}</span>
                  <ProgressBar value={s.count} max={content?.totalPosts || 1} color={STATUS_COLORS[s.status] || "bg-[#243645]"} />
                  <span className="text-sm font-medium w-10 text-right text-ink">{s.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-6">
          <div className="px-6 py-4 border-b border-border">
            <h3 className="font-serif text-ink font-medium">By Platform</h3>
          </div>
          <div className="p-6">
            <div className="space-y-3">
              {(content?.byPlatform ?? []).map((p: any) => (
                <div key={p.platformName} className="flex items-center gap-3">
                  <span className="text-sm w-24 shrink-0 text-ink-3">{p.platformName}</span>
                  <ProgressBar value={p.count} max={content?.totalPosts || 1} color={PLATFORM_COLORS[p.platformName] || "bg-[#243645]"} />
                  <span className="text-sm font-medium w-10 text-right text-ink">{p.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
