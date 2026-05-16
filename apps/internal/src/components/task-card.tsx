"use client";
import Link from "next/link";

const PRIORITY_BADGE: Record<string, string> = {
  CRITICAL: "bg-danger-bg text-danger border-danger/20",
  HIGH:     "bg-attention-bg text-attention border-attention/20",
  MEDIUM:   "bg-action-soft text-ink border-ink/15",
  LOW:      "bg-neutral-bg text-neutral border-neutral/20",
};

function avatarBg(name: string) {
  const colors = ["#EDEDFD","#EEF4ED","#FDF0EC","#FFF3C4"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
}
function avatarText(name: string) {
  const colors = ["#5D5FEF","#4A7C52","#E07A5F","#C05826"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
}

export function TaskCard({ task }: { task: any }) {
  return (
    <Link href={`/tasks/${task.id}`}>
      <div className="v3-card-sm p-3 v3-card-lift cursor-pointer">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h4 className="text-sm font-semibold text-ink line-clamp-2 leading-snug">{task.title}</h4>
          {task.priority && (
            <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 border shrink-0 ${PRIORITY_BADGE[task.priority] || PRIORITY_BADGE.LOW}`}>
              {task.priority}
            </span>
          )}
        </div>

        {task.account && (
          <p className="text-[11px] text-ink-4 mb-2">
            {task.account.platform?.name}: {task.account.handle}
          </p>
        )}

        <div className="flex items-center justify-between">
          {task.assignee ? (
            <div className="flex items-center gap-1.5">
              <div
                className="h-5 w-5 rounded-full border border-ink/20 flex items-center justify-center text-[9px] font-bold shrink-0"
                style={{ background: avatarBg(task.assignee.name || ""), color: avatarText(task.assignee.name || "") }}
              >
                {(task.assignee.name || "?").charAt(0).toUpperCase()}
              </div>
              <span className="text-[11px] text-ink-3">{task.assignee.name}</span>
            </div>
          ) : (
            <span className="text-[11px] text-attention font-medium">Unassigned</span>
          )}
          {task.dueDate && (
            <span className="text-[10px] text-ink-4">
              {new Date(task.dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
            </span>
          )}
        </div>

        {task._count?.comments > 0 && (
          <p className="text-[10px] text-ink-4 mt-1.5">
            {task._count.comments} comment{task._count.comments > 1 ? "s" : ""}
          </p>
        )}
      </div>
    </Link>
  );
}
