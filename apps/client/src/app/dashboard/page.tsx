"use client";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Card, CardHeader, CardTitle, CardContent, Badge, StatCard } from "@dashmani/ui";
import Link from "next/link";
import { FolderOpen, CheckSquare, Clock } from "lucide-react";

export default function ClientDashboard() {
  const { user } = useAuth();
  const { data, isLoading } = useSWR("/client/dashboard", (url) => apiFetch(url));
  const dashboard = (data as any)?.data;

  if (isLoading) return <div className="text-center py-8 text-muted-foreground">Loading...</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Welcome, {user?.name}</h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard title="Active Projects" value={dashboard?.projects?.length || 0} icon={<FolderOpen className="h-5 w-5" />} />
        <StatCard title="Pending Approvals" value={dashboard?.pendingApprovals?.length || 0} icon={<CheckSquare className="h-5 w-5" />} trend={dashboard?.pendingApprovals?.length > 0 ? "Needs attention" : ""} />
        <StatCard title="Status" value={dashboard?.client?.status || "--"} icon={<Clock className="h-5 w-5" />} />
      </div>

      {dashboard?.pendingApprovals?.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Pending Approvals</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-3">
              {dashboard.pendingApprovals.map((a: any) => (
                <div key={a.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="font-medium text-sm">{a.title}</p>
                    <p className="text-xs text-muted-foreground">{a.project?.name}</p>
                  </div>
                  <Link href="/approvals">
                    <Badge variant="warning">Review</Badge>
                  </Link>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Your Projects</CardTitle></CardHeader>
        <CardContent>
          {dashboard?.projects?.length === 0 ? (
            <p className="text-muted-foreground text-sm">No active projects yet.</p>
          ) : (
            <div className="space-y-3">
              {dashboard?.projects?.map((p: any) => (
                <Link key={p.id} href={`/projects/${p.id}`} className="block">
                  <div className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50 transition">
                    <p className="font-medium text-sm">{p.name}</p>
                    <Badge variant={p.status === "ACTIVE" ? "default" : "secondary"}>{p.status}</Badge>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
