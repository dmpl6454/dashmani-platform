"use client";
import Link from "next/link";
import { Badge } from "@dashmani/ui";

const priorityColor: Record<string, "danger" | "warning" | "default" | "secondary"> = {
  CRITICAL: "danger",
  HIGH: "warning",
  MEDIUM: "default",
  LOW: "secondary",
};

interface TaskCardProps {
  task: any;
}

export function TaskCard({ task }: TaskCardProps) {
  return (
    <Link href={`/tasks/${task.id}`}>
      <div className="bg-white border border-[#E8E0D0] rounded-2xl p-3 shadow-[0_2px_16px_rgba(0,0,0,0.06)] hover:shadow-md transition-shadow cursor-pointer">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-medium line-clamp-2 text-[#1A1A1A]">{task.title}</h4>
          <Badge variant={priorityColor[task.priority]} className="shrink-0 text-[10px]">
            {task.priority}
          </Badge>
        </div>
        {task.account && (
          <p className="text-xs text-[#7A7A7A] mt-1">
            {task.account.platform?.name}: {task.account.handle}
          </p>
        )}
        <div className="flex items-center justify-between mt-2">
          {task.assignee ? (
            <div className="flex items-center gap-1.5">
              <span className="h-5 w-5 rounded-full bg-[#F5D547] text-[#1A1A1A] font-bold text-[10px] flex items-center justify-center">{task.assignee.name?.[0]}</span>
              <span className="text-xs text-[#7A7A7A]">{task.assignee.name}</span>
            </div>
          ) : (
            <span className="text-xs text-orange-500">Unassigned</span>
          )}
          {task.dueDate && (
            <span className="text-xs text-[#B0B0B0]">
              {new Date(task.dueDate).toLocaleDateString()}
            </span>
          )}
        </div>
        {task._count?.comments > 0 && (
          <span className="text-xs text-[#B0B0B0] mt-1 block">
            {task._count.comments} comment{task._count.comments > 1 ? "s" : ""}
          </span>
        )}
      </div>
    </Link>
  );
}
