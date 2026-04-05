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
      <div className="bg-white border rounded-lg p-3 shadow-sm hover:shadow-md transition-shadow cursor-pointer">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-medium line-clamp-2">{task.title}</h4>
          <Badge variant={priorityColor[task.priority]} className="shrink-0 text-[10px]">
            {task.priority}
          </Badge>
        </div>
        {task.account && (
          <p className="text-xs text-muted-foreground mt-1">
            {task.account.platform?.name}: {task.account.handle}
          </p>
        )}
        <div className="flex items-center justify-between mt-2">
          {task.assignee ? (
            <span className="text-xs text-muted-foreground">{task.assignee.name}</span>
          ) : (
            <span className="text-xs text-orange-500">Unassigned</span>
          )}
          {task.dueDate && (
            <span className="text-xs text-muted-foreground">
              {new Date(task.dueDate).toLocaleDateString()}
            </span>
          )}
        </div>
        {task._count?.comments > 0 && (
          <span className="text-xs text-muted-foreground mt-1 block">
            {task._count.comments} comment{task._count.comments > 1 ? "s" : ""}
          </span>
        )}
      </div>
    </Link>
  );
}
