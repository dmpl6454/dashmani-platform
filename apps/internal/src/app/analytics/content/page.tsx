"use client";
import { Card, CardHeader, CardTitle, CardContent } from "@dashmani/ui";
import { useContentAnalytics } from "@/lib/hooks/use-analytics";

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="w-full bg-gray-200 rounded-full h-3">
      <div className={`h-3 rounded-full ${color}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-gray-400",
  SCHEDULED: "bg-blue-500",
  PUBLISHED: "bg-green-500",
  FAILED: "bg-red-500",
};

const PLATFORM_COLORS: Record<string, string> = {
  Instagram: "bg-pink-500",
  Twitter: "bg-sky-500",
  LinkedIn: "bg-blue-700",
  Facebook: "bg-blue-600",
  YouTube: "bg-red-600",
  TikTok: "bg-gray-800",
};

export default function ContentAnalyticsPage() {
  const { data, isLoading } = useContentAnalytics();
  const content = (data as any)?.data;

  if (isLoading) {
    return <div className="text-center py-8 text-muted-foreground">Loading content analytics...</div>;
  }

  if ((content?.totalPosts ?? 0) === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold">Content Analytics</h2>
          <p className="text-muted-foreground">Content performance and pipeline status</p>
        </div>
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground">No content posts yet.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Content Analytics</h2>
        <p className="text-muted-foreground">Content performance and pipeline status</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">{content?.totalPosts ?? 0}</p>
            <p className="text-sm text-muted-foreground">Total Posts</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-green-600">{content?.publishedThisMonth ?? 0}</p>
            <p className="text-sm text-muted-foreground">Published This Month</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-blue-600">{content?.scheduledUpcoming ?? 0}</p>
            <p className="text-sm text-muted-foreground">Scheduled Upcoming</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">{(content?.byPlatform ?? []).length}</p>
            <p className="text-sm text-muted-foreground">Platforms Active</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>By Status</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-3">
              {(content?.byStatus ?? []).map((s: any) => (
                <div key={s.status} className="flex items-center gap-3">
                  <span className="text-sm w-24 shrink-0">{s.status}</span>
                  <ProgressBar value={s.count} max={content?.totalPosts || 1} color={STATUS_COLORS[s.status] || "bg-gray-400"} />
                  <span className="text-sm font-medium w-10 text-right">{s.count}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>By Platform</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-3">
              {(content?.byPlatform ?? []).map((p: any) => (
                <div key={p.platformName} className="flex items-center gap-3">
                  <span className="text-sm w-24 shrink-0">{p.platformName}</span>
                  <ProgressBar value={p.count} max={content?.totalPosts || 1} color={PLATFORM_COLORS[p.platformName] || "bg-gray-500"} />
                  <span className="text-sm font-medium w-10 text-right">{p.count}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
