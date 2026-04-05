"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useContentPost } from "@/lib/hooks/use-content";
import { Button, Badge, Card, CardContent, CardHeader, CardTitle } from "@dashmani/ui";
import { ContentForm } from "@/components/content-form";
import { apiFetch } from "@/lib/api";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending Approval",
  APPROVED: "Approved",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  FAILED: "Failed",
  REJECTED: "Rejected",
};

const STATUS_COLOR: Record<string, "default" | "secondary" | "warning" | "danger"> = {
  DRAFT: "secondary",
  PENDING_APPROVAL: "warning",
  APPROVED: "default",
  SCHEDULED: "default",
  PUBLISHED: "default",
  FAILED: "danger",
  REJECTED: "danger",
};

// Valid transitions for UI buttons
const STATUS_ACTIONS: Record<string, { label: string; status: string; variant: "default" | "outline" }[]> = {
  DRAFT: [
    { label: "Send for Approval", status: "PENDING_APPROVAL", variant: "default" },
    { label: "Schedule Directly", status: "SCHEDULED", variant: "outline" },
  ],
  PENDING_APPROVAL: [
    { label: "Back to Draft", status: "DRAFT", variant: "outline" },
  ],
  APPROVED: [
    { label: "Schedule", status: "SCHEDULED", variant: "default" },
    { label: "Back to Draft", status: "DRAFT", variant: "outline" },
  ],
  REJECTED: [
    { label: "Back to Draft", status: "DRAFT", variant: "outline" },
  ],
  SCHEDULED: [
    { label: "Mark Published", status: "PUBLISHED", variant: "default" },
    { label: "Mark Failed", status: "FAILED", variant: "outline" },
    { label: "Back to Draft", status: "DRAFT", variant: "outline" },
  ],
  FAILED: [
    { label: "Reschedule", status: "SCHEDULED", variant: "default" },
    { label: "Back to Draft", status: "DRAFT", variant: "outline" },
  ],
  PUBLISHED: [],
};

export default function ContentDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { data, isLoading, mutate } = useContentPost(id as string);
  const [isEditing, setIsEditing] = useState(false);
  const [transitioning, setTransitioning] = useState(false);

  if (isLoading) return <div className="py-8 text-center text-muted-foreground">Loading...</div>;
  const post = (data as any)?.data;
  if (!post) return <div className="py-8 text-center text-muted-foreground">Content not found</div>;

  async function handleStatusChange(newStatus: string) {
    setTransitioning(true);
    try {
      await apiFetch(`/content/${id}/status`, {
        method: "PUT",
        body: JSON.stringify({ status: newStatus }),
      });
      mutate();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setTransitioning(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Are you sure you want to delete this content post?")) return;
    try {
      await apiFetch(`/content/${id}`, { method: "DELETE" });
      router.push("/content");
    } catch (err: any) {
      alert(err.message);
    }
  }

  if (isEditing) {
    return (
      <div className="max-w-2xl">
        <ContentForm content={post} />
      </div>
    );
  }

  const actions = STATUS_ACTIONS[post.status] || [];

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold">{post.title}</h2>
          <div className="flex gap-2 mt-2">
            <Badge variant={STATUS_COLOR[post.status] || "secondary"}>
              {STATUS_LABELS[post.status] || post.status}
            </Badge>
          </div>
        </div>
        <div className="flex gap-2">
          {post.status !== "PUBLISHED" && (
            <>
              <Button variant="outline" onClick={() => setIsEditing(true)}>Edit</Button>
              <Button variant="outline" onClick={handleDelete}>Delete</Button>
            </>
          )}
          <Button variant="outline" onClick={() => router.push("/content")}>Back</Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-6 space-y-4">
          {post.caption && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-1">Caption</h4>
              <p className="text-sm whitespace-pre-wrap">{post.caption}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Project:</span>{" "}
              {post.project?.name}
            </div>
            <div>
              <span className="text-muted-foreground">Client:</span>{" "}
              {post.project?.client?.companyName || "--"}
            </div>
            <div>
              <span className="text-muted-foreground">Account:</span>{" "}
              {post.account ? `${post.account.platform?.name}: ${post.account.handle}` : "--"}
            </div>
            <div>
              <span className="text-muted-foreground">Created by:</span>{" "}
              {post.createdBy?.name}
            </div>
            <div>
              <span className="text-muted-foreground">Scheduled:</span>{" "}
              {post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : "--"}
            </div>
            <div>
              <span className="text-muted-foreground">Published:</span>{" "}
              {post.publishedAt ? new Date(post.publishedAt).toLocaleString() : "--"}
            </div>
            <div>
              <span className="text-muted-foreground">Created:</span>{" "}
              {new Date(post.createdAt).toLocaleString()}
            </div>
            <div>
              <span className="text-muted-foreground">Updated:</span>{" "}
              {new Date(post.updatedAt).toLocaleString()}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Media URLs */}
      {post.mediaUrls?.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Media ({post.mediaUrls.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {post.mediaUrls.map((url: string, i: number) => (
                <div key={i} className="border rounded-md overflow-hidden">
                  <img
                    src={url}
                    alt={`Media ${i + 1}`}
                    className="w-full h-40 object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                      (e.target as HTMLImageElement).parentElement!.innerHTML = `<div class="flex items-center justify-center h-40 bg-gray-100 text-xs text-muted-foreground p-2 break-all">${url}</div>`;
                    }}
                  />
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-2 text-xs text-brand-blue hover:underline truncate"
                  >
                    {url}
                  </a>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Status Actions */}
      {actions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Actions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {actions.map((action) => (
                <Button
                  key={action.status}
                  variant={action.variant}
                  size="sm"
                  onClick={() => handleStatusChange(action.status)}
                  disabled={transitioning}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
