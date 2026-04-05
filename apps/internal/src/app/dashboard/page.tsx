"use client";
import { useAuth } from "@/lib/auth";
import { useOverviewStats } from "@/lib/hooks/use-analytics";
import { StatCard } from "@dashmani/ui";
import {
  Users,
  Building2,
  Clock,
  CheckCircle,
  FolderOpen,
  FileCheck,
  Send,
  CalendarClock,
} from "lucide-react";

export default function DashboardPage() {
  const { user } = useAuth();
  const { data, isLoading } = useOverviewStats();
  const stats = (data as any)?.data;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Welcome back, {user?.name}</h2>
        <p className="text-muted-foreground">Here is your overview for today.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Employees"
          value={isLoading ? "--" : stats?.totalEmployees ?? 0}
          icon={<Users className="h-8 w-8" />}
        />
        <StatCard
          title="Active Teams"
          value={isLoading ? "--" : stats?.activeTeams ?? 0}
          icon={<Building2 className="h-8 w-8" />}
        />
        <StatCard
          title="Present Today"
          value={isLoading ? "--" : stats?.presentToday ?? 0}
          icon={<Clock className="h-8 w-8" />}
        />
        <StatCard
          title="Tasks Completed"
          value={isLoading ? "--" : stats?.tasksCompletedThisMonth ?? 0}
          icon={<CheckCircle className="h-8 w-8" />}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Active Projects"
          value={isLoading ? "--" : stats?.activeProjects ?? 0}
          icon={<FolderOpen className="h-8 w-8" />}
        />
        <StatCard
          title="Pending Approvals"
          value={isLoading ? "--" : stats?.pendingApprovals ?? 0}
          icon={<FileCheck className="h-8 w-8" />}
        />
        <StatCard
          title="Content Published"
          value={isLoading ? "--" : stats?.contentPublishedThisMonth ?? 0}
          icon={<Send className="h-8 w-8" />}
        />
        <StatCard
          title="Content Scheduled"
          value={isLoading ? "--" : stats?.contentScheduledUpcoming ?? 0}
          icon={<CalendarClock className="h-8 w-8" />}
        />
      </div>
    </div>
  );
}
