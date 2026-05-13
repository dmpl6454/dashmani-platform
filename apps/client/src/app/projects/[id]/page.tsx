"use client";
import { useParams } from "next/navigation";
import { useClientProject } from "@/lib/hooks/use-projects";

const statusColor: Record<string, string> = {
  TODO: "bg-[#FFF3C4] text-[#1A1A1A]",
  IN_PROGRESS: "bg-[rgba(52,152,219,0.12)] text-[#3498DB]",
  IN_REVIEW: "bg-[#FFF3C4] text-[#1A1A1A]",
  DONE: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  CANCELLED: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
  PENDING: "bg-[#FFF3C4] text-[#1A1A1A]",
  APPROVED: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  REJECTED: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
  REVISION_REQUESTED: "bg-[#FFF3C4] text-[#1A1A1A]",
  ACTIVE: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  PAUSED: "bg-[#FFF3C4] text-[#1A1A1A]",
  COMPLETED: "bg-[rgba(52,152,219,0.12)] text-[#3498DB]",
  ARCHIVED: "bg-[#FFF3C4] text-[#1A1A1A]",
};

export default function ProjectDetailPage() {
  const { id } = useParams();
  const { data, isLoading } = useClientProject(id as string);
  const project = (data as any)?.data;

  if (isLoading) return (
    <div className="flex items-center justify-center py-12">
      <div className="h-8 w-8 border-2 border-[#E8E0D0] border-b-2 border-b-[#F5D547] rounded-full animate-spin" />
    </div>
  );
  if (!project) return <div className="text-center py-8 text-[#7A7A7A]">Project not found.</div>;

  return (
    <div className="space-y-8 crx-animate-fade">
      <div className="crx-animate-slide crx-delay-1 flex items-center justify-between">
        <div>
          <h2 className="font-serif text-4xl font-light text-[#1A1A1A]">{project.name}</h2>
          {project.description && (
            <p className="text-[#7A7A7A] mt-2">{project.description}</p>
          )}
        </div>
        <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${statusColor[project.status] || "bg-[#FFF3C4] text-[#1A1A1A]"}`}>{project.status}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Social Accounts */}
        <div className="crx-animate-slide crx-delay-2 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-shadow">
          <div className="p-5 border-b border-[#F0EAD8]">
            <h3 className="font-serif text-lg text-[#1A1A1A]">Social Accounts</h3>
          </div>
          <div className="p-5">
            {project.accounts?.length === 0 ? (
              <p className="text-sm text-[#7A7A7A]">No accounts linked.</p>
            ) : (
              <div className="space-y-2">
                {project.accounts?.map((a: any) => (
                  <div key={a.id} className="flex items-center gap-3 text-sm p-4 border border-[#E8E0D0] rounded-2xl bg-[#FEFCF7]">
                    <div className="h-9 w-9 rounded-full flex items-center justify-center text-white text-xs font-medium" style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}>
                      {(a.account?.platform?.name || "?").charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <span className="font-medium text-[#1A1A1A]">{a.account?.platform?.name}</span>
                      <p className="text-xs text-[#7A7A7A]">{a.account?.handle}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Tasks */}
        <div className="crx-animate-slide crx-delay-3 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-shadow">
          <div className="p-5 border-b border-[#F0EAD8]">
            <h3 className="font-serif text-lg text-[#1A1A1A]">Tasks</h3>
          </div>
          <div className="p-5">
            {project.tasks?.length === 0 ? (
              <p className="text-sm text-[#7A7A7A]">No tasks yet.</p>
            ) : (
              <div className="space-y-2">
                {project.tasks?.map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between p-4 border border-[#E8E0D0] rounded-2xl text-sm hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-all">
                    <div>
                      <p className="font-medium text-[#1A1A1A]">{t.task?.title}</p>
                      {t.task?.assignee && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <div className="h-5 w-5 rounded-full flex items-center justify-center text-white text-[8px] font-medium" style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}>
                            {(t.task.assignee.name || "?").charAt(0).toUpperCase()}
                          </div>
                          <span className="text-xs text-[#7A7A7A]">{t.task.assignee.name}</span>
                        </div>
                      )}
                    </div>
                    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${statusColor[t.task?.status] || "bg-[#FFF3C4] text-[#1A1A1A]"}`}>{t.task?.status?.replace("_", " ")}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Approvals */}
      <div className="crx-animate-slide crx-delay-4 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-shadow">
        <div className="p-5 border-b border-[#F0EAD8]">
          <h3 className="font-serif text-lg text-[#1A1A1A]">Approvals</h3>
        </div>
        <div className="p-5">
          {project.approvals?.length === 0 ? (
            <p className="text-sm text-[#7A7A7A]">No approvals yet.</p>
          ) : (
            <div className="space-y-3">
              {project.approvals?.map((a: any) => (
                <div key={a.id} className="flex items-center justify-between p-4 border border-[#E8E0D0] rounded-2xl hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-all">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full flex items-center justify-center text-white text-xs font-medium" style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}>
                      {(a.requestedBy?.name || "?").charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-medium text-sm text-[#1A1A1A]">{a.title}</p>
                      {a.description && <p className="text-xs text-[#7A7A7A]">{a.description}</p>}
                      <p className="text-xs text-[#B0B0B0] mt-0.5">By {a.requestedBy?.name}</p>
                    </div>
                  </div>
                  <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${statusColor[a.status] || "bg-[#FFF3C4] text-[#1A1A1A]"}`}>{a.status?.replace("_", " ")}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Files */}
      <div className="crx-animate-slide crx-delay-5 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-shadow">
        <div className="p-5 border-b border-[#F0EAD8]">
          <h3 className="font-serif text-lg text-[#1A1A1A]">Files</h3>
        </div>
        <div className="p-5">
          {project.files?.length === 0 ? (
            <p className="text-sm text-[#7A7A7A]">No files shared yet.</p>
          ) : (
            <div className="space-y-2">
              {project.files?.map((f: any) => (
                <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between p-4 border border-[#E8E0D0] rounded-2xl text-sm hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-all">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1A1A1A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>
                    </div>
                    <div>
                      <p className="font-medium text-[#1A1A1A]">{f.name}</p>
                      <p className="text-xs text-[#7A7A7A]">Uploaded by {f.uploadedBy?.name} · {(f.size / 1024).toFixed(0)} KB</p>
                    </div>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B0B0B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
