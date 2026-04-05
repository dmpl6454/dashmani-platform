"use client";
import { useParams } from "next/navigation";
import { useClientProject } from "@/lib/hooks/use-projects";
import { Card, CardHeader, CardTitle, CardContent, Badge } from "@dashmani/ui";

const statusColor: Record<string, "default" | "secondary" | "warning" | "danger"> = {
  TODO: "secondary", IN_PROGRESS: "default", IN_REVIEW: "warning", DONE: "default", CANCELLED: "danger",
  PENDING: "warning", APPROVED: "default", REJECTED: "danger", REVISION_REQUESTED: "warning",
};

export default function ProjectDetailPage() {
  const { id } = useParams();
  const { data, isLoading } = useClientProject(id as string);
  const project = (data as any)?.data;

  if (isLoading) return <div className="text-center py-8 text-muted-foreground">Loading...</div>;
  if (!project) return <div className="text-center py-8 text-muted-foreground">Project not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">{project.name}</h2>
        <Badge variant={statusColor[project.status]}>{project.status}</Badge>
      </div>

      {project.description && (
        <p className="text-muted-foreground">{project.description}</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Social Accounts</CardTitle></CardHeader>
          <CardContent>
            {project.accounts?.length === 0 ? (
              <p className="text-sm text-muted-foreground">No accounts linked.</p>
            ) : (
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
          <CardHeader><CardTitle>Tasks</CardTitle></CardHeader>
          <CardContent>
            {project.tasks?.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tasks yet.</p>
            ) : (
              <div className="space-y-2">
                {project.tasks?.map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between p-2 border rounded text-sm">
                    <div>
                      <p className="font-medium">{t.task?.title}</p>
                      {t.task?.assignee && <p className="text-xs text-muted-foreground">{t.task.assignee.name}</p>}
                    </div>
                    <Badge variant={statusColor[t.task?.status]}>{t.task?.status?.replace("_", " ")}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Approvals</CardTitle></CardHeader>
        <CardContent>
          {project.approvals?.length === 0 ? (
            <p className="text-sm text-muted-foreground">No approvals yet.</p>
          ) : (
            <div className="space-y-3">
              {project.approvals?.map((a: any) => (
                <div key={a.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="font-medium text-sm">{a.title}</p>
                    {a.description && <p className="text-xs text-muted-foreground">{a.description}</p>}
                    <p className="text-xs text-muted-foreground mt-1">By {a.requestedBy?.name}</p>
                  </div>
                  <Badge variant={statusColor[a.status]}>{a.status?.replace("_", " ")}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Files</CardTitle></CardHeader>
        <CardContent>
          {project.files?.length === 0 ? (
            <p className="text-sm text-muted-foreground">No files shared yet.</p>
          ) : (
            <div className="space-y-2">
              {project.files?.map((f: any) => (
                <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between p-2 border rounded text-sm hover:bg-gray-50">
                  <div>
                    <p className="font-medium">{f.name}</p>
                    <p className="text-xs text-muted-foreground">Uploaded by {f.uploadedBy?.name} · {(f.size / 1024).toFixed(0)} KB</p>
                  </div>
                </a>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
