"use client";
import { useContentAnalytics } from "@/lib/hooks/use-analytics";
import { formatStatus } from "@dashmani/shared";

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="w-full bg-[#F0E4C4] rounded-lg h-[24px]">
      <div className={`h-[24px] rounded-lg ${color}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-[#B0B0B0]",
  SCHEDULED: "bg-[#F5D547]",
  PUBLISHED: "bg-[#6BCB77]",
  FAILED: "bg-[#E74C3C]",
};

const PLATFORM_COLORS: Record<string, string> = {
  Instagram: "bg-pink-500",
  Twitter: "bg-sky-500",
  LinkedIn: "bg-[#F5D547]",
  Facebook: "bg-[#FAE89E]",
  YouTube: "bg-[#E74C3C]",
  TikTok: "bg-[#1A1A1A]",
};

export default function ContentAnalyticsPage() {
  const { data, isLoading } = useContentAnalytics();
  const content = (data as any)?.data;

  if (isLoading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" /></div>;
  }

  if ((content?.totalPosts ?? 0) === 0) {
    return (
      <div className="space-y-6 crx-animate-fade">
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Content Analytics</h1>
          <p className="text-[#7A7A7A] mt-1">Content performance and pipeline status</p>
        </div>
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-8 text-center">
          <p className="text-[#7A7A7A]">No content posts yet.</p>
        </div>
      </div>
    );
  }

  const statCards = [
    { title: "Total Posts", value: content?.totalPosts ?? 0, sub: "all time", color: "text-[#1A1A1A]" },
    { title: "Published This Month", value: content?.publishedThisMonth ?? 0, sub: "current period", color: "text-[#6BCB77]" },
    { title: "Scheduled Upcoming", value: content?.scheduledUpcoming ?? 0, sub: "in pipeline", color: "text-[#1A1A1A]" },
    { title: "Platforms Active", value: (content?.byPlatform ?? []).length, sub: "channels used", color: "text-[#1A1A1A]" },
  ];

  return (
    <div className="space-y-6 crx-animate-fade">
      <div>
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Content Analytics</h1>
        <p className="text-[#7A7A7A] mt-1">Content performance and pipeline status</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((card, i) => (
          <div
            key={card.title}
            className={`bg-white rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-${i + 1}`}
          >
            <span className="text-sm text-[#7A7A7A]">{card.title}</span>
            <p className={`text-[40px] font-light font-num leading-tight mt-2 ${card.color}`}>{card.value}</p>
            <p className="text-xs text-[#B0B0B0] mt-1">{card.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-5">
          <div className="px-6 py-4 border-b border-[#F0EAD8]">
            <h3 className="font-serif text-[#1A1A1A] font-medium">By Status</h3>
          </div>
          <div className="p-6">
            <div className="space-y-3">
              {(content?.byStatus ?? []).map((s: any) => (
                <div key={s.status} className="flex items-center gap-3">
                  <span className="text-sm w-24 shrink-0 text-[#7A7A7A]">{formatStatus(s.status)}</span>
                  <ProgressBar value={s.count} max={content?.totalPosts || 1} color={STATUS_COLORS[s.status] || "bg-[#B0B0B0]"} />
                  <span className="text-sm font-medium w-10 text-right text-[#1A1A1A]">{s.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-6">
          <div className="px-6 py-4 border-b border-[#F0EAD8]">
            <h3 className="font-serif text-[#1A1A1A] font-medium">By Platform</h3>
          </div>
          <div className="p-6">
            <div className="space-y-3">
              {(content?.byPlatform ?? []).map((p: any) => (
                <div key={p.platformName} className="flex items-center gap-3">
                  <span className="text-sm w-24 shrink-0 text-[#7A7A7A]">{p.platformName}</span>
                  <ProgressBar value={p.count} max={content?.totalPosts || 1} color={PLATFORM_COLORS[p.platformName] || "bg-[#B0B0B0]"} />
                  <span className="text-sm font-medium w-10 text-right text-[#1A1A1A]">{p.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
