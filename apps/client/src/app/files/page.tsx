"use client";
import { useClientProjects } from "@/lib/hooks/use-projects";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { FileText, Download } from "lucide-react";

export default function FilesPage() {
  const { data: projectsData, isLoading } = useClientProjects();
  const projects = (projectsData as any)?.data || [];

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="crx-animate-slide crx-delay-1">
        <h2 className="font-serif text-4xl font-light text-[#1A1A1A]">Shared Files</h2>
        <p className="text-[#7A7A7A] mt-1">Files shared across your projects</p>
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <div className="h-8 w-8 border-2 border-[#E8E0D0] border-b-2 border-b-[#F5D547] rounded-full animate-spin" />
        </div>
      ) : projects.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] py-12 text-center text-[#7A7A7A]">No projects found.</div>
      ) : (
        projects.map((project: any, idx: number) => (
          <ProjectFiles key={project.id} projectId={project.id} projectName={project.name} delay={Math.min(idx + 2, 6)} />
        ))
      )}
    </div>
  );
}

function ProjectFiles({ projectId, projectName, delay }: { projectId: string; projectName: string; delay: number }) {
  const { data, isLoading } = useSWR(`/client/projects/${projectId}`, (url) => apiFetch(url));
  const project = (data as any)?.data;
  const files = project?.files || [];

  if (isLoading || files.length === 0) return null;

  return (
    <div className={`crx-animate-slide crx-delay-${delay} bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-shadow`}>
      <div className="p-5 border-b border-[#F0EAD8]">
        <h3 className="font-serif text-lg text-[#1A1A1A]">{projectName}</h3>
      </div>
      <div className="p-5">
        <div className="space-y-2">
          {files.map((f: any) => (
            <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between p-4 border border-[#E8E0D0] rounded-2xl hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-all">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
                  <FileText className="h-4 w-4 text-[#1A1A1A]" />
                </div>
                <div>
                  <p className="text-sm font-medium text-[#1A1A1A]">{f.name}</p>
                  <p className="text-xs text-[#7A7A7A]">{(f.size / 1024).toFixed(0)} KB · {f.uploadedBy?.name}</p>
                </div>
              </div>
              <Download className="h-4 w-4 text-[#B0B0B0]" />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
