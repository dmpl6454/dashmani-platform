"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTask } from "@/lib/hooks/use-tasks";
import { Button, Badge, Card, CardContent, CardHeader, CardTitle, Input } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";

const STATUS_LABELS: Record<string, string> = {
  TODO: "To Do", IN_PROGRESS: "In Progress", IN_REVIEW: "In Review", DONE: "Done", CANCELLED: "Cancelled",
};

const STATUS_OPTIONS = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"];

const priorityColor: Record<string, "danger" | "warning" | "default" | "secondary"> = {
  CRITICAL: "danger", HIGH: "warning", MEDIUM: "default", LOW: "secondary",
};

export default function TaskDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { data, isLoading, mutate } = useTask(id as string);
  const [comment, setComment] = useState("");
  const [commenting, setCommenting] = useState(false);

  if (isLoading) return <div>Loading...</div>;
  const task = (data as any)?.data;
  if (!task) return <div>Task not found</div>;

  async function handleStatusChange(status: string) {
    try {
      await apiFetch(`/tasks/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
      mutate();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleAddComment() {
    if (!comment.trim()) return;
    setCommenting(true);
    try {
      await apiFetch(`/tasks/${id}/comments`, { method: "POST", body: JSON.stringify({ body: comment }) });
      setComment("");
      mutate();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setCommenting(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold">{task.title}</h2>
          <div className="flex gap-2 mt-2">
            <Badge variant={priorityColor[task.priority]}>{task.priority}</Badge>
            <Badge variant="secondary">{STATUS_LABELS[task.status]}</Badge>
          </div>
        </div>
        <Button variant="outline" onClick={() => router.push(`/tasks`)}>Back</Button>
      </div>

      <Card>
        <CardContent className="p-6 space-y-4">
          {task.description && <p className="text-sm">{task.description}</p>}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><span className="text-muted-foreground">Assignee:</span> {task.assignee?.name || "Unassigned"}</div>
            <div><span className="text-muted-foreground">Created by:</span> {task.createdBy?.name}</div>
            {task.account && <div><span className="text-muted-foreground">Account:</span> {task.account.platform?.name}: {task.account.handle}</div>}
            {task.dueDate && <div><span className="text-muted-foreground">Due:</span> {new Date(task.dueDate).toLocaleDateString()}</div>}
            {task.completedAt && <div><span className="text-muted-foreground">Completed:</span> {new Date(task.completedAt).toLocaleDateString()}</div>}
            {task.dependsOn && <div><span className="text-muted-foreground">Depends on:</span> {task.dependsOn.title} ({task.dependsOn.status})</div>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Update Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {STATUS_OPTIONS.map((s) => (
              <Button
                key={s}
                variant={task.status === s ? "default" : "outline"}
                size="sm"
                onClick={() => handleStatusChange(s)}
                disabled={task.status === s}
              >
                {STATUS_LABELS[s]}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Comments ({task.comments?.length || 0})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {task.comments?.map((c: any) => (
            <div key={c.id} className="border-b pb-3 last:border-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium">{c.author?.name}</span>
                <span className="text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              <p className="text-sm">{c.body}</p>
            </div>
          ))}
          <div className="flex gap-2">
            <Input placeholder="Add a comment..." value={comment} onChange={(e) => setComment(e.target.value)} className="flex-1" />
            <Button onClick={handleAddComment} disabled={commenting || !comment.trim()}>
              {commenting ? "..." : "Post"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
