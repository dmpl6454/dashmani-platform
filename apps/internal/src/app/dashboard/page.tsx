"use client";
import { useAuth } from "@/lib/auth";
import { StatCard } from "@dashmani/ui";
import { Users, Building2, Clock, CheckCircle } from "lucide-react";

export default function DashboardPage() {
  const { user } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Welcome back, {user?.name}</h2>
        <p className="text-muted-foreground">Here is your overview for today.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Employees"
          value="--"
          icon={<Users className="h-8 w-8" />}
          change={{ value: 0, label: "this month" }}
        />
        <StatCard
          title="Active Teams"
          value="--"
          icon={<Building2 className="h-8 w-8" />}
        />
        <StatCard
          title="Present Today"
          value="--"
          icon={<Clock className="h-8 w-8" />}
        />
        <StatCard
          title="Tasks Completed"
          value="--"
          icon={<CheckCircle className="h-8 w-8" />}
          change={{ value: 0, label: "this week" }}
        />
      </div>
    </div>
  );
}
