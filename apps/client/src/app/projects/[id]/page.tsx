"use client";
import { useParams, useRouter } from "next/navigation";
import { useClientProject } from "@/lib/hooks/use-projects";
import { Topstrip } from "@/components/portal-topstrip";
import { Avatar, StatusBadge, Empty, Button } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import type { StatusKey } from "@/lib/portal-store";

// Remap legacy statuses → the 4-token system. Anything unknown lands on neutral DRAFT.
const remapStatus = (raw: string | undefined): StatusKey => {
  switch (raw) {
    case "ACTIVE": return "ACTIVE";
    case "PAUSED": return "PAUSED";
    case "COMPLETED": return "COMPLETED";
    case "ARCHIVED": return "ARCHIVED";
    case "TODO":
    case "IN_PROGRESS":
    case "IN_REVIEW":
      return "PENDING";
    case "DONE":
    case "APPROVED": return "APPROVED";
    case "CANCELLED":
    case "REJECTED": return "REJECTED";
    case "PENDING":
    case "REVISION_REQUESTED": return "PENDING";
    default: return "DRAFT";
  }
};

export default function ProjectDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { data: project, isLoading, error } = useClientProject(id as string);

  if (isLoading) {
    return (
      <>
        <Topstrip title="Project" />
        <div className="p-6 flex-1 grid place-items-center">
          <div className="h-8 w-8 border-2 border-border border-b-action rounded-full animate-spin" />
        </div>
      </>
    );
  }

  if (error && !isLoading) {
    return (
      <>
        <Topstrip title="Project" />
        <div className="p-6 flex-1 grid place-items-center">
          <Empty icon={<Icon.X size={20}/>} title="Could not load project" hint="Please try refreshing." cta={<Button size="sm" onClick={() => router.push("/projects")}>Back to projects</Button>} />
        </div>
      </>
    );
  }

  if (!project) {
    return (
      <>
        <Topstrip title="Project" />
        <div className="p-6">
          <Empty icon={<Icon.X size={20}/>} title="Project not found" cta={<Button size="sm" onClick={() => router.push("/projects")}>Back to projects</Button>} />
        </div>
      </>
    );
  }

  return (
    <>
      <Topstrip
        title={
          <span className="inline-flex items-center gap-2">
            <button onClick={() => router.push("/projects")} className="text-ink-3 hover:text-ink"><Icon.ChevLeft size={18}/></button>
            <span>{project.name}</span>
          </span>
        }
        sub={project.description || undefined}
        right={<StatusBadge status={remapStatus(project.status)} />}
      />

      <div className="px-6 py-5 max-w-[1200px] mx-auto w-full space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Social accounts */}
          <div className="bg-surface border border-border rounded-lg">
            <div className="px-4 h-11 border-b border-rule flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-ink">Social accounts</h3>
              <span className="text-[11px] text-ink-3">{project.accounts?.length ?? 0}</span>
            </div>
            <div className="p-3">
              {!project.accounts?.length ? (
                <p className="text-[12.5px] text-ink-3 px-1 py-2">No accounts linked.</p>
              ) : (
                <ul className="space-y-1">
                  {project.accounts.map((a: any) => (
                    <li key={a.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-muted/40 transition-colors">
                      <Avatar initial={(a.account?.platform?.name || "?").charAt(0).toUpperCase()} size="sm" />
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-ink truncate">{a.account?.platform?.name}</div>
                        <div className="text-[11px] text-ink-3 truncate">{a.account?.handle}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Tasks */}
          <div className="bg-surface border border-border rounded-lg">
            <div className="px-4 h-11 border-b border-rule flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-ink">Tasks</h3>
              <span className="text-[11px] text-ink-3">{project.tasks?.length ?? 0}</span>
            </div>
            <div>
              {!project.tasks?.length ? (
                <p className="text-[12.5px] text-ink-3 px-4 py-3">No tasks yet.</p>
              ) : project.tasks.map((t: any, i: number) => (
                <div
                  key={t.id}
                  className={`px-4 h-row flex items-center gap-3 hover:bg-muted/40 transition-colors ${i < project.tasks.length - 1 ? "border-b border-rule" : ""}`}
                >
                  <span className="flex-1 text-[13.5px] truncate text-rowtight">{t.task?.title}</span>
                  {t.task?.assignee && (
                    <div className="flex items-center gap-1.5">
                      <Avatar initial={(t.task.assignee.name || "?").charAt(0).toUpperCase()} size="xs" />
                      <span className="text-[11px] text-ink-3 truncate">{t.task.assignee.name}</span>
                    </div>
                  )}
                  <StatusBadge status={remapStatus(t.task?.status)} className="!h-5 !text-[10.5px]" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Approvals */}
        <div className="bg-surface border border-border rounded-lg">
          <div className="px-4 h-11 border-b border-rule flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-ink">Approvals</h3>
            <span className="text-[11px] text-ink-3">{project.approvals?.length ?? 0}</span>
          </div>
          <div>
            {!project.approvals?.length ? (
              <p className="text-[12.5px] text-ink-3 px-4 py-3">No approvals yet.</p>
            ) : project.approvals.map((a: any, i: number) => (
              <div
                key={a.id}
                className={`px-4 py-2.5 flex items-center gap-3 hover:bg-muted/40 transition-colors ${i < project.approvals.length - 1 ? "border-b border-rule" : ""}`}
              >
                <Avatar initial={(a.requestedBy?.name || "?").charAt(0).toUpperCase()} size="sm" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-medium text-ink truncate">{a.title}</div>
                  {a.description && <div className="text-[11.5px] text-ink-3 truncate text-rowtight">{a.description}</div>}
                  <div className="text-[11px] text-ink-4 mt-0.5">By {a.requestedBy?.name}</div>
                </div>
                <StatusBadge status={remapStatus(a.status)} className="!h-5 !text-[10.5px]" />
              </div>
            ))}
          </div>
        </div>

        {/* Files */}
        <div className="bg-surface border border-border rounded-lg">
          <div className="px-4 h-11 border-b border-rule flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-ink">Files</h3>
            <span className="text-[11px] text-ink-3">{project.files?.length ?? 0}</span>
          </div>
          <div>
            {!project.files?.length ? (
              <p className="text-[12.5px] text-ink-3 px-4 py-3">No files shared yet.</p>
            ) : project.files.map((f: any, i: number) => (
              <a
                key={f.id}
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`px-4 py-2.5 flex items-center gap-3 hover:bg-muted/40 transition-colors ${i < project.files.length - 1 ? "border-b border-rule" : ""}`}
              >
                <div className="h-9 w-9 rounded-md bg-muted text-ink-3 grid place-items-center shrink-0">
                  <Icon.File size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-medium text-ink truncate">{f.name}</div>
                  <div className="text-[11.5px] text-ink-3 truncate">
                    Uploaded by {f.uploadedBy?.name} · {(f.size / 1024).toFixed(0)} KB
                  </div>
                </div>
                <Icon.ArrowRight size={14} className="text-ink-4" />
              </a>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
