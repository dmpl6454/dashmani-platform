"use client";
import { useParams } from "next/navigation";
import { useProject } from "@/lib/hooks/use-projects";

export default function ProjectDetailPage() {
  const { id } = useParams();
  const { data, isLoading } = useProject(id as string);
  const project = (data as any)?.data;

  if (isLoading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-action" /></div>;
  if (!project) return <div className="text-center py-8 text-ink-3">Project not found.</div>;

  const statusBadge: Record<string, string> = {
    ACTIVE: "bg-[rgba(107,203,119,0.12)] text-success",
    PAUSED: "bg-action-soft text-ink",
    COMPLETED: "bg-[rgba(52,152,219,0.12)] text-[#3498DB]",
    ARCHIVED: "bg-[rgba(0,0,0,0.06)] text-ink-3",
    TODO: "bg-[rgba(0,0,0,0.06)] text-ink-3",
    IN_PROGRESS: "bg-action-soft text-ink",
    IN_REVIEW: "bg-[rgba(245,166,35,0.12)] text-gold",
    DONE: "bg-[rgba(107,203,119,0.12)] text-success",
    CANCELLED: "bg-[rgba(231,76,60,0.1)] text-danger",
    PENDING: "bg-action-soft text-ink",
    APPROVED: "bg-[rgba(107,203,119,0.12)] text-success",
    REJECTED: "bg-[rgba(231,76,60,0.1)] text-danger",
    REVISION_REQUESTED: "bg-[rgba(245,166,35,0.12)] text-gold",
  };

  const statCards = [
    { title: "Tasks", value: project._count?.tasks || 0 },
    { title: "Files", value: project._count?.files || 0 },
    { title: "Approvals", value: project._count?.approvals || 0 },
  ];

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-4xl font-light text-ink">{project.name}</h1>
          <p className="text-ink-3 mt-1">{project.client?.companyName}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadge[project.status] || "bg-[rgba(0,0,0,0.06)] text-ink-3"}`}>{project.status}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {statCards.map((card, i) => (
          <div
            key={card.title}
            className={`bg-surface rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] text-center crx-animate-slide crx-delay-${i + 1}`}
          >
            <p className="text-[40px] font-light font-num text-ink leading-tight">{card.value}</p>
            <p className="text-sm text-ink-3 mt-1">{card.title}</p>
          </div>
        ))}
      </div>

      <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border crx-animate-slide crx-delay-4">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="font-serif text-ink font-medium">Linked Accounts</h3>
        </div>
        <div className="p-6">
          {project.accounts?.length === 0 ? <p className="text-sm text-ink-3">No accounts linked.</p> : (
            <div className="space-y-2">
              {project.accounts?.map((a: any) => (
                <div key={a.id} className="flex items-center gap-2 text-sm p-3 border border-border rounded-xl hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                  <span className="font-medium text-ink">{a.account?.platform?.name}</span>
                  <span className="text-ink-3">{a.account?.handle}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border crx-animate-slide crx-delay-5">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="font-serif text-ink font-medium">Approvals</h3>
        </div>
        <div className="p-6">
          {project.approvals?.length === 0 ? <p className="text-sm text-ink-3">No approvals yet.</p> : (
            <div className="space-y-2">
              {project.approvals?.map((a: any) => (
                <div key={a.id} className="flex items-center justify-between p-3 border border-border rounded-xl hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                  <div>
                    <p className="font-medium text-sm text-ink">{a.title}</p>
                    <p className="text-xs text-ink-3">By {a.requestedBy?.name}</p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadge[a.status] || "bg-[rgba(0,0,0,0.06)] text-ink-3"}`}>{a.status?.replace("_", " ")}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
