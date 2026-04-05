"use client";
import { useParams } from "next/navigation";
import { useProject } from "@/lib/hooks/use-projects";
import { Card, CardHeader, CardTitle, CardContent, Badge } from "@dashmani/ui";

export default function ProjectDetailPage() {
  const { id } = useParams();
  const { data, isLoading } = useProject(id as string);
  const project = (data as any)?.data;

  if (isLoading) return <div className="text-center py-8 text-muted-foreground">Loading...</div>;
  if (!project) return <div className="text-center py-8 text-muted-foreground">Project not found.</div>;

  const statusColor: Record<string, "default" | "secondary" | "warning" | "danger"> = {
    TODO: "secondary", IN_PROGRESS: "default", IN_REVIEW: "warning", DONE: "default", CANCELLED: "danger",
    PENDING: "warning", APPROVED: "default", REJECTED: "danger", REVISION_REQUESTED: "warning",
    ACTIVE: "default", PAUSED: "warning", COMPLETED: "secondary",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">{project.name}</h2>
          <p className="text-muted-foreground">{project.client?.companyName}</p>
        </div>
        <Badge variant={statusColor[project.status]}>{project.status}</Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">{project._count?.tasks || 0}</p>
            <p className="text-sm text-muted-foreground">Tasks</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">{project._count?.files || 0}</p>
            <p className="text-sm text-muted-foreground">Files</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">{project._count?.approvals || 0}</p>
            <p className="text-sm text-muted-foreground">Approvals</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Linked Accounts</CardTitle></CardHeader>
        <CardContent>
          {project.accounts?.length === 0 ? <p className="text-sm text-muted-foreground">No accounts linked.</p> : (
            <div className="space-y-2">
              {project.accounts?.map((a: any) => (
                <div key={a.id} className="flex items-center gap-2 text-sm p-2 border rounded">
                  <span className="font-medium">{a.account?.platform?.name}</span>
                  <span className="text-muted-foreground">{a.account?.handle}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Approvals</CardTitle></CardHeader>
        <CardContent>
          {project.approvals?.length === 0 ? <p className="text-sm text-muted-foreground">No approvals yet.</p> : (
            <div className="space-y-2">
              {project.approvals?.map((a: any) => (
                <div key={a.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="font-medium text-sm">{a.title}</p>
                    <p className="text-xs text-muted-foreground">By {a.requestedBy?.name}</p>
                  </div>
                  <Badge variant={statusColor[a.status]}>{a.status?.replace("_", " ")}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
