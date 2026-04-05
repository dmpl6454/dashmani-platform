"use client";
import { Card, CardHeader, CardTitle, CardContent, StatCard, Badge } from "@dashmani/ui";
import { useClientAnalytics } from "@/lib/hooks/use-analytics";
import { FolderOpen, CheckCircle, Clock, FileText } from "lucide-react";

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="w-full bg-gray-200 rounded-full h-3">
      <div className={`h-3 rounded-full ${color}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

const STATUS_BADGE: Record<string, "default" | "secondary" | "warning"> = {
  ACTIVE: "default",
  PAUSED: "warning",
  COMPLETED: "secondary",
  ARCHIVED: "secondary",
};

export default function ClientAnalyticsPage() {
  const { data, isLoading } = useClientAnalytics();
  const analytics = (data as any)?.data;

  if (isLoading) {
    return <div className="text-center py-8 text-muted-foreground">Loading analytics...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Project Analytics</h2>
        <p className="text-muted-foreground">Overview of your project health and progress</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Total Projects"
          value={analytics?.totalProjects ?? 0}
          icon={<FolderOpen className="h-5 w-5" />}
        />
        <StatCard
          title="Active Projects"
          value={analytics?.activeProjects ?? 0}
          icon={<Clock className="h-5 w-5" />}
        />
        <StatCard
          title="Tasks Completed"
          value={`${analytics?.completedTasks ?? 0}/${analytics?.totalTasks ?? 0}`}
          icon={<CheckCircle className="h-5 w-5" />}
        />
        <StatCard
          title="Pending Approvals"
          value={analytics?.pendingApprovals ?? 0}
          icon={<FileText className="h-5 w-5" />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Overall Completion</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <ProgressBar
                value={analytics?.overallCompletionPercent ?? 0}
                max={100}
                color="bg-green-500"
              />
            </div>
            <span className="text-lg font-bold text-green-600">
              {analytics?.overallCompletionPercent ?? 0}%
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Project Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {(analytics?.projects ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No projects found.</p>
          ) : (
            <div className="space-y-4">
              {(analytics?.projects ?? []).map((project: any) => (
                <div key={project.projectId} className="border rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h3 className="font-medium">{project.projectName}</h3>
                      <Badge variant={STATUS_BADGE[project.status] || "secondary"} className="mt-1">
                        {project.status}
                      </Badge>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold text-green-600">{project.taskCompletionPercent}%</p>
                      <p className="text-xs text-muted-foreground">complete</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Tasks</span>
                      <span>{project.completedTasks}/{project.totalTasks}</span>
                    </div>
                    <ProgressBar
                      value={project.completedTasks}
                      max={project.totalTasks || 1}
                      color="bg-green-500"
                    />
                  </div>

                  {project.totalContent > 0 && (
                    <div className="space-y-2 mt-3">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Content Published</span>
                        <span>{project.publishedContent}/{project.totalContent}</span>
                      </div>
                      <ProgressBar
                        value={project.publishedContent}
                        max={project.totalContent || 1}
                        color="bg-blue-500"
                      />
                    </div>
                  )}

                  {project.pendingApprovals > 0 && (
                    <p className="text-sm text-orange-600 mt-2">
                      {project.pendingApprovals} pending approval{project.pendingApprovals > 1 ? "s" : ""}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
