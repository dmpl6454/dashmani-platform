"use client";
import { useClientAnalytics } from "@/lib/hooks/use-analytics";
import { FolderOpen, CheckCircle, Clock, FileText } from "lucide-react";

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="w-full bg-[#F0EAD8] rounded-lg h-3">
      <div className={`h-3 rounded-lg ${color} transition-all duration-500`} style={{ width: `${percent}%` }} />
    </div>
  );
}

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  PAUSED: "bg-[#FFF3C4] text-[#1A1A1A]",
  COMPLETED: "bg-[rgba(52,152,219,0.12)] text-[#3498DB]",
  ARCHIVED: "bg-[#FFF3C4] text-[#1A1A1A]",
};

export default function ClientAnalyticsPage() {
  const { data, isLoading } = useClientAnalytics();
  const analytics = (data as any)?.data;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 border-2 border-[#E8E0D0] border-b-2 border-b-[#F5D547] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8 crx-animate-fade">
      <div className="crx-animate-slide crx-delay-1">
        <h2 className="font-serif text-4xl font-light text-[#1A1A1A]">Project Analytics</h2>
        <p className="text-[#7A7A7A] mt-1">Overview of your project health and progress</p>
      </div>

      {/* 4-column stat grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="crx-animate-slide crx-delay-2 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-5 hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-[#7A7A7A]">Total Projects</span>
            <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
              <FolderOpen className="h-5 w-5 text-[#1A1A1A]" />
            </div>
          </div>
          <p className="text-[40px] font-light font-serif text-[#1A1A1A] leading-none">{analytics?.totalProjects ?? 0}</p>
        </div>
        <div className="crx-animate-slide crx-delay-3 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-5 hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-[#7A7A7A]">Active Projects</span>
            <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
              <Clock className="h-5 w-5 text-[#1A1A1A]" />
            </div>
          </div>
          <p className="text-[40px] font-light font-serif text-[#1A1A1A] leading-none">{analytics?.activeProjects ?? 0}</p>
        </div>
        <div className="crx-animate-slide crx-delay-4 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-5 hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-[#7A7A7A]">Tasks Completed</span>
            <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
              <CheckCircle className="h-5 w-5 text-[#1A1A1A]" />
            </div>
          </div>
          <p className="text-[40px] font-light font-serif text-[#1A1A1A] leading-none">{analytics?.completedTasks ?? 0}<span className="text-lg text-[#7A7A7A]">/{analytics?.totalTasks ?? 0}</span></p>
        </div>
        <div className="crx-animate-slide crx-delay-5 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-5 hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-[#7A7A7A]">Pending Approvals</span>
            <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
              <FileText className="h-5 w-5 text-[#1A1A1A]" />
            </div>
          </div>
          <p className="text-[40px] font-light font-serif text-[#1A1A1A] leading-none">{analytics?.pendingApprovals ?? 0}</p>
        </div>
      </div>

      {/* Overall Completion */}
      <div className="crx-animate-slide crx-delay-5 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-shadow">
        <div className="p-5 border-b border-[#F0EAD8]">
          <h3 className="font-serif text-lg text-[#1A1A1A]">Overall Completion</h3>
        </div>
        <div className="p-5">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <ProgressBar
                value={analytics?.overallCompletionPercent ?? 0}
                max={100}
                color="bg-[#F5D547]"
              />
            </div>
            <span className="text-[40px] font-serif font-light text-[#1A1A1A] leading-none">
              {analytics?.overallCompletionPercent ?? 0}<span className="text-lg text-[#7A7A7A]">%</span>
            </span>
          </div>
        </div>
      </div>

      {/* Project Breakdown */}
      <div className="crx-animate-slide crx-delay-6 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
        <div className="p-5 border-b border-[#F0EAD8]">
          <h3 className="font-serif text-lg text-[#1A1A1A]">Project Breakdown</h3>
        </div>
        <div className="p-5">
          {(analytics?.projects ?? []).length === 0 ? (
            <p className="text-sm text-[#7A7A7A]">No projects found.</p>
          ) : (
            <div className="space-y-4">
              {(analytics?.projects ?? []).map((project: any) => (
                <div key={project.projectId} className="border border-[#E8E0D0] rounded-2xl p-5 hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-all">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full flex items-center justify-center text-white text-sm font-medium" style={{ background: "linear-gradient(135deg, #E8D5B7, #B8956A)" }}>
                        {(project.projectName || "?").charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <h3 className="font-medium text-[#1A1A1A]">{project.projectName}</h3>
                        <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium mt-1 ${STATUS_BADGE[project.status] || "bg-[#FFF3C4] text-[#1A1A1A]"}`}>
                          {project.status}
                        </span>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-[40px] font-light font-serif text-[#1A1A1A] leading-none">{project.taskCompletionPercent}<span className="text-lg text-[#7A7A7A]">%</span></p>
                      <p className="text-xs text-[#7A7A7A]">complete</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-[#7A7A7A]">Tasks</span>
                      <span className="text-[#1A1A1A] font-medium">{project.completedTasks}/{project.totalTasks}</span>
                    </div>
                    <ProgressBar
                      value={project.completedTasks}
                      max={project.totalTasks || 1}
                      color="bg-[#F5D547]"
                    />
                  </div>

                  {project.totalContent > 0 && (
                    <div className="space-y-2 mt-3">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-[#7A7A7A]">Content Published</span>
                        <span className="text-[#1A1A1A] font-medium">{project.publishedContent}/{project.totalContent}</span>
                      </div>
                      <ProgressBar
                        value={project.publishedContent}
                        max={project.totalContent || 1}
                        color="bg-[#F5A623]"
                      />
                    </div>
                  )}

                  {project.pendingApprovals > 0 && (
                    <div className="mt-3">
                      <span className="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium bg-[#FFF3C4] text-[#1A1A1A]">
                        {project.pendingApprovals} pending approval{project.pendingApprovals > 1 ? "s" : ""}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
