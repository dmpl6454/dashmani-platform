"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, FolderOpen } from "lucide-react";
import { useProject } from "@/lib/hooks/use-projects";

// Mockup palette.
const STATUS_COLOR: Record<string, string> = {
  ACTIVE: "var(--hx-00D7A0)",
  PAUSED: "var(--hx-FBBF24)",
  COMPLETED: "var(--hx-6EB2FF)",
  ARCHIVED: "var(--hx-738395)",
  TODO: "var(--hx-738395)",
  IN_PROGRESS: "var(--hx-E9BD62)",
  IN_REVIEW: "var(--hx-6EB2FF)",
  DONE: "var(--hx-00D7A0)",
  CANCELLED: "var(--hx-FB7185)",
  PENDING: "var(--hx-E9BD62)",
  APPROVED: "var(--hx-00D7A0)",
  REJECTED: "var(--hx-FB7185)",
  REVISION_REQUESTED: "var(--hx-FBBF24)",
};
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
function StatusPill({ status, label }: { status: string; label: string }) {
  const color = STATUS_COLOR[status] || "var(--hx-738395)";
  return (
    <span
      className="inline-flex items-center h-7 px-3.5 rounded-full border text-[12px] font-semibold whitespace-nowrap"
      style={{ background: rgba(color, 0.1), borderColor: rgba(color, 0.3), color }}
    >
      {label}
    </span>
  );
}

const CARD = "rounded-[12px] border border-[color:var(--hx-1D3444)] bg-ds-card overflow-hidden shadow-[inset_0_1px_0_rgba(233,189,98,.06),0_12px_32px_rgba(0,0,0,.35)]";

export default function ProjectDetailPage() {
  const { id } = useParams();
  const { data, isLoading } = useProject(id as string);
  const project = (data as any)?.data;

  if (isLoading) {
    return (
      <div className="pt-[26px] space-y-3.5" aria-hidden="true">
        <div className="h-3 w-16 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
        <div className="h-7 w-56 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => <div key={i} className="h-[104px] rounded-[12px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />)}
        </div>
        <div className="h-48 rounded-[12px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
      </div>
    );
  }
  if (!project) {
    return (
      <div className="py-20 px-5 text-center text-ds-t3 text-[13px]">
        <FolderOpen className="h-[30px] w-[30px] mx-auto mb-2.5 opacity-50" strokeWidth={1.5} />
        Project not found.
      </div>
    );
  }

  const statCards = [
    { title: "Tasks", value: project._count?.tasks || 0 },
    { title: "Files", value: project._count?.files || 0 },
    { title: "Approvals", value: project._count?.approvals || 0 },
  ];

  return (
    <div className="pb-8">
      <section className="pt-[26px]">
        <Link href="/projects" className="inline-flex items-center gap-1.5 text-[13px] text-ds-t2 hover:text-ds-text transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" /> Projects
        </Link>
      </section>
      <section className="flex flex-wrap items-end justify-between gap-3 pt-3.5 pb-[22px]">
        <div className="min-w-0">
          <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight [overflow-wrap:anywhere]">{project.name}</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">{project.client?.companyName}</p>
        </div>
        <StatusPill status={project.status} label={project.status} />
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {statCards.map((card) => (
          <div key={card.title} className={`${CARD} px-6 py-5 text-center`}>
            <p className="text-[34px] font-bold tracking-[-.04em] text-ds-text tabular-nums leading-tight">{card.value}</p>
            <p className="mt-1 text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3">{card.title}</p>
          </div>
        ))}
      </section>

      <section className={`${CARD} mt-4`}>
        <div className="flex items-center h-[60px] px-6 border-b border-ds-line">
          <h3 className="text-[15px] font-semibold tracking-[-.01em] text-ds-text">Linked Accounts</h3>
        </div>
        {project.accounts?.length === 0 ? (
          <div className="py-12 px-5 text-center text-ds-t3 text-[13px]">No accounts linked.</div>
        ) : (
          <div>
            {project.accounts?.map((a: any) => (
              <div key={a.id} className="flex items-center gap-2 px-6 py-3.5 border-b border-[color:var(--hx-132430)] last:border-b-0 text-[13px] hover:bg-[color:var(--hx-0A1620)] transition-colors">
                <span className="font-semibold text-ds-text">{a.account?.platform?.name}</span>
                <span className="text-ds-t2">{a.account?.handle}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={`${CARD} mt-4`}>
        <div className="flex items-center h-[60px] px-6 border-b border-ds-line">
          <h3 className="text-[15px] font-semibold tracking-[-.01em] text-ds-text">Approvals</h3>
        </div>
        {project.approvals?.length === 0 ? (
          <div className="py-12 px-5 text-center text-ds-t3 text-[13px]">No approvals yet.</div>
        ) : (
          <div>
            {project.approvals?.map((a: any) => (
              <div key={a.id} className="flex items-center justify-between gap-3 px-6 py-3.5 border-b border-[color:var(--hx-132430)] last:border-b-0 hover:bg-[color:var(--hx-0A1620)] transition-colors">
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-ds-text truncate">{a.title}</p>
                  <p className="text-[12px] text-ds-t3">By {a.requestedBy?.name}</p>
                </div>
                <StatusPill status={a.status} label={a.status?.replace("_", " ")} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
