"use client";
import { useClientProjects } from "@/lib/hooks/use-projects";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "@dashmani/ui";
import { FileText, Download } from "lucide-react";

export default function FilesPage() {
  const { data: projectsData, isLoading } = useClientProjects();
  const projects = (projectsData as any)?.data || [];

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Shared Files</h2>
      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : projects.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">No projects found.</CardContent></Card>
      ) : (
        projects.map((project: any) => (
          <ProjectFiles key={project.id} projectId={project.id} projectName={project.name} />
        ))
      )}
    </div>
  );
}

function ProjectFiles({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { data, isLoading } = useSWR(`/client/projects/${projectId}`, (url) => apiFetch(url));
  const project = (data as any)?.data;
  const files = project?.files || [];

  if (isLoading || files.length === 0) return null;

  return (
    <Card>
      <CardHeader><CardTitle>{projectName}</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-2">
          {files.map((f: any) => (
            <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50 transition">
              <div className="flex items-center gap-3">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">{f.name}</p>
                  <p className="text-xs text-muted-foreground">{(f.size / 1024).toFixed(0)} KB · {f.uploadedBy?.name}</p>
                </div>
              </div>
              <Download className="h-4 w-4 text-muted-foreground" />
            </a>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
